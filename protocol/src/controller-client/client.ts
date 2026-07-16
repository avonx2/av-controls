import {
  ArtworkCaptureAckMessage,
  ArtworkHello,
  ArtworkRenderAckMessage,
  ArtworkRuntimeStatusMessage,
  ControllerHello,
  ControlSignal,
  ControlStatePatch,
  ControlStateRestore,
  ControlUpdate,
  RootSpecification,
  dispatchStatePatchToSender,
  dispatchUpdateTreeToSender,
  signalToTree,
  type Message,
  type UpdateOrigin,
} from '../messages';
import { createSenderFromSpec } from '../common';
import type { Base } from '../controls';
import type { Sender as TransportSender } from '../transports/base';
import { PROTOCOL_VERSION, isCompatible } from '../transports/envelope';

export type ControllerRootSpecEvent = {
  name: string;
  rootSpec: RootSpecification;
  rootSender: Base.Sender;
  generation: number;
};

export type ControllerControlUpdateEvent = {
  update: ControlUpdate;
  rootSender: Base.Sender | null;
};

export type ControllerClientOptions = {
  clientId?: string;
  autoHandleUpdates?: boolean;
  createRootSender?: (spec: Base.Spec) => Base.Sender;
  wrapRootSender?: (sender: Base.Sender) => Base.Sender;
  loadInitialState?: (
    rootSpec: RootSpecification,
    rootSender: Base.Sender,
  ) => Base.State | null | undefined | Promise<Base.State | null | undefined>;
  onInitializedState?: (name: string, state: Base.State) => void;
  /**
   * Future multi-version seam: called with the artwork's protocol version as
   * soon as it is known (from its hello). Today this is informational; a future
   * host can use it to select/load a controller implementation matching a
   * breaking protocol version. Left unpopulated by default.
   */
  resolveProtocol?: (version: string) => void;
};

export class ControllerClient {
  public readonly clientId: string;
  public onRootSpec: ((event: ControllerRootSpecEvent) => void) | null = null;
  public onControlUpdate: ((event: ControllerControlUpdateEvent) => void) | null = null;
  public onSignal: ((signal: Base.Signal) => void) | null = null;
  public onStatePatch: ((state: Base.State) => void) | null = null;
  public onUnknownMessage: ((message: Message) => void) | null = null;
  public onError: ((error: unknown) => void) | null = null;
  /** Protocol version announced by the artwork, once known. */
  public peerVersion: string | null = null;

  private rootSpec: RootSpecification | null = null;
  private rootSender: Base.Sender | null = null;
  private controlledName = '';
  private generation = 0;
  private seqCounter = 0;
  private removeListener: (() => void) | null = null;
  private sender: TransportSender;
  private options: ControllerClientOptions;

  constructor(
    sender: TransportSender,
    options: ControllerClientOptions = {},
  ) {
    this.sender = sender;
    this.options = options;
    this.clientId = options.clientId ?? `controller-${Math.random().toString(36).slice(2, 10)}`;
    this.sender.setClientId?.(this.clientId);
    this.removeListener = this.sender.addListener((message: Message) => {
      void this.handleMessage(message);
    });
    // Announce ourselves so the artwork sends its hello + spec. Sent after the
    // listener is attached so we never miss the reply. On transports that gate
    // sends until a peer is attached (websocket), this is simply a no-op there.
    this.sender.send(new ControllerHello(PROTOCOL_VERSION, this.clientId));
  }

  /** The artwork's protocol version, if known (hello or transport envelope). */
  getPeerVersion(): string | null {
    return this.peerVersion ?? this.sender.peerVersion ?? null;
  }

  getRootSpec() {
    return this.rootSpec;
  }

  getRootSender() {
    return this.rootSender;
  }

  getControlledName() {
    return this.controlledName;
  }

  sendSignal(signal: Base.Signal) {
    this.sender.send(new ControlSignal(
      signalToTree(signal),
      this.nextSeq(),
      { kind: 'controller', clientId: this.clientId },
    ));
    this.onSignal?.(signal);
  }

  sendStatePatch(state: Base.State) {
    if (this.rootSender) {
      dispatchStatePatchToSender(this.rootSender, state);
    }
    this.sender.send(new ControlStatePatch(
      state,
      { kind: 'controller', clientId: this.clientId },
      this.nextSeq(),
    ));
    this.onStatePatch?.(state);
  }

  restoreState(
    state: Base.State,
    origin: UpdateOrigin = { kind: 'controller', clientId: this.clientId },
  ) {
    this.rootSender?.setState(state);
    this.sender.send(new ControlStateRestore(state, origin));
  }

  private nextSeq() {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  private async handleRootSpecification(rootSpec: RootSpecification) {
    const generation = ++this.generation;
    const createRootSender = this.options.createRootSender ?? createSenderFromSpec;
    const createdRootSender = createRootSender(rootSpec.rootControlSpec);
    const rootSender = this.options.wrapRootSender?.(createdRootSender) ?? createdRootSender;

    rootSender.setState(rootSpec.currentState);
    if (!rootSpec.stateInitialized && this.options.loadInitialState) {
      try {
        const storedState = await this.options.loadInitialState(rootSpec, rootSender);
        if (generation !== this.generation) {
          return;
        }
        if (storedState) {
          rootSender.setState(storedState);
          this.sender.send(new ControlStateRestore(
            storedState,
            { kind: 'controller', clientId: this.clientId },
          ));
        }
      } catch (error) {
        this.onError?.(error);
      }
    } else if (rootSpec.stateInitialized) {
      const state = rootSender.getState()
      if (state) {
        this.options.onInitializedState?.(rootSpec.name, state);
      }
    }

    if (generation !== this.generation) {
      return;
    }

    rootSender.onSignal = (signal: Base.Signal) => {
      this.sendSignal(signal);
    };
    rootSender.onStatePatch = (state: Base.State) => {
      this.sendStatePatch(state);
    };

    this.rootSpec = rootSpec;
    this.rootSender = rootSender;
    this.controlledName = rootSpec.name;
    this.onRootSpec?.({
      name: rootSpec.name,
      rootSpec,
      rootSender,
      generation,
    });
  }

  private handleControlUpdate(update: ControlUpdate) {
    const isOwnControllerEcho = update.origin.kind === 'controller'
      && update.origin.clientId === this.clientId;
    if ((this.options.autoHandleUpdates ?? true) && !isOwnControllerEcho) {
      if (this.rootSender) {
        dispatchUpdateTreeToSender(this.rootSender, update.update);
      }
    }
    this.onControlUpdate?.({
      update,
      rootSender: this.rootSender,
    });
  }

  private handleControlStatePatch(patch: ControlStatePatch) {
    const isOwnControllerEcho = patch.origin.kind === 'controller'
      && patch.origin.clientId === this.clientId;
    if ((this.options.autoHandleUpdates ?? true) && !isOwnControllerEcho) {
      if (this.rootSender) {
        dispatchStatePatchToSender(this.rootSender, patch.state);
      }
    }
    this.onStatePatch?.(patch.state);
  }

  private handleArtworkHello(hello: ArtworkHello) {
    this.peerVersion = hello.version;
    if (!isCompatible(hello.version)) {
      this.onError?.(new Error(
        `Incompatible artwork protocol version ${hello.version} (controller speaks ${PROTOCOL_VERSION})`,
      ));
    }
    this.options.resolveProtocol?.(hello.version);
    // Bridge: re-send our hello so the artwork emits its spec. This covers the
    // case where our construction-time hello was sent before the artwork was
    // listening. The artwork replies to ControllerHello with spec only, so this
    // does not ping-pong.
    this.sender.send(new ControllerHello(PROTOCOL_VERSION, this.clientId));
  }

  private async handleMessage(message: Message) {
    if (message.type === ArtworkHello.type) {
      this.handleArtworkHello(message as ArtworkHello);
      return;
    }
    if (message.type === RootSpecification.type) {
      await this.handleRootSpecification(message as RootSpecification);
      return;
    }
    if (message.type === ControlUpdate.type) {
      this.handleControlUpdate(message as ControlUpdate);
      return;
    }
    if (message.type === ControlStatePatch.type) {
      this.handleControlStatePatch(message as ControlStatePatch);
      return;
    }
    if (
      message.type === ArtworkRuntimeStatusMessage.type
      || message.type === ArtworkRenderAckMessage.type
      || message.type === ArtworkCaptureAckMessage.type
    ) {
      return;
    }
    this.onUnknownMessage?.(message);
  }

  dispose() {
    this.generation += 1;
    this.removeListener?.();
    this.removeListener = null;
    this.rootSpec = null;
    this.rootSender = null;
    this.controlledName = '';
    this.onRootSpec = null;
    this.onControlUpdate = null;
    this.onSignal = null;
    this.onStatePatch = null;
    this.onUnknownMessage = null;
    this.onError = null;
  }
}
