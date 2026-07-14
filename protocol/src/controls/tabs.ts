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

export class SpecWithoutControls extends Group.SpecWithoutControls {
  static type = 'tabs-without-controls'
  public type = SpecWithoutControls.type

  constructor(
    baseArgs: Base.Args,
    public initialActiveId: string,
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
  ) {
    super(baseArgs, tabs)
  }
}

export class Receiver extends Group.Receiver {
  public type = 'tabs'
  public activeId: string

  constructor(
    spec: SpecWithoutControls,
    tabs: {[id: string]: Base.Receiver},
  ) {
    super(spec, tabs)
    this.activeId = spec.initialActiveId
  }

  makeSpec(spec: SpecWithoutControls, controlSpecs: SpecsDict) {
    return new Spec(
      spec.baseArgs,
      controlSpecs,
      spec.initialActiveId,
    );
  }

  getState(context?: Base.StateSnapshotContext | string | null): Group.State | undefined {
    const ownContext = Base.resolveStateSnapshotContext(this.spec, context)
    const childStates: {[id: string]: Base.State} = {};
    for (const id in this.controls) {
      const control = this.controls[id]!
      const childContext = Base.resolveStateSnapshotContext(control.spec, ownContext)
      if (!childContext.included && !Base.hasReceiverStateChildren(control)) {
        continue
      }
      const childState = control.getState(childContext)
      if (childState !== undefined) {
        childStates[id] = childState
      }
    }
    if (!ownContext.included && Object.keys(childStates).length === 0) {
      return undefined
    }
    if (!ownContext.included) {
      return new Group.State(childStates)
    }
    return new State(this.activeId, childStates);
  }

  restoreState(state: State): void {
    if (state instanceof State) {
      this.activeId = state.activeId;
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

  getState(context?: Base.StateSnapshotContext | string | null): Group.State | undefined {
    const ownContext = Base.resolveStateSnapshotContext(this.spec, context)
    const childStates: {[id: string]: Base.State} = {};
    for (const id in this.senders) {
      const sender = this.senders[id]!
      const childContext = Base.resolveStateSnapshotContext(sender.spec, ownContext)
      if (!childContext.included && !Base.hasSenderStateChildren(sender)) {
        continue
      }
      const childState = sender.getState(childContext)
      if (childState !== undefined) {
        childStates[id] = childState
      }
    }
    if (!ownContext.included && Object.keys(childStates).length === 0) {
      return undefined
    }
    if (!ownContext.included) {
      return new Group.State(childStates)
    }
    return new State(this.activeId, childStates);
  }

  handleUpdate(update: { controlId: string; update: Base.Update }): void {
    const sender = this.senders[update.controlId]
    if (tabsTimelineUpdateLog) {
      console.info(`[controller:tabs:update] controlId=${update.controlId} hasSender=${Boolean(sender)} update=${JSON.stringify(update.update)}`)
    }
    if (sender) {
      sender.handleUpdate(update.update)
    }
  }

  setState(state: State): void {
    if (state instanceof State) {
      this.activeId = state.activeId;
    }
    for (const id in this.senders) {
      const childState = state.states[id];
      if (childState) {
        this.senders[id]!.setState(childState);
      }
    }
  }
}
