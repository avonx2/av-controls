<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { shade } from 'polished'
import { Controls } from '@av-controls/protocol'

type Vec3 = [number, number, number]
type Quaternion = [number, number, number, number]

const props = defineProps({
  player3d: {
    type: Object as () => Controls.Player3D.Sender,
    required: true,
  },
})

const root = ref<HTMLDivElement | null>(null)
const captured = ref(false)
const pressedKeys = new Set<string>()
const localVelocity: Vec3 = [0, 0, 0]
let localRollVelocity = 0
let targetRotation: Quaternion = [0, 0, 0, 1]

let animationFrame = 0
let lastFrameAt = 0

const backgroundStyle = computed(() => {
  const color = props.player3d.spec.color || '#444'
  try {
    return {
      backgroundColor: shade(0.3, color),
      borderColor: captured.value ? color : shade(0.05, color),
      boxShadow: captured.value ? `0 0 3rem -1.5rem ${color}` : `0 0 2rem -1.6rem ${color}`,
    }
  } catch {
    return {
      backgroundColor: '#444',
      borderColor: '#666',
    }
  }
})

const arrowStyle = computed(() => ({
  color: props.player3d.spec.color || '#7af',
}))

function clonePosition(): Vec3 {
  return [...props.player3d.position] as Vec3
}

function cloneRotation(): Quaternion {
  return [...props.player3d.rotation] as Quaternion
}

function normalizeQuaternion(rotation: Quaternion): Quaternion {
  const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3])
  if (length <= 1e-8) {
    return [0, 0, 0, 1]
  }
  return [
    rotation[0] / length,
    rotation[1] / length,
    rotation[2] / length,
    rotation[3] / length,
  ]
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return normalizeQuaternion([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ])
}

function slerpQuaternions(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let from = normalizeQuaternion(a)
  let to = normalizeQuaternion(b)
  let dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3]
  if (dot < 0) {
    dot = -dot
    to = [-to[0], -to[1], -to[2], -to[3]]
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
      from[3] + (to[3] - from[3]) * t,
    ])
  }
  const theta0 = Math.acos(Math.max(-1, Math.min(1, dot)))
  const theta = theta0 * t
  const sinTheta = Math.sin(theta)
  const sinTheta0 = Math.sin(theta0)
  const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0
  const s1 = sinTheta / sinTheta0
  return normalizeQuaternion([
    s0 * from[0] + s1 * to[0],
    s0 * from[1] + s1 * to[1],
    s0 * from[2] + s1 * to[2],
    s0 * from[3] + s1 * to[3],
  ])
}

function rotationMatchesTarget(current: Quaternion, target: Quaternion) {
  const dot = Math.abs(
    current[0] * target[0]
    + current[1] * target[1]
    + current[2] * target[2]
    + current[3] * target[3]
  )
  return dot > 0.99999
}

function quaternionFromAxisAngle(axis: Vec3, angle: number): Quaternion {
  const axisLength = Math.hypot(axis[0], axis[1], axis[2])
  if (axisLength <= 1e-8 || Math.abs(angle) <= 1e-8) {
    return [0, 0, 0, 1]
  }
  const half = angle * 0.5
  const scale = Math.sin(half) / axisLength
  return [
    axis[0] * scale,
    axis[1] * scale,
    axis[2] * scale,
    Math.cos(half),
  ]
}

function rotateVector(rotation: Quaternion, vector: Vec3): Vec3 {
  const x = vector[0]
  const y = vector[1]
  const z = vector[2]
  const qx = rotation[0]
  const qy = rotation[1]
  const qz = rotation[2]
  const qw = rotation[3]

  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)

  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ]
}

function setPose(position: Vec3, rotation: Quaternion) {
  props.player3d.setPose(position, rotation)
}

function expSmoothingAlpha(timeConstant: number, dt: number) {
  return 1 - Math.exp(-dt / Math.max(1e-3, timeConstant))
}

function getSiblingFaderValue(id: string) {
  const parent = props.player3d.parent
  if (!(parent instanceof Controls.Group.Sender)) return null
  const sibling = parent.senders[id]
  if (!(sibling instanceof Controls.Fader.Sender)) return null
  return sibling.value
}

function getKeySpeed() {
  return getSiblingFaderValue('keySpeed') ?? props.player3d.spec.moveSpeed
}

function getRotationSpeed() {
  return getSiblingFaderValue('rotationSpeed') ?? props.player3d.spec.moveSpeed
}

function getRotationSmoothness() {
  return getSiblingFaderValue('rotationSmoothness') ?? 0
}

function getKeyBuildup() {
  return getSiblingFaderValue('keyBuildup') ?? 0.8
}

function applyLookStep(movementX: number, movementY: number) {
  if (!captured.value) return false
  if (Math.abs(movementX) <= 1e-8 && Math.abs(movementY) <= 1e-8) return false

  const speed = getRotationSpeed()
  const sensitivity = props.player3d.spec.lookSensitivity * speed
  const rotation = cloneRotation()
  const localUp = rotateVector(rotation, [0, 1, 0])
  const localRight = rotateVector(rotation, [1, 0, 0])
  const yaw = quaternionFromAxisAngle(localUp, -movementX * sensitivity)
  const pitch = quaternionFromAxisAngle(localRight, -movementY * sensitivity)
  targetRotation = multiplyQuaternions(pitch, multiplyQuaternions(yaw, targetRotation))
  if (getRotationSmoothness() <= 1e-4) {
    setPose(clonePosition(), targetRotation)
  }
  return true
}

function shouldCaptureKey(code: string) {
  if (code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD') return true
  if (code === 'Space' || code === 'ControlLeft' || code === 'ControlRight') return true
  if (props.player3d.spec.enableRoll && (code === 'KeyQ' || code === 'KeyE')) return true
  return code === 'Escape'
}

function preventKeyEvent(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
}

function onKeyDown(event: KeyboardEvent) {
  if (!captured.value || !shouldCaptureKey(event.code)) return
  preventKeyEvent(event)

  if (event.code === 'Escape') {
    releasePointerLock()
    return
  }

  pressedKeys.add(event.code)
  ensureAnimationLoop()
}

function onKeyUp(event: KeyboardEvent) {
  if (!captured.value || !shouldCaptureKey(event.code)) return
  preventKeyEvent(event)
  pressedKeys.delete(event.code)
}

function onMouseMove(event: MouseEvent) {
  if (!captured.value) return
  applyLookStep(event.movementX, event.movementY)
  ensureAnimationLoop()
}

function animate(now: number) {
  animationFrame = 0
  if (!captured.value) return

  const dt = lastFrameAt > 0 ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0
  lastFrameAt = now

  if (dt > 0) {
    let changed = false
    const moveAxis: Vec3 = [0, 0, 0]
    if (pressedKeys.has('KeyA')) moveAxis[0] -= 1
    if (pressedKeys.has('KeyD')) moveAxis[0] += 1
    if (pressedKeys.has('ControlLeft') || pressedKeys.has('ControlRight')) moveAxis[1] -= 1
    if (pressedKeys.has('Space')) moveAxis[1] += 1
    if (pressedKeys.has('KeyW')) moveAxis[2] -= 1
    if (pressedKeys.has('KeyS')) moveAxis[2] += 1

    const moveLength = Math.hypot(moveAxis[0], moveAxis[1], moveAxis[2])
    let position = clonePosition()
    let rotation = cloneRotation()
    const speed = getKeySpeed()
    const buildup = getKeyBuildup()
    const rotationSmoothness = getRotationSmoothness()

    const targetLocalVelocity: Vec3 = moveLength > 1e-6
      ? [
          (moveAxis[0] / moveLength) * speed,
          (moveAxis[1] / moveLength) * speed,
          (moveAxis[2] / moveLength) * speed,
        ]
      : [0, 0, 0]

    const attackSeconds = Math.max(0.05, buildup)
    const releaseSeconds = Math.max(0.04, attackSeconds * 0.7)
    const rollAxis =
      (pressedKeys.has('KeyE') ? 1 : 0)
      - (pressedKeys.has('KeyQ') ? 1 : 0)
    const targetRollVelocity = rollAxis * speed

    for (let i = 0; i < 3; i++) {
      const target = targetLocalVelocity[i] ?? 0
      const current = localVelocity[i] ?? 0
      const tau = Math.abs(target) > Math.abs(current) ? attackSeconds : releaseSeconds
      const alpha = expSmoothingAlpha(tau, dt)
      localVelocity[i] = current + (target - current) * alpha
      const next = localVelocity[i] ?? 0
      if (Math.abs(next) < 1e-4 && Math.abs(target) < 1e-6) {
        localVelocity[i] = 0
      }
    }

    {
      const tau = Math.abs(targetRollVelocity) > Math.abs(localRollVelocity) ? attackSeconds : releaseSeconds
      const alpha = expSmoothingAlpha(tau, dt)
      localRollVelocity += (targetRollVelocity - localRollVelocity) * alpha
      if (Math.abs(localRollVelocity) < 1e-4 && Math.abs(targetRollVelocity) < 1e-6) {
        localRollVelocity = 0
      }
    }

    if (rotationSmoothness > 1e-4 && !rotationMatchesTarget(rotation, targetRotation)) {
      const tau = 0.01 + rotationSmoothness * 0.35
      const alpha = expSmoothingAlpha(tau, dt)
      rotation = slerpQuaternions(rotation, targetRotation, alpha)
      changed = true
    } else if (rotationSmoothness <= 1e-4) {
      targetRotation = rotation
    }

    const localSpeed = Math.hypot(localVelocity[0], localVelocity[1], localVelocity[2])
    if (localSpeed > 1e-6) {
      const worldMove = rotateVector(rotation, localVelocity)
      position = [
        position[0] + worldMove[0] * dt,
        position[1] + worldMove[1] * dt,
        position[2] + worldMove[2] * dt,
      ]
      changed = true
    }

    if (props.player3d.spec.enableRoll) {
      if (Math.abs(localRollVelocity) > 1e-6) {
        const forward = rotateVector(rotation, [0, 0, -1])
        const rollSpeed = props.player3d.spec.lookSensitivity * 180
        const roll = quaternionFromAxisAngle(forward, localRollVelocity * rollSpeed * dt)
        rotation = multiplyQuaternions(roll, rotation)
        targetRotation = multiplyQuaternions(roll, targetRotation)
        changed = true
      }
    }

    if (changed) {
      setPose(position, rotation)
    }
  }

  if (captured.value) {
    ensureAnimationLoop()
  }
}

function ensureAnimationLoop() {
  if (!captured.value || animationFrame !== 0) return
  animationFrame = window.requestAnimationFrame(animate)
}

function clearInteractionState() {
  pressedKeys.clear()
  localVelocity[0] = 0
  localVelocity[1] = 0
  localVelocity[2] = 0
  localRollVelocity = 0
  targetRotation = cloneRotation()
  lastFrameAt = 0
  if (animationFrame !== 0) {
    cancelAnimationFrame(animationFrame)
    animationFrame = 0
  }
}

function releasePointerLock() {
  if (document.pointerLockElement === root.value) {
    document.exitPointerLock()
  }
}

function onPointerLockChange() {
  const locked = document.pointerLockElement === root.value
  captured.value = locked
  if (!locked) {
    clearInteractionState()
  } else {
    ensureAnimationLoop()
  }
}

function capturePointer(event: MouseEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  props.player3d.onTouch()
  root.value?.requestPointerLock()
}

onBeforeUnmount(() => {
  clearInteractionState()
  if (document.pointerLockElement === root.value) {
    document.exitPointerLock()
  }
  document.removeEventListener('pointerlockchange', onPointerLockChange)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('keyup', onKeyUp, true)
})

onMounted(() => {
  targetRotation = cloneRotation()
  document.addEventListener('pointerlockchange', onPointerLockChange)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
})

watch(() => props.player3d.rotation, () => {
  if (!captured.value) {
    targetRotation = cloneRotation()
  }
}, { deep: true })
</script>

<template>
  <div
    ref="root"
    class="basis player3d-basis"
    :class="{ captured }"
    :style="backgroundStyle"
    :tabindex="props.player3d.tabIndex()"
    @mousedown="capturePointer"
  >
    <div class="side-arrow top" :style="arrowStyle">▲</div>
    <div class="side-arrow right" :style="arrowStyle">▶</div>
    <div class="side-arrow bottom" :style="arrowStyle">▼</div>
    <div class="side-arrow left" :style="arrowStyle">◀</div>
    <div class="centered-label player3d-label">{{ props.player3d.spec.name }}</div>
  </div>
</template>

<style scoped>
@import './control-styles.css';

.player3d-basis {
  border-width: 0.35rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.player3d-basis.captured {
  cursor: grabbing;
}

.player3d-label {
  padding: 0 2.4rem;
  line-height: 1.2;
}

.side-arrow {
  position: absolute;
  font-size: 1.5rem;
  font-weight: 900;
  line-height: 1;
  user-select: none;
  pointer-events: none;
  text-shadow: 0 0 0.75rem rgb(0 0 0 / 0.45);
}

.side-arrow.top {
  top: 0.4rem;
  left: 50%;
  transform: translateX(-50%);
}

.side-arrow.right {
  top: 50%;
  right: 0.5rem;
  transform: translateY(-50%);
}

.side-arrow.bottom {
  bottom: 0.4rem;
  left: 50%;
  transform: translateX(-50%);
}

.side-arrow.left {
  top: 50%;
  left: 0.5rem;
  transform: translateY(-50%);
}
</style>
