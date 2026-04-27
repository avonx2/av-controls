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

type TriggerEdge = {
  t: number;
  value: number;
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

function extractUpdatePath(update: Controls.Base.Update): { path: ControlPath; leaf: any } {
  const path: string[] = [];
  let current: any = update;
  while (current && typeof current === 'object' && 'controlId' in current && 'update' in current) {
    path.push(current.controlId);
    current = current.update;
  }
  return { path, leaf: current };
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

function buildSignalLeaf(spec: Controls.Base.Spec, values: Record<string, number>): Controls.Base.Signal | null {
  if (spec.type === Controls.Fader.Spec.type || spec.type === Controls.Knob.Spec.type) {
    const value = values.value;
    return isNumber(value) ? { value } as Controls.Base.Signal : null;
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
    return {
      type: 'full',
      dots: value.values.map(dot => [dot[0], dot[1]]),
    } as Controls.Base.Signal;
  }
  return null;
}

function getSignalSignature(signal: Controls.Base.Signal): string {
  return JSON.stringify(signal);
}

function canSkipAutomationSignal(spec: Controls.Base.Spec, adapterKind: 'curve' | 'step' | 'trigger' | 'keyframes') {
  if (adapterKind === 'trigger') {
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

function getSortedTriggerEdgesInRange(triggers: TimelineTrigger[], previousTime: number, currentTime: number): TriggerEdge[] {
  if (!(currentTime > previousTime)) {
    return [];
  }
  const edges: TriggerEdge[] = [];
  for (const trigger of triggers) {
    if (trigger.on.t > previousTime && trigger.on.t <= currentTime) {
      edges.push({ t: trigger.on.t, value: Math.max(0, trigger.on.value) });
    }
    if (trigger.off.t > previousTime && trigger.off.t <= currentTime) {
      edges.push({ t: trigger.off.t, value: -1 });
    }
  }
  edges.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (a.value >= 0 && b.value < 0) return -1;
    if (a.value < 0 && b.value >= 0) return 1;
    return 0;
  });
  return edges;
}

function buildSignalBatch(nodes: PendingAutomationSignal[]): Messages.ControlSignalBatchNode[] {
  const roots: Messages.ControlSignalBatchNode[] = [];
  const rootIndex = new Map<string, Messages.ControlSignalBatchNode>();

  for (const entry of nodes) {
    let siblings = roots;
    let siblingIndex = rootIndex;
    let currentNode: Messages.ControlSignalBatchNode | null = null;

    for (let i = 0; i < entry.path.length; i += 1) {
      const controlId = entry.path[i]!;
      let node = siblingIndex.get(controlId);
      if (!node) {
        node = { controlId };
        siblings.push(node);
        siblingIndex.set(controlId, node);
      }
      currentNode = node;
      if (i === entry.path.length - 1) {
        node.signal = entry.leaf;
      } else {
        if (!node.children) {
          node.children = [];
        }
        if (!(node as any)._childIndex) {
          (node as any)._childIndex = new Map<string, Messages.ControlSignalBatchNode>();
        }
        siblings = node.children;
        siblingIndex = (node as any)._childIndex as Map<string, Messages.ControlSignalBatchNode>;
      }
    }

    if (currentNode && !currentNode.signal) {
      currentNode.signal = entry.leaf;
    }
  }

  const stripIndexes = (entries: Messages.ControlSignalBatchNode[]) => {
    for (const node of entries) {
      delete (node as any)._childIndex;
      if (node.children?.length) {
        stripIndexes(node.children);
      }
    }
  };
  stripIndexes(roots);
  return roots;
}

function sendPendingSignal(
  sender: TransportSender,
  pending: PendingAutomationSignal,
  clientId: string,
) {
  sender.send(new Messages.ControlSignalBatch(
    buildSignalBatch([pending]),
    undefined,
    { kind: 'timeline', clientId },
  ));
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
  private pendingContinuousBatch: Messages.ControlSignalBatch | null = null;
  private pendingContinuousBatchSignatures = new Map<string, string>();
  private flushContinuousBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private removeListener: (() => void) | null = null;

  public onState: ((event: TimelineStateEvent) => void) | null = null;
  public onRootSpec: ((spec: RootSpecification) => void) | null = null;
  public onControlUpdate: ((update: ControlUpdate) => void) | null = null;

  constructor(
    private sender: TransportSender,
    options?: TimelineClientOptions,
  ) {
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
    const previousTime = this.state.time;
    this.state.time = Math.max(0, time);
    const useRenderLanes = options?.useRenderLanes ?? false;
    const initialBufferedAmount = this.sender.getBufferedAmount?.() ?? 0;
    const pendingSignals: PendingAutomationSignal[] = [];

    for (const control of this.state.controls) {
      if (!control.enabled || control.manualOverride) continue;
      const entry = this.controlIndex.get(getPathKey(control.path));
      if (!entry) continue;
      const adapter = getTimelineAdapter(entry.spec);

      if (adapter.kind === 'keyframes') {
        const lane = control.lanes.find(candidate => candidate.enabled && candidate.type === 'keyframes');
        if (!lane || lane.type !== 'keyframes' || !adapter.getKeyframeValueBuffer) continue;
        const sourceLane = useRenderLanes && lane.renderKeyframes !== undefined
          ? { ...lane, keyframes: lane.renderKeyframes }
          : lane;
        const payload = adapter.getKeyframeValueBuffer(sourceLane)?.getValue(this.state.time);
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
        if (lane.type === 'trigger' && triggerSource) {
          const key = getPathKey(control.path);
          const edgeSignals: PendingAutomationSignal[] = [];
          for (const edge of getSortedTriggerEdgesInRange(triggerSource, previousTime, this.state.time)) {
            const mapped = getLaneValueMap(entry.spec, this.lastValues.get(key) ?? {}, { value: edge.value });
            const leaf = buildSignalLeaf(entry.spec, mapped);
            if (!leaf) continue;
            edgeSignals.push({
              path: [...control.path],
              key,
              kind: 'trigger',
              leaf,
              values: mapped,
              signature: getSignalSignature(leaf),
            });
          }
          for (const pending of edgeSignals) {
            logSignal('send-trigger-edge', {
              path: pending.key,
              value: pending.values,
              time: this.state.time,
            });
            sendPendingSignal(this.sender, pending, this.clientId);
            this.lastValues.set(key, pending.values ?? {});
            this.lastSentSignalSignatures.set(key, pending.signature);
          }
        }
        const value = lane.type === 'trigger'
          ? getTriggerLaneValueBuffer(triggerSource ?? []).getValue(this.state.time)
          : (() => {
              const points = (isBezierCurveLane(lane) || isStepLane(lane)) && useRenderLanes && lane.renderPoints !== undefined
                ? lane.renderPoints
                : lane.points;
              return isStepLane(lane)
                ? getStepLaneValueBuffer(points, range.min, range.max).getValue(this.state.time)
                : getPlaybackLaneSampleBuffer(points, range.min, range.max, range.wrap ?? false).getValue(this.state.time);
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

    if (pendingSignals.length === 0) {
      return;
    }

    const bufferedAmount = this.sender.getBufferedAmount?.() ?? initialBufferedAmount;
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

    const shouldBypassBackpressure = options?.bypassBackpressure ?? false;
    const signalsToSend = !shouldBypassBackpressure && bufferedAmount > 0
      ? discreteSignals
      : pendingSignals;

    if (!shouldBypassBackpressure && bufferedAmount > 0) {
      if (continuousSignals.length > 0) {
        this.pendingContinuousBatch = new Messages.ControlSignalBatch(
          buildSignalBatch(continuousSignals),
          undefined,
          { kind: 'timeline', clientId: this.clientId },
        );
        this.pendingContinuousBatchSignatures = new Map(
          continuousSignals.map(signal => [signal.key, signal.signature]),
        );
        this.schedulePendingContinuousBatchFlush();
      }
      for (const pending of continuousSignals) {
        logSignal('send-skipped', {
          path: pending.key,
          kind: pending.kind,
          reason: 'backpressure-buffered-latest',
          bufferedAmount,
          values: pending.values,
        });
      }
    }

    if (signalsToSend.length === 0) {
      return;
    }

    const batch = new Messages.ControlSignalBatch(
      buildSignalBatch(signalsToSend),
      undefined,
      { kind: 'timeline', clientId: this.clientId },
    );
    logSignal('send-batch', {
      signalCount: signalsToSend.length,
      discreteCount: discreteSignals.length,
      continuousCount: continuousSignals.length,
      bufferedAmount,
    });
    this.sender.send(batch);
    for (const signal of signalsToSend) {
      this.lastSentSignalSignatures.set(signal.key, signal.signature);
    }
  }

  private schedulePendingContinuousBatchFlush() {
    if (this.flushContinuousBatchTimer !== null) {
      return;
    }

    const pump = () => {
      this.flushContinuousBatchTimer = null;
      if (!this.pendingContinuousBatch) {
        return;
      }

      const bufferedAmount = this.sender.getBufferedAmount?.() ?? 0;
      if (bufferedAmount > 0) {
        this.flushContinuousBatchTimer = setTimeout(pump, 16);
        return;
      }

      const pendingBatch = this.pendingContinuousBatch;
      const pendingSignatures = this.pendingContinuousBatchSignatures;
      this.pendingContinuousBatch = null;
      this.pendingContinuousBatchSignatures = new Map();

      logSignal('send-batch', {
        signalCount: pendingBatch.signals.length,
        discreteCount: 0,
        continuousCount: pendingBatch.signals.length,
        bufferedAmount,
        source: 'pending-latest',
      });
      this.sender.send(pendingBatch);
      for (const [key, signature] of pendingSignatures) {
        this.lastSentSignalSignatures.set(key, signature);
      }
    };

    this.flushContinuousBatchTimer = setTimeout(pump, 16);
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
      const { path, leaf } = extractUpdatePath(update.update);
      const key = getPathKey(path);
      if (this.ignoredControlPaths.has(key)) {
        return;
      }
      logSignal('receive-update', {
        path: key,
        origin: update.origin,
        seq: update.seq,
        update: update.update,
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
              seq: (update as any).seq,
            });
            this.onControlUpdate?.(update);
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
            seq: (update as any).seq,
          });
          this.emitState('snapshot');
        }
      }
      this.onControlUpdate?.(update);
    }
  }

  dispose() {
    if (this.flushContinuousBatchTimer !== null) {
      clearTimeout(this.flushContinuousBatchTimer);
      this.flushContinuousBatchTimer = null;
    }
    this.pendingContinuousBatch = null;
    this.pendingContinuousBatchSignatures.clear();
    this.removeListener?.();
    this.removeListener = null;
    this.onState = null;
    this.onRootSpec = null;
    this.onControlUpdate = null;
  }
}
