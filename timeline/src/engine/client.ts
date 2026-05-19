import { Controls, Messages } from 'av-controls';
import { getPlaybackLaneSampleBuffer } from './curve';
import { getStepLaneValueBuffer, getTriggerLaneValueBuffer } from './discrete';
import { getTimelineAdapter, sortTimelineKeyframes } from './adapters';
import type {
  TimelineState,
  TimelineLane,
  TimelineTriggerLane,
  TimelineCurveLane,
  TimelineStepLane,
  TimelineKeyframeLane,
  TimelinePoint,
  TimelineTrigger,
  TimelineStateKind,
} from './index';

type Message = Messages.Message;
type ControlUpdate = Messages.ControlUpdate;
type RootSpecification = Messages.RootSpecification;

type TransportSender = {
  send(message: Message): void;
  getBufferedAmount?: () => number;
  addListener(listener: (message: Message) => void): () => void;
  setClientId?: (clientId: string) => void;
};

type ControlPath = string[];
type ControlIndexEntry = {
  path: ControlPath;
  spec: Controls.Base.Spec;
};

type PendingAutomationSignal = {
  path: ControlPath;
  key: string;
  kind: 'curve' | 'step' | 'trigger' | 'keyframes';
  leaf: Controls.Base.Signal;
  values?: Record<string, number>;
  signature: string;
};

type PendingAutomationWindow = {
  fromTime: number;
  toTime: number;
  useRenderLanes: boolean;
};

const manualOverrideLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('timeline-manual-override-log') === '1';
const timelineSignalLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('timeline-signal-log') === '1';
const AUTOMATION_REENABLE_SUPPRESSION_MS = 400;

function logManualOverride(event: string, data?: unknown) {
  if (!manualOverrideLog) return;
  const timestamp = new Date().toISOString();
  console.info(`[${timestamp}] [timeline:manual-override] ${event}`, data ?? {});
}

function logSignal(event: string, data?: unknown) {
  if (!timelineSignalLog) return;
  const timestamp = new Date().toISOString();
  console.info(`[${timestamp}] [timeline:signal] ${event}`, data ?? {});
}

const containerTypes = new Set([
  Controls.Group.Spec.type,
  Controls.Tabs.Spec.type,
  Controls.Modal.Spec.type,
]);

function isContainerSpec(spec: Controls.Base.Spec): boolean {
  return containerTypes.has(spec.type);
}

function isAutomatableSpec(spec: Controls.Base.Spec): boolean {
  if (isContainerSpec(spec)) return false;
  return spec.type !== Controls.Cake.Spec.type
    && spec.type !== Controls.Meter.Spec.type
    && spec.type !== Controls.Lamp.Spec.type;
}

function getPathKey(path: ControlPath): string {
  return path.join('.');
}

function walkSpecs(
  spec: Controls.Base.Spec,
  path: ControlPath,
  onNode: (entry: ControlIndexEntry) => void,
) {
  onNode({ path, spec });
  if (
    spec.type === Controls.Group.Spec.type
    || spec.type === Controls.Tabs.Spec.type
    || spec.type === Controls.Modal.Spec.type
  ) {
    const container = spec as Controls.Group.Spec | Controls.Tabs.Spec | Controls.Modal.Spec;
    for (const id in container.controlSpecs) {
      const child = container.controlSpecs[id];
      if (child) {
        walkSpecs(child, [...path, id], onNode);
      }
    }
  }
}

function ensureSorted(points: TimelinePoint[]): TimelinePoint[] {
  return [...points].sort((a, b) => a.t - b.t);
}

function ensureSortedTriggers(triggers: TimelineTrigger[]): TimelineTrigger[] {
  return [...triggers]
    .map(trigger => ({
      on: { t: trigger.on.t, value: trigger.on.value },
      off: { t: trigger.off.t },
    }))
    .sort((a, b) => a.on.t - b.on.t);
}

function isBezierCurveLane(lane: TimelineLane): lane is TimelineCurveLane {
  return lane.type !== 'keyframes' && lane.type !== 'step' && lane.type !== 'trigger';
}

function isStepLane(lane: TimelineLane): lane is TimelineStepLane {
  return lane.type === 'step';
}

function normalizeQuaternion(values: [number, number, number, number]): [number, number, number, number] {
  const length = Math.hypot(values[0], values[1], values[2], values[3]);
  if (length <= 1e-8) {
    return [0, 0, 0, 1];
  }
  return [
    values[0] / length,
    values[1] / length,
    values[2] / length,
    values[3] / length,
  ];
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function getSpecRange(spec: Controls.Base.Spec): { min?: number; max?: number; wrap?: boolean } {
  if (spec.type === Controls.Fader.Spec.type || spec.type === Controls.Knob.Spec.type) {
    const s = spec as Controls.Fader.Spec | Controls.Knob.Spec;
    return { min: s.min, max: s.max, wrap: 'wrap' in s ? s.wrap : false };
  }
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type || spec.type === Controls.Pad.Spec.type) {
    return { min: -1 };
  }
  if (spec.type === Controls.Selector.Spec.type) {
    const s = spec as Controls.Selector.Spec;
    return { min: 0, max: Math.max(0, s.options.length - 1) };
  }
  if (spec.type === Controls.Joystick.Spec.type || spec.type === Controls.Player3D.Spec.type) {
    return { min: -1, max: 1 };
  }
  return {};
}

function getControlValues(spec: Controls.Base.Spec, payload: any): Record<string, number> {
  const current: Record<string, number> = {};
  if (!payload || typeof payload !== 'object') return current;

  if (spec.type === Controls.Joystick.Spec.type) {
    if (isNumber(payload.x)) current.x = payload.x;
    if (isNumber(payload.y)) current.y = payload.y;
    return current;
  }
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type) {
    if (typeof payload.on === 'boolean') current.on = payload.on ? 0 : -1;
    return current;
  }
  if (spec.type === Controls.Pad.Spec.type) {
    if (typeof payload.pressed === 'boolean') {
      const velocity = isNumber(payload.velocity) ? payload.velocity : (payload.pressed ? 1 : 0);
      current.value = payload.pressed ? Math.max(0, velocity) : -1;
    }
    return current;
  }
  if (spec.type === Controls.Selector.Spec.type) {
    if (isNumber(payload.index)) current.index = payload.index;
    return current;
  }
  if (spec.type === Controls.Player3D.Spec.type) {
    const position = Array.isArray(payload.position) ? payload.position : [];
    const rotation = Array.isArray(payload.rotation) ? payload.rotation : [];
    if (isNumber(position[0])) current.x = position[0];
    if (isNumber(position[1])) current.y = position[1];
    if (isNumber(position[2])) current.z = position[2];
    if (isNumber(rotation[0])) current.qx = rotation[0];
    if (isNumber(rotation[1])) current.qy = rotation[1];
    if (isNumber(rotation[2])) current.qz = rotation[2];
    if (isNumber(rotation[3])) current.qw = rotation[3];
    return current;
  }
  if (isNumber(payload.value)) current.value = payload.value;
  return current;
}

function getLaneValueMap(
  spec: Controls.Base.Spec,
  currentValues: Record<string, number>,
  laneValues: Record<string, number>,
): Record<string, number> {
  if (spec.type === Controls.Joystick.Spec.type) {
    return {
      x: laneValues.x ?? currentValues.x ?? 0,
      y: laneValues.y ?? currentValues.y ?? 0,
    };
  }
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type) {
    return { on: laneValues.on ?? laneValues.value ?? currentValues.on ?? -1 };
  }
  if (spec.type === Controls.Pad.Spec.type) {
    return { value: laneValues.value ?? currentValues.value ?? -1 };
  }
  if (spec.type === Controls.Selector.Spec.type) {
    return { index: laneValues.index ?? laneValues.value ?? currentValues.index ?? 0 };
  }
  if (spec.type === Controls.Player3D.Spec.type) {
    return {
      x: laneValues.x ?? currentValues.x ?? 0,
      y: laneValues.y ?? currentValues.y ?? 0,
      z: laneValues.z ?? currentValues.z ?? 0,
      qx: laneValues.qx ?? currentValues.qx ?? 0,
      qy: laneValues.qy ?? currentValues.qy ?? 0,
      qz: laneValues.qz ?? currentValues.qz ?? 0,
      qw: laneValues.qw ?? currentValues.qw ?? 1,
    };
  }
  return { value: laneValues.value ?? currentValues.value ?? 0 };
}

export function getEventLaneValueBuffer(events: TimelineEventPoint[]) {
  return {
    getValue(time: number) {
      if (!events.length) return null;
      let latestEvent = null;
      for (const e of events) {
        if (e.t <= time) {
          latestEvent = e;
        } else {
          break;
        }
      }
      // If we haven't passed any events yet, use the first future event
      if (!latestEvent && events.length > 0) {
        latestEvent = events[0]!;
      }
      return latestEvent ? latestEvent.t : null;
    }
  };
}

function buildSignalLeaf(spec: Controls.Base.Spec, values: Record<string, number>): Controls.Base.Signal | null {
  if (spec.type === Controls.Fader.Spec.type || spec.type === Controls.Knob.Spec.type) {
    const value = values.value;
    return isNumber(value) ? { value } as Controls.Base.Signal : null;
  }
  if (spec.type === 'time-anchor') {
    const time = values.value;
    return isNumber(time) ? { action: 'set-to-time', time } as Controls.Base.Signal : null;
  }
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type) {
    const on = values.on ?? values.value;
    return isNumber(on) ? { on: on >= 0 } as Controls.Base.Signal : null;
  }
  if (spec.type === Controls.Pad.Spec.type) {
    const value = values.value ?? -1;
    return isNumber(value)
      ? { pressed: value >= 0, velocity: value >= 0 ? Math.max(0, value) : 0 } as Controls.Base.Signal
      : null;
  }
  if (spec.type === Controls.Joystick.Spec.type) {
    const x = values.x ?? 0;
    const y = values.y ?? 0;
    return isNumber(x) && isNumber(y) ? { x, y } as Controls.Base.Signal : null;
  }
  if (spec.type === Controls.Selector.Spec.type) {
    const index = values.index ?? values.value;
    return isNumber(index) ? { index: Math.round(index) } as Controls.Base.Signal : null;
  }
  if (spec.type === Controls.Player3D.Spec.type) {
    return {
      position: [
        values.x ?? 0,
        values.y ?? 0,
        values.z ?? 0,
      ],
      rotation: normalizeQuaternion([
        values.qx ?? 0,
        values.qy ?? 0,
        values.qz ?? 0,
        values.qw ?? 1,
      ]),
    } as Controls.Base.Signal;
  }
  return null;
}

function buildSignalFromPayload(spec: Controls.Base.Spec, payload: unknown): Controls.Base.Signal | null {
  if (spec.type === Controls.Player3D.Spec.type) {
    const value = payload as Controls.Player3D.State | Controls.Player3D.Signal;
    return {
      position: value.position,
      rotation: normalizeQuaternion(value.rotation),
    } as Controls.Base.Signal;
  }
  if (spec.type === Controls.Dots.Spec.type) {
    const value = payload as Controls.Dots.State | Controls.Dots.Update;
    const dots = Array.isArray(value.values) ? value.values : [];
    return {
      type: 'full',
      value: dots.map(dot => [dot[0], dot[1]]),
    } as Controls.Base.Signal;
  }
  return null;
}

function getSignalSignature(signal: Controls.Base.Signal): string {
  return JSON.stringify(signal);
}

function canSkipAutomationSignal(spec: Controls.Base.Spec, adapterKind: 'curve' | 'step' | 'trigger' | 'keyframes' | 'event') {
  if (adapterKind === 'trigger' || adapterKind === 'event') {
    return false;
  }
  if (
    spec.type === Controls.Switch.Spec.type
    || spec.type === Controls.ConfirmSwitch.Spec.type
    || spec.type === Controls.Pad.Spec.type
    || spec.type === Controls.Selector.Spec.type
  ) {
    return false;
  }
  return true;
}

function hasTriggerEventInReverseWindow(triggers: TimelineTrigger[], currentTime: number, previousTime: number) {
  if (!(currentTime < previousTime)) {
    return false;
  }
  for (const trigger of triggers) {
    if (
      (trigger.on.t > currentTime && trigger.on.t < previousTime)
      || (trigger.off.t > currentTime && trigger.off.t < previousTime)
    ) {
      return true;
    }
  }
  return false;
}

function hasEventInReverseWindow(events: TimelineEventPoint[], currentTime: number, previousTime: number) {
  if (!(currentTime < previousTime)) {
    return false;
  }
  return events.some(e => e.t > currentTime && e.t < previousTime);
}

function hasStepEventInReverseWindow(points: TimelinePoint[], currentTime: number, previousTime: number) {
  if (!(currentTime < previousTime)) {
    return false;
  }
  return points.some(point => point.t > currentTime && point.t < previousTime);
}

function buildSignalTree(nodes: PendingAutomationSignal[]): Messages.ControlSignalTree {
  const root: Messages.ControlSignalTree = {};

  for (const entry of nodes) {
    let currentNode = root;
    for (let i = 0; i < entry.path.length; i += 1) {
      const controlId = entry.path[i]!;
      currentNode.children = currentNode.children ?? {};
      currentNode.children[controlId] = currentNode.children[controlId] ?? {};
      currentNode = currentNode.children[controlId]!;
    }
    currentNode.signal = entry.leaf;
  }

  return root;
}

function createEmptyState(): TimelineState {
  return {
    time: 0,
    state: 'playing',
    playing: true,
    alwaysRender: true,
    loopEnabled: false,
    loopDurationSec: 4,
    controls: [],
  };
}

function cloneTimelineState(state: TimelineState): TimelineState {
  return JSON.parse(JSON.stringify(state)) as TimelineState;
}

export type TimelineClientOptions = {
  autoRequestState?: boolean;
};

export type TimelineStateEvent = {
  state: TimelineState;
  source: 'snapshot' | 'edit-echo';
  seq?: number;
  stateSeq?: number;
};

export class TimelineClient {
  private readonly clientId = `timeline-${Math.random().toString(36).slice(2, 10)}`;
  private state: TimelineState = createEmptyState();
  private rootSpec: RootSpecification | null = null;
  private seqCounter = 0;
  private stateSeq = 0;
  private controlIndex = new Map<string, ControlIndexEntry>();
  private ignoredControlPaths = new Set<string>();
  private lastValues = new Map<string, Record<string, number>>();
  private lastSentSignalSignatures = new Map<string, string>();
  private suppressControllerDisableUntil = new Map<string, number>();
  private pendingAutomationWindow: PendingAutomationWindow | null = null;
  private flushAutomationTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutomationSentTime = 0;
  private removeListener: (() => void) | null = null;

  public onState: ((event: TimelineStateEvent) => void) | null = null;
  public onRootSpec: ((spec: RootSpecification) => void) | null = null;
  public onControlUpdate: ((update: ControlUpdate) => void) | null = null;

  constructor(
    private sender: TransportSender,
    options?: TimelineClientOptions,
  ) {
    this.sender.setClientId?.(this.clientId);
    this.removeListener = this.sender.addListener((message: Message) => {
      this.handleMessage(message);
    });
    if (options?.autoRequestState ?? true) {
      this.requestState();
    }
  }

  getState() {
    return this.state;
  }

  getRootSpec() {
    return this.rootSpec;
  }

  requestState() {
    this.emitState('snapshot');
  }

  private emitState(source: 'snapshot' | 'edit-echo', seq?: number) {
    this.onState?.({
      state: cloneTimelineState(this.state),
      source,
      seq,
      stateSeq: ++this.stateSeq,
    });
  }

  private nextSeq() {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  private ensureControlState(path: string[]) {
    let control = this.state.controls.find(candidate => getPathKey(candidate.path) === getPathKey(path));
    if (!control) {
      control = {
        path: [...path],
        enabled: true,
        manualOverride: false,
        lanes: [],
      };
      this.state.controls.push(control);
    }
    return control;
  }

  private findControlState(path: string[]) {
    return this.state.controls.find(candidate => getPathKey(candidate.path) === getPathKey(path)) ?? null;
  }

  private emitEdit(seq?: number) {
    this.emitState('edit-echo', seq);
  }

  setPlaying(playing: boolean) {
    const seq = this.nextSeq();
    this.state.playing = playing;
    this.state.state = playing ? 'playing' : 'paused';
    this.emitEdit(seq);
    return seq;
  }

  setState(state: TimelineStateKind) {
    const seq = this.nextSeq();
    this.state.state = state;
    this.state.playing = state === 'playing';
    this.emitEdit(seq);
    return seq;
  }

  seek(time: number) {
    this.state.time = Math.max(0, time);
    this.lastAutomationSentTime = this.state.time;
    this.clearPendingAutomationWindow();
    this.emitEdit(this.nextSeq());
  }

  setAlwaysRender(alwaysRender: boolean) {
    this.state.alwaysRender = alwaysRender;
    this.emitEdit(this.nextSeq());
  }

  setLoopEnabled(loopEnabled: boolean) {
    this.state.loopEnabled = loopEnabled;
    this.emitEdit(this.nextSeq());
  }

  setLoopDuration(loopDurationSec: number) {
    this.state.loopDurationSec = loopDurationSec;
    this.emitEdit(this.nextSeq());
  }

  setControlEnabled(path: string[], enabled: boolean) {
    const control = this.ensureControlState(path);
    const key = getPathKey(path);
    const previous = { enabled: control.enabled, manualOverride: control.manualOverride };
    control.enabled = enabled;
    if (enabled) {
      control.manualOverride = false;
      this.suppressControllerDisableUntil.set(
        key,
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) + AUTOMATION_REENABLE_SUPPRESSION_MS,
      );
    } else {
      this.suppressControllerDisableUntil.delete(key);
    }
    logManualOverride('set-control-enabled', {
      path: key,
      enabled,
      previous,
      next: { enabled: control.enabled, manualOverride: control.manualOverride },
    });
    this.emitEdit(this.nextSeq());
  }

  setLaneEnabled(path: string[], laneKey: string, enabled: boolean) {
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane) {
      lane.enabled = enabled;
      this.emitEdit(this.nextSeq());
    }
  }

  setLanePoints(path: string[], laneKey: string, points: TimelinePoint[]) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && lane.type !== 'keyframes' && lane.type !== 'trigger') {
      lane.points = ensureSorted(points);
      lane.seq = seq;
      this.emitEdit(seq);
    }
  }

  setLaneTriggers(path: string[], laneKey: string, triggers: TimelineTrigger[]) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && lane.type === 'trigger') {
      lane.triggers = ensureSortedTriggers(triggers);
      lane.seq = seq;
      this.emitEdit(seq);
    }
  }

  setLaneKeyframes(path: string[], laneKey: string, keyframes: TimelineKeyframeLane['keyframes']) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && lane.type === 'keyframes') {
      lane.keyframes = sortTimelineKeyframes(keyframes);
      lane.seq = seq;
      this.emitEdit(seq);
    }
  }

  setLaneEvents(path: string[], laneKey: string, events: TimelineEventLane['events']) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && lane.type === 'event') {
      lane.events = [...events].sort((a, b) => a.t - b.t);
      lane.seq = seq;
      this.emitEdit(seq);
    }
  }

  setRenderLanePoints(path: string[], laneKey: string, points: TimelinePoint[]) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && (isBezierCurveLane(lane) || isStepLane(lane))) {
      lane.renderPoints = ensureSorted(points);
      lane.renderSeq = seq;
      this.emitEdit(seq);
    }
  }

  setRenderLaneTriggers(path: string[], laneKey: string, triggers: TimelineTriggerLane['triggers']) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && lane.type === 'trigger') {
      lane.renderTriggers = ensureSortedTriggers(triggers);
      lane.renderSeq = seq;
      this.emitEdit(seq);
    }
  }

  setRenderLaneKeyframes(path: string[], laneKey: string, keyframes: TimelineKeyframeLane['keyframes']) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && lane.type === 'keyframes') {
      lane.renderKeyframes = sortTimelineKeyframes(keyframes);
      lane.renderSeq = seq;
      this.emitEdit(seq);
    }
  }

  setRenderLaneEvents(path: string[], laneKey: string, events: TimelineEventLane['events']) {
    const seq = this.nextSeq();
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && lane.type === 'event') {
      lane.renderEvents = [...events].sort((a, b) => a.t - b.t);
      lane.renderSeq = seq;
      this.emitEdit(seq);
    }
  }

  addLane(path: string[], lane: TimelineLane) {
    const control = this.ensureControlState(path);
    const exists = control.lanes.find(candidate => candidate.key === lane.key);
    if (exists) {
      return;
    }
    if (lane.type === 'keyframes') {
      control.lanes.push({
        ...lane,
        keyframes: sortTimelineKeyframes(lane.keyframes ?? []),
        renderKeyframes: lane.renderKeyframes ? sortTimelineKeyframes(lane.renderKeyframes) : undefined,
      });
    } else if (lane.type === 'trigger') {
      control.lanes.push({
        ...lane,
        triggers: ensureSortedTriggers(lane.triggers ?? []),
        renderTriggers: lane.renderTriggers ? ensureSortedTriggers(lane.renderTriggers) : undefined,
      });
    } else if (lane.type === 'event') {
      control.lanes.push({
        ...lane,
        events: lane.events ? [...lane.events].sort((a, b) => a.t - b.t) : [],
        renderEvents: lane.renderEvents ? [...lane.renderEvents].sort((a, b) => a.t - b.t) : undefined,
      });
    } else {
      control.lanes.push({
        ...lane,
        points: ensureSorted(lane.points ?? []),
        renderPoints: lane.renderPoints ? ensureSorted(lane.renderPoints) : undefined,
      });
    }
    this.emitEdit(this.nextSeq());
  }

  addRenderLane(path: string[], laneKey: string) {
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && (isBezierCurveLane(lane) || isStepLane(lane)) && lane.renderPoints === undefined) {
      lane.renderPoints = [];
      this.emitEdit(this.nextSeq());
    } else if (lane && lane.type === 'trigger' && lane.renderTriggers === undefined) {
      lane.renderTriggers = [];
      this.emitEdit(this.nextSeq());
    } else if (lane && lane.type === 'keyframes' && lane.renderKeyframes === undefined) {
      lane.renderKeyframes = [];
      this.emitEdit(this.nextSeq());
    } else if (lane && lane.type === 'event' && lane.renderEvents === undefined) {
      lane.renderEvents = [];
      this.emitEdit(this.nextSeq());
    }
  }

  removeLane(path: string[], laneKey: string) {
    const control = this.ensureControlState(path);
    control.lanes = control.lanes.filter(candidate => candidate.key !== laneKey);
    this.emitEdit(this.nextSeq());
  }

  removeRenderLane(path: string[], laneKey: string) {
    const lane = this.ensureControlState(path).lanes.find(candidate => candidate.key === laneKey);
    if (lane && (isBezierCurveLane(lane) || isStepLane(lane))) {
      delete lane.renderPoints;
      delete lane.renderSeq;
      this.emitEdit(this.nextSeq());
    } else if (lane && lane.type === 'trigger') {
      delete lane.renderTriggers;
      delete lane.renderSeq;
      this.emitEdit(this.nextSeq());
    } else if (lane && lane.type === 'keyframes') {
      delete lane.renderKeyframes;
      delete lane.renderSeq;
      this.emitEdit(this.nextSeq());
    }
  }

  renderFrame() {
    this.emitEdit(this.nextSeq());
  }

  applyAutomation(time: number, options?: { useRenderLanes?: boolean; bypassBackpressure?: boolean }) {
    const currentTime = Math.max(0, time);
    const useRenderLanes = options?.useRenderLanes ?? false;
    const shouldBypassBackpressure = options?.bypassBackpressure ?? false;

    this.state.time = currentTime;
    if (!shouldBypassBackpressure && (this.sender.getBufferedAmount?.() ?? 0) > 0) {
      this.queueAutomationWindow(currentTime, useRenderLanes);
      return;
    }

    const fromTime = shouldBypassBackpressure
      ? this.lastAutomationSentTime
      : this.pendingAutomationWindow?.fromTime ?? this.lastAutomationSentTime;
    this.clearPendingAutomationWindow();
    this.sendAutomationWindow(fromTime, currentTime, useRenderLanes, 'live');
  }

  private collectAutomationSignals(previousTime: number, currentTime: number, useRenderLanes: boolean) {
    const pendingSignals: PendingAutomationSignal[] = [];

    for (const control of this.state.controls) {
      if (!control.enabled || control.manualOverride) continue;
      const entry = this.controlIndex.get(getPathKey(control.path));
      if (!entry) continue;
      const adapter = getTimelineAdapter(entry.spec);

      if (adapter.kind === 'keyframes') {
        const lane = control.lanes.find(candidate => candidate.enabled && candidate.type === 'keyframes');
        if (!lane || lane.type !== 'keyframes') continue;
        const sourceLane = useRenderLanes && lane.renderKeyframes !== undefined
          ? { ...lane, keyframes: lane.renderKeyframes }
          : lane;
        const payload = adapter.evaluateKeyframes
          ? adapter.evaluateKeyframes(sourceLane, currentTime)
          : adapter.getKeyframeValueBuffer?.(sourceLane)?.getValue(currentTime);
        if (payload === null || payload === undefined) continue;
        const leaf = buildSignalFromPayload(entry.spec, payload);
        if (!leaf) continue;
        const key = getPathKey(control.path);
        this.lastValues.set(key, getControlValues(entry.spec, payload));
        const signature = getSignalSignature(leaf);
        if (this.lastSentSignalSignatures.get(key) === signature) {
          continue;
        }
        pendingSignals.push({
          path: [...control.path],
          key,
          kind: adapter.kind,
          leaf,
          signature,
        });
        continue;
      }

      const laneValues: Record<string, number> = {};
      const range = getSpecRange(entry.spec);
      for (const lane of control.lanes) {
        if (!lane.enabled || lane.type === 'keyframes') continue;
        const triggerSource = lane.type === 'trigger'
          ? (useRenderLanes && lane.renderTriggers !== undefined ? lane.renderTriggers : lane.triggers)
          : null;
        if (
          lane.type === 'trigger'
          && triggerSource
          && currentTime < previousTime
          && !hasTriggerEventInReverseWindow(triggerSource, currentTime, previousTime)
        ) continue;
        if (
          lane.type === 'event'
          && currentTime < previousTime
          && !hasEventInReverseWindow(
            useRenderLanes && lane.renderEvents !== undefined ? lane.renderEvents : lane.events,
            currentTime,
            previousTime,
          )
        ) continue;
        if (
          isStepLane(lane)
          && currentTime < previousTime
          && !hasStepEventInReverseWindow(
            useRenderLanes && lane.renderPoints !== undefined ? lane.renderPoints : lane.points,
            currentTime,
            previousTime,
          )
        ) continue;
        const value = lane.type === 'trigger'
          ? getTriggerLaneValueBuffer(triggerSource ?? []).getValue(currentTime)
          : lane.type === 'event'
          ? getEventLaneValueBuffer(useRenderLanes && lane.renderEvents !== undefined ? lane.renderEvents : lane.events).getValue(currentTime)
          : (() => {
              const points = (isBezierCurveLane(lane) || isStepLane(lane)) && useRenderLanes && lane.renderPoints !== undefined
                ? lane.renderPoints
                : (lane as any).points;
              return isStepLane(lane)
                ? getStepLaneValueBuffer(points, range.min, range.max).getValue(currentTime)
                : getPlaybackLaneSampleBuffer(points, range.min, range.max, range.wrap ?? false).getValue(currentTime);
            })();
        if (value === null) continue;
        laneValues[lane.key] = value;
      }
      if (Object.keys(laneValues).length === 0) continue;

      const key = getPathKey(control.path);
      const previousValues = this.lastValues.get(key) ?? {};
      const mapped = getLaneValueMap(entry.spec, previousValues, laneValues);
      const leaf = buildSignalLeaf(entry.spec, mapped);
      if (!leaf) continue;
      this.lastValues.set(key, mapped);
      const signature = getSignalSignature(leaf);
      if (this.lastSentSignalSignatures.get(key) === signature) {
        continue;
      }
      pendingSignals.push({
        path: [...control.path],
        key,
        kind: adapter.kind,
        leaf,
        values: mapped,
        signature,
      });
    }

    return pendingSignals;
  }

  private sendAutomationWindow(
    previousTime: number,
    currentTime: number,
    useRenderLanes: boolean,
    source: 'live' | 'pending-latest',
  ) {
    this.state.time = currentTime;
    const pendingSignals = this.collectAutomationSignals(previousTime, currentTime, useRenderLanes);
    if (pendingSignals.length === 0) {
      this.lastAutomationSentTime = currentTime;
      return;
    }

    const bufferedAmount = this.sender.getBufferedAmount?.() ?? 0;
    const discreteSignals: PendingAutomationSignal[] = [];
    const continuousSignals: PendingAutomationSignal[] = [];
    for (const pending of pendingSignals) {
      const entry = this.controlIndex.get(pending.key);
      if (entry && canSkipAutomationSignal(entry.spec, pending.kind)) {
        continuousSignals.push(pending);
      } else {
        discreteSignals.push(pending);
      }
    }

    const batch = new Messages.ControlSignal(
      buildSignalTree(pendingSignals),
      undefined,
      { kind: 'timeline', clientId: this.clientId },
    );
    logSignal('send-batch', {
      signalCount: pendingSignals.length,
      discreteCount: discreteSignals.length,
      continuousCount: continuousSignals.length,
      bufferedAmount,
      fromTime: previousTime,
      toTime: currentTime,
      source,
    });
    this.sender.send(batch);
    for (const signal of pendingSignals) {
      this.lastSentSignalSignatures.set(signal.key, signal.signature);
    }
    this.lastAutomationSentTime = currentTime;
  }

  private queueAutomationWindow(toTime: number, useRenderLanes: boolean) {
    const fromTime = this.pendingAutomationWindow?.fromTime ?? this.lastAutomationSentTime;
    this.pendingAutomationWindow = { fromTime, toTime, useRenderLanes };
    logSignal('send-skipped', {
      reason: 'backpressure-buffered-latest',
      bufferedAmount: this.sender.getBufferedAmount?.() ?? 0,
      fromTime,
      toTime,
      useRenderLanes,
    });
    this.schedulePendingAutomationFlush();
  }

  private clearPendingAutomationWindow() {
    this.pendingAutomationWindow = null;
    if (this.flushAutomationTimer !== null) {
      clearTimeout(this.flushAutomationTimer);
      this.flushAutomationTimer = null;
    }
  }

  private schedulePendingAutomationFlush() {
    if (this.flushAutomationTimer !== null) {
      return;
    }

    const pump = () => {
      this.flushAutomationTimer = null;
      if (!this.pendingAutomationWindow) {
        return;
      }

      const bufferedAmount = this.sender.getBufferedAmount?.() ?? 0;
      if (bufferedAmount > 0) {
        this.flushAutomationTimer = setTimeout(pump, 16);
        return;
      }

      const pending = this.pendingAutomationWindow;
      this.pendingAutomationWindow = null;
      this.sendAutomationWindow(pending.fromTime, pending.toTime, pending.useRenderLanes, 'pending-latest');
    };

    this.flushAutomationTimer = setTimeout(pump, 16);
  }

  private buildIndex() {
    this.controlIndex.clear();
    this.ignoredControlPaths.clear();
    this.lastValues.clear();
    this.lastSentSignalSignatures.clear();
    this.suppressControllerDisableUntil.clear();
    if (!this.rootSpec) {
      return;
    }
    walkSpecs(this.rootSpec.rootControlSpec, [], (entry) => {
      if (isContainerSpec(entry.spec)) return;
      const key = getPathKey(entry.path);
      if (!isAutomatableSpec(entry.spec)) {
        this.ignoredControlPaths.add(key);
        return;
      }
      this.controlIndex.set(key, entry);
    });
  }

  private handleMessage(message: Message) {
    if (message.type === Messages.RootSpecification.type) {
      this.rootSpec = message as RootSpecification;
      this.buildIndex();
      this.onRootSpec?.(this.rootSpec);
      return;
    }
    if (message.type === Messages.ControlUpdate.type) {
      const update = message as ControlUpdate;
      Messages.walkUpdateTree(update.update, (path, leaf) => {
        const key = getPathKey(path);
        if (this.ignoredControlPaths.has(key)) {
          return;
        }
        logSignal('receive-update', {
          path: key,
          origin: update.origin,
          seq: update.seq,
          serverSeq: update.serverSeq,
          update: leaf,
        });
        const entry = this.controlIndex.get(key);
        if (entry) {
          this.lastValues.set(key, {
            ...(this.lastValues.get(key) ?? {}),
            ...getControlValues(entry.spec, leaf),
          });
        }
        if (update.origin?.kind === 'controller') {
          const control = this.findControlState(path);
          if (control) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const suppressUntil = this.suppressControllerDisableUntil.get(key) ?? 0;
            if (suppressUntil > now) {
              logManualOverride('controller-update-disable-suppressed', {
                path: key,
                suppressUntil,
                now,
                origin: update.origin,
                seq: update.seq,
                serverSeq: update.serverSeq,
              });
              return;
            }
            const previous = { enabled: control.enabled, manualOverride: control.manualOverride };
            control.enabled = false;
            control.manualOverride = true;
            this.suppressControllerDisableUntil.delete(key);
            logManualOverride('controller-update-disabled-automation', {
              path: key,
              previous,
              next: { enabled: control.enabled, manualOverride: control.manualOverride },
              origin: update.origin,
              seq: update.seq,
              serverSeq: update.serverSeq,
            });
            this.emitState('snapshot');
          }
        }
      });
      this.onControlUpdate?.(update);
    }
  }

  dispose() {
    this.clearPendingAutomationWindow();
    this.removeListener?.();
    this.removeListener = null;
    this.onState = null;
    this.onRootSpec = null;
    this.onControlUpdate = null;
  }
}
