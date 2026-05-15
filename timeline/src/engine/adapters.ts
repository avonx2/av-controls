import { Controls } from 'av-controls';
import type { TimelineKeyframe, TimelineLane } from './types';

type Quaternion = [number, number, number, number];
type Vec3 = [number, number, number];
type Dot = [number, number];
type Player3DPose = {
  position: Vec3;
  rotation: Quaternion;
};

type SanitizedPlayer3DKeyframe = TimelineKeyframe & {
  value: Player3DPose;
};

type Player3DSegment = {
  startTime: number;
  endTime: number;
  duration: number;
  positionStart: Vec3;
  positionEnd: Vec3;
  positionOutVelocity: Vec3;
  positionInVelocity: Vec3;
  rotationStart: Quaternion;
  rotationEnd: Quaternion;
  rotationOutControl: Quaternion;
  rotationInControl: Quaternion;
};

type PreparedPlayer3DCurve = {
  keyframes: SanitizedPlayer3DKeyframe[];
  segments: Player3DSegment[];
};

type KeyframeSample = {
  t: number;
  value: unknown;
};

export type KeyframeValueBuffer = {
  samples: KeyframeSample[];
  getValue(time: number, binarySearch?: boolean): unknown | null;
  getSamplesInRange(start: number, end: number, includeSampleBefore?: boolean, includeSampleAfter?: boolean): KeyframeSample[];
};

export type TimelineAdapter = {
  kind: 'curve' | 'step' | 'trigger' | 'keyframes';
  capturePayload: (state: unknown) => unknown;
  evaluateKeyframes?: (lane: TimelineLane, time: number) => unknown | null;
  getKeyframeValueBuffer?: (lane: TimelineLane) => KeyframeValueBuffer | null;
};

const PLAYER3D_CONTINUITY_EPSILON = 1e-3;
const VECTOR_EPSILON = 1e-8;

function cloneUnknown<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function clamp01(value: number | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function endpointSmoothness(left: number | undefined, right: number | undefined) {
  return Math.sqrt(clamp01(left) * clamp01(right));
}

function sortKeyframes(keyframes: TimelineKeyframe[]) {
  return [...keyframes].sort((a, b) => a.t - b.t);
}

function normalizeQuaternion(values: Quaternion): Quaternion {
  const length = Math.hypot(values[0], values[1], values[2], values[3]);
  if (length <= 1e-8) return [0, 0, 0, 1];
  return [
    values[0] / length,
    values[1] / length,
    values[2] / length,
    values[3] / length,
  ];
}

function alignQuaternionHemisphere(reference: Quaternion, value: Quaternion): Quaternion {
  const dot = reference[0] * value[0] + reference[1] * value[1] + reference[2] * value[2] + reference[3] * value[3];
  if (dot >= 0) return value;
  return [-value[0], -value[1], -value[2], -value[3]];
}

function quaternionMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quaternionConjugate(value: Quaternion): Quaternion {
  return [-value[0], -value[1], -value[2], value[3]];
}

function quaternionLog(value: Quaternion): Vec3 {
  const q = normalizeQuaternion(value);
  const vNorm = Math.hypot(q[0], q[1], q[2]);
  if (vNorm <= 1e-8) return [0, 0, 0];
  const angle = Math.atan2(vNorm, q[3]);
  const scale = angle / vNorm;
  return [q[0] * scale, q[1] * scale, q[2] * scale];
}

function quaternionExp(value: Vec3): Quaternion {
  const angle = Math.hypot(value[0], value[1], value[2]);
  if (angle <= 1e-8) return [0, 0, 0, 1];
  const sinAngle = Math.sin(angle);
  const scale = sinAngle / angle;
  return normalizeQuaternion([
    value[0] * scale,
    value[1] * scale,
    value[2] * scale,
    Math.cos(angle),
  ]);
}

function slerpQuaternion(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let from = normalizeQuaternion(a);
  let to = normalizeQuaternion(b);
  let dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3];
  if (dot < 0) {
    dot = -dot;
    to = [-to[0], -to[1], -to[2], -to[3]];
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
      from[3] + (to[3] - from[3]) * t,
    ]);
  }
  const theta0 = Math.acos(Math.max(-1, Math.min(1, dot)));
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0;
  const s1 = sinTheta / sinTheta0;
  return normalizeQuaternion([
    s0 * from[0] + s1 * to[0],
    s0 * from[1] + s1 * to[1],
    s0 * from[2] + s1 * to[2],
    s0 * from[3] + s1 * to[3],
  ]);
}

function sphericalCubicBezier(q0: Quaternion, q1: Quaternion, q2: Quaternion, q3: Quaternion, t: number): Quaternion {
  const q01 = slerpQuaternion(q0, q1, t);
  const q12 = slerpQuaternion(q1, q2, t);
  const q23 = slerpQuaternion(q2, q3, t);
  const q012 = slerpQuaternion(q01, q12, t);
  const q123 = slerpQuaternion(q12, q23, t);
  return slerpQuaternion(q012, q123, t);
}

function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vec3Scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function vec3Lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function vec3Length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function vec3NormalizeOr(a: Vec3, fallback: Vec3): Vec3 {
  const length = vec3Length(a);
  if (length <= VECTOR_EPSILON) return fallback;
  return [a[0] / length, a[1] / length, a[2] / length];
}

function dotSub(a: Dot, b: Dot): Dot {
  return [a[0] - b[0], a[1] - b[1]];
}

function dotScale(a: Dot, factor: number): Dot {
  return [a[0] * factor, a[1] * factor];
}

function hermiteScalar(p0: number, p1: number, m0: number, m1: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0
    + (t3 - 2 * t2 + t) * m0
    + (-2 * t3 + 3 * t2) * p1
    + (t3 - t2) * m1;
}

function hermiteVec3(p0: Vec3, p1: Vec3, m0: Vec3, m1: Vec3, t: number): Vec3 {
  return [
    hermiteScalar(p0[0], p1[0], m0[0], m1[0], t),
    hermiteScalar(p0[1], p1[1], m0[1], m1[1], t),
    hermiteScalar(p0[2], p1[2], m0[2], m1[2], t),
  ];
}

function hermiteDot(p0: Dot, p1: Dot, m0: Dot, m1: Dot, t: number): Dot {
  return [
    hermiteScalar(p0[0], p1[0], m0[0], m1[0], t),
    hermiteScalar(p0[1], p1[1], m0[1], m1[1], t),
  ];
}

function shapeSegmentParameter(u: number, startSmoothness: number, endSmoothness: number) {
  return clamp01(hermiteScalar(0, 1, startSmoothness, endSmoothness, u));
}

function lerpNumber(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function findKeyframeSegment(keyframes: TimelineKeyframe[], time: number) {
  const sorted = sortKeyframes(keyframes);
  if (!sorted.length) return null;
  if (time <= sorted[0]!.t) return { sorted, index: 0, atStart: true, atEnd: false };
  if (time >= sorted[sorted.length - 1]!.t) return { sorted, index: sorted.length - 1, atStart: false, atEnd: true };
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    if (time >= current.t && time <= next.t) {
      return { sorted, index: i, atStart: false, atEnd: false };
    }
  }
  return { sorted, index: sorted.length - 1, atStart: false, atEnd: true };
}

function sanitizePlayer3DPose(value: any): Player3DPose {
  const position = Array.isArray(value?.position) ? value.position : [];
  const rotation = Array.isArray(value?.rotation) ? value.rotation : [];
  return {
    position: [
      typeof position[0] === 'number' ? position[0] : 0,
      typeof position[1] === 'number' ? position[1] : 0,
      typeof position[2] === 'number' ? position[2] : 0,
    ] as Vec3,
    rotation: normalizeQuaternion([
      typeof rotation[0] === 'number' ? rotation[0] : 0,
      typeof rotation[1] === 'number' ? rotation[1] : 0,
      typeof rotation[2] === 'number' ? rotation[2] : 0,
      typeof rotation[3] === 'number' ? rotation[3] : 1,
    ]),
  };
}

function sanitizePlayer3DKeyframes(keyframes: TimelineKeyframe[]): SanitizedPlayer3DKeyframe[] {
  const sorted = sortKeyframes(keyframes).map((keyframe) => ({
    ...keyframe,
    value: sanitizePlayer3DPose(keyframe.value),
  }));

  for (let i = 1; i < sorted.length; i++) {
    sorted[i] = {
      ...sorted[i]!,
      value: {
        ...sorted[i]!.value,
        rotation: alignQuaternionHemisphere(sorted[i - 1]!.value.rotation, sorted[i]!.value.rotation),
      },
    };
  }

  return sorted;
}

function player3DKeyframeSignature(keyframes: SanitizedPlayer3DKeyframe[]) {
  return JSON.stringify(keyframes.map((keyframe) => ({
    t: keyframe.t,
    leftSmooth: keyframe.leftSmooth ?? null,
    rightSmooth: keyframe.rightSmooth ?? null,
    position: keyframe.value.position,
    rotation: keyframe.value.rotation,
  })));
}

function sanitizeDotsValue(value: any) {
  if (!Array.isArray(value?.values)) {
    return { values: [] as Dot[] };
  }
  return {
    values: value.values
      .filter((dot: any) => Array.isArray(dot) && typeof dot[0] === 'number' && typeof dot[1] === 'number')
      .map((dot: Dot) => [dot[0], dot[1]] as Dot),
  };
}

function sanitizeDotsKeyframes(keyframes: TimelineKeyframe[]) {
  return sortKeyframes(keyframes).map((keyframe) => ({
    ...keyframe,
    value: sanitizeDotsValue(keyframe.value),
  }));
}

function dotsKeyframeSignature(keyframes: ReturnType<typeof sanitizeDotsKeyframes>) {
  return JSON.stringify(keyframes.map((keyframe) => ({
    t: keyframe.t,
    leftSmooth: keyframe.leftSmooth ?? null,
    rightSmooth: keyframe.rightSmooth ?? null,
    values: keyframe.value.values,
  })));
}

function quaternionRelativeLog(from: Quaternion, to: Quaternion): Vec3 {
  return quaternionLog(quaternionMultiply(quaternionConjugate(from), alignQuaternionHemisphere(from, to)));
}

function velocityFromDelta(delta: Vec3, duration: number): Vec3 {
  return vec3Scale(delta, 1 / Math.max(1e-6, duration));
}

function weightedAverageVelocity(previous: Vec3 | null, previousDuration: number, next: Vec3 | null, nextDuration: number): Vec3 {
  if (previous && next) {
    const duration = Math.max(1e-6, previousDuration + nextDuration);
    return vec3Scale(vec3Add(vec3Scale(previous, previousDuration), vec3Scale(next, nextDuration)), 1 / duration);
  }
  return previous ?? next ?? [0, 0, 0];
}

function normalizePlayer3DContinuity(value: number | undefined) {
  const continuity = clamp01(value ?? 1);
  if (continuity <= PLAYER3D_CONTINUITY_EPSILON) return 0;
  if (continuity >= 1 - PLAYER3D_CONTINUITY_EPSILON) return 1;
  return (continuity - PLAYER3D_CONTINUITY_EPSILON) / (1 - 2 * PLAYER3D_CONTINUITY_EPSILON);
}

function player3DEdgeAmount(value: number | undefined) {
  const sharpness = 1 - normalizePlayer3DContinuity(value);
  return sharpness * sharpness * sharpness;
}

function blendVelocityDirection(smoothVelocity: Vec3, edgeVelocity: Vec3, edgeAmount: number): Vec3 {
  const smoothLength = vec3Length(smoothVelocity);
  const edgeLength = vec3Length(edgeVelocity);
  const smoothDirection = smoothLength > VECTOR_EPSILON
    ? vec3Scale(smoothVelocity, 1 / smoothLength)
    : null;
  const edgeDirection = edgeLength > VECTOR_EPSILON
    ? vec3Scale(edgeVelocity, 1 / edgeLength)
    : null;

  if (!smoothDirection && !edgeDirection) return [0, 0, 0];
  if (!smoothDirection) return edgeDirection!;
  if (!edgeDirection) return smoothDirection;
  if (edgeAmount <= 0) return smoothDirection;
  if (edgeAmount >= 1) return edgeDirection;

  return vec3NormalizeOr(
    vec3Lerp(smoothDirection, edgeDirection, edgeAmount),
    edgeAmount < 0.5 ? smoothDirection : edgeDirection,
  );
}

function resolveKeyframeVelocities(
  previousVelocity: Vec3 | null,
  nextVelocity: Vec3 | null,
  smoothVelocity: Vec3,
  leftSmooth: number | undefined,
  rightSmooth: number | undefined,
) {
  const leftEdge = player3DEdgeAmount(leftSmooth);
  const rightEdge = player3DEdgeAmount(rightSmooth);
  const smoothSpeed = vec3Length(smoothVelocity);
  let chordSpeed = 0;
  let chordSpeedCount = 0;
  let edge = 0;
  let edgeCount = 0;

  if (previousVelocity) {
    chordSpeed += vec3Length(previousVelocity);
    chordSpeedCount += 1;
    edge += leftEdge;
    edgeCount += 1;
  }
  if (nextVelocity) {
    chordSpeed += vec3Length(nextVelocity);
    chordSpeedCount += 1;
    edge += rightEdge;
    edgeCount += 1;
  }

  const targetSpeed = chordSpeedCount > 0 ? chordSpeed / chordSpeedCount : smoothSpeed;
  const speedEdge = edgeCount > 0 ? edge / edgeCount : 0;
  // Preserve scalar speed continuity at the keyframe while handles split direction.
  const sharedSpeed = lerpNumber(smoothSpeed, targetSpeed, speedEdge);
  const fallbackDirection = vec3NormalizeOr(smoothVelocity, [0, 0, 0]);
  const inDirection = previousVelocity
    ? blendVelocityDirection(smoothVelocity, previousVelocity, leftEdge)
    : nextVelocity
      ? blendVelocityDirection(smoothVelocity, nextVelocity, rightEdge)
      : fallbackDirection;
  const outDirection = nextVelocity
    ? blendVelocityDirection(smoothVelocity, nextVelocity, rightEdge)
    : previousVelocity
      ? blendVelocityDirection(smoothVelocity, previousVelocity, leftEdge)
      : fallbackDirection;

  return {
    inVelocity: vec3Scale(inDirection, sharedSpeed),
    outVelocity: vec3Scale(outDirection, sharedSpeed),
  };
}

function solveTridiagonalVec3(lower: number[], diagonal: number[], upper: number[], rhs: Vec3[]) {
  const count = diagonal.length;
  const d = diagonal.slice();
  const b = rhs.map(value => [...value] as Vec3);

  for (let i = 1; i < count; i++) {
    const denominator = Math.abs(d[i - 1]!) <= VECTOR_EPSILON ? VECTOR_EPSILON : d[i - 1]!;
    const factor = lower[i]! / denominator;
    d[i] = d[i]! - factor * upper[i - 1]!;
    b[i] = vec3Sub(b[i]!, vec3Scale(b[i - 1]!, factor));
  }

  const result = new Array<Vec3>(count);
  const lastDenominator = Math.abs(d[count - 1]!) <= VECTOR_EPSILON ? VECTOR_EPSILON : d[count - 1]!;
  result[count - 1] = vec3Scale(b[count - 1]!, 1 / lastDenominator);

  for (let i = count - 2; i >= 0; i--) {
    const denominator = Math.abs(d[i]!) <= VECTOR_EPSILON ? VECTOR_EPSILON : d[i]!;
    result[i] = vec3Scale(vec3Sub(b[i]!, vec3Scale(result[i + 1]!, upper[i]!)), 1 / denominator);
  }

  return result;
}

function solveClampedCubicVelocities(
  keyframes: SanitizedPlayer3DKeyframe[],
  getValue: (keyframe: SanitizedPlayer3DKeyframe) => Vec3,
) {
  const count = keyframes.length;
  if (count === 1) return [[0, 0, 0] as Vec3];

  const values = keyframes.map(getValue);
  const durations = values.slice(0, -1).map((_, index) => Math.max(1e-6, keyframes[index + 1]!.t - keyframes[index]!.t));
  if (count === 2) {
    const velocity = velocityFromDelta(vec3Sub(values[1]!, values[0]!), durations[0]!);
    return [velocity, velocity];
  }

  const lower = new Array<number>(count).fill(0);
  const diagonal = new Array<number>(count).fill(0);
  const upper = new Array<number>(count).fill(0);
  const rhs = new Array<Vec3>(count);

  diagonal[0] = 1;
  rhs[0] = velocityFromDelta(vec3Sub(values[1]!, values[0]!), durations[0]!);
  diagonal[count - 1] = 1;
  rhs[count - 1] = velocityFromDelta(vec3Sub(values[count - 1]!, values[count - 2]!), durations[count - 2]!);

  for (let i = 1; i < count - 1; i++) {
    const previousDuration = durations[i - 1]!;
    const nextDuration = durations[i]!;
    const previousDelta = vec3Sub(values[i]!, values[i - 1]!);
    const nextDelta = vec3Sub(values[i + 1]!, values[i]!);

    lower[i] = nextDuration;
    diagonal[i] = 2 * (previousDuration + nextDuration);
    upper[i] = previousDuration;
    rhs[i] = vec3Scale(
      vec3Add(
        vec3Scale(previousDelta, nextDuration / previousDuration),
        vec3Scale(nextDelta, previousDuration / nextDuration),
      ),
      3,
    );
  }

  return solveTridiagonalVec3(lower, diagonal, upper, rhs);
}

function getPositionVelocities(keyframes: SanitizedPlayer3DKeyframe[]) {
  const inVelocities: Vec3[] = [];
  const outVelocities: Vec3[] = [];
  const smoothVelocities = solveClampedCubicVelocities(keyframes, keyframe => keyframe.value.position);

  for (let i = 0; i < keyframes.length; i++) {
    const keyframe = keyframes[i]!;
    const previous = i > 0 ? keyframes[i - 1]! : null;
    const next = i + 1 < keyframes.length ? keyframes[i + 1]! : null;
    const previousDuration = previous ? keyframe.t - previous.t : 0;
    const nextDuration = next ? next.t - keyframe.t : 0;
    const previousVelocity = previous
      ? velocityFromDelta(vec3Sub(keyframe.value.position, previous.value.position), previousDuration)
      : null;
    const nextVelocity = next
      ? velocityFromDelta(vec3Sub(next.value.position, keyframe.value.position), nextDuration)
      : null;
    const velocities = resolveKeyframeVelocities(
      previousVelocity,
      nextVelocity,
      smoothVelocities[i]!,
      keyframe.leftSmooth,
      keyframe.rightSmooth,
    );

    inVelocities.push(velocities.inVelocity);
    outVelocities.push(velocities.outVelocity);
  }

  return { inVelocities, outVelocities };
}

function getRotationVelocities(keyframes: SanitizedPlayer3DKeyframe[]) {
  const inVelocities: Vec3[] = [];
  const outVelocities: Vec3[] = [];

  for (let i = 0; i < keyframes.length; i++) {
    const keyframe = keyframes[i]!;
    const previous = i > 0 ? keyframes[i - 1]! : null;
    const next = i + 1 < keyframes.length ? keyframes[i + 1]! : null;
    const previousDuration = previous ? keyframe.t - previous.t : 0;
    const nextDuration = next ? next.t - keyframe.t : 0;
    const previousVelocity = previous
      ? velocityFromDelta(vec3Scale(quaternionRelativeLog(keyframe.value.rotation, previous.value.rotation), -1), previousDuration)
      : null;
    const nextVelocity = next
      ? velocityFromDelta(quaternionRelativeLog(keyframe.value.rotation, next.value.rotation), nextDuration)
      : null;
    const smoothVelocity = weightedAverageVelocity(previousVelocity, previousDuration, nextVelocity, nextDuration);
    const velocities = resolveKeyframeVelocities(
      previousVelocity,
      nextVelocity,
      smoothVelocity,
      keyframe.leftSmooth,
      keyframe.rightSmooth,
    );

    inVelocities.push(velocities.inVelocity);
    outVelocities.push(velocities.outVelocity);
  }

  return { inVelocities, outVelocities };
}

function findSegmentIndexFromTime(keyframes: SanitizedPlayer3DKeyframe[], time: number) {
  if (time <= keyframes[0]!.t) return 0;
  if (time >= keyframes[keyframes.length - 1]!.t) return keyframes.length - 2;
  let low = 0;
  let high = keyframes.length - 2;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = keyframes[mid]!.t;
    const end = keyframes[mid + 1]!.t;
    if (time < start) {
      high = mid - 1;
    } else if (time > end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(keyframes.length - 2, low));
}

const player3DCurveCache = new WeakMap<TimelineLane, { signature: string; curve: PreparedPlayer3DCurve }>();

function preparePlayer3DCurve(lane: TimelineLane): PreparedPlayer3DCurve | null {
  if (lane.type !== 'keyframes') return null;
  const sanitizedKeyframes = sanitizePlayer3DKeyframes(lane.keyframes);
  if (!sanitizedKeyframes.length) return null;
  if (sanitizedKeyframes.length === 1) {
    return {
      keyframes: sanitizedKeyframes,
      segments: [],
    };
  }

  const signature = player3DKeyframeSignature(sanitizedKeyframes);
  const cached = player3DCurveCache.get(lane);
  if (cached && cached.signature === signature) return cached.curve;

  const positionVelocities = getPositionVelocities(sanitizedKeyframes);
  const rotationVelocities = getRotationVelocities(sanitizedKeyframes);
  const segments: Player3DSegment[] = [];
  for (let i = 0; i < sanitizedKeyframes.length - 1; i++) {
    const start = sanitizedKeyframes[i]!;
    const end = sanitizedKeyframes[i + 1]!;
    const duration = Math.max(1e-6, end.t - start.t);
    const rotationOutVelocity = rotationVelocities.outVelocities[i]!;
    const rotationInVelocity = rotationVelocities.inVelocities[i + 1]!;
    const rotationOutControl = normalizeQuaternion(quaternionMultiply(
      start.value.rotation,
      quaternionExp(vec3Scale(rotationOutVelocity, duration / 3)),
    ));
    const rotationInControl = normalizeQuaternion(quaternionMultiply(
      end.value.rotation,
      quaternionExp(vec3Scale(rotationInVelocity, -duration / 3)),
    ));

    segments.push({
      startTime: start.t,
      endTime: end.t,
      duration,
      positionStart: start.value.position,
      positionEnd: end.value.position,
      positionOutVelocity: positionVelocities.outVelocities[i]!,
      positionInVelocity: positionVelocities.inVelocities[i + 1]!,
      rotationStart: start.value.rotation,
      rotationEnd: end.value.rotation,
      rotationOutControl,
      rotationInControl,
    });
  }

  const curve = {
    keyframes: sanitizedKeyframes,
    segments,
  };
  player3DCurveCache.set(lane, { signature, curve });
  return curve;
}

function evaluatePlayer3DKeyframes(lane: TimelineLane, time: number) {
  const prepared = preparePlayer3DCurve(lane);
  if (!prepared) return null;
  return evaluatePreparedPlayer3DKeyframes(prepared, time);
}

function evaluatePreparedPlayer3DKeyframes(prepared: PreparedPlayer3DCurve, time: number) {
  const { keyframes, segments } = prepared;
  if (keyframes.length === 1 || !segments.length) return keyframes[0]!.value;
  if (time <= keyframes[0]!.t) return keyframes[0]!.value;
  if (time >= keyframes[keyframes.length - 1]!.t) return keyframes[keyframes.length - 1]!.value;
  const segment = segments[findSegmentIndexFromTime(keyframes, time)]!;
  const u = clamp01((time - segment.startTime) / segment.duration);

  return {
    position: hermiteVec3(
      segment.positionStart,
      segment.positionEnd,
      vec3Scale(segment.positionOutVelocity, segment.duration),
      vec3Scale(segment.positionInVelocity, segment.duration),
      u,
    ),
    rotation: sphericalCubicBezier(
      segment.rotationStart,
      segment.rotationOutControl,
      segment.rotationInControl,
      segment.rotationEnd,
      u,
    ),
  };
}

function evaluateDotsPreparedKeyframes(sorted: ReturnType<typeof sanitizeDotsKeyframes>, time: number) {
  if (!sorted.length) return null;
  const segment = findKeyframeSegment(sorted, time);
  if (!segment) return null;
  const { index, atStart, atEnd } = segment;
  if (atStart || atEnd || index >= sorted.length - 1) {
    return sanitizeDotsValue(sorted[Math.min(index, sorted.length - 1)]!.value);
  }

  const current = sorted[index]!;
  const next = sorted[index + 1]!;
  const a = sanitizeDotsValue(current.value);
  const b = sanitizeDotsValue(next.value);
  if (a.values.length !== b.values.length) {
    return time - current.t <= next.t - time ? a : b;
  }
  const dt = Math.max(1e-6, next.t - current.t);
  const u = (time - current.t) / dt;
  const currentSmoothness = endpointSmoothness(current.leftSmooth, current.rightSmooth);
  const nextSmoothness = endpointSmoothness(next.leftSmooth, next.rightSmooth);
  const shapedU = shapeSegmentParameter(u, currentSmoothness, nextSmoothness);
  if (sorted.length < 3) {
    return {
      values: a.values.map((dot: Dot, indexDot: number) => {
        const nextDot = b.values[indexDot]!;
        return [
          dot[0] + (nextDot[0] - dot[0]) * shapedU,
          dot[1] + (nextDot[1] - dot[1]) * shapedU,
        ] as Dot;
      }),
    };
  }

  const prev = index > 0 ? sanitizeDotsValue(sorted[index - 1]!.value) : a;
  const after = index + 2 < sorted.length ? sanitizeDotsValue(sorted[index + 2]!.value) : b;
  if (prev.values.length !== a.values.length || after.values.length !== b.values.length) {
    return {
      values: a.values.map((dot: Dot, indexDot: number) => {
        const nextDot = b.values[indexDot]!;
        return [
          dot[0] + (nextDot[0] - dot[0]) * shapedU,
          dot[1] + (nextDot[1] - dot[1]) * shapedU,
        ] as Dot;
      }),
    };
  }

  const rightStrength = clamp01(current.rightSmooth);
  const leftStrength = clamp01(next.leftSmooth);
  const spanOut = Math.max(1e-6, sorted[index + 1]!.t - sorted[Math.max(0, index - 1)]!.t);
  const spanIn = Math.max(1e-6, sorted[Math.min(index + 2, sorted.length - 1)]!.t - sorted[index]!.t);

  return {
    values: a.values.map((dot: Dot, indexDot: number) => {
      const prevDot = prev.values[indexDot]!;
      const nextDot = b.values[indexDot]!;
      const afterDot = after.values[indexDot]!;
      const tangentOut = dotScale(dotSub(nextDot, prevDot), (0.5 * rightStrength * dt) / spanOut);
      const tangentIn = dotScale(dotSub(afterDot, dot), (0.5 * leftStrength * dt) / spanIn);
      return hermiteDot(dot, nextDot, tangentOut, tangentIn, shapedU);
    }),
  };
}

function evaluateDotsKeyframes(lane: TimelineLane, time: number) {
  if (lane.type !== 'keyframes') return null;
  return evaluateDotsPreparedKeyframes(sanitizeDotsKeyframes(lane.keyframes), time);
}

const KEYFRAME_SAMPLES_PER_SEGMENT = 32;
const PLAYER3D_KEYFRAME_SAMPLES_PER_SEGMENT = 64;

function lowerBoundSampleIndex(samples: KeyframeSample[], time: number) {
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

function createKeyframeValueBuffer(
  times: number[],
  evaluateAtTime: (time: number) => unknown | null,
  interpolateValues: (a: unknown, b: unknown, t: number) => unknown,
  samplesPerSegment = KEYFRAME_SAMPLES_PER_SEGMENT,
): KeyframeValueBuffer {
  const samples: KeyframeSample[] = [];
  for (let segmentIndex = 0; segmentIndex < Math.max(1, times.length - 1); segmentIndex++) {
    const start = times[segmentIndex]!;
    const end = times[Math.min(times.length - 1, segmentIndex + 1)]!;
    const sampleCount = segmentIndex === times.length - 1 ? 0 : samplesPerSegment;
    for (let i = 0; i <= sampleCount; i++) {
      const factor = sampleCount === 0 ? 0 : i / sampleCount;
      const t = start + (end - start) * factor;
      const value = evaluateAtTime(t);
      if (value === null || value === undefined) continue;
      const previous = samples[samples.length - 1];
      if (previous && Math.abs(previous.t - t) < 1e-9) {
        previous.value = value;
      } else {
        samples.push({ t, value });
      }
    }
  }
  return createKeyframeValueBufferFromSamples(samples, interpolateValues);
}

const player3DValueBufferCache = new WeakMap<TimelineLane, {
  signature: string;
  buffer: KeyframeValueBuffer;
}>();
const dotsValueBufferCache = new WeakMap<TimelineLane, { signature: string; buffer: KeyframeValueBuffer }>();

function interpolatePlayer3DValues(a: unknown, b: unknown, t: number) {
  const from = sanitizePlayer3DPose(a);
  const to = sanitizePlayer3DPose(b);
  return {
    position: vec3Lerp(from.position, to.position, t),
    rotation: slerpQuaternion(from.rotation, to.rotation, t),
  };
}

function interpolateDotsValues(a: unknown, b: unknown, t: number) {
  const from = sanitizeDotsValue(a);
  const to = sanitizeDotsValue(b);
  if (from.values.length !== to.values.length) {
    return t < 0.5 ? from : to;
  }
  return {
    values: from.values.map((dot: Dot, index: number) => {
      const nextDot = to.values[index]!;
      return [
        dot[0] + (nextDot[0] - dot[0]) * t,
        dot[1] + (nextDot[1] - dot[1]) * t,
      ] as Dot;
    }),
  };
}

function createKeyframeValueBufferFromSamples(
  rawSamples: KeyframeSample[],
  interpolateValues: (a: unknown, b: unknown, t: number) => unknown,
): KeyframeValueBuffer {
  const samples = rawSamples;
  let lastLeftIndex: number | null = null;
  return {
    samples,
    getValue(time: number, binarySearch = false) {
      if (!samples.length) return null;
      if (time <= samples[0]!.t) return samples[0]!.value;
      if (time >= samples[samples.length - 1]!.t) return samples[samples.length - 1]!.value;

      let leftIndex: number;
      let rightIndex: number;

      if (!binarySearch && lastLeftIndex !== null) {
        const a = samples[lastLeftIndex];
        const b = samples[lastLeftIndex + 1];
        const prev = lastLeftIndex > 0 ? samples[lastLeftIndex - 1] : null;
        const next = lastLeftIndex + 2 < samples.length ? samples[lastLeftIndex + 2] : null;
        if (a && b && time >= a.t && time <= b.t) {
          leftIndex = lastLeftIndex;
          rightIndex = lastLeftIndex + 1;
        } else if (prev && a && time >= prev.t && time <= a.t) {
          leftIndex = lastLeftIndex - 1;
          rightIndex = lastLeftIndex;
        } else if (b && next && time >= b.t && time <= next.t) {
          leftIndex = lastLeftIndex + 1;
          rightIndex = lastLeftIndex + 2;
        } else {
          const insertIndex = lowerBoundSampleIndex(samples, time);
          leftIndex = Math.max(0, insertIndex - 1);
          rightIndex = Math.min(samples.length - 1, insertIndex);
        }
      } else {
        const insertIndex = lowerBoundSampleIndex(samples, time);
        leftIndex = Math.max(0, insertIndex - 1);
        rightIndex = Math.min(samples.length - 1, insertIndex);
      }

      lastLeftIndex = leftIndex;
      const left = samples[leftIndex]!;
      const right = samples[rightIndex]!;
      if (leftIndex === rightIndex || Math.abs(right.t - left.t) < 1e-9) return left.value;
      const factor = (time - left.t) / (right.t - left.t);
      return interpolateValues(left.value, right.value, factor);
    },
    getSamplesInRange(start: number, end: number, includeSampleBefore = false, includeSampleAfter = false) {
      if (!samples.length) return [];
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      let fromIndex = lowerBoundSampleIndex(samples, lower);
      let toIndex = lowerBoundSampleIndex(samples, upper);
      if (fromIndex > 0 && includeSampleBefore) fromIndex -= 1;
      if (toIndex < samples.length && includeSampleAfter) {
        toIndex += 1;
      } else if (toIndex < samples.length && Math.abs(samples[toIndex]!.t - upper) < 1e-9) {
        toIndex += 1;
      }
      return samples.slice(fromIndex, Math.min(samples.length, toIndex));
    },
  };
}

function getPlayer3DKeyframeValueBuffer(lane: TimelineLane) {
  const prepared = preparePlayer3DCurve(lane);
  if (!prepared) return null;
  const signature = player3DKeyframeSignature(prepared.keyframes);
  const cached = player3DValueBufferCache.get(lane);
  if (cached && cached.signature === signature) return cached.buffer;
  const buffer = createKeyframeValueBuffer(
    prepared.keyframes.map(keyframe => keyframe.t),
    time => evaluatePreparedPlayer3DKeyframes(prepared, time),
    interpolatePlayer3DValues,
    PLAYER3D_KEYFRAME_SAMPLES_PER_SEGMENT,
  );
  player3DValueBufferCache.set(lane, { signature, buffer });
  return buffer;
}

function getDotsKeyframeValueBuffer(lane: TimelineLane) {
  if (lane.type !== 'keyframes') return null;
  const prepared = sanitizeDotsKeyframes(lane.keyframes);
  if (!prepared.length) return null;
  const signature = dotsKeyframeSignature(prepared);
  const cached = dotsValueBufferCache.get(lane);
  if (cached && cached.signature === signature) return cached.buffer;
  const buffer = createKeyframeValueBuffer(
    prepared.map(keyframe => keyframe.t),
    time => evaluateDotsPreparedKeyframes(prepared, time),
    interpolateDotsValues,
  );
  dotsValueBufferCache.set(lane, { signature, buffer });
  return buffer;
}

const curveAdapter: TimelineAdapter = {
  kind: 'curve',
  capturePayload: (state) => cloneUnknown(state),
};

const triggerAdapter: TimelineAdapter = {
  kind: 'trigger',
  capturePayload: (state) => cloneUnknown(state),
};

const stepAdapter: TimelineAdapter = {
  kind: 'step',
  capturePayload: (state) => cloneUnknown(state),
};

const player3dAdapter: TimelineAdapter = {
  kind: 'keyframes',
  capturePayload: (state) => sanitizePlayer3DPose(state),
  evaluateKeyframes: evaluatePlayer3DKeyframes,
  getKeyframeValueBuffer: getPlayer3DKeyframeValueBuffer,
};

const dotsAdapter: TimelineAdapter = {
  kind: 'keyframes',
  capturePayload: (state) => sanitizeDotsValue(state),
  evaluateKeyframes: evaluateDotsKeyframes,
  getKeyframeValueBuffer: getDotsKeyframeValueBuffer,
};

export function getTimelineAdapter(spec: Controls.Base.Spec): TimelineAdapter {
  if (spec.type === Controls.Player3D.Spec.type) return player3dAdapter;
  if (spec.type === Controls.Dots.Spec.type) return dotsAdapter;
  if (spec.type === Controls.Selector.Spec.type) return stepAdapter;
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type || spec.type === Controls.Pad.Spec.type) return triggerAdapter;
  return curveAdapter;
}

export function sortTimelineKeyframes(keyframes: TimelineKeyframe[]) {
  return sortKeyframes(keyframes);
}
