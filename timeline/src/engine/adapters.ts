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
  rotationStart: Quaternion;
  rotationDelta: Vec3;
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

function squadQuaternion(a: Quaternion, b: Quaternion, s0: Quaternion, s1: Quaternion, t: number): Quaternion {
  const ab = slerpQuaternion(a, b, t);
  const ss = slerpQuaternion(s0, s1, t);
  return slerpQuaternion(ab, ss, 2 * t * (1 - t));
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
  if (length <= 1e-8) return fallback;
  return [a[0] / length, a[1] / length, a[2] / length];
}

function rotateVec3ByQuat(v: Vec3, q: Quaternion): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const s = q[3];
  const uv: Vec3 = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const uuv: Vec3 = [
    u[1] * uv[2] - u[2] * uv[1],
    u[2] * uv[0] - u[0] * uv[2],
    u[0] * uv[1] - u[1] * uv[0],
  ];
  return [
    v[0] + 2 * (s * uv[0] + uuv[0]),
    v[1] + 2 * (s * uv[1] + uuv[1]),
    v[2] + 2 * (s * uv[2] + uuv[2]),
  ];
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

function cubicHermiteVec3(p0: Vec3, p1: Vec3, m0: Vec3, m1: Vec3, u: number): Vec3 {
  return [
    hermiteScalar(p0[0], p1[0], m0[0], m1[0], u),
    hermiteScalar(p0[1], p1[1], m0[1], m1[1], u),
    hermiteScalar(p0[2], p1[2], m0[2], m1[2], u),
  ];
}


function quaternionRelativeLog(from: Quaternion, to: Quaternion): Vec3 {
  return quaternionLog(quaternionMultiply(quaternionConjugate(from), alignQuaternionHemisphere(from, to)));
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

  const segments: Player3DSegment[] = [];
  for (let i = 0; i < sanitizedKeyframes.length - 1; i++) {
    const start = sanitizedKeyframes[i]!;
    const end = sanitizedKeyframes[i + 1]!;
    const duration = Math.max(1e-6, end.t - start.t);
    const rotationDelta = quaternionRelativeLog(start.value.rotation, end.value.rotation);

    segments.push({
      startTime: start.t,
      endTime: end.t,
      duration,
      rotationStart: start.value.rotation,
      rotationDelta,
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

type Player3DCorner = {
  tIn: number;
  tOut: number;
  positionIn: Vec3;
  positionOut: Vec3;
  velocityIn: Vec3;
  velocityOut: Vec3;
  rotationIn: Quaternion;
  rotationOut: Quaternion;
  rotationVelocityIn: Vec3;
  rotationVelocityOut: Vec3;
};

function getPlayer3DCorner(prepared: PreparedPlayer3DCurve, index: number): Player3DCorner {
  const keyframes = prepared.keyframes;
  const keyframe = keyframes[index]!;
  if (index <= 0 || index >= keyframes.length - 1) {
    return {
      tIn: keyframe.t,
      tOut: keyframe.t,
      positionIn: keyframe.value.position,
      positionOut: keyframe.value.position,
      velocityIn: [0, 0, 0],
      velocityOut: [0, 0, 0],
      rotationIn: keyframe.value.rotation,
      rotationOut: keyframe.value.rotation,
      rotationVelocityIn: [0, 0, 0],
      rotationVelocityOut: [0, 0, 0],
    };
  }

  const previous = keyframes[index - 1]!;
  const next = keyframes[index + 1]!;
  const leftSmooth = clamp01(keyframe.leftSmooth ?? 1);
  const rightSmooth = clamp01(keyframe.rightSmooth ?? 1);
  const previousDelta = vec3Sub(keyframe.value.position, previous.value.position);
  const nextDelta = vec3Sub(next.value.position, keyframe.value.position);
  const previousDistance = vec3Length(previousDelta);
  const nextDistance = vec3Length(nextDelta);
  const previousDuration = Math.max(1e-6, keyframe.t - previous.t);
  const nextDuration = Math.max(1e-6, next.t - keyframe.t);
  const incomingDirection = vec3NormalizeOr(previousDelta, [0, 0, 0]);
  const outgoingDirection = vec3NormalizeOr(nextDelta, incomingDirection);
  const leftDistance = leftSmooth * 0.5 * previousDistance;
  const rightDistance = rightSmooth * 0.5 * nextDistance;
  const leftTime = leftSmooth * 0.5 * previousDuration;
  const rightTime = rightSmooth * 0.5 * nextDuration;
  const previousRotationDelta = quaternionRelativeLog(previous.value.rotation, keyframe.value.rotation);
  const nextRotationDelta = quaternionRelativeLog(keyframe.value.rotation, next.value.rotation);
  const previousRotationSpeed = vec3Scale(previousRotationDelta, 1 / previousDuration);
  const nextRotationSpeed = vec3Scale(nextRotationDelta, 1 / nextDuration);
  const rotationInVector = vec3Scale(previousRotationDelta, Math.max(0, 1 - leftTime / previousDuration));
  const rotationOutVector = vec3Scale(nextRotationDelta, rightTime / nextDuration);

  return {
    tIn: keyframe.t - leftTime,
    tOut: keyframe.t + rightTime,
    positionIn: vec3Sub(keyframe.value.position, vec3Scale(incomingDirection, leftDistance)),
    positionOut: vec3Add(keyframe.value.position, vec3Scale(outgoingDirection, rightDistance)),
    velocityIn: vec3Scale(incomingDirection, previousDistance / previousDuration),
    velocityOut: vec3Scale(outgoingDirection, nextDistance / nextDuration),
    rotationIn: normalizeQuaternion(quaternionMultiply(previous.value.rotation, quaternionExp(rotationInVector))),
    rotationOut: normalizeQuaternion(quaternionMultiply(keyframe.value.rotation, quaternionExp(rotationOutVector))),
    rotationVelocityIn: previousRotationSpeed,
    rotationVelocityOut: nextRotationSpeed,
  };
}

function evaluatePlayer3DRoundedPosition(prepared: PreparedPlayer3DCurve, time: number): Vec3 {
  const keyframes = prepared.keyframes;
  if (keyframes.length === 1) return keyframes[0]!.value.position;
  if (time <= keyframes[0]!.t) return keyframes[0]!.value.position;
  if (time >= keyframes[keyframes.length - 1]!.t) return keyframes[keyframes.length - 1]!.value.position;

  for (let i = 1; i < keyframes.length - 1; i++) {
    const corner = getPlayer3DCorner(prepared, i);
    if (corner.tOut <= corner.tIn) continue;
    if (time >= corner.tIn && time <= corner.tOut) {
      const duration = corner.tOut - corner.tIn;
      const u = clamp01((time - corner.tIn) / duration);
      return cubicHermiteVec3(
        corner.positionIn,
        corner.positionOut,
        vec3Scale(corner.velocityIn, duration),
        vec3Scale(corner.velocityOut, duration),
        u,
      );
    }
  }

  for (let i = 0; i < keyframes.length - 1; i++) {
    const start = i === 0
      ? {
        t: keyframes[i]!.t,
        position: keyframes[i]!.value.position,
      }
      : (() => {
        const corner = getPlayer3DCorner(prepared, i);
        return { t: corner.tOut, position: corner.positionOut };
      })();
    const end = i + 1 === keyframes.length - 1
      ? {
        t: keyframes[i + 1]!.t,
        position: keyframes[i + 1]!.value.position,
      }
      : (() => {
        const corner = getPlayer3DCorner(prepared, i + 1);
        return { t: corner.tIn, position: corner.positionIn };
      })();

    if (time >= start.t && time <= end.t) {
      const duration = end.t - start.t;
      if (duration <= 1e-8) return end.position;
      return vec3Lerp(start.position, end.position, clamp01((time - start.t) / duration));
    }
  }

  return keyframes[keyframes.length - 1]!.value.position;
}

function evaluatePlayer3DRoundedRotation(prepared: PreparedPlayer3DCurve, time: number): Quaternion {
  const keyframes = prepared.keyframes;
  if (keyframes.length === 1) return keyframes[0]!.value.rotation;
  if (time <= keyframes[0]!.t) return keyframes[0]!.value.rotation;
  if (time >= keyframes[keyframes.length - 1]!.t) return keyframes[keyframes.length - 1]!.value.rotation;

  for (let i = 1; i < keyframes.length - 1; i++) {
    const corner = getPlayer3DCorner(prepared, i);
    if (corner.tOut <= corner.tIn) continue;
    if (time >= corner.tIn && time <= corner.tOut) {
      const duration = corner.tOut - corner.tIn;
      const u = clamp01((time - corner.tIn) / duration);
      const delta = quaternionRelativeLog(corner.rotationIn, corner.rotationOut);
      const transportedOutVelocity = rotateVec3ByQuat(corner.rotationVelocityOut, quaternionExp(delta));
      const rotationVector = cubicHermiteVec3(
        [0, 0, 0],
        delta,
        vec3Scale(corner.rotationVelocityIn, duration),
        vec3Scale(transportedOutVelocity, duration),
        u,
      );
      return normalizeQuaternion(quaternionMultiply(corner.rotationIn, quaternionExp(rotationVector)));
    }
  }

  for (let i = 0; i < keyframes.length - 1; i++) {
    const start = i === 0
      ? {
        t: keyframes[i]!.t,
        rotation: keyframes[i]!.value.rotation,
      }
      : (() => {
        const corner = getPlayer3DCorner(prepared, i);
        return { t: corner.tOut, rotation: corner.rotationOut };
      })();
    const end = i + 1 === keyframes.length - 1
      ? {
        t: keyframes[i + 1]!.t,
        rotation: keyframes[i + 1]!.value.rotation,
      }
      : (() => {
        const corner = getPlayer3DCorner(prepared, i + 1);
        return { t: corner.tIn, rotation: corner.rotationIn };
      })();

    if (time >= start.t && time <= end.t) {
      const duration = end.t - start.t;
      if (duration <= 1e-8) return end.rotation;
      return slerpQuaternion(start.rotation, end.rotation, clamp01((time - start.t) / duration));
    }
  }

  return keyframes[keyframes.length - 1]!.value.rotation;
}

function evaluatePreparedPlayer3DKeyframes(prepared: PreparedPlayer3DCurve, time: number) {
  const { keyframes, segments } = prepared;
  if (keyframes.length === 1 || !segments.length) return keyframes[0]!.value;
  if (time <= keyframes[0]!.t) return keyframes[0]!.value;
  if (time >= keyframes[keyframes.length - 1]!.t) return keyframes[keyframes.length - 1]!.value;

  return {
    position: evaluatePlayer3DRoundedPosition(prepared, time),
    rotation: evaluatePlayer3DRoundedRotation(prepared, time),
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
