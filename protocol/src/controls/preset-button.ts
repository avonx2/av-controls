import * as Base from './base';
import { Logger } from '../error';

export class Update extends Base.Update {
  constructor(
    public action: 'random' | 'next',
    public avoidRecentRatio = 0,
  ) {
    super();
  }
}

export class Signal extends Base.Signal {
  constructor(
    public action: 'bank-changed'
  ) {
    super();
  }
}

export class Spec extends Base.Spec {
  static type = 'preset-button'
  public type = Spec.type

  constructor(
    baseArgs: Base.Args,
    public stencil: any,
    public presetKey: string = baseArgs.name,
  ) {
		super(baseArgs);
	}
}

export class Receiver extends Base.Receiver {
  constructor(
    public spec: Spec,
  ) {
    super();
  }

  handleSignal(_signal: Base.Signal): void {
    Logger.debug('PresetButton received message, ignoring', { button: this.spec.name });
  }

  makeRandomSwitch(avoidRecentRatio = 0.5): void {
    this.onUpdate(new Update('random', avoidRecentRatio));
  }
}

export class Sender extends Base.Sender {
  private savedParentStates: {[id: string]: Base.State} = {}

  private lastPresetLoaded: string | undefined
  private recentlyLoadedPresets: string[] = []

  getLoadedPreset() {
    return this.lastPresetLoaded
  }

  constructor(
    public spec: Spec,
  ) {
    super()
  }
  
  handleUpdate(update: Update) {
    console.log('update arrived at ', update)
    if(update.action == 'next') {
      this.nextPresetInRow()
    } else if(update.action == 'random') {
      this.randomPreset(update.avoidRecentRatio)
    }
  }

  save(presetId: string) {
    if(this.parent) {
      const state = this.parent.getState(this.spec.presetKey)
      if (state === undefined) {
        return
      }
      console.log(`saving preset ${presetId}`, state)
      this.savedParentStates[presetId] = state
      this.notifyStateChanged()
    }
  }

  load(presetId: string) {
    const savedState = this.savedParentStates[presetId]
    if(this.parent && savedState) {
      this.parent.onStatePatch(savedState)
    }
    this.lastPresetLoaded = presetId
    this.rememberLoadedPreset(presetId)
  }

  getAllPresets() {
    return this.savedParentStates
  }

  setPresets(presets: {[id: string]: Base.State}) {
    this.savedParentStates = presets
    this.notifyStateChanged()
  }

  mergePresets(presets: {[id: string]: Base.State}) {
    this.savedParentStates = {
      ...presets,
      ...this.savedParentStates,
    }
    this.notifyStateChanged()
  }

  renamePreset(presetId: string, newPresetId: string) {
    const newId = newPresetId.trim()
    if (!newId || presetId === newId || !this.savedParentStates[presetId]) {
      return
    }
    this.savedParentStates[newId] = this.savedParentStates[presetId]!
    delete this.savedParentStates[presetId]
    if (this.lastPresetLoaded === presetId) {
      this.lastPresetLoaded = newId
    }
    this.recentlyLoadedPresets = this.recentlyLoadedPresets.map(id => id === presetId ? newId : id)
    this.notifyStateChanged()
  }

  deletePreset(presetId: string) {
    delete this.savedParentStates[presetId]
    this.notifyStateChanged()
  }

  nextPresetInRow() {
    const presetIds = Object.keys(this.savedParentStates)
    if(presetIds.length > 0) {
      let i = 0
      if(this.lastPresetLoaded !== undefined) {
        i = (presetIds.indexOf(this.lastPresetLoaded) + 1) % presetIds.length
      }
      const nextPresetId = presetIds[i]!
      this.load(nextPresetId)
    }
  }

  randomPreset(avoidRecentRatio = 0.5) {
    const presetIds = Object.keys(this.savedParentStates)
    if(presetIds.length > 0) {
      const avoidCount = Math.max(0, Math.min(
        presetIds.length - 1,
        Math.floor(presetIds.length * avoidRecentRatio),
      ))
      const recent = new Set(this.recentlyLoadedPresets.slice(0, avoidCount))
      const candidates = presetIds.filter(id => !recent.has(id))
      const pool = candidates.length > 0 ? candidates : presetIds
      const nextPresetId = pool[Math.floor(Math.random() * pool.length)]!
      this.load(nextPresetId)
    }
  }

  getNames() {
    return Object.keys(this.savedParentStates)
  }

  getState(context?: Base.StateSnapshotContext | string | null): State | undefined {
    const ownContext = Base.resolveStateSnapshotContext(this.spec, context)
    if (ownContext.presetKey !== null || !Base.includesOwnState(ownContext)) {
      return undefined
    }
    return new State(this.savedParentStates)
  }

  setState(state: State): void {
    if (state.savedParentStates && typeof state.savedParentStates === 'object') {
      this.savedParentStates = state.savedParentStates
      this.notifyStateChanged()
    }
  }

  private notifyStateChanged() {
    this.onSignal(new Signal('bank-changed'))
  }

  private rememberLoadedPreset(presetId: string) {
    this.recentlyLoadedPresets = [
      presetId,
      ...this.recentlyLoadedPresets.filter(id => id !== presetId),
    ]
    const maxHistory = Math.max(1, Object.keys(this.savedParentStates).length)
    this.recentlyLoadedPresets.length = Math.min(this.recentlyLoadedPresets.length, maxHistory)
  }
}

export class State extends Base.State {
  constructor(
    public savedParentStates: {[id: string]: Base.State},
  ) {
    super()
  }
}
