import { Sender as BaseSender } from './base';
import { CommunicationError, Logger } from '../error';

import * as AvControlsMessages from '../messages';
import { Base } from '../controls';
import { StatePersistence } from '../persistence';
import type { PersistenceOptions } from '../persistence';
import { PROTOCOL_VERSION, isEnvelope, wrap } from './envelope';

/**
 * Main receiver class for handling control communication
 */
export class Receiver {
  private persistence: StatePersistence | null = null
  public ready: Promise<void>
  private boundHandlePostMessage: (event: MessageEvent) => void
  private stateInitialized = false
  private pendingUpdateTree: AvControlsMessages.ControlUpdateTree | null = null
  /** Protocol version announced by the controller in its hello, if any. */
  public controllerVersion: string | null = null

  constructor(
    private otherWindow: Window,
    private name: string,
    private rootReceiver: Base.Receiver,
    persistenceOptions?: PersistenceOptions,
  ) {
    this.boundHandlePostMessage = this.handlePostMessage.bind(this);
    window.addEventListener('message', this.boundHandlePostMessage);

    // Initialize with or without persistence
    if (persistenceOptions && persistenceOptions.enabled !== false) {
      this.persistence = new StatePersistence(persistenceOptions)
      this.ready = this.initWithPersistence()
    } else {
      this.initWithoutPersistence()
      this.ready = Promise.resolve()
    }

    // Announce ourselves. The controller answers with a ControllerHello (see
    // respondToHello), which then drives the spec. Because each side starts
    // listening at its own construction and beacons at construction, at most
    // one of the two beacons can be lost — so the handshake never deadlocks.
    this.send(new AvControlsMessages.ArtworkHello(PROTOCOL_VERSION, this.name))
  }

  private async initWithPersistence(): Promise<void> {
    try {
      await this.persistence!.init()
      const storedState = await this.persistence!.loadState()
      this.persistence!.applyStoredState(this.rootReceiver, storedState)
      this.stateInitialized = storedState.size > 0
    } catch (e) {
      Logger.warn('Failed to load persisted state', { error: e })
    }

    // Spec is no longer pushed on construction — it is sent in response to the
    // controller's hello (see respondToHello), which removes the attach race.

    // Hook onUpdate for persistence
    this.rootReceiver.onUpdate = (update: Base.Update) => this.handleRootUpdate(update)
  }

  private initWithoutPersistence(): void {
    this.rootReceiver.onUpdate = (update: Base.Update) => this.handleRootUpdate(update)
  }

  private handleRootUpdate(update: Base.Update): void {
    this.stateInitialized = true
    const origin = Base.Receiver.currentUpdateOrigin() ?? { kind: 'artwork' as const }
    const updateTree = AvControlsMessages.updateToTree(update)
    if (this.pendingUpdateTree) {
      AvControlsMessages.mergeUpdateTree(this.pendingUpdateTree, updateTree)
    } else {
      this.send(new AvControlsMessages.ControlUpdate(updateTree, origin))
    }
    this.persistence?.handleUpdate(update)
  }

  private dispatchSignal(signalMessage: AvControlsMessages.ControlSignal): void {
    const previousTree = this.pendingUpdateTree
    const updateTree: AvControlsMessages.ControlUpdateTree = {}
    this.pendingUpdateTree = updateTree
    try {
      Base.Receiver.withUpdateOrigin(signalMessage.origin ?? { kind: 'controller' }, () => {
        AvControlsMessages.dispatchSignalTreeToReceiver(this.rootReceiver, signalMessage.signal)
      })
    } finally {
      this.pendingUpdateTree = previousTree
    }

    if (updateTree.update !== undefined || updateTree.children !== undefined) {
      this.send(new AvControlsMessages.ControlUpdate(
        updateTree,
        signalMessage.origin ?? { kind: 'controller' },
      ))
    }
  }

  private handlePostMessage(event: MessageEvent): void {
    if (!isEnvelope(event.data)) {
      return
    }
    const message = event.data.message
    if (message.type === AvControlsMessages.ControllerHello.type) {
      this.controllerVersion = (message as AvControlsMessages.ControllerHello).version
      void this.respondToHello()
      return
    }
    if(message.type === AvControlsMessages.ControlSignal.type) {
      this.dispatchSignal(message as AvControlsMessages.ControlSignal)
    }
    if(message.type === AvControlsMessages.ControlStateRestore.type && !this.stateInitialized) {
      const restoreMessage = message as AvControlsMessages.ControlStateRestore
      Base.Receiver.withUpdateOrigin(restoreMessage.origin, () => {
        this.rootReceiver.restoreState(restoreMessage.state)
      })
      this.stateInitialized = true
      this.persistence?.persistReceiverState(this.rootReceiver)
      this.sendRootSpecification()
    }
  }

  send(message: AvControlsMessages.Message): void {
    try {
      this.otherWindow.postMessage(wrap(message), '*');
    } catch (error) {
      Logger.error('Failed to send message', { error, message });
      throw new CommunicationError(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    window.removeEventListener('message', this.boundHandlePostMessage)
  }

  /**
   * Reply to the controller's hello with the spec (only) once any persisted
   * state has finished loading. We intentionally do NOT re-emit an ArtworkHello
   * here: the controller bridges on our construction-time beacon, and replying
   * with a hello would ping-pong forever.
   */
  private async respondToHello(): Promise<void> {
    await this.ready
    this.sendRootSpecification()
  }

  private sendRootSpecification() {
    const currentState = this.rootReceiver.getState()
    this.send(new AvControlsMessages.RootSpecification(
      this.name,
      this.rootReceiver.spec,
      currentState ?? new Base.State(),
      this.stateInitialized,
    ))
  }
}

export class Sender extends BaseSender {
  constructor(
    private tab: Window
  ) {
    super();
    this.handlePostMessage = this.handlePostMessage.bind(this);
    window.addEventListener('message', this.handlePostMessage)
  }

  destroy() {
    window.removeEventListener('message', this.handlePostMessage)
  }

  send(message: AvControlsMessages.Message): void {
    this.tab.postMessage(wrap(message), '*');
  }

  handlePostMessage(event: MessageEvent) {
    if(event.source === this.tab && isEnvelope(event.data)) {
      this.peerVersion = event.data.protocol
      this.broadcastAvMessage(event.data.message)
    }
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
}
