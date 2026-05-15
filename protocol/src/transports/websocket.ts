/**
 * WebSocket communication adapter for AV Controls
 */

import { Sender as BaseSender } from './base';

import { CommunicationError, Logger } from '../error';
import { Messages as AvControlsMessages } from '..';

import { Base } from '../controls'
import { StatePersistence } from '../persistence'
import type { PersistenceOptions } from '../persistence'

const websocketConnectionLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('ws-log') === '1';
const websocketSignalLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('timeline-signal-log') === '1';

let nextWebSocketClientId = 1;

// Create a namespace to group the messages
export namespace Messages {
  export interface Message {
    type: string;
  }

  // ws messages
  export class RegisterReceiver implements Message {
    static type = 'register-receiver' as const;
    type = RegisterReceiver.type;

    constructor() {}
  }

  export class RegisterSender implements Message {
    static type = 'register-sender' as const;
    type = RegisterSender.type;
    clientId?: string;

    constructor(clientId?: string) {
      this.clientId = clientId;
    }
  }

  export class AddNetPanel implements Message {
    static type = 'add-net-panel' as const;
    type = AddNetPanel.type;

    constructor(
      public id: string,
      public rootSpecification: AvControlsMessages.RootSpecification
    ) {}
  }

  export class WrappedMessage implements Message {
    static type = 'wrapped-message' as const;
    type = WrappedMessage.type;

    constructor(
      public panelId: string, 
      public message: AvControlsMessages.Message,
    ) {}
  }

  export class PanelList implements Message {
    static type = 'panel-list' as const;
    type = PanelList.type;

    constructor(
      public panelIds: string[],
      public onlinePanelIds: string[] = panelIds,
    ) {}
  }

  export class ChoosePanel implements Message {
    static type = 'choose-panel' as const;
    type = ChoosePanel.type;

    constructor(
      public panelId: string
    ) {}
  }
}

function logWsConnection(role: 'sender' | 'receiver', event: string, data?: Record<string, unknown>) {
  if (!websocketConnectionLog) {
    return;
  }
  const relativeTimestamp = typeof performance !== 'undefined'
    ? performance.now().toFixed(1)
    : Date.now().toString();
  const isoTimestamp = new Date().toISOString();
  console.info(`[${isoTimestamp}] [ws:${role}] ${event} @${relativeTimestamp}ms`, data ?? {});
}

function logWsSignal(role: 'sender' | 'receiver', event: string, data?: Record<string, unknown>) {
  if (!websocketSignalLog) {
    return;
  }
  const relativeTimestamp = typeof performance !== 'undefined'
    ? performance.now().toFixed(1)
    : Date.now().toString();
  const isoTimestamp = new Date().toISOString();
  console.info(`[${isoTimestamp}] [ws:${role}:signal] ${event} @${relativeTimestamp}ms`, data ?? {});
}

function logIgnoredUpdateOnlySignal(role: 'sender' | 'receiver') {
  if (!websocketSignalLog) {
    return;
  }
  console.info(`[ws:${role}:signal] update-only control received`);
}

function shouldIgnoreSignalLogMessage(message: AvControlsMessages.Message): boolean {
  if (message.type !== AvControlsMessages.ControlUpdate.type) {
    return false;
  }
  const updateMessage = message as AvControlsMessages.ControlUpdate;
  const paths: string[][] = [];
  AvControlsMessages.walkUpdateTree(updateMessage.update, (path) => {
    paths.push(path);
  });
  return paths.length > 0 && paths.every((path) => {
    const leafId = path[path.length - 1];
    return leafId === 'audioMeter' || leafId === 'phaseCake' || leafId === 'lamp';
  });
}

/**
 * Options for the WebSocket adapter
 */
export interface WebSocketAdapterOptions {
  /**
   * Auto reconnect on disconnection
   */
  autoReconnect?: boolean;
  
  /**
   * Time in milliseconds between reconnection attempts
   */
  reconnectInterval?: number;
  
  /**
   * Maximum number of reconnection attempts
   */
  maxReconnectAttempts?: number;
}

export interface WebSocketSenderOptions extends WebSocketAdapterOptions {
  /**
   * Observe the latest available panel ids announced by the broker.
   */
  onPanelList?: (panelIds: string[]) => void;
}

type ArtworkRuntimeHandler = {
  handleMessage(message: AvControlsMessages.ArtworkRuntimeCommandMessage): void
}

type SingleReceiverPersistenceOptions = Omit<PersistenceOptions, 'artworkId'> & {
  artworkId?: string
}

export interface ReceiverSession {
  /**
   * Stable artwork/session id used for broker routing, root specification naming,
   * and default persistence keys.
   */
  id: string
  receiver: Base.Receiver
  handleMessage?: (message: AvControlsMessages.ArtworkRuntimeCommandMessage) => void
  persistence?: SingleReceiverPersistenceOptions
}

function isReceiverSession(value: ReceiverSession | {[id: string]: Base.Receiver}): value is ReceiverSession {
  return 'id' in value && 'receiver' in value
}

/**
 * WebSocket-based communication adapter
 */
abstract class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: any = null;
  private isConnecting = false;
  private readonly clientId = nextWebSocketClientId++;
  
  private options: WebSocketAdapterOptions = {
    autoReconnect: true,
    reconnectInterval: 3000,
    maxReconnectAttempts: 10,
  };
  
  /**
   * Create a new WebSocket adapter
   */
  constructor(
    private url: string,
    options?: WebSocketAdapterOptions
  ) {
    // Apply defaults
    Object.assign(this.options, options)
  }
  
  public initialize() {
    return this.connect();
  }

  protected getClientId() {
    return this.clientId;
  }

  protected getLogPageContext() {
    if (typeof window === 'undefined') {
      return undefined;
    }
    return `${window.location.pathname}${window.location.search}`;
  }

  protected abstract connectionRole(): 'sender' | 'receiver';
  abstract onConnectionOpened(): void;

  abstract handleWsMessage(message: Messages.Message): void;
  
  /**
   * Connect to the WebSocket server
   */
  private async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }
    
    this.isConnecting = true;
    logWsConnection(this.connectionRole(), 'connect-attempt', {
      clientId: this.clientId,
      page: this.getLogPageContext(),
      url: this.url,
      reconnectAttempts: this.reconnectAttempts,
      readyState: this.ws?.readyState ?? null,
    });
    
    return new Promise<void>((resolve, reject) => {
      try {
        if (Logger && typeof Logger.debug === 'function') {
          Logger.debug('WebSocket create', { url: this.url });
        }
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
          if (Logger && typeof Logger.debug === 'function') {
            Logger.debug('WebSocket open', { url: this.url });
          }
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          Logger.info('WebSocket connected', { url: this.url });
          logWsConnection(this.connectionRole(), 'socket-open', {
            clientId: this.clientId,
            page: this.getLogPageContext(),
            url: this.url,
          });

          // Send 
          this.onConnectionOpened()
          
          resolve();
        };
        
        this.ws.onclose = (event) => {
          if (Logger && typeof Logger.debug === 'function') {
            Logger.debug('WebSocket close', { url: this.url, code: event.code, reason: event.reason });
          }
          Logger.warn('WebSocket closed', { code: event.code, reason: event.reason });
          logWsConnection(this.connectionRole(), 'socket-close', {
            clientId: this.clientId,
            page: this.getLogPageContext(),
            url: this.url,
            code: event.code,
            reason: event.reason,
            willReconnect: Boolean(this.options.autoReconnect && this.reconnectAttempts < (this.options.maxReconnectAttempts || 10)),
          });
          this.isConnecting = false;
          
          if (this.options.autoReconnect && this.reconnectAttempts < (this.options.maxReconnectAttempts || 10)) {
            this.scheduleReconnect();
          }
        };
        
        this.ws.onerror = (error) => {
          if (Logger && typeof Logger.debug === 'function') {
            Logger.debug('WebSocket error', { url: this.url, error });
          }
          Logger.error('WebSocket error', { error });
          logWsConnection(this.connectionRole(), 'socket-error', {
            clientId: this.clientId,
            page: this.getLogPageContext(),
            url: this.url,
            error,
          });
          this.isConnecting = false;
          
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            reject(new CommunicationError('WebSocket connection failed'));
          }
        };
        
        this.ws.onmessage = (event) => {
          if (Logger && typeof Logger.debug === 'function') {
            Logger.debug('WebSocket message', { preview: typeof event.data === 'string' ? event.data.slice(0, 200) : event.data });
          }
          try{
            const deserialized = JSON.parse(event.data as string);
            this.handleWsMessage(deserialized as Messages.Message);
          } catch (error) {
            Logger.error('Error processing WebSocket message', { error, data: event.data });
          }
        };
      } catch (error) {
        this.isConnecting = false;
        Logger.error('Error creating WebSocket', { error, url: this.url });
        reject(new CommunicationError(`Failed to create WebSocket: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }
  
  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      Logger.info('Attempting to reconnect WebSocket', { 
        attempt: this.reconnectAttempts, 
        maxAttempts: this.options.maxReconnectAttempts 
      });
      logWsConnection(this.connectionRole(), 'reconnect-scheduled', {
        clientId: this.clientId,
        page: this.getLogPageContext(),
        url: this.url,
        attempt: this.reconnectAttempts,
        maxAttempts: this.options.maxReconnectAttempts,
        delayMs: this.options.reconnectInterval,
      });
      
      this.connect().catch(() => {
        // Error is already logged in connect
      });
    }, this.options.reconnectInterval);
  }
  

  sendWsMessage(message: Messages.Message): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      const serialized = JSON.stringify(message)
      this.ws.send(serialized);
    } catch (error) {
      Logger.error('Error sending WebSocket message', { error, message });
      throw new CommunicationError(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected getSocketBufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  protected isSocketOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    if (this.ws) {
      // Prevent reconnect on intentional close
      this.options.autoReconnect = false;
      
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        logWsConnection(this.connectionRole(), 'dispose-close', {
          clientId: this.clientId,
          page: this.getLogPageContext(),
          url: this.url,
          readyState: this.ws.readyState,
        });
        this.ws.close();
      }

      logWsConnection(this.connectionRole(), 'disposed', {
        clientId: this.clientId,
        page: this.getLogPageContext(),
        url: this.url,
      });
      
      this.ws = null;
    }
  }
}

export class Receiver extends WebSocketClient {
  private persistenceByPanel = new Map<string, StatePersistence>()
  private stateInitializedByPanel = new Map<string, boolean>()
  private pendingUpdateTreeByPanel = new Map<string, AvControlsMessages.ControlUpdateTree>()
  private rootReceivers: {[id: string]: Base.Receiver}
  private artworkRuntimeHandlers?: {[id: string]: ArtworkRuntimeHandler}
  private persistenceOptions?: {[id: string]: PersistenceOptions}
  public ready: Promise<void>

  constructor(
    session: ReceiverSession,
    url: string,
    options?: WebSocketAdapterOptions,
  )
  constructor(
    rootReceivers: {[id: string]: Base.Receiver},
    url: string,
    options?: WebSocketAdapterOptions,
    artworkRuntimeHandlers?: {[id: string]: ArtworkRuntimeHandler},
    persistenceOptions?: {[id: string]: PersistenceOptions},
  )
  constructor(
    sessionOrRootReceivers: ReceiverSession | {[id: string]: Base.Receiver},
    url: string,
    options?: WebSocketAdapterOptions,
    artworkRuntimeHandlers?: {[id: string]: ArtworkRuntimeHandler},
    persistenceOptions?: {[id: string]: PersistenceOptions},
  ) {
    super(url, options)

    if (isReceiverSession(sessionOrRootReceivers)) {
      const session = sessionOrRootReceivers
      this.rootReceivers = { [session.id]: session.receiver }
      this.artworkRuntimeHandlers = session.handleMessage
        ? { [session.id]: { handleMessage: session.handleMessage } }
        : undefined
      this.persistenceOptions = session.persistence
        ? { [session.id]: { ...session.persistence, artworkId: session.persistence.artworkId ?? session.id } }
        : undefined
    } else {
      this.rootReceivers = sessionOrRootReceivers
      this.artworkRuntimeHandlers = artworkRuntimeHandlers
      this.persistenceOptions = persistenceOptions
    }

    // Initialize persistence for each panel before connecting
    if (this.persistenceOptions) {
      this.ready = this.initPersistence().then(() => {
        this.initialize()
      })
    } else {
      this.ready = Promise.resolve()
      this.initialize()
    }
  }

  private async initPersistence(): Promise<void> {
    for (const id in this.persistenceOptions) {
      const opts = this.persistenceOptions[id]
      if (opts && opts.enabled !== false) {
        const persistence = new StatePersistence(opts)
        this.persistenceByPanel.set(id, persistence)

        try {
          await persistence.init()
          const storedState = await persistence.loadState()
          const receiver = this.rootReceivers[id]
          if (receiver) {
            persistence.applyStoredState(receiver, storedState)
            this.stateInitializedByPanel.set(id, storedState.size > 0)
          }
        } catch (e) {
          Logger.warn('Failed to load persisted state for panel', { panelId: id, error: e })
        }
      }
    }
  }

  protected connectionRole(): 'receiver' {
    return 'receiver'
  }

  onConnectionOpened(): void {
    logWsConnection('receiver', 'register-receiver', {
      clientId: this.getClientId(),
      panelIds: Object.keys(this.rootReceivers),
    })
    this.sendWsMessage(new Messages.RegisterReceiver());
    for(const id in this.rootReceivers) {
      const rootReceiver = this.rootReceivers[id]!
      const persistence = this.persistenceByPanel.get(id)

      logWsConnection('receiver', 'announce-panel', {
        clientId: this.getClientId(),
        panelId: id,
        hasPersistence: Boolean(persistence),
      })
      this.sendWsMessage(new Messages.AddNetPanel(id, this.makeRootSpecification(id, rootReceiver)));

      rootReceiver.onUpdate = (update: Base.Update) => {
        this.handleRootUpdate(id, update, persistence)
      }
    }
  }

  private handleRootUpdate(id: string, update: Base.Update, persistence?: StatePersistence): void {
    this.stateInitializedByPanel.set(id, true)
    const origin = Base.Receiver.currentUpdateOrigin() ?? { kind: 'artwork' as const }
    const updateTree = AvControlsMessages.updateToTree(update)
    const pendingTree = this.pendingUpdateTreeByPanel.get(id)
    if (pendingTree) {
      AvControlsMessages.mergeUpdateTree(pendingTree, updateTree)
    } else {
      this.sendWsMessage(new Messages.WrappedMessage(id, new AvControlsMessages.ControlUpdate(updateTree, origin)))
    }
    persistence?.handleUpdate(update)
  }

  private dispatchSignal(panelId: string, receiver: Base.Receiver, signalMessage: AvControlsMessages.ControlSignal): void {
    const previousTree = this.pendingUpdateTreeByPanel.get(panelId)
    const updateTree: AvControlsMessages.ControlUpdateTree = {}
    this.pendingUpdateTreeByPanel.set(panelId, updateTree)
    try {
      Base.Receiver.withUpdateOrigin(signalMessage.origin ?? { kind: 'controller' }, () => {
        AvControlsMessages.dispatchSignalTreeToReceiver(receiver, signalMessage.signal)
      })
    } finally {
      if (previousTree) {
        this.pendingUpdateTreeByPanel.set(panelId, previousTree)
      } else {
        this.pendingUpdateTreeByPanel.delete(panelId)
      }
    }

    if (updateTree.update !== undefined || updateTree.children !== undefined) {
      this.sendWsMessage(new Messages.WrappedMessage(
        panelId,
        new AvControlsMessages.ControlUpdate(updateTree, signalMessage.origin ?? { kind: 'controller' }),
      ))
    }
  }

  handleWsMessage(msg: Messages.Message): void {
    switch(msg.type) {
      case Messages.WrappedMessage.type:
        const wsMessage = msg as Messages.WrappedMessage
        switch(wsMessage.message.type) {
          case AvControlsMessages.ControlSignal.type:
            const avMessage = wsMessage.message as AvControlsMessages.ControlSignal
            const receiver = this.rootReceivers[wsMessage.panelId]
            if (receiver) {
              this.dispatchSignal(wsMessage.panelId, receiver, avMessage)
            }
            break;
          case AvControlsMessages.ControlStateRestore.type:
            const restoreMessage = wsMessage.message as AvControlsMessages.ControlStateRestore
            const restoreReceiver = this.rootReceivers[wsMessage.panelId]
            if (restoreReceiver && !this.stateInitializedByPanel.get(wsMessage.panelId)) {
              Base.Receiver.withUpdateOrigin(restoreMessage.origin, () => {
                restoreReceiver.restoreState(restoreMessage.state)
              })
              this.stateInitializedByPanel.set(wsMessage.panelId, true)
              this.persistenceByPanel.get(wsMessage.panelId)?.persistReceiverState(restoreReceiver)
              this.sendWsMessage(new Messages.WrappedMessage(
                wsMessage.panelId,
                this.makeRootSpecification(wsMessage.panelId, restoreReceiver),
              ))
            }
            break;
          case AvControlsMessages.ArtworkRuntimeCommandMessage.type:
            this.artworkRuntimeHandlers?.[wsMessage.panelId]?.handleMessage(
              wsMessage.message as AvControlsMessages.ArtworkRuntimeCommandMessage,
            )
            break;
        }
        break;
    }
  }

  send(message: AvControlsMessages.Message, panelId?: string): void {
    const resolvedPanelId = panelId ?? this.resolveDefaultPanelId()
    if (!resolvedPanelId) {
      Logger.warn('Receiver send skipped: no panelId available for outgoing message', { message })
      return
    }
    this.sendWsMessage(new Messages.WrappedMessage(resolvedPanelId, message))
  }

  private resolveDefaultPanelId(): string | null {
    const panelIds = Object.keys(this.rootReceivers)
    if (panelIds.length === 1) {
      return panelIds[0] ?? null
    }
    return null
  }

  private makeRootSpecification(id: string, rootReceiver: Base.Receiver) {
    return new AvControlsMessages.RootSpecification(
      id,
      rootReceiver.spec,
      rootReceiver.getState(),
      this.stateInitializedByPanel.get(id) ?? false,
    )
  }
}

export class Sender extends WebSocketClient implements BaseSender {
  panelId: string | null = null
  private isPanelAttached = false
  private lastServerSeq = 0
  private protocolClientId: string | null = null

  constructor(
    url: string,
    private chooseNetPanel: (panelIdList: string[]) => Promise<string>, 
    private senderOptions?: WebSocketSenderOptions,
  ) {
    super(url, senderOptions)
    this.initialize()
  }

  protected connectionRole(): 'sender' {
    return 'sender'
  }

  onConnectionOpened(): void {
    this.isPanelAttached = false
    logWsConnection('sender', 'register-sender', {
      clientId: this.getClientId(),
      protocolClientId: this.protocolClientId,
      selectedPanelId: this.panelId,
    })
    this.sendWsMessage(new Messages.RegisterSender(this.protocolClientId ?? undefined));
  }

  setClientId(clientId: string): void {
    if (this.protocolClientId === clientId) {
      return
    }
    this.protocolClientId = clientId
    if (this.isSocketOpen()) {
      this.sendWsMessage(new Messages.RegisterSender(clientId))
      if (this.panelId) {
        this.isPanelAttached = false
        this.sendWsMessage(new Messages.ChoosePanel(this.panelId))
      }
    }
  }

  async handleWsMessage(message: Messages.Message): Promise<void> {
    switch(message.type) {
      case Messages.PanelList.type:
        await this.handlePanelList(message as Messages.PanelList)
        break;
      case Messages.WrappedMessage.type:
        const wrapped = message as Messages.WrappedMessage
        const avMessage = wrapped.message as AvControlsMessages.Message
        if (avMessage.type === AvControlsMessages.RootSpecification.type) {
          this.panelId = wrapped.panelId
          this.isPanelAttached = true
          this.lastServerSeq = typeof avMessage.serverSeq === 'number' ? avMessage.serverSeq : 0
          logWsConnection('sender', 'panel-attached', {
            clientId: this.getClientId(),
            panelId: this.panelId,
            specName: (avMessage as AvControlsMessages.RootSpecification).name,
            stateInitialized: (avMessage as AvControlsMessages.RootSpecification).stateInitialized,
            serverSeq: avMessage.serverSeq,
          })
        }
        if (avMessage.type === AvControlsMessages.ControlUpdate.type) {
          const updateMsg = avMessage as AvControlsMessages.ControlUpdate
          if (shouldIgnoreSignalLogMessage(updateMsg)) {
            logIgnoredUpdateOnlySignal('sender')
          } else {
            logWsSignal('sender', 'recv-control-update', {
              panelId: wrapped.panelId,
              origin: updateMsg.origin,
              seq: updateMsg.seq,
              update: updateMsg.update,
            })
          }
          if (typeof updateMsg.serverSeq === 'number') {
            if (updateMsg.serverSeq <= this.lastServerSeq) {
              return
            }
            this.lastServerSeq = updateMsg.serverSeq
          }
        }
        this.broadcastAvMessage(avMessage); 
    }
  }
  
  /**
   * Actual send implementation
   */
  send(message: AvControlsMessages.Message): void {
    if(this.panelId && this.isPanelAttached) {
      if (message.type === AvControlsMessages.ControlSignal.type) {
        const signalMessage = message as AvControlsMessages.ControlSignal
        logWsSignal('sender', 'send-control-signal', {
          panelId: this.panelId,
          origin: signalMessage.origin,
          seq: signalMessage.seq,
          signal: signalMessage.signal,
          bufferedAmount: this.getSocketBufferedAmount(),
        })
      }
      this.sendWsMessage(new Messages.WrappedMessage(this.panelId, message));
    } 
  }

  getBufferedAmount(): number {
    return this.getSocketBufferedAmount();
  }

  private listeners: ((message: AvControlsMessages.Message) => void)[] = []
  addListener(listener: (message: AvControlsMessages.Message) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index !== -1) {
        this.listeners.splice(index, 1)
      }
    }
  }

  private broadcastAvMessage(message: AvControlsMessages.Message): void {
    this.listeners.forEach(listener => listener(message))
  }

  private async handlePanelList(message: Messages.PanelList): Promise<void> {
    const panelIds = message.panelIds
    const onlinePanelIds = message.onlinePanelIds ?? panelIds
    this.senderOptions?.onPanelList?.([...panelIds])
    logWsConnection('sender', 'panel-list', {
      clientId: this.getClientId(),
      panelIds,
      onlinePanelIds,
      currentPanelId: this.panelId,
      isPanelAttached: this.isPanelAttached,
    })

    if (panelIds.length === 0) {
      this.isPanelAttached = false
      return
    }

    if (this.panelId && !onlinePanelIds.includes(this.panelId)) {
      this.isPanelAttached = false
    }

    if (this.panelId && panelIds.includes(this.panelId)) {
      if (!this.isPanelAttached) {
        logWsConnection('sender', 'reattach-panel', {
          clientId: this.getClientId(),
          panelId: this.panelId,
        })
        this.sendWsMessage(new Messages.ChoosePanel(this.panelId))
      }
      return
    }

    const nextPanelId = await this.chooseNetPanel(panelIds)
    if (!nextPanelId || !panelIds.includes(nextPanelId)) {
      Logger.warn('Ignoring invalid panel selection', { nextPanelId, panelIds })
      this.isPanelAttached = false
      logWsConnection('sender', 'invalid-panel-selection', {
        clientId: this.getClientId(),
        nextPanelId,
        panelIds,
      })
      return
    }

    this.panelId = nextPanelId
    this.isPanelAttached = false
    this.lastServerSeq = 0
    logWsConnection('sender', 'choose-panel', {
      clientId: this.getClientId(),
      panelId: this.panelId,
    })
    this.sendWsMessage(new Messages.ChoosePanel(this.panelId))
  }
}
