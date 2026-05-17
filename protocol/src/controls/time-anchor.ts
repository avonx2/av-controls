import * as Base from './base';

export class Signal extends Base.Signal {
  constructor(
    public action: 'set-to-now' | 'set-to-time',
    public time?: number,
  ) {
    super();
  }
}

export class Update extends Base.Update {
  constructor(
    public time: number | null,
  ) {
    super();
  }
}

export class State extends Base.State {
  constructor(
    public time: number | null = null,
  ) {
    super();
  }
}

export class Spec extends Base.Spec {
  static type = 'time-anchor' as const;
  public type = Spec.type;

  constructor(
    baseArgs: Base.Args,
    public initialState: State = new State(null),
  ) {
    super(baseArgs);
  }
}

export class Receiver extends Base.Receiver {
  public time: number | null;
  
  constructor(
    public spec: Spec,
    public onSetToNow?: () => void,
    public onSetToTime?: (time: number) => void,
  ) {
    super();
    this.time = spec.initialState.time;
  }

  handleSignal(payload: Signal): void {
    if (payload.action === 'set-to-now') {
      if (this.onSetToNow) {
        this.onSetToNow();
      }
    } else if (payload.action === 'set-to-time' && typeof payload.time === 'number') {
      this.time = payload.time;
      if (this.onSetToTime) {
        this.onSetToTime(this.time);
      }
      this.onUpdate(new Update(this.time));
    }
  }

  // Called by artwork when "set-to-now" resolves to a specific timeline time
  confirmTime(time: number) {
    this.time = time;
    this.onUpdate(new Update(this.time));
  }

  getState(): State {
    return new State(this.time);
  }

  restoreState(state: State): void {
    this.time = state.time;
    if (this.time !== null && this.onSetToTime) {
      this.onSetToTime(this.time);
    }
  }
}

export class Sender extends Base.Sender {
  time: number | null = null;

  constructor(
    public spec: Spec,
  ) {
    super();
  }

  setToNow() {
    this.onSignal(new Signal('set-to-now'));
  }

  setToTime(time: number) {
    this.time = time;
    this.onSignal(new Signal('set-to-time', time));
  }

  getState() {
    return new State(this.time);
  }

  setState(state: State) {
    if (state.time !== null) {
      this.setToTime(state.time);
    }
  }

  handleUpdate(update: Update) {
    this.time = update.time;
  }
}