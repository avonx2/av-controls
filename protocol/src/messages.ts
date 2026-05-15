import { Base } from './controls';
import packageJson from '../package.json'; 

// Base interface for all messages
export interface Message {
  type: string;
  protocol?: string;
  serverSeq?: number;
}

export type UpdateOrigin =
  | { kind: 'controller'; clientId?: string }
  | { kind: 'timeline'; clientId?: string }
  | { kind: 'artwork' };

export class RootSpecification implements Message {
  static type = 'controller-specification' as const;
  type = RootSpecification.type;
  version = packageJson.version;

  constructor(
    public name: string,
    public rootControlSpec: Base.Spec,
    public currentState: Base.State,
    public stateInitialized = false,
  ) {}
}

// signals go from the controller to the visuals
export class ControlSignal implements Message {
  static type = 'control-signal' as const;
  type = ControlSignal.type;

  constructor(
    public signal: ControlSignalTree,
    public seq?: number,
    public origin?: UpdateOrigin,
    public serverSeq?: number,
  ) {}
}

export type ControlSignalTree = {
  signal?: Base.Signal;
  children?: Record<string, ControlSignalTree>;
};

export class ControlStateRestore implements Message {
  static type = 'control-state-restore' as const;
  type = ControlStateRestore.type;

  constructor(
    public state: Base.State,
    public origin: UpdateOrigin = { kind: 'controller' },
  ) {}
}

// updates go from the visuals to the controller
export class ControlUpdate implements Message {
  static type = 'control-update' as const;
  type = ControlUpdate.type;

  constructor(
    public update: ControlUpdateTree,
    public origin: UpdateOrigin = { kind: 'artwork' },
    public seq?: number,
    public serverSeq?: number,
  ) {}
}

export type ControlUpdateTree = {
  update?: Base.Update;
  children?: Record<string, ControlUpdateTree>;
};

export function signalToTree(signal: Base.Signal): ControlSignalTree {
  const path: string[] = [];
  let current: any = signal;
  while (current && typeof current === 'object' && 'controlId' in current && 'signal' in current) {
    path.push(String(current.controlId));
    current = current.signal;
  }
  return setTreeSignal(path, current as Base.Signal);
}

export function updateToTree(update: Base.Update): ControlUpdateTree {
  const path: string[] = [];
  let current: any = update;
  while (current && typeof current === 'object' && 'controlId' in current && 'update' in current) {
    path.push(String(current.controlId));
    current = current.update;
  }
  return setTreeUpdate(path, current as Base.Update);
}

export function setTreeSignal(path: string[], signal: Base.Signal): ControlSignalTree {
  const root: ControlSignalTree = {};
  let node = root;
  for (const controlId of path) {
    node.children = node.children ?? {};
    node.children[controlId] = node.children[controlId] ?? {};
    node = node.children[controlId]!;
  }
  node.signal = signal;
  return root;
}

export function setTreeUpdate(path: string[], update: Base.Update): ControlUpdateTree {
  const root: ControlUpdateTree = {};
  let node = root;
  for (const controlId of path) {
    node.children = node.children ?? {};
    node.children[controlId] = node.children[controlId] ?? {};
    node = node.children[controlId]!;
  }
  node.update = update;
  return root;
}

export function mergeSignalTree(target: ControlSignalTree, source: ControlSignalTree): ControlSignalTree {
  if (source.signal !== undefined) {
    target.signal = source.signal;
  }
  if (source.children) {
    target.children = target.children ?? {};
    for (const controlId in source.children) {
      target.children[controlId] = mergeSignalTree(
        target.children[controlId] ?? {},
        source.children[controlId]!,
      );
    }
  }
  return target;
}

export function mergeUpdateTree(target: ControlUpdateTree, source: ControlUpdateTree): ControlUpdateTree {
  if (source.update !== undefined) {
    target.update = source.update;
  }
  if (source.children) {
    target.children = target.children ?? {};
    for (const controlId in source.children) {
      target.children[controlId] = mergeUpdateTree(
        target.children[controlId] ?? {},
        source.children[controlId]!,
      );
    }
  }
  return target;
}

export function dispatchSignalTreeToReceiver(receiver: Base.Receiver, tree: ControlSignalTree): void {
  if (tree.signal !== undefined) {
    receiver.handleSignal(tree.signal);
  }
  const controls = receiverControls(receiver);
  if (!controls || !tree.children) {
    return;
  }
  for (const controlId in tree.children) {
    const child = controls[controlId];
    if (child) {
      dispatchSignalTreeToReceiver(child, tree.children[controlId]!);
    }
  }
}

export function dispatchUpdateTreeToSender(sender: Base.Sender, tree: ControlUpdateTree): void {
  if (tree.update !== undefined) {
    sender.handleUpdate(tree.update);
  }
  const senders = senderChildren(sender);
  if (!senders || !tree.children) {
    return;
  }
  for (const controlId in tree.children) {
    const child = senders[controlId];
    if (child) {
      dispatchUpdateTreeToSender(child, tree.children[controlId]!);
    }
  }
}

export function walkUpdateTree(
  tree: ControlUpdateTree,
  visit: (path: string[], update: Base.Update) => void,
  path: string[] = [],
): void {
  if (tree.update !== undefined) {
    visit(path, tree.update);
  }
  if (!tree.children) {
    return;
  }
  for (const controlId in tree.children) {
    walkUpdateTree(tree.children[controlId]!, visit, [...path, controlId]);
  }
}

export function walkSignalTree(
  tree: ControlSignalTree,
  visit: (path: string[], signal: Base.Signal) => void,
  path: string[] = [],
): void {
  if (tree.signal !== undefined) {
    visit(path, tree.signal);
  }
  if (!tree.children) {
    return;
  }
  for (const controlId in tree.children) {
    walkSignalTree(tree.children[controlId]!, visit, [...path, controlId]);
  }
}

function receiverControls(receiver: Base.Receiver): Record<string, Base.Receiver | undefined> | null {
  return 'controls' in receiver && receiver.controls && typeof receiver.controls === 'object'
    ? receiver.controls as Record<string, Base.Receiver | undefined>
    : null;
}

function senderChildren(sender: Base.Sender): Record<string, Base.Sender | undefined> | null {
  return 'senders' in sender && sender.senders && typeof sender.senders === 'object'
    ? sender.senders as Record<string, Base.Sender | undefined>
    : null;
}

export type ArtworkMode = 'artwork-live' | 'timeline-live' | 'timeline-render' | 'paused';
export type LegacyArtworkMode = 'live' | 'playing';
export type ArtworkModeCommand = ArtworkMode | LegacyArtworkMode;

export type ArtworkRuntimeCommand =
  | { type: 'set-artwork-mode'; mode: ArtworkModeCommand }
  | { type: 'set-artwork-time'; time: number }
  | { type: 'reset-render-state' }
  | { type: 'configure-image-capture'; workerCount: number }
  | { type: 'start-video-capture'; downloadName: string; fps: number; codec: 'avc' | 'hevc'; quality: number }
  | { type: 'finalize-video-capture' }
  | { type: 'cancel-video-capture' }
  | { type: 'flush-image-capture' }
  | { type: 'cancel-image-capture' }
  | { type: 'render-artwork'; time: number; capture?: { downloadName?: string } }
  | { type: 'probe-render-latency'; probeId: string };

export class ArtworkRuntimeCommandMessage implements Message {
  static type = 'artwork-runtime-command' as const;
  type = ArtworkRuntimeCommandMessage.type;

  constructor(
    public command: ArtworkRuntimeCommand,
  ) {}
}

export class ArtworkRuntimeStatusMessage implements Message {
  static type = 'artwork-runtime-status' as const;
  type = ArtworkRuntimeStatusMessage.type;

  constructor(
    public mode: ArtworkMode,
    public time: number,
  ) {}
}

export class ArtworkRenderAckMessage implements Message {
  static type = 'artwork-render-ack' as const;
  type = ArtworkRenderAckMessage.type;

  constructor(
    public time: number,
    public captured: boolean,
    public ok: boolean,
    public error?: string,
    public probeId?: string,
  ) {}
}

export class ArtworkCaptureAckMessage implements Message {
  static type = 'artwork-capture-ack' as const;
  type = ArtworkCaptureAckMessage.type;

  constructor(
    public action: 'start-video' | 'finalize-video' | 'cancel-video' | 'flush-images' | 'cancel-images',
    public ok: boolean,
    public error?: string,
  ) {}
}
