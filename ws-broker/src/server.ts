import { WebSocketServer, WebSocket } from 'ws';
import { Transports, Messages } from 'av-controls';
type RootSpecification = Messages.RootSpecification;
const {
  ControlStateRestore,
  walkSignalTree,
  walkUpdateTree,
} = Messages;
const RootSpecification = Messages.RootSpecification;

const verboseForwardingLog = process.env.WS_BROKER_VERBOSE_FORWARDING === '1';

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${timestamp}] ${message}`, data);
    return;
  }
  console.log(`[${timestamp}] ${message}`);
}

function warn(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.warn(`[${timestamp}] ${message}`, data);
    return;
  }
  console.warn(`[${timestamp}] ${message}`);
}

function error(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.error(`[${timestamp}] ${message}`, data);
    return;
  }
  console.error(`[${timestamp}] ${message}`);
}

function verbose(message: string, data?: unknown) {
  if (!verboseForwardingLog) {
    return;
  }
  log(message, data);
}

// serve websocket
const parsedWsPort = Number.parseInt(process.env.WS_PORT ?? '', 10);
const wsPort = Number.isFinite(parsedWsPort) ? parsedWsPort : 8080;
const wss = new WebSocketServer({ port: wsPort }); 
log(`🚀 WebSocket server running on port ${wsPort}`);
let shuttingDown = false;

type Sender = WebSocket;

type PanelInfo = {
  spec: RootSpecification;
  currentState: any; // Controls.Base.State (mutable, gets patched on updates)
  stateInitialized: boolean;
  receiver: WebSocket | null;
  online: boolean;
  generation: number;
};

let receiver: WebSocket | null = null;
let receiverGeneration = 0;
let netPanels: {[id: string]: PanelInfo} = {};
const senders: Sender[] = [];
const seqByPanelPath = new Map<string, number>();
const serverSeqByPanel = new Map<string, number>();
const receiverPanelIds = new WeakMap<WebSocket, Set<string>>();
const senderClientIds = new WeakMap<WebSocket, string>();
let nextSocketId = 1;
const socketIds = new WeakMap<WebSocket, number>();

function getSocketId(ws: WebSocket) {
  let id = socketIds.get(ws);
  if (!id) {
    id = nextSocketId++;
    socketIds.set(ws, id);
  }
  return id;
}

wss.on('connection', (ws) => {
  if (shuttingDown) {
    ws.close(1001, 'broker shutting down');
    return;
  }
  log('New WS connection', { socketId: getSocketId(ws) });

  ws.onmessage = (event) => {
    try {
      const deserialized = JSON.parse(event.data.toString());
      const type = deserialized.type;
      switch (type) {
        case Transports.WebSocket.Messages.RegisterReceiver.type:
          receiverGeneration += 1;
          const generation = receiverGeneration;
          receiver = ws;
          receiverPanelIds.set(ws, new Set());

          log(`It's a receiver!`, { socketId: getSocketId(ws), generation });

          ws.onmessage = (event) => handleReceiverMessage(ws, event.data.toString());
          ws.onclose = () => handleReceiverDisconnect(ws, generation);
          break;

        case Transports.WebSocket.Messages.RegisterSender.type:
          pruneClosedSenders();
          if (!senders.includes(ws)) {
            senders.push(ws);
          }
          if (typeof deserialized.clientId === 'string' && deserialized.clientId) {
            senderClientIds.set(ws, deserialized.clientId);
          }
          log(`It's a sender!`, {
            socketId: getSocketId(ws),
            clientId: senderClientIds.get(ws) ?? null,
            senderCount: senders.length,
            senderSocketIds: getSenderSocketIds(),
          });

          sendPanelList(ws);

          ws.onmessage = (event) => handleSenderMessage(ws, event.data.toString());
          ws.onclose = () => handleSenderDisconnect(ws);
          break;
      }
    } catch (error) {
      errorLog('Invalid message received', error);
    }
  };
});

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log('Shutting down WebSocket broker', { signal, clientCount: wss.clients.size });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(1001, 'broker shutting down');
    }
  }

  const forceClose = setTimeout(() => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.CLOSED) {
        client.terminate();
      }
    }
    finishShutdown(signal);
  }, 500);

  wss.close(() => {
    clearTimeout(forceClose);
    finishShutdown(signal);
  });
}

function finishShutdown(signal: NodeJS.Signals) {
  if (signal === 'SIGUSR2') {
    process.kill(process.pid, 'SIGUSR2');
    return;
  }
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGUSR2', shutdown);

function errorLog(message: string, data?: unknown) {
  error(message, data);
}

let panelSubscribers: {[id: string]: Set<WebSocket>} = {};

function pruneClosedSenders() {
  for (let i = senders.length - 1; i >= 0; i -= 1) {
    const sender = senders[i];
    if (!sender || sender.readyState !== WebSocket.OPEN) {
      if (sender) {
        unsubscribeSenderFromPanels(sender);
      }
      senders.splice(i, 1);
    }
  }
}

function pruneClosedSubscribers(panelId?: string) {
  const panelIds = panelId ? [panelId] : Object.keys(panelSubscribers);
  for (const id of panelIds) {
    const subscribers = panelSubscribers[id];
    if (!subscribers) continue;
    for (const sender of [...subscribers]) {
      if (sender.readyState !== WebSocket.OPEN) {
        subscribers.delete(sender);
      }
    }
    if (subscribers.size === 0) {
      delete panelSubscribers[id];
    }
  }
}

function getSenderSocketIds() {
  pruneClosedSenders();
  return senders.map((sender) => getSocketId(sender));
}

function getSubscriberSocketIds(panelId: string) {
  pruneClosedSubscribers(panelId);
  return [...(panelSubscribers[panelId] ?? new Set<WebSocket>())].map((sender) => getSocketId(sender));
}

function unsubscribeSenderFromPanels(ws: WebSocket) {
  for (const panelId in panelSubscribers) {
    panelSubscribers[panelId]?.delete(ws);
    if (panelSubscribers[panelId]?.size === 0) {
      delete panelSubscribers[panelId];
    }
  }
}

function sendPanelList(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  log('Sending panel list', {
    socketId: getSocketId(ws),
    panels: Object.keys(netPanels),
    onlinePanels: getOnlinePanelIds(),
  });
  const message = new Transports.WebSocket.Messages.PanelList(
    Object.keys(netPanels),
    getOnlinePanelIds(),
  )
  ws.send(JSON.stringify(message));
}

function broadcastPanelList() {
  pruneClosedSenders();
  for (const ws of [...senders]) {
    if (ws.readyState !== WebSocket.OPEN) {
      handleSenderDisconnect(ws);
      continue;
    }
    sendPanelList(ws);
  }
}

function handleReceiverMessage(ws: WebSocket, message: string) {
  try {
    const parsed = JSON.parse(message);
    switch (parsed.type) {
      case Transports.WebSocket.Messages.AddNetPanel.type:
        const msg = parsed as Transports.WebSocket.Messages.AddNetPanel
        const previous = netPanels[msg.id];
        const generation = (previous?.generation ?? 0) + 1;
        receiverPanelIds.get(ws)?.add(msg.id);
        netPanels[msg.id] = {
          spec: msg.rootSpecification,
          currentState: previous?.stateInitialized
            ? previous.currentState
            : msg.rootSpecification.currentState,
          stateInitialized: previous?.stateInitialized || msg.rootSpecification.stateInitialized,
          receiver: ws,
          online: true,
          generation,
        };

        log(`NetPanel ${msg.id} added`, {
          receiverSocketId: getSocketId(ws),
          generation,
          restoredFromBrokerState: Boolean(previous?.stateInitialized),
          subscriberCount: getSubscriberSocketIds(msg.id).length,
          subscriberSocketIds: getSubscriberSocketIds(msg.id),
        });
        if (previous?.stateInitialized) {
          sendMessageToReceiver(ws, msg.id, new ControlStateRestore(previous.currentState));
        }
        sendRootSpecificationToSubscribers(msg.id);
        broadcastPanelList();
        break;

      case Transports.WebSocket.Messages.WrappedMessage.type:
        // forward the message to all subscribers of the panel
        const panelId = parsed.panelId;
        const avMessage = parsed.message;
        const sourcePanel = netPanels[panelId];
        if (!sourcePanel || sourcePanel.receiver !== ws) {
          warn('Ignoring stale receiver message', {
            receiverSocketId: getSocketId(ws),
            panelId,
            type: avMessage?.type,
            activeReceiverSocketId: sourcePanel?.receiver ? getSocketId(sourcePanel.receiver) : null,
          });
          break;
        }
        if (avMessage?.type === 'control-update') {
          applyControlUpdate(panelId, avMessage);
        }
        if (avMessage?.type === 'controller-specification') {
          sourcePanel.spec = avMessage as RootSpecification;
          sourcePanel.currentState = avMessage.currentState;
          sourcePanel.stateInitialized = avMessage.stateInitialized;
        }
        pruneClosedSubscribers(panelId);
        const listeners = panelSubscribers[panelId] || new Set<WebSocket>();
        const updatePath = avMessage?.type === 'control-update'
          ? extractFirstUpdatePath(avMessage.update)
          : [];
        assignServerSeq(panelId, avMessage);
        verbose('Forwarding receiver message to subscribers', {
          panelId,
          type: avMessage?.type,
          path: avMessage?.type === 'control-update' ? updatePath.join('.') : undefined,
          subscriberCount: listeners.size,
          subscriberSocketIds: getSubscriberSocketIds(panelId),
          receiverSocketId: receiver ? getSocketId(receiver) : null,
        });
        const payload = JSON.stringify(parsed);
        listeners.forEach((subscriber) => {
          if (shouldSuppressSubscriberEcho(subscriber, avMessage)) {
            verbose('Suppressing sender echo', {
              subscriberSocketId: getSocketId(subscriber),
              clientId: senderClientIds.get(subscriber),
              type: avMessage.type,
              path: avMessage.path ?? null,
            });
            return;
          }
          subscriber.send(payload);
        });
        break;
    }
  } catch (error) {
    errorLog('Error in receiver message handling', error);
  }
}

// 📩 **Sender-Side Message Handling**
function handleSenderMessage(ws: WebSocket, message: string) {
  try {
    const parsed = JSON.parse(message);

    switch (parsed.type) {
      case Transports.WebSocket.Messages.ChoosePanel.type:
        const msg = parsed as Transports.WebSocket.Messages.ChoosePanel
        pruneClosedSenders();
        pruneClosedSubscribers();
        unsubscribeSenderFromPanels(ws);
        if (!netPanels[msg.panelId]) {
          warn(`Panel ${msg.panelId} is not known`);
          sendPanelList(ws);
          break;
        }
        panelSubscribers[msg.panelId] = panelSubscribers[msg.panelId] || new Set<WebSocket>();
        panelSubscribers[msg.panelId]!.add(ws);
        log('Sender subscribed to panel', {
          socketId: getSocketId(ws),
          panelId: msg.panelId,
          subscriberCount: panelSubscribers[msg.panelId]!.size,
          subscriberSocketIds: getSubscriberSocketIds(msg.panelId),
        });

        sendRootSpecificationToSubscriber(msg.panelId, ws);
        break;
    
      case Transports.WebSocket.Messages.WrappedMessage.type:
        // just forward the message to the single receiver
        const targetReceiver = netPanels[parsed.panelId]?.receiver;
        if (targetReceiver && targetReceiver.readyState === WebSocket.OPEN) {
          const avMessage = parsed.message;
          if (avMessage?.type === 'control-signal') {
            const path = extractFirstSignalPath(avMessage.signal);
            const key = makeSeqKey(parsed.panelId, path);
            const seq = (seqByPanelPath.get(key) ?? 0) + 1;
            seqByPanelPath.set(key, seq);
            avMessage.seq = seq;
            assignServerSeq(parsed.panelId, avMessage);
            verbose('Forwarding control signal to receiver', {
              senderSocketId: getSocketId(ws),
              receiverSocketId: getSocketId(targetReceiver),
              panelId: parsed.panelId,
              path: path.join('.'),
              seq,
              origin: avMessage.origin,
            });
          } else {
            assignServerSeq(parsed.panelId, avMessage);
            verbose('Forwarding sender message to receiver', {
              senderSocketId: getSocketId(ws),
              receiverSocketId: getSocketId(targetReceiver),
              panelId: parsed.panelId,
              type: avMessage?.type,
            });
          }
          targetReceiver.send(JSON.stringify(parsed));
        } else {
          warn('No receiver available, message dropped', {
            senderSocketId: getSocketId(ws),
            panelId: parsed.panelId,
            type: parsed.message?.type,
          });
        }
        break;
    }
  } catch (error) {
    errorLog('Error in sender message handling', error);
  }
}

function handleReceiverDisconnect(ws: WebSocket, generation: number) {
  const panels = receiverPanelIds.get(ws) ?? new Set<string>();
  if (receiver === ws) {
    receiver = null;
  }
  receiverPanelIds.delete(ws);

  if (panels.size === 0) {
    log('Receiver disconnected before announcing panels', {
      socketId: getSocketId(ws),
      generation,
      activeGeneration: receiverGeneration,
      activeReceiverSocketId: receiver ? getSocketId(receiver) : null,
    });
    return;
  }

  log('️Receiver disconnected', { socketId: getSocketId(ws), generation });
  for (const panelId of panels) {
    const panel = netPanels[panelId];
    if (!panel || panel.receiver !== ws) {
      continue;
    }
    panel.receiver = null;
    panel.online = false;
    log('Panel marked offline', {
      panelId,
      generation: panel.generation,
      subscriberSocketIds: getSubscriberSocketIds(panelId),
    });
  }
  broadcastPanelList();
}

function handleSenderDisconnect(ws: WebSocket) {
  const socketId = getSocketId(ws);
  unsubscribeSenderFromPanels(ws);
  const index = senders.indexOf(ws);
  if (index !== -1) {
    senders.splice(index, 1);
  }
  log('Sender disconnected', {
    socketId,
    senderCount: senders.length,
    senderSocketIds: getSenderSocketIds(),
  });
}

function shouldSuppressSubscriberEcho(subscriber: WebSocket, avMessage: any) {
  if (avMessage?.type !== 'control-update') {
    return false;
  }
  const origin = avMessage.origin;
  if (!origin || typeof origin !== 'object') {
    return false;
  }
  if (origin.kind !== 'timeline' || typeof origin.clientId !== 'string') {
    return false;
  }
  return senderClientIds.get(subscriber) === origin.clientId;
}

function extractFirstSignalPath(signal: any): string[] {
  let firstPath: string[] = [];
  walkSignalTree(signal, (path) => {
    if (firstPath.length === 0) {
      firstPath = path;
    }
  });
  return firstPath;
}

function extractFirstUpdatePath(update: any): string[] {
  let firstPath: string[] = [];
  walkUpdateTree(update, (path) => {
    if (firstPath.length === 0) {
      firstPath = path;
    }
  });
  return firstPath;
}

function makeSeqKey(panelId: string, path: string[]) {
  return `${panelId}:${path.join('.')}`;
}

function getOnlinePanelIds() {
  return Object.entries(netPanels)
    .filter(([, panel]) => panel.online)
    .map(([id]) => id);
}

function makeRootSpecification(panelId: string) {
  const panel = netPanels[panelId];
  if (!panel) {
    return null;
  }
  return new RootSpecification(
    panel.spec.name,
    panel.spec.rootControlSpec,
    panel.currentState,
    panel.stateInitialized,
  );
}

function sendRootSpecificationToSubscriber(panelId: string, subscriber: WebSocket) {
  if (subscriber.readyState !== WebSocket.OPEN) {
    return;
  }
  const panel = netPanels[panelId];
  if (!panel || !panel.online) {
    log('Subscribed panel is offline; root specification deferred', {
      socketId: getSocketId(subscriber),
      panelId,
    });
    return;
  }
  const rootSpec = makeRootSpecification(panelId);
  if (!rootSpec) {
    return;
  }
  assignServerSeq(panelId, rootSpec);
  const wrappedRootSpec = new Transports.WebSocket.Messages.WrappedMessage(panelId, rootSpec);
  subscriber.send(JSON.stringify(wrappedRootSpec));
}

function sendRootSpecificationToSubscribers(panelId: string) {
  pruneClosedSubscribers(panelId);
  const subscribers = panelSubscribers[panelId] ?? new Set<WebSocket>();
  for (const subscriber of subscribers) {
    sendRootSpecificationToSubscriber(panelId, subscriber);
  }
}

function sendMessageToReceiver(ws: WebSocket, panelId: string, message: any) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  const wrapped = new Transports.WebSocket.Messages.WrappedMessage(panelId, message);
  ws.send(JSON.stringify(wrapped));
}

function applyControlUpdate(panelId: string, avMessage: any) {
  let maxSeq = typeof avMessage.seq === 'number' ? avMessage.seq : 0;
  walkUpdateTree(avMessage.update, (path, update) => {
    const key = makeSeqKey(panelId, path);
    const seq = (seqByPanelPath.get(key) ?? 0) + 1;
    seqByPanelPath.set(key, seq);
    maxSeq = Math.max(maxSeq, seq);

    const panel = netPanels[panelId];
    if (panel) {
      patchStateAtPath(panel.currentState, path, update);
      panel.stateInitialized = true;
    }
  });
  avMessage.seq = maxSeq;
}

function assignServerSeq(panelId: string, avMessage: any) {
  if (!avMessage || typeof avMessage !== 'object') {
    return;
  }
  const nextSeq = (serverSeqByPanel.get(panelId) ?? 0) + 1;
  serverSeqByPanel.set(panelId, nextSeq);
  avMessage.serverSeq = nextSeq;
}

/**
 * Patch currentState at the given path with values from update
 * The path already points to the leaf update; recurse through state only.
 * For leaf controls, copy all properties from update to state
 */
function patchStateAtPath(state: any, path: string[], update: any): void {
  if (path.length === 0) {
    // Leaf: copy all update properties to state
    for (const key in update) {
      if (key !== 'controlId' && key !== 'update') {
        state[key] = update[key];
      }
    }
    return;
  }

  // Recurse into group
  const [controlId, ...restPath] = path;
  if (!state.states) {
    console.warn('State path not found during patch:', path);
    return;
  }
  if (!state.states[controlId]) {
    console.warn('State child not found during patch:', controlId);
    return;
  }
  patchStateAtPath(state.states[controlId], restPath, update);
}
