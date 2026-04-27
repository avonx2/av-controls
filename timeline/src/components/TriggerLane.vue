<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Timeline from '../engine'
import { snapTimeToMarkers } from '../snap'

const props = defineProps<{
  lane: Timeline.TimelineTriggerLane
  collapsed?: boolean
  manualOverride?: boolean
  height: number
  width: number
  secondsPerWidth: number
  timeOffset: number
  range: { min: number; max: number }
  snapEnabled?: boolean
  snapMarkers?: number[]
}>()

const emit = defineEmits<{
  'update:triggers': [triggers: Timeline.TimelineTrigger[]]
}>()

const surfaceRef = ref<HTMLElement | null>(null)
const surfaceWidthPx = ref(0)
const isViewportVisible = ref(true)
const POINT_RADIUS = 6
const POINT_HIT_RADIUS = 12
const accentColor = computed(() => props.manualOverride ? 'rgba(182, 182, 182, 1)' : 'rgba(235, 130, 52, 1)')
const accentFaintColor = computed(() => props.manualOverride ? 'rgba(182, 182, 182, 0.55)' : 'rgba(235, 130, 52, 0.55)')
const secondaryColor = computed(() => props.manualOverride ? 'rgba(214, 214, 214, 1)' : 'rgba(150, 220, 255, 1)')
const MIN_TRIGGER_DURATION = 0.05

let surfaceResizeObserver: ResizeObserver | null = null
let intersectionObserver: IntersectionObserver | null = null

function updateSurfaceWidth() {
  const rect = surfaceRef.value?.getBoundingClientRect()
  surfaceWidthPx.value = rect ? Math.max(0, rect.width) : 0
}

function getSurfaceWidth() {
  return surfaceWidthPx.value || props.width
}

function cloneTriggerList(triggers: Timeline.TimelineTrigger[]) {
  return triggers
    .map(trigger => ({
      on: { ...trigger.on },
      off: { ...trigger.off },
    }))
    .sort((a, b) => a.on.t - b.on.t)
}

const workingTriggers = ref<Timeline.TimelineTrigger[] | null>(null)
const lastEmittedTriggers = ref<Timeline.TimelineTrigger[] | null>(null)

function currentTriggers() {
  return workingTriggers.value ?? props.lane.triggers
}

function cloneCurrentTriggers() {
  return cloneTriggerList(currentTriggers())
}

function triggersEqual(a: Timeline.TimelineTrigger[], b: Timeline.TimelineTrigger[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ta = a[i]!
    const tb = b[i]!
    if (Math.abs(ta.on.t - tb.on.t) > 1e-6) return false
    if (Math.abs(ta.on.value - tb.on.value) > 1e-6) return false
    if (Math.abs(ta.off.t - tb.off.t) > 1e-6) return false
  }
  return true
}

watch(() => props.lane.triggers, (triggers) => {
  if (dragState.value) return
  const next = cloneTriggerList(triggers)
  if (lastEmittedTriggers.value && triggersEqual(next, lastEmittedTriggers.value)) {
    lastEmittedTriggers.value = null
    workingTriggers.value = null
    return
  }
  workingTriggers.value = null
}, { deep: true })

function scheduleEmit() {
  const triggers = cloneCurrentTriggers()
  lastEmittedTriggers.value = triggers
  emit('update:triggers', triggers)
}

function flushEmit() {
  const triggers = cloneCurrentTriggers()
  lastEmittedTriggers.value = triggers
  emit('update:triggers', triggers)
}

const animatedMaxVelocity = ref(1)
let animationRafId: number | null = null

const targetMaxVelocity = computed(() => {
  const visibleTimeMin = props.timeOffset
  const visibleTimeMax = props.timeOffset + props.secondsPerWidth
  let maxVelocity = 0
  for (const trigger of currentTriggers()) {
    if (trigger.on.t < visibleTimeMin || trigger.on.t > visibleTimeMax) continue
    maxVelocity = Math.max(maxVelocity, Math.max(0, trigger.on.value))
  }
  return Math.max(1, maxVelocity)
})

function initAnimatedRange() {
  animatedMaxVelocity.value = targetMaxVelocity.value
}

function runAnimation() {
  const delta = targetMaxVelocity.value - animatedMaxVelocity.value
  animatedMaxVelocity.value += delta * 0.12
  if (Math.abs(delta) < 0.002) {
    animatedMaxVelocity.value = targetMaxVelocity.value
    animationRafId = null
    return
  }
  animationRafId = requestAnimationFrame(runAnimation)
}

function startAnimationIfNeeded() {
  if (!isViewportVisible.value) return
  if (animationRafId !== null) return
  if (Math.abs(targetMaxVelocity.value - animatedMaxVelocity.value) < 0.002) return
  animationRafId = requestAnimationFrame(runAnimation)
}

function getPointY(value: number, height = props.height) {
  const offTop = offBandTopY.value
  const offBottom = offBandBottomY.value
  const maxY = maxLabelY.value
  if (value <= 0) {
    const norm = (value + 1) / 1
    return offBottom - norm * (offBottom - offTop)
  }
  const span = Math.max(1e-6, animatedMaxVelocity.value)
  const norm = value / span
  return offTop - norm * (offTop - maxY)
}

function valueToY(value: number, height = props.height) {
  if (value < 0) return getPointY(-1, height)
  return getPointY(value, height)
}

function yToValue(y: number, height = props.height) {
  const clampedY = Math.max(0, Math.min(height, y))
  if (clampedY >= offBandTopY.value) {
    const norm = (offBandBottomY.value - clampedY) / Math.max(1e-6, offBandBottomY.value - offBandTopY.value)
    return -1 + norm
  }
  const norm = (offBandTopY.value - clampedY) / Math.max(1e-6, offBandTopY.value - maxLabelY.value)
  return norm * Math.max(1, animatedMaxVelocity.value)
}

function timeToX(time: number, width = getSurfaceWidth()) {
  if (!width) return 0
  return ((time - props.timeOffset) / props.secondsPerWidth) * width
}

function xToTime(x: number, width = getSurfaceWidth()) {
  if (!width) return 0
  return (x / width) * props.secondsPerWidth + props.timeOffset
}

function applySnap(time: number, width = getSurfaceWidth()) {
  if (!props.snapEnabled) return time
  return snapTimeToMarkers(time, props.snapMarkers ?? [], width, props.secondsPerWidth)
}

function clampOnValue(value: number) {
  return Math.max(0, value)
}

function formatVelocity(value: number) {
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2).replace(/\.?0+$/, '')
}

const offBandTopY = computed(() => props.height * (2 / 3))
const offBandBottomY = computed(() => props.height)
const maxLabelY = computed(() => props.height * 0.1)
const zeroLabelY = computed(() => offBandTopY.value)
const offLabelY = computed(() => offBandTopY.value)

function yToOnDisplayValue(y: number, height = props.height) {
  const displayMin = 0
  const displayMax = Math.max(1, animatedMaxVelocity.value)
  const span = displayMax - displayMin
  if (span <= 0) return displayMin
  const clampedY = Math.max(0, Math.min(height, y))
  const norm = (offBandTopY.value - clampedY) / Math.max(1e-6, offBandTopY.value - maxLabelY.value)
  return displayMin + norm * span
}

const topLabel = computed(() => formatVelocity(animatedMaxVelocity.value))

type TriggerHandle = {
  trigger: Timeline.TimelineTrigger
  index: number
  role: 'on' | 'off'
  x: number
  y: number
}

const triggerHandles = computed<TriggerHandle[]>(() => {
  return currentTriggers().flatMap((trigger, index) => ([
    {
      trigger,
      index,
      role: 'on' as const,
      x: timeToX(trigger.on.t),
      y: valueToY(trigger.on.value),
    },
    {
      trigger,
      index,
      role: 'off' as const,
      x: timeToX(trigger.off.t),
      y: valueToY(-1),
    },
  ]))
})

const visibleHandles = computed(() => {
  const width = getSurfaceWidth()
  return triggerHandles.value.filter(handle => handle.x >= -20 && handle.x <= width + 20)
})

function getMeanTriggerDuration() {
  const triggers = currentTriggers()
  if (!triggers.length) return Math.max(MIN_TRIGGER_DURATION, props.secondsPerWidth / 12)
  return triggers.reduce((sum, trigger) => sum + Math.max(MIN_TRIGGER_DURATION, trigger.off.t - trigger.on.t), 0) / triggers.length
}

function getNextOnTime(index: number) {
  const next = currentTriggers()[index + 1]
  return next ? next.on.t : Infinity
}

function getPreviousOnTime(index: number) {
  const previous = currentTriggers()[index - 1]
  return previous ? previous.on.t : -Infinity
}

function getTriggerIndex(trigger: Timeline.TimelineTrigger) {
  return currentTriggers().indexOf(trigger)
}

function findPreviousTriggerIndex(time: number) {
  let previousIndex = -1
  const triggers = currentTriggers()
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i]!.on.t < time) previousIndex = i
  }
  return previousIndex
}

function repositionPreviousOff(time: number) {
  const previousIndex = findPreviousTriggerIndex(time)
  if (previousIndex < 0) return
  const previous = currentTriggers()[previousIndex]
  if (!previous) return
  const desiredOffT = previous.on.t + Math.min(getMeanTriggerDuration(), Math.max(0, time - previous.on.t))
  previous.off.t = Math.max(previous.on.t, Math.min(previous.off.t, desiredOffT))
}

function createTrigger(time: number, value: number) {
  if (!workingTriggers.value) workingTriggers.value = cloneCurrentTriggers()
  repositionPreviousOff(time)
  const triggers = currentTriggers()
  const insertIndex = triggers.findIndex(trigger => trigger.on.t > time)
  const nextOnTime = insertIndex >= 0 ? triggers[insertIndex]!.on.t : Infinity
  const duration = Math.max(MIN_TRIGGER_DURATION, Math.min(getMeanTriggerDuration(), nextOnTime - time))
  const trigger = {
    on: { t: time, value: Math.max(0, value) },
    off: { t: time + duration },
  }
  triggers.push(trigger)
  triggers.sort((a, b) => a.on.t - b.on.t)
  return trigger
}

const pathData = computed(() => {
  const width = getSurfaceWidth()
  if (!width) return ''
  const visibleTimeMin = props.timeOffset
  const visibleTimeMax = props.timeOffset + props.secondsPerWidth
  const segments: string[] = []
  let currentValue = -1

  for (const trigger of currentTriggers()) {
    if (trigger.on.t <= visibleTimeMin && trigger.off.t > visibleTimeMin) {
      currentValue = trigger.on.value
      break
    }
    if (trigger.off.t <= visibleTimeMin) currentValue = -1
    if (trigger.on.t > visibleTimeMin) break
  }

  let currentX = 0
  segments.push(`M0,${valueToY(currentValue).toFixed(2)}`)

  for (const trigger of currentTriggers()) {
    if (trigger.off.t <= visibleTimeMin) continue
    if (trigger.on.t >= visibleTimeMax) break

    const onX = Math.max(0, Math.min(width, timeToX(trigger.on.t, width)))
    const offX = Math.max(0, Math.min(width, timeToX(trigger.off.t, width)))
    const onY = valueToY(trigger.on.value).toFixed(2)

    if (trigger.on.t >= visibleTimeMin) {
      if (onX > currentX) segments.push(`L${onX.toFixed(2)},${valueToY(currentValue).toFixed(2)}`)
      currentX = onX
      currentValue = trigger.on.value
      segments.push(`L${currentX.toFixed(2)},${onY}`)
    } else if (currentValue !== trigger.on.value) {
      currentValue = trigger.on.value
      segments.push(`L${currentX.toFixed(2)},${onY}`)
    }

    if (trigger.off.t <= visibleTimeMax) {
      if (offX > currentX) segments.push(`L${offX.toFixed(2)},${valueToY(currentValue).toFixed(2)}`)
      currentX = offX
      currentValue = -1
      segments.push(`L${currentX.toFixed(2)},${valueToY(currentValue).toFixed(2)}`)
    } else {
      if (width > currentX) segments.push(`L${width.toFixed(2)},${valueToY(currentValue).toFixed(2)}`)
      currentX = width
      break
    }
  }

  if (currentX < width) {
    segments.push(`L${width.toFixed(2)},${valueToY(currentValue).toFixed(2)}`)
  }

  return segments.join(' ')
})

const backgroundPathData = computed(() => {
  const width = getSurfaceWidth()
  if (!currentTriggers().length || !width) return ''
  return `M0,${valueToY(-1).toFixed(2)} L${width.toFixed(2)},${valueToY(-1).toFixed(2)}`
})

type DragState = {
  trigger: Timeline.TimelineTrigger
  role: 'on' | 'off'
  pairDuration: number
  previousTrigger: Timeline.TimelineTrigger | null
  restorePreviousOffT: number | null
  lastClientX: number
  lastClientY: number
  startClientX: number
  startClientY: number
  moved: boolean
  createdOnPointerDown: boolean
} | null

const dragState = ref<DragState>(null)
const triggerUids = new WeakMap<Timeline.TimelineTrigger, number>()
let nextTriggerUid = 1

function getTriggerUid(trigger: Timeline.TimelineTrigger) {
  let uid = triggerUids.get(trigger)
  if (!uid) {
    uid = nextTriggerUid++
    triggerUids.set(trigger, uid)
  }
  return uid
}

function getPreviousTrigger(trigger: Timeline.TimelineTrigger, role: 'on' | 'off') {
  const triggerIndex = getTriggerIndex(trigger)
  if (role !== 'on' || triggerIndex <= 0) return null
  return currentTriggers()[triggerIndex - 1] ?? null
}

function beginDrag(
  trigger: Timeline.TimelineTrigger,
  role: 'on' | 'off',
  clientX: number,
  clientY: number,
  createdOnPointerDown: boolean,
  restorePreviousOffT: number | null = null,
) {
  const triggerIndex = getTriggerIndex(trigger)
  if (!workingTriggers.value) {
    workingTriggers.value = cloneCurrentTriggers()
  }
  const activeTrigger = triggerIndex >= 0 ? currentTriggers()[triggerIndex] ?? trigger : trigger
  const previousTrigger = getPreviousTrigger(activeTrigger, role)
  dragState.value = {
    trigger: activeTrigger,
    role,
    pairDuration: activeTrigger.off.t - activeTrigger.on.t,
    previousTrigger,
    restorePreviousOffT: restorePreviousOffT ?? previousTrigger?.off.t ?? null,
    lastClientX: clientX,
    lastClientY: clientY,
    startClientX: clientX,
    startClientY: clientY,
    moved: false,
    createdOnPointerDown,
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}

function applyOnDrag(state: Exclude<DragState, null>, nextT: number, nextValue: number) {
  const trigger = state.trigger
  const currentIndex = getTriggerIndex(trigger)
  if (currentIndex < 0) return

  const previousTrigger = currentTriggers()[currentIndex - 1] ?? null
  const previousOnTime = previousTrigger ? previousTrigger.on.t : -Infinity
  const nextOnTime = getNextOnTime(currentIndex)

  trigger.on.t = Math.max(previousOnTime, Math.min(nextT, nextOnTime))
  trigger.on.value = clampOnValue(nextValue)

  if (previousTrigger && state.previousTrigger === previousTrigger && state.restorePreviousOffT !== null) {
    previousTrigger.off.t = Math.max(
      previousTrigger.on.t,
      Math.min(state.restorePreviousOffT, trigger.on.t),
    )
  }

  trigger.off.t = Math.max(
    trigger.on.t,
    Math.min(trigger.on.t + state.pairDuration, nextOnTime),
  )
}

function applyOffDrag(state: Exclude<DragState, null>, nextT: number) {
  const trigger = state.trigger
  const currentIndex = getTriggerIndex(trigger)
  if (currentIndex < 0) return
  const nextOnTime = getNextOnTime(currentIndex)
  trigger.off.t = Math.max(trigger.on.t, Math.min(nextT, nextOnTime))
}

function updateDraggedTrigger(clientX: number, clientY: number) {
  const state = dragState.value
  if (!state || !surfaceRef.value) return
  const rect = surfaceRef.value.getBoundingClientRect()
  const nextT = applySnap(xToTime(clientX - rect.left, rect.width), rect.width)
  const nextValue = yToValue(clientY - rect.top, rect.height)

  if (state.role === 'on') {
    applyOnDrag(state, nextT, nextValue)
  } else {
    applyOffDrag(state, nextT)
  }

  currentTriggers().sort((a, b) => a.on.t - b.on.t)
  state.lastClientX = clientX
  state.lastClientY = clientY
  scheduleEmit()
}

function onPointerMove(event: PointerEvent) {
  if (dragState.value && !dragState.value.moved && Math.hypot(event.clientX - dragState.value.startClientX, event.clientY - dragState.value.startClientY) > 3) {
    dragState.value.moved = true
  }
  updateDraggedTrigger(event.clientX, event.clientY)
}

function onPointerUp() {
  if (dragState.value && !dragState.value.moved && !dragState.value.createdOnPointerDown) {
    const triggers = currentTriggers()
    const index = triggers.indexOf(dragState.value.trigger)
    const deleted = index >= 0
    dragState.value = null
    if (deleted) triggers.splice(index, 1)
    flushEmit()
  } else {
    flushEmit()
    dragState.value = null
  }
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
}

function onHandlePointerDown(event: PointerEvent, handle: TriggerHandle) {
  if (event.ctrlKey || event.metaKey) return
  event.stopPropagation()
  event.preventDefault()
  beginDrag(handle.trigger, handle.role, event.clientX, event.clientY, false)
}

function onSurfacePointerDown(event: PointerEvent) {
  if (event.ctrlKey || event.metaKey) return
  if (!surfaceRef.value) return
  if ((event.target as HTMLElement | null)?.closest('.trigger-point-group')) return
  const rect = surfaceRef.value.getBoundingClientRect()
  const nextT = applySnap(xToTime(event.clientX - rect.left, rect.width), rect.width)
  const nextV = clampOnValue(yToValue(event.clientY - rect.top, rect.height))
  const previousTriggerIndex = findPreviousTriggerIndex(nextT)
  if (!workingTriggers.value) workingTriggers.value = cloneCurrentTriggers()
  const previousTrigger = previousTriggerIndex >= 0 ? currentTriggers()[previousTriggerIndex] ?? null : null
  const restorePreviousOffT = previousTrigger ? previousTrigger.off.t : null
  const trigger = createTrigger(nextT, nextV)
  beginDrag(trigger, 'on', event.clientX, event.clientY, true, restorePreviousOffT)
}

watch(targetMaxVelocity, () => {
  startAnimationIfNeeded()
})

watch(() => animatedMaxVelocity.value, () => {
  if (dragState.value) {
    updateDraggedTrigger(dragState.value.lastClientX, dragState.value.lastClientY)
  }
})

watch(() => props.lane.key, initAnimatedRange)
watch(isViewportVisible, (visible) => {
  if (visible) {
    startAnimationIfNeeded()
    return
  }
  if (animationRafId !== null) {
    cancelAnimationFrame(animationRafId)
    animationRafId = null
  }
})
initAnimatedRange()

onMounted(() => {
  updateSurfaceWidth()
  surfaceResizeObserver = new ResizeObserver(() => {
    updateSurfaceWidth()
  })
  if (surfaceRef.value) {
    surfaceResizeObserver.observe(surfaceRef.value)
    intersectionObserver = new IntersectionObserver((entries) => {
      isViewportVisible.value = entries.some((entry) => entry.isIntersecting)
    }, { threshold: 0 })
    intersectionObserver.observe(surfaceRef.value)
  }
})

onBeforeUnmount(() => {
  if (animationRafId !== null) cancelAnimationFrame(animationRafId)
  surfaceResizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
})
</script>

<template>
  <div ref="surfaceRef" class="trigger-surface" :class="{ collapsed }" @pointerdown="collapsed ? undefined : onSurfacePointerDown($event)">
    <div
      v-if="!collapsed"
      class="trigger-off-band"
      :style="{
        top: `${offBandTopY}px`,
        height: `${Math.max(0, offBandBottomY - offBandTopY)}px`,
      }"
    />

    <div v-if="!collapsed" class="lane-range-line" :style="{ top: `${maxLabelY}px`, left: `0px` }" />
    <div v-if="!collapsed" class="lane-range-line" :style="{ top: `${offBandTopY}px`, left: `0px` }" />
    <div v-if="!collapsed" class="lane-range-label lane-max-label" :style="{ top: `${maxLabelY}px` }">{{ topLabel }}</div>
    <div v-if="!collapsed" class="lane-range-label lane-off-label" :style="{ top: `${offLabelY}px` }">off</div>
    <div v-if="!collapsed" class="lane-range-label lane-zero-label" :style="{ top: `${zeroLabelY}px` }">0</div>

    <svg
      class="trigger-svg"
      :viewBox="`0 0 ${Math.max(1, getSurfaceWidth())} ${Math.max(1, height)}`"
      preserveAspectRatio="none"
      aria-hidden="true"
      :style="{ top: '0px', height: '100%' }"
    >
      <path v-if="backgroundPathData" :d="backgroundPathData" class="trigger-base-line" />
      <path v-if="pathData" :d="pathData" class="trigger-line" />
      <g
        v-for="handle in visibleHandles"
        :key="`${getTriggerUid(handle.trigger)}-${handle.role}`"
        class="trigger-point-group"
        :class="{ dragging: dragState?.trigger === handle.trigger }"
        @pointerdown="collapsed ? undefined : onHandlePointerDown($event, handle)"
      >
        <circle v-if="!collapsed" class="trigger-point-dot" :class="handle.role" :cx="handle.x" :cy="handle.y" :r="POINT_RADIUS" />
        <circle v-if="!collapsed" class="trigger-point-hit" :class="handle.role" :cx="handle.x" :cy="handle.y" :r="POINT_HIT_RADIUS" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.trigger-surface {
  position: absolute;
  inset: 0;
  cursor: crosshair;
  background: rgba(255,255,255,0.012);
}

.trigger-off-band {
  position: absolute;
  left: 0;
  right: 0;
  background: rgba(68, 136, 255, 0.13);
  pointer-events: none;
  z-index: 0;
}

.trigger-svg {
  position: absolute;
  left: 0;
  width: 100%;
  z-index: 2;
  overflow: visible;
  display: block;
}

.lane-range-line {
  position: absolute;
  right: 0;
  height: 0;
  border-top: 0.1rem dotted rgba(255, 255, 255, 0.25);
  pointer-events: none;
  z-index: 1;
}

.lane-range-label {
  position: absolute;
  left: 0.3rem;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.87);
  pointer-events: none;
  z-index: 3;
  white-space: nowrap;
}

.lane-max-label,
.lane-min-label { transform: translateY(-50%); }
.lane-off-label { transform: translateY(0); }
.lane-zero-label { transform: translateY(-100%); }

.trigger-base-line {
  fill: none;
  stroke: v-bind(accentFaintColor);
  stroke-width: 0.1rem;
}

.trigger-line {
  fill: none;
  stroke: v-bind(accentColor);
  stroke-width: 0.1rem;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.trigger-point-group { cursor: pointer; }

.trigger-point-hit {
  opacity: 0;
  transition: opacity 0.12s ease;
}

.trigger-point-hit.on { fill: v-bind(accentColor); }
.trigger-point-hit.off { fill: v-bind(secondaryColor); }

.trigger-point-dot {
  stroke: rgba(15, 17, 21, 0.8);
  stroke-width: 0.1rem;
}

.trigger-point-dot.on { fill: v-bind(accentColor); }
.trigger-point-dot.off { fill: v-bind(secondaryColor); }

.trigger-point-group:hover .trigger-point-hit,
.trigger-point-group.dragging .trigger-point-hit {
  opacity: 0.45;
}
</style>
