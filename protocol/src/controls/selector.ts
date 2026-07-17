import * as Base from './base';

export type Option = string | { key: string; label: string }

function normalizeOptions(options: Option[]) {
  return options.map((option) => {
    if (typeof option === 'string') {
      return { key: option, label: option }
    }
    return option
  })
}

export class Signal extends Base.Signal {
    public key?: string
    public index?: number

    constructor(
        keyOrIndex: string | number,
    ) {
        super();
        if (typeof keyOrIndex === 'number') {
            this.index = keyOrIndex
        } else {
            this.key = keyOrIndex
        }
    }
}

export class Update extends Base.Update {
  public key: string
  public index: number

  constructor(
    key: string,
    index: number,
  ) {
    super();
    this.key = key
    this.index = index
  }
}

export class Spec extends Base.Spec {
  static type = 'selector'
  public type = Spec.type
  public options: string[]
  public optionKeys: string[]

  constructor(
    baseArgs: Base.Args,
    options: Option[],
    public initialState: State,
  ) {
    super(baseArgs);
    const normalized = normalizeOptions(options)
    this.options = normalized.map((option) => option.label)
    this.optionKeys = normalized.map((option) => option.key)
  }
}

/**
 * Selector control receiver
 */
export class Receiver extends Base.Receiver {
  public key: string;

  get index(): number {
    const index = this.spec.optionKeys.indexOf(this.key)
    return index >= 0 ? index : 0
  }

  set index(index: number) {
    this.key = this.keyForIndex(index)
  }

  constructor(
    public spec: Spec,
    public onSelect?: (index: number, key: string) => void,
  ) {
    super();
    this.key = this.resolveStateKey(spec.initialState)
  }

  handleSignal(payload: Signal): void {
    this.key = this.resolveSignalKey(payload);
    if (this.onSelect) {
      this.onSelect(this.index, this.key);
    }
    this.onUpdate(new Update(this.key, this.index));
  }

  getState(): State {
    return new State(this.key, this.index);
  }

  restoreState(state: State): void {
    this.key = this.resolveStateKey(state);
    if (this.onSelect) {
      this.onSelect(this.index, this.key);
    }
  }

  private keyForIndex(index: number | undefined): string {
    return this.spec.optionKeys[index ?? 0] ?? this.spec.optionKeys[0] ?? ''
  }

  private resolveSignalKey(signal: Signal): string {
    if (signal.key && this.spec.optionKeys.includes(signal.key)) {
      return signal.key
    }
    return this.keyForIndex(signal.index)
  }

  private resolveStateKey(state: State): string {
    if (state.key && this.spec.optionKeys.includes(state.key)) {
      return state.key
    }
    return this.keyForIndex(state.index)
  }
}

export class State extends Base.State {
  public key?: string
  public index?: number

  constructor(
    keyOrIndex: string | number,
    index?: number,
  ) {
    super();
    if (typeof keyOrIndex === 'number') {
      this.index = keyOrIndex
    } else {
      this.key = keyOrIndex
      this.index = index
    }
  }
}

export class Sender extends Base.Sender {
  key: string

  get index(): number {
    const index = this.spec.optionKeys.indexOf(this.key)
    return index >= 0 ? index : 0
  }

  set index(index: number) {
    this.key = this.keyForIndex(index)
  }

  constructor(
    public spec: Spec,
  ) {
    super()
    this.key = this.resolveStateKey(spec.initialState)
  }

  select(value: number | string) {
    this.key = typeof value === 'number' ? this.keyForIndex(value) : value
    this.onSignal(new Signal(this.key))
  }

  increment() {
    this.select((this.index + 1) % this.spec.options.length)
  }

  decrement() {
    this.select((this.index - 1 + this.spec.options.length) % this.spec.options.length)
  }

  getState() {
    return new State(this.key, this.index)
  }

  setState(state: State) {
    this.select(this.resolveStateKey(state))
  }

  handleUpdate(update: Update) {
    this.key = this.resolveUpdateKey(update)
  }

  private keyForIndex(index: number | undefined): string {
    return this.spec.optionKeys[index ?? 0] ?? this.spec.optionKeys[0] ?? ''
  }

  private resolveStateKey(state: State): string {
    if (state.key && this.spec.optionKeys.includes(state.key)) {
      return state.key
    }
    return this.keyForIndex(state.index)
  }

  private resolveUpdateKey(update: Update): string {
    if (update.key && this.spec.optionKeys.includes(update.key)) {
      return update.key
    }
    return this.keyForIndex(update.index)
  }
}
