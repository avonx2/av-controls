import { vec3 } from 'gl-matrix';
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

type PreparedPlayer3DKeyframe = SanitizedPlayer3DKeyframe & {
  positionVelocity: Vec3;
  positionAcceleration: Vec3;
  rotationVelocity: Vec3;
  rotationAcceleration: Vec3;
};

type Player3DSegment = {
  startTime: number;
  endTime: number;
  duration: number;
  positionStart: Vec3;
  positionEnd: Vec3;
  positionStartVelocity: Vec3;
  positionEndVelocity: Vec3;
  positionStartAcceleration: Vec3;
  positionEndAcceleration: Vec3;
  rotationStart: Quaternion;
  rotationDelta: Vec3;
  rotationStartVelocity: Vec3;
  rotationEndVelocity: Vec3;
  rotationStartAcceleration: Vec3;
  rotationEndAcceleration: Vec3;
  rotationEndVelocityTransported: Vec3;
  rotationEndAccelerationTransported: Vec3;
};

type PreparedPlayer3DCurve = {
  keyframes: PreparedPlayer3DKeyframe[];
  segments: Player3DSegment[];
};

type KeyframeSample = {
  t: number;
  value: unknown;
};

type SegmentedKeyframeSampleBlock = {
  signature: string;
  samples: KeyframeSample[];
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


function vec3WeightedAverage(a: Vec3, aWeight: number, b: Vec3, bWeight: number): Vec3 {
  const total = aWeight + bWeight;
  if (total <= 1e-8) return [0, 0, 0];
  return [
    (a[0] * aWeight + b[0] * bWeight) / total,
    (a[1] * aWeight + b[1] * bWeight) / total,
    (a[2] * aWeight + b[2] * bWeight) / total,
  ];
}

function rotateVec3ByQuat(v: Vec3, q: Quaternion): Vec3 {
  const out = vec3.create();
  vec3.transformQuat(out, v, q);
  return [out[0], out[1], out[2]];
}

function vec3AngleBetween(a: Vec3, b: Vec3): number {
  const lenA = Math.hypot(a[0], a[1], a[2]);
  const lenB = Math.hypot(b[0], b[1], b[2]);
  if (lenA < 1e-8 || lenB < 1e-8) return 0;
  const dot = (a[0]*b[0] + a[1]*b[1] + a[2]*b[2]) / (lenA * lenB);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
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

function getPositionVelocity(
  prev: Vec3 | null,
  current: Vec3,
  next: Vec3 | null,
  dtPrev: number | null,
  dtNext: number | null,
): Vec3 {
  if (prev && next && dtPrev && dtNext) {
    const vPrev = vec3Scale(vec3Sub(current, prev), 1 / Math.max(1e-6, dtPrev));
    const vNext = vec3Scale(vec3Sub(next, current), 1 / Math.max(1e-6, dtNext));
    return vec3WeightedAverage(vPrev, dtNext, vNext, dtPrev);
  }
  if (next && dtNext) {
    return vec3Scale(vec3Sub(next, current), 1 / Math.max(1e-6, dtNext));
  }
  if (prev && dtPrev) {
    return vec3Scale(vec3Sub(current, prev), 1 / Math.max(1e-6, dtPrev));
  }
  return [0, 0, 0];
}

function getTcbParameters(left: number | undefined, right: number | undefined) {
  const handleIn = clamp01(left);
  const handleOut = clamp01(right);
  const average = (handleIn + handleOut) * 0.5;
  const tension = Math.max(-1, Math.min(1, average * 2 - 1));
  const bias = Math.max(-1, Math.min(1, handleOut - handleIn));
  return { tension, bias };
}

function computeTcbVelocityTangent(
  prevVelocity: Vec3 | null,
  nextVelocity: Vec3 | null,
  tension: number,
  bias: number,
): Vec3 {
  const scale = 0.5 * (1 - tension);
  if (prevVelocity && nextVelocity) {
    return [
      scale * ((1 + bias) * prevVelocity[0] + (1 - bias) * nextVelocity[0]),
      scale * ((1 + bias) * prevVelocity[1] + (1 - bias) * nextVelocity[1]),
      scale * ((1 + bias) * prevVelocity[2] + (1 - bias) * nextVelocity[2]),
    ];
  }
  if (nextVelocity) return vec3Scale(nextVelocity, 1 - tension);
  if (prevVelocity) return vec3Scale(prevVelocity, 1 - tension);
  return [0, 0, 0];
}

function computeHandleVelocityScale(left: number | undefined, right: number | undefined) {
  const handleIn = 1 - clamp01(left);
  const handleOut = 1 - clamp01(right);
  const average = (handleIn + handleOut) * 0.5;
  return Math.max(0.22, 1 - average * 0.78);
}

function computeHandleAccelerationScale(left: number | undefined, right: number | undefined) {
  const handleIn = 1 - clamp01(left);
  const handleOut = 1 - clamp01(right);
  const bias = handleOut - handleIn;
  const accelScaleIn = Math.max(0.08, 1 - handleIn * 0.92);
  const accelScaleOut = Math.max(0.08, 1 - handleOut * 0.92);
  const accelBias = 0.5 + bias * 0.3;
  return accelScaleIn * (1 - accelBias) + accelScaleOut * (1 + accelBias);
}

function quinticHermiteBasis(u: number) {
  const u2 = u * u;
  const u3 = u2 * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  return {
    h00: 1 - 10 * u3 + 15 * u4 - 6 * u5,
    h10: u - 6 * u3 + 8 * u4 - 3 * u5,
    h20: 0.5 * u2 - 1.5 * u3 + 1.5 * u4 - 0.5 * u5,
    h01: 10 * u3 - 15 * u4 + 6 * u5,
    h11: -4 * u3 + 7 * u4 - 3 * u5,
    h21: 0.5 * u3 - u4 + 0.5 * u5,
  };
}

function quinticHermiteVec3(
  p0: Vec3,
  v0: Vec3,
  a0: Vec3,
  p1: Vec3,
  v1: Vec3,
  a1: Vec3,
  u: number,
): Vec3 {
  const { h00, h10, h20, h01, h11, h21 } = quinticHermiteBasis(u);
  return [
    p0[0] * h00 + v0[0] * h10 + a0[0] * h20 + p1[0] * h01 + v1[0] * h11 + a1[0] * h21,
    p0[1] * h00 + v0[1] * h10 + a0[1] * h20 + p1[1] * h01 + v1[1] * h11 + a1[1] * h21,
    p0[2] * h00 + v0[2] * h10 + a0[2] * h20 + p1[2] * h01 + v1[2] * h11 + a1[2] * h21,
  ];
}


function getRotationVelocity(
  prev: Quaternion | null,
  current: Quaternion,
  next: Quaternion | null,
  dtPrev: number | null,
  dtNext: number | null,
): Vec3 {
  if (prev && next && dtPrev && dtNext) {
    const prevDelta = vec3Scale(
      quaternionLog(quaternionMultiply(quaternionConjugate(current), alignQuaternionHemisphere(current, prev))),
      -1 / Math.max(1e-6, dtPrev),
    );
    const nextDelta = vec3Scale(
      quaternionLog(quaternionMultiply(quaternionConjugate(current), alignQuaternionHemisphere(current, next))),
      1 / Math.max(1e-6, dtNext),
    );
    return vec3WeightedAverage(prevDelta, dtNext, nextDelta, dtPrev);
  }
  if (next && dtNext) {
    return vec3Scale(
      quaternionLog(quaternionMultiply(quaternionConjugate(current), alignQuaternionHemisphere(current, next))),
      1 / Math.max(1e-6, dtNext),
    );
  }
  if (prev && dtPrev) {
    return vec3Scale(
      quaternionLog(quaternionMultiply(quaternionConjugate(current), alignQuaternionHemisphere(current, prev))),
      -1 / Math.max(1e-6, dtPrev),
    );
  }
  return [0, 0, 0];
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
    const only = sanitizedKeyframes[0]!;
    return {
      keyframes: [{
        ...only,
        positionVelocity: [0, 0, 0],
        positionAcceleration: [0, 0, 0],
        rotationVelocity: [0, 0, 0],
        rotationAcceleration: [0, 0, 0],
      }],
      segments: [],
    };
  }

  const signature = player3DKeyframeSignature(sanitizedKeyframes);
  const cached = player3DCurveCache.get(lane);
  if (cached && cached.signature === signature) return cached.curve;

  const positionVelocities: Vec3[] = [];
  const rotationVelocities: Vec3[] = [];
  for (let i = 0; i < sanitizedKeyframes.length; i++) {
    const prev = i > 0 ? sanitizedKeyframes[i - 1]!.value : null;
    const currentKeyframe = sanitizedKeyframes[i]!;
    const current = currentKeyframe.value;
    const next = i + 1 < sanitizedKeyframes.length ? sanitizedKeyframes[i + 1]!.value : null;
    const dtPrev = i > 0 ? sanitizedKeyframes[i]!.t - sanitizedKeyframes[i - 1]!.t : null;
    const dtNext = i + 1 < sanitizedKeyframes.length ? sanitizedKeyframes[i + 1]!.t - sanitizedKeyframes[i]!.t : null;

    let basePositionVelocity = getPositionVelocity(prev?.position ?? null, current.position, next?.position ?? null, dtPrev, dtNext);
    let baseRotationVelocity = getRotationVelocity(prev?.rotation ?? null, current.rotation, next?.rotation ?? null, dtPrev, dtNext);

    const velocityScale = computeHandleVelocityScale(currentKeyframe.leftSmooth, currentKeyframe.rightSmooth);
    basePositionVelocity = vec3Scale(basePositionVelocity, velocityScale);
    baseRotationVelocity = vec3Scale(baseRotationVelocity, velocityScale);

    positionVelocities.push(basePositionVelocity);
    rotationVelocities.push(baseRotationVelocity);
  }

  const keyframes: PreparedPlayer3DKeyframe[] = sanitizedKeyframes.map((keyframe, index) => {
    let positionAcceleration: Vec3 = [0, 0, 0];
    let rotationAcceleration: Vec3 = [0, 0, 0];

    if (index > 0 && index < sanitizedKeyframes.length - 1) {
      const dtPrev = sanitizedKeyframes[index]!.t - sanitizedKeyframes[index - 1]!.t;
      const dtNext = sanitizedKeyframes[index + 1]!.t - sanitizedKeyframes[index]!.t;
      const accelScale = computeHandleAccelerationScale(keyframe.leftSmooth, keyframe.rightSmooth);
      positionAcceleration = vec3Scale(
        vec3Sub(positionVelocities[index + 1]!, positionVelocities[index - 1]!),
        accelScale / Math.max(1e-6, dtPrev + dtNext),
      );
      rotationAcceleration = vec3Scale(
        vec3Sub(rotationVelocities[index + 1]!, rotationVelocities[index - 1]!),
        accelScale / Math.max(1e-6, dtPrev + dtNext),
      );
    }

    return {
      ...keyframe,
      positionVelocity: positionVelocities[index]!,
      positionAcceleration,
      rotationVelocity: rotationVelocities[index]!,
      rotationAcceleration,
    };
  });

  const segments: Player3DSegment[] = [];
  for (let i = 0; i < keyframes.length - 1; i++) {
    const start = keyframes[i]!;
    const end = keyframes[i + 1]!;
    const duration = Math.max(1e-6, end.t - start.t);
    const rotationDelta = quaternionRelativeLog(start.value.rotation, end.value.rotation);
    const rotationTransport = quaternionExp(rotationDelta);

    segments.push({
      startTime: start.t,
      endTime: end.t,
      duration,
      positionStart: start.value.position,
      positionEnd: end.value.position,
      positionStartVelocity: start.positionVelocity,
      positionEndVelocity: end.positionVelocity,
      positionStartAcceleration: start.positionAcceleration,
      positionEndAcceleration: end.positionAcceleration,
      rotationStart: start.value.rotation,
      rotationDelta,
      rotationStartVelocity: start.rotationVelocity,
      rotationEndVelocity: end.rotationVelocity,
      rotationStartAcceleration: start.rotationAcceleration,
      rotationEndAcceleration: end.rotationAcceleration,
      rotationEndVelocityTransported: rotateVec3ByQuat(end.rotationVelocity, rotationTransport),
      rotationEndAccelerationTransported: rotateVec3ByQuat(end.rotationAcceleration, rotationTransport),
    });
  }

  const curve = {
    keyframes,
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

  const segmentIndex = findSegmentIndexFromTime(keyframes, time);
  const segment = segments[segmentIndex]!;
  const localTime = time - segment.startTime;
  const u = clamp01(localTime / segment.duration);
  const scaledPositionStartVelocity = vec3Scale(segment.positionStartVelocity, segment.duration);
  const scaledPositionEndVelocity = vec3Scale(segment.positionEndVelocity, segment.duration);
  const scaledPositionStartAcceleration = vec3Scale(segment.positionStartAcceleration, segment.duration * segment.duration);
  const scaledPositionEndAcceleration = vec3Scale(segment.positionEndAcceleration, segment.duration * segment.duration);
  const scaledRotationStartVelocity = vec3Scale(segment.rotationStartVelocity, segment.duration);
  const scaledRotationEndVelocity = vec3Scale(segment.rotationEndVelocityTransported, segment.duration);
  const scaledRotationStartAcceleration = vec3Scale(segment.rotationStartAcceleration, segment.duration * segment.duration);
  const scaledRotationEndAcceleration = vec3Scale(segment.rotationEndAccelerationTransported, segment.duration * segment.duration);
  const rotationVector = quinticHermiteVec3(
    [0, 0, 0],
    scaledRotationStartVelocity,
    scaledRotationStartAcceleration,
    segment.rotationDelta,
    scaledRotationEndVelocity,
    scaledRotationEndAcceleration,
    u,
  );

  return {
    position: quinticHermiteVec3(
      segment.positionStart,
      scaledPositionStartVelocity,
      scaledPositionStartAcceleration,
      segment.positionEnd,
      scaledPositionEndVelocity,
      scaledPositionEndAcceleration,
      u,
    ),
    rotation: normalizeQuaternion(quaternionMultiply(segment.rotationStart, quaternionExp(rotationVector))),
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
  blocks: SegmentedKeyframeSampleBlock[];
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

function getPlayer3DSegmentSignature(segment: Player3DSegment) {
  return JSON.stringify([
    segment.startTime,
    segment.endTime,
    segment.duration,
    segment.positionStart,
    segment.positionEnd,
    segment.positionStartVelocity,
    segment.positionEndVelocity,
    segment.positionStartAcceleration,
    segment.positionEndAcceleration,
    segment.rotationStart,
    segment.rotationDelta,
    segment.rotationStartVelocity,
    segment.rotationEndVelocity,
    segment.rotationStartAcceleration,
    segment.rotationEndAcceleration,
  ]);
}

function evaluatePreparedPlayer3DSegment(segment: Player3DSegment, time: number) {
  const localTime = time - segment.startTime;
  const u = clamp01(localTime / segment.duration);
  const scaledPositionStartVelocity = vec3Scale(segment.positionStartVelocity, segment.duration);
  const scaledPositionEndVelocity = vec3Scale(segment.positionEndVelocity, segment.duration);
  const scaledPositionStartAcceleration = vec3Scale(segment.positionStartAcceleration, segment.duration * segment.duration);
  const scaledPositionEndAcceleration = vec3Scale(segment.positionEndAcceleration, segment.duration * segment.duration);
  const scaledRotationStartVelocity = vec3Scale(segment.rotationStartVelocity, segment.duration);
  const scaledRotationEndVelocity = vec3Scale(segment.rotationEndVelocityTransported, segment.duration);
  const scaledRotationStartAcceleration = vec3Scale(segment.rotationStartAcceleration, segment.duration * segment.duration);
  const scaledRotationEndAcceleration = vec3Scale(segment.rotationEndAccelerationTransported, segment.duration * segment.duration);
  const rotationVector = quinticHermiteVec3(
    [0, 0, 0],
    scaledRotationStartVelocity,
    scaledRotationStartAcceleration,
    segment.rotationDelta,
    scaledRotationEndVelocity,
    scaledRotationEndAcceleration,
    u,
  );

  return {
    position: quinticHermiteVec3(
      segment.positionStart,
      scaledPositionStartVelocity,
      scaledPositionStartAcceleration,
      segment.positionEnd,
      scaledPositionEndVelocity,
      scaledPositionEndAcceleration,
      u,
    ),
    rotation: normalizeQuaternion(quaternionMultiply(segment.rotationStart, quaternionExp(rotationVector))),
  };
}

const ADAPTIVE_SAMPLE_MIN_DEPTH = 3;
const ADAPTIVE_SAMPLE_MAX_DEPTH = 10;
const ADAPTIVE_SAMPLE_ROT_CURVE_THRESHOLD = 2 * Math.PI / 180;
const ADAPTIVE_SAMPLE_DIR_THRESHOLD = 2 * Math.PI / 180;
const ADAPTIVE_SAMPLE_SPEED_THRESHOLD = 0.1;

function quaternionAngleBetween(a: Quaternion, b: Quaternion): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

function adaptiveSubdivideSegment(
  segment: Player3DSegment,
  aT: number,
  aValue: Player3DPose,
  bT: number,
  bValue: Player3DPose,
  depth: number,
  out: KeyframeSample[],
) {
  const midT = (aT + bT) * 0.5;
  const midValue = evaluatePreparedPlayer3DSegment(segment, midT);

  if (depth < ADAPTIVE_SAMPLE_MIN_DEPTH) {
    adaptiveSubdivideSegment(segment, aT, aValue, midT, midValue, depth + 1, out);
    adaptiveSubdivideSegment(segment, midT, midValue, bT, bValue, depth + 1, out);
    return;
  }

  if (depth < ADAPTIVE_SAMPLE_MAX_DEPTH) {
    const rotDeltaAM = quaternionMultiply(quaternionConjugate(aValue.rotation), midValue.rotation);
    const rotDeltaMB = quaternionMultiply(quaternionConjugate(midValue.rotation), bValue.rotation);
    const rotCurvOk = quaternionAngleBetween(rotDeltaAM, rotDeltaMB) <= ADAPTIVE_SAMPLE_ROT_CURVE_THRESHOLD;
    const chordAM = vec3Sub(midValue.position, aValue.position);
    const chordMB = vec3Sub(bValue.position, midValue.position);
    const dirOk = vec3AngleBetween(chordAM, chordMB) <= ADAPTIVE_SAMPLE_DIR_THRESHOLD;
    const lenAM = Math.hypot(...chordAM);
    const lenMB = Math.hypot(...chordMB);
    const maxLen = Math.max(lenAM, lenMB);
    const speedOk = maxLen < 1e-8 || Math.abs(lenAM - lenMB) / maxLen <= ADAPTIVE_SAMPLE_SPEED_THRESHOLD;

    if (!rotCurvOk || !dirOk || !speedOk) {
      adaptiveSubdivideSegment(segment, aT, aValue, midT, midValue, depth + 1, out);
      adaptiveSubdivideSegment(segment, midT, midValue, bT, bValue, depth + 1, out);
      return;
    }
  }

  out.push({ t: bT, value: bValue });
}

function samplePreparedPlayer3DSegment(segment: Player3DSegment): KeyframeSample[] {
  const startValue = evaluatePreparedPlayer3DSegment(segment, segment.startTime);
  const endValue = evaluatePreparedPlayer3DSegment(segment, segment.endTime);
  const samples: KeyframeSample[] = [{ t: segment.startTime, value: startValue }];
  adaptiveSubdivideSegment(segment, segment.startTime, startValue, segment.endTime, endValue, 0, samples);
  samples.pop(); // [startTime, endTime) — end point owned by next segment or the final keyframe
  console.log(`[player3d] segment [${segment.startTime.toFixed(3)}, ${segment.endTime.toFixed(3)}] → ${samples.length} samples`);
  return samples;
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

function createSegmentedKeyframeValueBuffer(
  blocks: SegmentedKeyframeSampleBlock[],
  interpolateValues: (a: unknown, b: unknown, t: number) => unknown,
  finalSample: KeyframeSample,
): KeyframeValueBuffer {
  const samples: KeyframeSample[] = [];
  for (const block of blocks) {
    for (const sample of block.samples) {
      samples.push(sample);
    }
  }
  samples.push(finalSample);
  return createKeyframeValueBufferFromSamples(samples, interpolateValues);
}

function buildPlayer3DSampleBlocks(
  prepared: PreparedPlayer3DCurve,
  previousBlocks: SegmentedKeyframeSampleBlock[] = [],
) {
  const nextSignatures = prepared.segments.map(getPlayer3DSegmentSignature);
  let prefix = 0;
  while (
    prefix < previousBlocks.length
    && prefix < nextSignatures.length
    && previousBlocks[prefix]!.signature === nextSignatures[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previousBlocks.length - prefix
    && suffix < nextSignatures.length - prefix
    && previousBlocks[previousBlocks.length - 1 - suffix]!.signature === nextSignatures[nextSignatures.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const blocks: SegmentedKeyframeSampleBlock[] = [];
  for (let i = 0; i < prefix; i++) {
    blocks.push(previousBlocks[i]!);
  }
  for (let i = prefix; i < nextSignatures.length - suffix; i++) {
    const segment = prepared.segments[i]!;
    blocks.push({
      signature: nextSignatures[i]!,
      samples: samplePreparedPlayer3DSegment(segment),
    });
  }
  for (let i = previousBlocks.length - suffix; i < previousBlocks.length; i++) {
    blocks.push(previousBlocks[i]!);
  }
  return blocks;
}

function getPlayer3DKeyframeValueBuffer(lane: TimelineLane) {
  const prepared = preparePlayer3DCurve(lane);
  if (!prepared) return null;
  const signature = player3DKeyframeSignature(prepared.keyframes);
  const cached = player3DValueBufferCache.get(lane);
  if (cached && cached.signature === signature) return cached.buffer;
  if (prepared.keyframes.length === 1 || prepared.segments.length === 0) {
    const buffer = createKeyframeValueBuffer(
      prepared.keyframes.map(keyframe => keyframe.t),
      time => evaluatePreparedPlayer3DKeyframes(prepared, time),
      interpolatePlayer3DValues,
      PLAYER3D_KEYFRAME_SAMPLES_PER_SEGMENT,
    );
    player3DValueBufferCache.set(lane, { signature, blocks: [], buffer });
    return buffer;
  }
  const blocks = buildPlayer3DSampleBlocks(prepared, cached?.blocks ?? []);
  const lastKeyframe = prepared.keyframes[prepared.keyframes.length - 1]!;
  const buffer = createSegmentedKeyframeValueBuffer(blocks, interpolatePlayer3DValues, {
    t: lastKeyframe.t,
    value: lastKeyframe.value,
  });
  player3DValueBufferCache.set(lane, { signature, blocks, buffer });
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
