import { type SpecsDict } from '../common'
import { Group, Base } from '../controls'

const tabsTimelineUpdateLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('controller-timeline-deep-log') === '1'

export class State extends Group.State {
  constructor(
    public activeId: string,
    states: {[id: string]: Base.State},
  ) {
    super(states);
  }
}

export class Signal extends Base.Signal {
  constructor(
    public activeId: string,
  ) {
    super()
  }
}

export class Update extends Base.Update {
  constructor(
    public activeId: string,
  ) {
    super()
  }
}

export class SpecWithoutControls extends Group.SpecWithoutControls {
  static type = 'tabs-without-controls'
  public type = SpecWithoutControls.type

  constructor(
    baseArgs: Base.Args,
    public initialActiveId: string,
    public syncSelection = false,
    public vertical = false,
  ) {
    super(baseArgs)
  }
}

export class Spec extends Group.Spec {
  static type = 'tabs'
  public type = Spec.type

  constructor(
    baseArgs: Base.Args,
    public tabs: {[id: string]: Base.Spec},
    public initialActiveId: string,
    public syncSelection = false,
    public vertical = false,
  ) {
    super(baseArgs, tabs)
  }
}

export class Receiver extends Group.Receiver {
  public type = 'tabs'
  public spec!: Spec
  public activeId: string

  constructor(
    spec: SpecWithoutControls,
    tabs: {[id: string]: Base.Receiver},
    private onSelect?: (activeId: string) => void,
  ) {
    super(spec, tabs)
    this.activeId = spec.initialActiveId
  }

  makeSpec(spec: SpecWithoutControls, controlSpecs: SpecsDict) {
    return new Spec(
      spec.baseArgs,
      controlSpecs,
      spec.initialActiveId,
      spec.syncSelection,
      spec.vertical,
    );
  }

  handleSignal(signal: Group.Signal | Signal): void {
    if (isSelectionSignal(signal)) {
      this.select(signal.activeId)
      return
    }
    super.handleSignal(signal)
  }

  select(activeId: string): void {
    if (!this.controls[activeId]) return
    this.activeId = activeId
    this.onSelect?.(activeId)
    if (this.spec.syncSelection) {
      this.onUpdate(new Update(activeId))
    }
  }

  getState(context?: Base.StateSnapshotContext | string | null): Group.State | undefined {
    const ownContext = Base.resolveStateSnapshotContext(this.spec, context)
    const childStates: {[id: string]: Base.State} = {};
    for (const id in this.controls) {
      const control = this.controls[id]!
      const childContext = Base.resolveStateSnapshotContext(control.spec, ownContext)
      if (!Base.includesOwnState(childContext) && !Base.hasReceiverStateChildren(control)) {
        continue
      }
      const childState = control.getState(childContext)
      if (childState !== undefined) {
        childStates[id] = childState
      }
    }
    if (!Base.includesOwnState(ownContext) && Object.keys(childStates).length === 0) {
      return undefined
    }
    if (!Base.includesOwnState(ownContext)) {
      return new Group.State(childStates)
    }
    return new State(this.activeId, childStates);
  }

  restoreState(state: State): void {
    const activeId = getStateActiveId(state)
    if (activeId && this.controls[activeId]) {
      this.activeId = activeId;
      this.onSelect?.(activeId);
    }
    for (const id in this.controls) {
      const childState = state.states[id];
      if (childState) {
        this.controls[id]!.restoreState(childState);
      }
    }
  }
}

export class Sender extends Group.Sender {
  public type = 'tabs'
  public activeId: string

  constructor(
    public spec: Spec,
  ) {
    super(spec)
    this.activeId = spec.initialActiveId
  }

  select(activeId: string) {
    if (!this.senders[activeId]) return
    this.activeId = activeId
    if (this.spec.syncSelection) {
      this.onSignal(new Signal(activeId))
    }
  }

  getState(context?: Base.StateSnapshotContext | string | null): Group.State | undefined {
    const ownContext = Base.resolveStateSnapshotContext(this.spec, context)
    const childStates: {[id: string]: Base.State} = {};
    for (const id in this.senders) {
      const sender = this.senders[id]!
      const childContext = Base.resolveStateSnapshotContext(sender.spec, ownContext)
      if (!Base.includesOwnState(childContext) && !Base.hasSenderStateChildren(sender)) {
        continue
      }
      const childState = sender.getState(childContext)
      if (childState !== undefined) {
        childStates[id] = childState
      }
    }
    if (!Base.includesOwnState(ownContext) && Object.keys(childStates).length === 0) {
      return undefined
    }
    if (!Base.includesOwnState(ownContext)) {
      return new Group.State(childStates)
    }
    return new State(this.activeId, childStates);
  }

  handleUpdate(update: Group.Update | Update): void {
    if (isSelectionUpdate(update)) {
      if (this.senders[update.activeId]) {
        this.activeId = update.activeId
      }
      return
    }
    const sender = this.senders[update.controlId]
    if (tabsTimelineUpdateLog) {
      console.info(`[controller:tabs:update] controlId=${update.controlId} hasSender=${Boolean(sender)} update=${JSON.stringify(update.update)}`)
    }
    if (sender) {
      sender.handleUpdate(update.update)
    }
  }

  setState(state: State): void {
    const activeId = getStateActiveId(state)
    if (activeId && this.senders[activeId]) {
      this.activeId = activeId;
    }
    for (const id in this.senders) {
      const childState = state.states[id];
      if (childState) {
        this.senders[id]!.setState(childState);
      }
    }
  }

  applyStatePatch(state: Group.State): void {
    const activeId = getStateActiveId(state)
    if (activeId && this.senders[activeId]) {
      this.activeId = activeId;
    }
    for (const id in this.senders) {
      const childState = state.states[id];
      if (childState) {
        this.senders[id]!.applyStatePatch(childState);
      }
    }
  }
}

function isSelectionSignal(signal: Base.Signal): signal is Signal {
  return 'activeId' in signal && typeof (signal as { activeId?: unknown }).activeId === 'string'
}

function isSelectionUpdate(update: Base.Update): update is Update {
  return 'activeId' in update && typeof (update as { activeId?: unknown }).activeId === 'string'
}

function getStateActiveId(state: Group.State): string | undefined {
  return 'activeId' in state && typeof (state as { activeId?: unknown }).activeId === 'string'
    ? (state as { activeId: string }).activeId
    : undefined
}
