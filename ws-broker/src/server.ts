import { WebSocketServer, WebSocket } from 'ws';
import { Controls, Transports } from 'av-controls'; 
import { RootSpecification } from 'av-controls/src/messages';

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
const wsPort = 8080;
const wss = new WebSocketServer({ port: wsPort }); 
log(`🚀 WebSocket server running on port ${wsPort}`);

type Sender = WebSocket;

type PanelInfo = {
  spec: RootSpecification;
  currentState: any; // Controls.Base.State (mutable, gets patched on updates)
};

let receiver: WebSocket | null = null;
let receiverGeneration = 0;
let netPanels: {[id: string]: PanelInfo} = {};
const senders: Sender[] = [];
const seqByPanelPath = new Map<string, number>();
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
  log('New WS connection', { socketId: getSocketId(ws) });

  ws.onmessage = (event) => {
    try {
      const deserialized = JSON.parse(event.data.toString());
      const type = deserialized.type;
      switch (type) {
        case Transports.WebSocket.Messages.RegisterReceiver.type:
          const previousReceiver = receiver;
          receiverGeneration += 1;
          const generation = receiverGeneration;
          receiver = ws;
          resetReceiverState();

          if (previousReceiver && previousReceiver !== ws) {
            log('Replacing old receiver', {
              previousSocketId: getSocketId(previousReceiver),
              nextSocketId: getSocketId(ws),
              generation,
            });
            previousReceiver.close(); // Disconnect old receiver
          }
          log(`It's a receiver!`, { socketId: getSocketId(ws), generation });

          ws.onmessage = (event) => handleReceiverMessage(ws, event.data.toString());
          ws.onclose = () => handleReceiverDisconnect(ws, generation);
          break;

        case Transports.WebSocket.Messages.RegisterSender.type:
          pruneClosedSenders();
          if (!senders.includes(ws)) {
            senders.push(ws);
          }
          log(`It's a sender!`, {
            socketId: getSocketId(ws),
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
  log('Sending panel list', { socketId: getSocketId(ws), panels: Object.keys(netPanels) });
  const message = new Transports.WebSocket.Messages.PanelList(
    Object.keys(netPanels)
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

function resetReceiverState() {
  log('Resetting receiver state', {
    panelCount: Object.keys(netPanels).length,
    subscriberPanels: Object.keys(panelSubscribers),
    seqCount: seqByPanelPath.size,
  });
  netPanels = {};
  seqByPanelPath.clear();
}

function handleReceiverMessage(_ws: WebSocket, message: string) {
  try {
    const parsed = JSON.parse(message);
    switch (parsed.type) {
      case Transports.WebSocket.Messages.AddNetPanel.type:
        const msg = parsed as Transports.WebSocket.Messages.AddNetPanel
        netPanels[msg.id] = {
          spec: msg.rootSpecification,
          currentState: msg.rootSpecification.currentState, // cache mutable state
        };

        log(`NetPanel ${msg.id} added`, {
          receiverSocketId: receiver ? getSocketId(receiver) : null,
          subscriberCount: getSubscriberSocketIds(msg.id).length,
          subscriberSocketIds: getSubscriberSocketIds(msg.id),
        });
        broadcastPanelList();
        break;

      case Transports.WebSocket.Messages.WrappedMessage.type:
        // forward the message to all subscribers of the panel
        const panelId = parsed.panelId;
        const avMessage = parsed.message;
        if (avMessage?.type === 'control-update') {
          const path = extractUpdatePath(avMessage.update);
          const key = makeSeqKey(panelId, path);
          let seq: number;
          if (typeof avMessage.seq === 'number') {
            seq = avMessage.seq;
          } else {
            seq = (seqByPanelPath.get(key) ?? 0) + 1;
          }
          seqByPanelPath.set(key, seq);
          avMessage.seq = seq;

          // Patch cached currentState
          const panel = netPanels[panelId];
          if (panel) {
            patchStateAtPath(panel.currentState, path, avMessage.update);
          }
        }
        pruneClosedSubscribers(panelId);
        const listeners = panelSubscribers[panelId] || new Set<WebSocket>();
        const updatePath = avMessage?.type === 'control-update'
          ? extractUpdatePath(avMessage.update)
          : [];
        verbose('Forwarding receiver message to subscribers', {
          panelId,
          type: avMessage?.type,
          path: avMessage?.type === 'control-update' ? updatePath.join('.') : undefined,
          subscriberCount: listeners.size,
          subscriberSocketIds: getSubscriberSocketIds(panelId),
          receiverSocketId: receiver ? getSocketId(receiver) : null,
        });
        const payload = JSON.stringify(parsed);
        listeners.forEach((subscriber) => subscriber.send(payload));
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
          warn(`Panel ${msg.panelId} is not available`);
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

        // Send spec with current (cached) state
        const panel = netPanels[msg.panelId];
        if (panel) {
          const rootSpec = new RootSpecification(
            panel.spec.name,
            panel.spec.rootControlSpec,
            panel.currentState  // Send cached/patched currentState
          );
          const wrappedRootSpec = new Transports.WebSocket.Messages.WrappedMessage(msg.panelId, rootSpec);
          ws.send(JSON.stringify(wrappedRootSpec));
        }
        break;
    
      case Transports.WebSocket.Messages.WrappedMessage.type:
        // just forward the message to the single receiver
        if (receiver) {
          const avMessage = parsed.message;
          if (avMessage?.type === 'control-signal') {
            const path = extractSignalPath(avMessage.signal);
            const key = makeSeqKey(parsed.panelId, path);
            const seq = (seqByPanelPath.get(key) ?? 0) + 1;
            seqByPanelPath.set(key, seq);
            avMessage.seq = seq;
            verbose('Forwarding control signal to receiver', {
              senderSocketId: getSocketId(ws),
              receiverSocketId: getSocketId(receiver),
              panelId: parsed.panelId,
              path: path.join('.'),
              seq,
              origin: avMessage.origin,
            });
          } else {
            verbose('Forwarding sender message to receiver', {
              senderSocketId: getSocketId(ws),
              receiverSocketId: getSocketId(receiver),
              panelId: parsed.panelId,
              type: avMessage?.type,
            });
          }
          receiver.send(JSON.stringify(parsed));
        } else {
          warn('No receiver available, control signal dropped');
        }
        break;
    }
  } catch (error) {
    errorLog('Error in sender message handling', error);
  }
}

function handleReceiverDisconnect(ws: WebSocket, generation: number) {
  if (receiver !== ws || receiverGeneration !== generation) {
    log('Ignoring stale receiver disconnect', {
      socketId: getSocketId(ws),
      generation,
      activeGeneration: receiverGeneration,
      activeReceiverSocketId: receiver ? getSocketId(receiver) : null,
    });
    return;
  }
  log('️Receiver disconnected', { socketId: getSocketId(ws), generation });
  receiver = null;
  resetReceiverState();
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

function extractSignalPath(signal: any): string[] {
  const path: string[] = [];
  let current = signal;
  while (current && typeof current === 'object' && 'controlId' in current && 'signal' in current) {
    path.push(current.controlId);
    current = current.signal;
  }
  return path;
}

function extractUpdatePath(update: any): string[] {
  const path: string[] = [];
  let current = update;
  while (current && typeof current === 'object' && 'controlId' in current && 'update' in current) {
    path.push(current.controlId);
    current = current.update;
  }
  return path;
}

function makeSeqKey(panelId: string, path: string[]) {
  return `${panelId}:${path.join('.')}`;
}

/**
 * Patch currentState at the given path with values from update
 * For groups, update.update is the child update, recurse down
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
