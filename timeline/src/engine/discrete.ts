import type { TimelinePoint, TimelineTrigger } from './types';

type StepBuffer = {
  points: TimelinePoint[];
  signature: string;
  getValue(time: number, binarySearch?: boolean): number | null;
};

type TriggerBuffer = {
  triggers: TimelineTrigger[];
  signature: string;
  getValue(time: number, binarySearch?: boolean): number | null;
};

const stepBufferCache = new WeakMap<TimelinePoint[], StepBuffer>();
const triggerBufferCache = new WeakMap<TimelineTrigger[], TriggerBuffer>();

function clampValue(value: number, min?: number, max?: number) {
  if (min === undefined || max === undefined) return value;
  if (min > max) return value;
  return Math.max(min, Math.min(max, value));
}

function sortStepPoints(points: TimelinePoint[]) {
  return [...points].sort((a, b) => a.t - b.t);
}

function sortTriggers(triggers: TimelineTrigger[]) {
  return [...triggers]
    .map(trigger => ({
      on: { t: trigger.on.t, value: trigger.on.value },
      off: { t: trigger.off.t },
    }))
    .sort((a, b) => a.on.t - b.on.t);
}

function getStepSignature(points: TimelinePoint[]) {
  return points.map(point => `${point.t}:${point.v}:${point.kind ?? 'pos'}`).join('|');
}

function getTriggerSignature(triggers: TimelineTrigger[]) {
  return triggers.map(trigger => `${trigger.on.t}:${trigger.on.value}:${trigger.off.t}`).join('|');
}

function lowerBoundTimeIndex<T>(items: T[], time: number, getTime: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getTime(items[mid]!) < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function upperBoundTimeIndex<T>(items: T[], time: number, getTime: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getTime(items[mid]!) <= time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function findStepWindow(points: TimelinePoint[], time: number, lastLeftIndex: number, binarySearch = false) {
  if (points.length === 0) return null;
  if (!binarySearch) {
    const clampedLeft = Math.max(0, Math.min(lastLeftIndex, points.length - 1));
    const left = points[clampedLeft];
    const right = points[clampedLeft + 1];
    if (left && (!right || (time >= left.t && time < right.t))) {
      return { leftIndex: clampedLeft, rightIndex: Math.min(points.length - 1, clampedLeft + 1) };
    }
    if (clampedLeft > 0) {
      const prevLeft = points[clampedLeft - 1];
      if (prevLeft && left && time >= prevLeft.t && time < left.t) {
        return { leftIndex: clampedLeft - 1, rightIndex: clampedLeft };
      }
    }
    if (right) {
      const nextRight = points[clampedLeft + 2];
      if (nextRight && time >= right.t && time < nextRight.t) {
        return { leftIndex: clampedLeft + 1, rightIndex: clampedLeft + 2 };
      }
    }
  }

  const rightIndex = upperBoundTimeIndex(points, time, point => point.t);
  if (rightIndex <= 0) return { leftIndex: 0, rightIndex: Math.min(1, points.length - 1) };
  if (rightIndex >= points.length) {
    return { leftIndex: points.length - 1, rightIndex: points.length - 1 };
  }
  return { leftIndex: rightIndex - 1, rightIndex };
}

function findTriggerWindow(triggers: TimelineTrigger[], time: number, lastIndex: number, binarySearch = false) {
  if (triggers.length === 0) return -1;
  if (!binarySearch) {
    const clampedIndex = Math.max(0, Math.min(lastIndex, triggers.length - 1));
    const current = triggers[clampedIndex];
    if (current && time >= current.on.t && time < current.off.t) return clampedIndex;

    const previous = triggers[clampedIndex - 1];
    if (previous && time >= previous.on.t && time < previous.off.t) return clampedIndex - 1;

    const next = triggers[clampedIndex + 1];
    if (next && time >= next.on.t && time < next.off.t) return clampedIndex + 1;

    if (current) {
      if (time < current.on.t) return clampedIndex;
      if (time >= current.off.t && (!next || time < next.on.t)) return clampedIndex;
    }
  }

  const insertIndex = lowerBoundTimeIndex(triggers, time, trigger => trigger.on.t);
  if (insertIndex > 0) {
    const active = triggers[insertIndex - 1]!;
    if (time < active.off.t) return insertIndex - 1;
  }
  return Math.max(0, Math.min(triggers.length - 1, insertIndex));
}

export function getStepLaneValueBuffer(points: TimelinePoint[], min?: number, max?: number): StepBuffer {
  const signature = getStepSignature(points);
  const cached = stepBufferCache.get(points);
  if (cached && cached.signature === signature) {
    return cached;
  }

  const sorted = sortStepPoints(points);
  let lastLeftIndex: number | null = null;
  const buffer: StepBuffer = {
    points: sorted,
    signature,
    getValue(time: number, binarySearch = false) {
      if (!sorted.length) return null;
      if (sorted.length === 1) return clampValue(sorted[0]!.v, min, max);
      if (time <= sorted[0]!.t) return clampValue(sorted[0]!.v, min, max);
      const last = sorted[sorted.length - 1]!;
      if (time >= last.t) return clampValue(last.v, min, max);
      const window = findStepWindow(sorted, time, lastLeftIndex ?? 0, binarySearch || lastLeftIndex === null);
      if (!window) return null;
      lastLeftIndex = window.leftIndex;
      return clampValue(sorted[window.leftIndex]!.v, min, max);
    },
  };
  stepBufferCache.set(points, buffer);
  return buffer;
}

export function evalStepLane(points: TimelinePoint[], time: number, min?: number, max?: number): number | null {
  return getStepLaneValueBuffer(points, min, max).getValue(time);
}

export function getTriggerLaneValueBuffer(triggers: TimelineTrigger[]): TriggerBuffer {
  const signature = getTriggerSignature(triggers);
  const cached = triggerBufferCache.get(triggers);
  if (cached && cached.signature === signature) {
    return cached;
  }

  const sorted = sortTriggers(triggers);
  let lastIndex: number | null = null;
  const buffer: TriggerBuffer = {
    triggers: sorted,
    signature,
    getValue(time: number, binarySearch = false) {
      if (!sorted.length) return null;
      if (time < sorted[0]!.on.t) return -0.5;
      const index = findTriggerWindow(sorted, time, lastIndex ?? 0, binarySearch || lastIndex === null);
      lastIndex = index;
      const trigger = sorted[index];
      if (!trigger) return -0.5;
      if (time < trigger.on.t) return -0.5;
      if (time < trigger.off.t) return Math.max(0, trigger.on.value);
      return -0.5;
    },
  };
  triggerBufferCache.set(triggers, buffer);
  return buffer;
}

export function evalTriggerLane(triggers: TimelineTrigger[], time: number): number | null {
  return getTriggerLaneValueBuffer(triggers).getValue(time);
}
