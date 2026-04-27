import type { TimelinePoint } from './types';

type Point2 = { t: number; v: number };
type WrapOptions = { min: number; max: number; wrap: true } | { min?: number; max?: number; wrap?: false };
type CachedLaneSampleBuffer = LaneSampleBuffer & {
  samples: Point2[];
  settingsKey: string;
  signature: string;
};
export type LaneSampleBuffer = {
  samples: Point2[];
  getValue(time: number, binarySearch?: boolean): number | null;
  getSamplesInRange(start: number, end: number, includeSampleBefore?: boolean, includeSampleAfter?: boolean): Point2[];
};

type LaneBufferOptions = {
  samplesPerControlHandle?: number;
  min?: number;
  max?: number;
  wrap?: boolean;
};

const RENDER_SAMPLES_PER_CONTROL_HANDLE = 16;
const PLAYBACK_SAMPLES_PER_CONTROL_HANDLE = 32;

const laneBufferCache = new WeakMap<TimelinePoint[], Map<string, CachedLaneSampleBuffer>>();

function isPos(point: TimelinePoint) {
  return (point.kind ?? 'pos') === 'pos';
}

function sortByTime(points: TimelinePoint[]) {
  return [...points].sort((a, b) => a.t - b.t);
}

function getPositionalPoints(points: TimelinePoint[]) {
  return sortByTime(points).filter(isPos);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function deCasteljau(points: Point2[], t: number): Point2 {
  let current = points.map(p => ({ ...p }));
  for (let k = current.length - 1; k > 0; k--) {
    for (let i = 0; i < k; i++) {
      current[i] = {
        t: lerp(current[i]!.t, current[i + 1]!.t, t),
        v: lerp(current[i]!.v, current[i + 1]!.v, t),
      };
    }
  }
  return current[0]!;
}

function clampValue(value: number, min?: number, max?: number) {
  if (min === undefined || max === undefined) return value;
  if (min > max) return value;
  return Math.max(min, Math.min(max, value));
}

function wrapValue(value: number, min: number, max: number) {
  const range = max - min;
  if (!Number.isFinite(range) || range <= 0) return value;
  return ((((value - min) % range) + range) % range) + min;
}

function shortestWrappedDelta(from: number, to: number, min: number, max: number) {
  const range = max - min;
  if (!Number.isFinite(range) || range <= 0) return to - from;
  let delta = (to - from) % range;
  if (delta > range / 2) delta -= range;
  if (delta < -range / 2) delta += range;
  return delta;
}

function mapValueForOutput(value: number, options?: WrapOptions) {
  if (options?.wrap && options.min !== undefined && options.max !== undefined) {
    return wrapValue(value, options.min, options.max);
  }
  return clampValue(value, options?.min, options?.max);
}

function buildSegments(points: TimelinePoint[]) {
  const sorted = sortByTime(points);
  const segments: TimelinePoint[][] = [];
  let current: TimelinePoint[] = [];
  for (const point of sorted) {
    if (isPos(point)) {
      if (current.length) {
        current.push(point);
        segments.push(current);
        current = [point];
      } else {
        current.push(point);
      }
    } else {
      if (!current.length) continue;
      current.push(point);
    }
  }
  return segments;
}

function segmentToBezierPoints(segment: TimelinePoint[]) {
  const points: Point2[] = segment.map(p => ({ t: p.t, v: p.v }));
  return points;
}

function segmentToWrappedBezierPoints(segment: TimelinePoint[], min: number, max: number) {
  const points: Point2[] = [];
  let previousValue: number | null = null;
  for (const point of segment) {
    if (previousValue === null) {
      previousValue = point.v;
      points.push({ t: point.t, v: point.v });
      continue;
    }
    const nextValue: number = previousValue + shortestWrappedDelta(previousValue, point.v, min, max);
    points.push({ t: point.t, v: nextValue });
    previousValue = nextValue;
  }
  return points;
}

export function getLaneHoldValues(points: TimelinePoint[], min?: number, max?: number, wrap = false) {
  const sorted = sortByTime(points);
  const positional = sorted.filter(isPos);
  if (!positional.length) {
    return null;
  }

  const first = positional[0]!;
  const last = positional[positional.length - 1]!;
  const firstIndex = sorted.indexOf(first);
  const lastIndex = sorted.indexOf(last);
  const firstHandle = firstIndex > 0 ? sorted[firstIndex - 1] : undefined;
  const lastHandle = lastIndex >= 0 ? sorted[lastIndex + 1] : undefined;
  const wrapOptions: WrapOptions = wrap && min !== undefined && max !== undefined
    ? { min, max, wrap: true }
    : { min, max, wrap: false };

  const startValue = mapValueForOutput(
    firstHandle && !isPos(firstHandle) ? firstHandle.v : first.v,
    wrapOptions,
  );
  const endValue = mapValueForOutput(
    lastHandle && !isPos(lastHandle) ? lastHandle.v : last.v,
    wrapOptions,
  );

  return {
    startTime: first.t,
    endTime: last.t,
    startValue,
    endValue,
  };
}

function getSamplesForSegment(segment: TimelinePoint[], samplesPerControlHandle: number) {
  const controlHandleCount = Math.max(0, segment.length - 2)
  if (controlHandleCount === 0) return 1
  return Math.max(1, controlHandleCount * samplesPerControlHandle)
}

function getLaneBufferSignature(points: TimelinePoint[]) {
  return points.map(point => `${point.t}:${point.v}:${point.kind ?? 'pos'}`).join('|')
}

function getLaneBufferSettingsKey(samplesPerControlHandle: number, min?: number, max?: number, wrap = false) {
  return `${samplesPerControlHandle}:${min ?? 'n'}:${max ?? 'n'}:${wrap ? 1 : 0}`
}

function buildLaneSamples(points: TimelinePoint[], samplesPerControlHandle = RENDER_SAMPLES_PER_CONTROL_HANDLE, min?: number, max?: number, wrap = false): Point2[] {
  if (points.length === 0) {
    return [];
  }
  const segments = buildSegments(points);
  if (!segments.length) {
    return [];
  }
  const samples: Point2[] = [];
  const wrapOptions: WrapOptions = wrap && min !== undefined && max !== undefined
    ? { min, max, wrap: true }
    : { min, max, wrap: false };
  for (const segment of segments) {
    if (segment.length === 2) {
      const start = segment[0]!;
      const end = segment[1]!;
      samples.push({ t: start.t, v: mapValueForOutput(start.v, wrapOptions) });
      if (wrapOptions.wrap) {
        samples.push({
          t: end.t,
          v: mapValueForOutput(start.v + shortestWrappedDelta(start.v, end.v, min!, max!), wrapOptions),
        });
      } else {
        samples.push({ t: end.t, v: mapValueForOutput(end.v, wrapOptions) });
      }
      continue;
    }
    const controlPoints = wrapOptions.wrap
      ? segmentToWrappedBezierPoints(segment, min!, max!)
      : segmentToBezierPoints(segment);
    const samplesForSegment = getSamplesForSegment(segment, samplesPerControlHandle);
    for (let i = 0; i <= samplesForSegment; i++) {
      const t = i / samplesForSegment;
      const sample = deCasteljau(controlPoints, t);
      samples.push({ t: sample.t, v: mapValueForOutput(sample.v, wrapOptions) });
    }
  }
  return samples.sort((a, b) => a.t - b.t);
}

function findInterpolationWindow(samples: Point2[], time: number, lastLeftIndex: number, binarySearch = false) {
  if (samples.length === 0) {
    return null;
  }
  if (!binarySearch) {
    const clampedLastLeftIndex = Math.max(0, Math.min(lastLeftIndex, samples.length - 1));
    const previous = samples[clampedLastLeftIndex];
    const next = samples[clampedLastLeftIndex + 1];
    if (previous && next && time >= previous.t && time <= next.t) {
      return { leftIndex: clampedLastLeftIndex, rightIndex: clampedLastLeftIndex + 1 };
    }
    if (previous && clampedLastLeftIndex > 0) {
      const prevPrevious = samples[clampedLastLeftIndex - 1];
      if (prevPrevious && time >= prevPrevious.t && time <= previous.t) {
        return { leftIndex: clampedLastLeftIndex - 1, rightIndex: clampedLastLeftIndex };
      }
    }
    if (next && clampedLastLeftIndex + 2 < samples.length) {
      const nextNext = samples[clampedLastLeftIndex + 2];
      if (nextNext && time >= next.t && time <= nextNext.t) {
        return { leftIndex: clampedLastLeftIndex + 1, rightIndex: clampedLastLeftIndex + 2 };
      }
    }
  }

  const rightIndex = lowerBoundSampleIndex(samples, time);
  if (rightIndex <= 0) {
    return { leftIndex: 0, rightIndex: 0 };
  }
  if (rightIndex >= samples.length) {
    return { leftIndex: samples.length - 1, rightIndex: samples.length - 1 };
  }
  return { leftIndex: rightIndex - 1, rightIndex };
}

function createLaneSampleBuffer(points: TimelinePoint[], samplesPerControlHandle = RENDER_SAMPLES_PER_CONTROL_HANDLE, min?: number, max?: number, wrap = false): CachedLaneSampleBuffer {
  const signature = getLaneBufferSignature(points);
  const settingsKey = getLaneBufferSettingsKey(samplesPerControlHandle, min, max, wrap);
  const samples = buildLaneSamples(points, samplesPerControlHandle, min, max, wrap);
  const wrapOptions = getWrapOptions({ min, max, wrap });
  let lastLeftIndex: number | null = null;

  return {
    samples,
    settingsKey,
    signature,
    getValue(time: number, binarySearch = false) {
      if (!points.length) return null;
      const sorted = getPositionalPoints(points);
      if (sorted.length === 1) return mapValueForOutput(sorted[0]!.v, wrapOptions);
      const holdValues = getLaneHoldValues(points, min, max, wrap);
      if (time <= sorted[0]!.t) {
        return holdValues ? holdValues.startValue : mapValueForOutput(sorted[0]!.v, wrapOptions);
      }
      const last = sorted[sorted.length - 1]!;
      if (time >= last.t) {
        return holdValues ? holdValues.endValue : mapValueForOutput(last.v, wrapOptions);
      }
      const window = findInterpolationWindow(samples, time, lastLeftIndex ?? 0, binarySearch || lastLeftIndex === null);
      if (!window) return null;
      lastLeftIndex = window.leftIndex;
      return evalLaneFromSamplesWindow(samples, window.leftIndex, window.rightIndex, time, wrapOptions);
    },
    getSamplesInRange(start: number, end: number, includeSampleBefore = false, includeSampleAfter = false) {
      if (!samples.length) return [];
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      let fromIndex = lowerBoundSampleIndex(samples, lower);
      let toIndex = lowerBoundSampleIndex(samples, upper);

      if (fromIndex > 0 && includeSampleBefore) {
        fromIndex -= 1;
      }
      if (toIndex < samples.length && includeSampleAfter) {
        toIndex += 1;
      } else if (toIndex < samples.length && samples[toIndex] && Math.abs(samples[toIndex]!.t - upper) < 1e-9) {
        toIndex += 1;
      }

      return samples.slice(fromIndex, Math.min(samples.length, toIndex));
    },
  };
}

function getLaneBufferInternals(points: TimelinePoint[], samplesPerControlHandle = RENDER_SAMPLES_PER_CONTROL_HANDLE, min?: number, max?: number, wrap = false) {
  const signature = getLaneBufferSignature(points);
  const settingsKey = getLaneBufferSettingsKey(samplesPerControlHandle, min, max, wrap);
  const cachedBySettings = laneBufferCache.get(points);
  const cached = cachedBySettings?.get(settingsKey);
  if (cached && cached.signature === signature) {
    return cached;
  }
  const next = createLaneSampleBuffer(points, samplesPerControlHandle, min, max, wrap);
  const nextCachedBySettings = cachedBySettings ?? new Map<string, CachedLaneSampleBuffer>();
  nextCachedBySettings.set(settingsKey, next);
  laneBufferCache.set(points, nextCachedBySettings);
  return next;
}

function getWrapOptions(options?: LaneBufferOptions): WrapOptions {
  return options?.wrap && options.min !== undefined && options.max !== undefined
    ? { min: options.min, max: options.max, wrap: true }
    : { min: options?.min, max: options?.max, wrap: false };
}

function lowerBoundSampleIndex(samples: Point2[], time: number) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid]!.t < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function getLaneSampleBuffer(points: TimelinePoint[], options?: LaneBufferOptions): LaneSampleBuffer {
  const samplesPerControlHandle = options?.samplesPerControlHandle ?? RENDER_SAMPLES_PER_CONTROL_HANDLE;
  return getLaneBufferInternals(points, samplesPerControlHandle, options?.min, options?.max, options?.wrap ?? false);
}

export function getRenderLaneSampleBuffer(points: TimelinePoint[], min?: number, max?: number, wrap = false) {
  return getLaneSampleBuffer(points, {
    samplesPerControlHandle: RENDER_SAMPLES_PER_CONTROL_HANDLE,
    min,
    max,
    wrap,
  });
}

export function getPlaybackLaneSampleBuffer(points: TimelinePoint[], min?: number, max?: number, wrap = false) {
  return getLaneSampleBuffer(points, {
    samplesPerControlHandle: PLAYBACK_SAMPLES_PER_CONTROL_HANDLE,
    min,
    max,
    wrap,
  });
}

function evalLaneFromSamplesWindow(samples: Point2[], leftIndex: number, rightIndex: number, time: number, wrapOptions: WrapOptions): number | null {
  const a = samples[leftIndex];
  const b = samples[rightIndex];
  if (!a || !b) return null;
  if (leftIndex === rightIndex) return mapValueForOutput(a.v, wrapOptions);
  const span = b.t - a.t;
  if (span <= 0) return mapValueForOutput(a.v, wrapOptions);
  const factor = (time - a.t) / span;
  if (wrapOptions.wrap) {
    const delta = shortestWrappedDelta(a.v, b.v, wrapOptions.min!, wrapOptions.max!);
    return mapValueForOutput(a.v + delta * factor, wrapOptions);
  }
  return mapValueForOutput(a.v + (b.v - a.v) * factor, wrapOptions);
}

export function ensureLaneHasPos(points: TimelinePoint[]) {
  return points.some(p => isPos(p));
}

export function normalizeLane(points: TimelinePoint[]) {
  const sorted = sortByTime(points);
  return sorted;
}

export function getLaneKind(point: TimelinePoint) {
  return point.kind ?? 'pos';
}
