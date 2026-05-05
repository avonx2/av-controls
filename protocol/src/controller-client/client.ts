import {
  ArtworkCaptureAckMessage,
  ArtworkRenderAckMessage,
  ArtworkRuntimeStatusMessage,
  ControlSignal,
  ControlStateRestore,
  ControlUpdate,
  RootSpecification,
  type Message,
  type UpdateOrigin,
} from '../messages';
import { createSenderFromSpec } from '../common';
import type { Base } from '../controls';
import type { Sender as TransportSender } from '../transports/base';

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
};

export class ControllerClient {
  public readonly clientId: string;
  public onRootSpec: ((event: ControllerRootSpecEvent) => void) | null = null;
  public onControlUpdate: ((event: ControllerControlUpdateEvent) => void) | null = null;
  public onSignal: ((signal: Base.Signal) => void) | null = null;
  public onUnknownMessage: ((message: Message) => void) | null = null;
  public onError: ((error: unknown) => void) | null = null;

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
    this.removeListener = this.sender.addListener((message: Message) => {
      void this.handleMessage(message);
    });
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
      signal,
      this.nextSeq(),
      { kind: 'controller', clientId: this.clientId },
    ));
    this.onSignal?.(signal);
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
      this.options.onInitializedState?.(rootSpec.name, rootSender.getState());
    }

    if (generation !== this.generation) {
      return;
    }

    rootSender.onSignal = (signal: Base.Signal) => {
      this.sendSignal(signal);
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
    if (this.options.autoHandleUpdates ?? true) {
      this.rootSender?.handleUpdate(update.update);
    }
    this.onControlUpdate?.({
      update,
      rootSender: this.rootSender,
    });
  }

  private async handleMessage(message: Message) {
    if (message.type === RootSpecification.type) {
      await this.handleRootSpecification(message as RootSpecification);
      return;
    }
    if (message.type === ControlUpdate.type) {
      this.handleControlUpdate(message as ControlUpdate);
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
    this.onUnknownMessage = null;
    this.onError = null;
  }
}
