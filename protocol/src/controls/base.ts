import type { UpdateOrigin } from '../messages';

export type StateSnapshotMaskValue = 'YES' | 'NO' | 'SPARSE_YES'
export type StateSnapshotMask = Record<string, StateSnapshotMaskValue>
export type StateSnapshotMode = 'include' | 'exclude' | 'sparse'

export type StateSnapshotContext = {
  presetKey: string | null
  mode: StateSnapshotMode
}

export function makeStateSnapshotContext(presetKey?: string | null): StateSnapshotContext {
  const resolvedPresetKey = presetKey ?? null
  return {
    presetKey: resolvedPresetKey,
    mode: resolvedPresetKey === null ? 'include' : 'exclude',
  }
}

export function resolveStateSnapshotContext(
  spec: Spec,
  context?: StateSnapshotContext | string | null,
): StateSnapshotContext {
  const resolvedContext = typeof context === 'object' && context !== null && 'presetKey' in context
    ? context
    : makeStateSnapshotContext(context ?? null)

  if (resolvedContext.presetKey === null) {
    return {
      presetKey: null,
      mode: 'include',
    }
  }

  const entry = spec.stateSnapshotMask[resolvedContext.presetKey]
  if (entry === 'YES') {
    return {
      presetKey: resolvedContext.presetKey,
      mode: 'include',
    }
  }
  if (entry === 'NO') {
    return {
      presetKey: resolvedContext.presetKey,
      mode: 'exclude',
    }
  }
  if (entry === 'SPARSE_YES') {
    return {
      presetKey: resolvedContext.presetKey,
      mode: 'sparse',
    }
  }
  return resolvedContext
}

export function includesOwnState(context: StateSnapshotContext): boolean {
  return context.mode === 'include'
}

export function shouldTraverseChildren(context: StateSnapshotContext): boolean {
  return context.mode !== 'exclude'
}

export function hasSenderStateChildren(sender: Sender): boolean {
  return 'senders' in sender
    && typeof (sender as { senders?: unknown }).senders === 'object'
    && (sender as { senders?: unknown }).senders !== null
}

export function hasReceiverStateChildren(receiver: Receiver): boolean {
  return 'controls' in receiver
    && typeof (receiver as { controls?: unknown }).controls === 'object'
    && (receiver as { controls?: unknown }).controls !== null
}

// updates go from visuals to controller
export class Update {
}

// signals go from controller to visuals
export class Signal {
}

export class Args {
  constructor(
    public name: string,
    public x: number,
    public y: number,
    public width: number,
    public height: number,
    public color: string,
    public stateSnapshotMask: StateSnapshotMask = {},
  ) {
    // Sanitize name: '/' is used as path separator in persistence
    if (name.includes('/')) {
      console.warn(`Control name "${name}" contains '/'. Replacing with '-'.`)
      this.name = name.replace(/\//g, '-')
    }
  }
}

export class Spec {
  static type = ''
  public type = Spec.type

  public name: string
  public x: number
  public y: number
  public width: number
  public height: number
  public color: string
  public stateSnapshotMask: StateSnapshotMask
  constructor(
    public baseArgs: Args,
  ) {
    this.name = baseArgs.name
    this.x = baseArgs.x
    this.y = baseArgs.y
    this.width = baseArgs.width
    this.height = baseArgs.height
    this.color = baseArgs.color
    this.stateSnapshotMask = baseArgs.stateSnapshotMask
  }
}

type OnUpdateCallback = (update: Update) => void
type OnSignalCallback = (signal: Signal) => void
type OnStatePatchCallback = (state: State) => void
type OnTouchCallback = () => void

export abstract class Receiver {
  private static updateOriginStack: UpdateOrigin[] = []
  abstract spec: Spec;

  public onUpdate: OnUpdateCallback = () => {}

  handleSignal(_signal: Signal): void {
  }

  getState(_context?: StateSnapshotContext | string | null): State | undefined {
    return new State()
  }

  // Restore state WITHOUT triggering onUpdate (avoids persistence loop)
  restoreState(_state: State): void {
  }

  static withUpdateOrigin<T>(origin: UpdateOrigin, fn: () => T): T {
    Receiver.updateOriginStack.push(origin)
    try {
      return fn()
    } finally {
      Receiver.updateOriginStack.pop()
    }
  }

  static currentUpdateOrigin(): UpdateOrigin | undefined {
    return Receiver.updateOriginStack[Receiver.updateOriginStack.length - 1]
  }
}


export type TraversalCallback = (sender: Sender, object: any) => void
export type DeepForeachCallback = (sender: Sender) => void

export class State {
}

export abstract class Sender {
  public abstract spec: Spec

  public onSignal: OnSignalCallback = () => {}
  public onStatePatch: OnStatePatchCallback = () => {}
  public onTouch: OnTouchCallback = () => {}

  public parent?: Sender

  constructor(
  ) { }

  tabIndex() {
    return 0
  }

  handleUpdate(_update: Update) {
  }

  getState(_context?: StateSnapshotContext | string | null): State | undefined {
    return new State()
  }

  setState(_state: State): void {
  }

  applyStatePatch(state: State): void {
    this.handleUpdate(state as unknown as Update)
  }

  traverse(callback: TraversalCallback, object: any) {
    callback(this, object)
  }

  deepForeach(callback: DeepForeachCallback) {
    callback(this)
  }
}
