<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import * as Timeline from '../engine'
import { snapTimeToMarkers } from '../snap'

const props = defineProps<{
  lane: Timeline.TimelineStepLane
  collapsed?: boolean
  manualOverride?: boolean
  height: number
  width: number
  secondsPerWidth: number
  timeOffset: number
  range: { min: number; max: number }
  snapEnabled?: boolean
  snapMarkers?: number[]
  optionLabels?: string[]
}>()

const emit = defineEmits<{
  'update:points': [points: Timeline.TimelinePoint[]]
}>()

const surfaceRef = ref<HTMLElement | null>(null)
const POINT_RADIUS = 6
const POINT_HIT_RADIUS = 12
const LABEL_GUTTER = 44
const accentColor = computed(() => props.manualOverride ? 'rgba(182, 182, 182, 1)' : 'rgba(235, 130, 52, 1)')
const accentFaintColor = computed(() => props.manualOverride ? 'rgba(182, 182, 182, 0.55)' : 'rgba(235, 130, 52, 0.55)')

function clonePointList(points: Timeline.TimelinePoint[]) {
  return points
    .map(point => ({ ...point }))
    .sort((a, b) => a.t - b.t)
}

function pointsEqual(a: Timeline.TimelinePoint[], b: Timeline.TimelinePoint[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!
    const pb = b[i]!
    if (Math.abs(pa.t - pb.t) > 1e-6) return false
    if (Math.abs(pa.v - pb.v) > 1e-6) return false
    if ((pa.kind ?? 'pos') !== (pb.kind ?? 'pos')) return false
  }
  return true
}

const workingPoints = ref<Timeline.TimelinePoint[] | null>(null)
const lastEmittedPoints = ref<Timeline.TimelinePoint[] | null>(null)

function currentPoints() {
  return workingPoints.value ?? props.lane.points
}

function cloneCurrentPoints() {
  return clonePointList(currentPoints())
}

function ensureWorkingPoints() {
  if (!workingPoints.value) {
    workingPoints.value = cloneCurrentPoints()
  }
  return workingPoints.value
}

function scheduleEmit() {
  const points = cloneCurrentPoints()
  lastEmittedPoints.value = points
  emit('update:points', points)
}

function flushEmit() {
  const points = cloneCurrentPoints()
  lastEmittedPoints.value = points
  emit('update:points', points)
}
watch(() => props.lane.points, (points) => {
  if (dragState.value) return
  const next = clonePointList(points)
  if (lastEmittedPoints.value && pointsEqual(next, lastEmittedPoints.value)) {
    lastEmittedPoints.value = null
    workingPoints.value = null
    return
  }
  workingPoints.value = null
}, { deep: true })

const discreteMin = computed(() => Math.round(Math.min(props.range.min, props.range.max)))
const discreteMax = computed(() => Math.round(Math.max(props.range.min, props.range.max)))
const discreteStepCount = computed(() => Math.max(1, discreteMax.value - discreteMin.value + 1))

function snapDiscreteValue(value: number) {
  return Math.max(discreteMin.value, Math.min(discreteMax.value, Math.round(value)))
}

function valueToY(value: number, height = props.height) {
  const topPadding = POINT_RADIUS + 2
  const bottomPadding = POINT_RADIUS + 2
  if (discreteStepCount.value <= 1) return (topPadding + Math.max(topPadding, height - bottomPadding)) / 2
  const clampedValue = snapDiscreteValue(value)
  const normalized = (clampedValue - discreteMin.value) / Math.max(1, discreteMax.value - discreteMin.value)
  const usableHeight = Math.max(1, height - topPadding - bottomPadding)
  return topPadding + (1 - normalized) * usableHeight
}

function yToValue(y: number, height = props.height) {
  const topPadding = POINT_RADIUS + 2
  const bottomPadding = POINT_RADIUS + 2
  const usableHeight = Math.max(1, height - topPadding - bottomPadding)
  const clampedY = Math.max(topPadding, Math.min(height - bottomPadding, y))
  const normalized = 1 - (clampedY - topPadding) / usableHeight
  return snapDiscreteValue(discreteMin.value + normalized * Math.max(1, discreteMax.value - discreteMin.value))
}

function timeToX(time: number, width = props.width) {
  if (!width) return 0
  return ((time - props.timeOffset) / props.secondsPerWidth) * width
}

function xToTime(x: number, width = props.width) {
  if (!width) return 0
  return (x / width) * props.secondsPerWidth + props.timeOffset
}

function applySnap(time: number) {
  if (!props.snapEnabled) return time
  return snapTimeToMarkers(time, props.snapMarkers ?? [], props.width, props.secondsPerWidth)
}

function snapValue(value: number) {
  return snapDiscreteValue(value)
}

function getValueLabel(value: number) {
  const snapped = snapDiscreteValue(value)
  const label = props.optionLabels?.[snapped]
  return label ?? `${snapped}`
}

const lanePoints = computed(() => {
  return currentPoints()
    .map((point, index) => ({
      ...point,
      index,
      x: timeToX(point.t),
      y: valueToY(point.v),
    }))
    .sort((a, b) => a.t - b.t)
})

const visibleLanePoints = computed(() => {
  return lanePoints.value.filter(point => point.x >= -20 && point.x <= props.width + 20)
})

const pathData = computed(() => {
  if (!props.width) return ''
  const segments: string[] = []
  let currentValue = discreteMin.value

  for (const point of lanePoints.value) {
    if (point.x <= 0) {
      currentValue = point.v
      continue
    }
    break
  }

  segments.push(`M0,${valueToY(currentValue).toFixed(2)}`)

  for (const point of lanePoints.value) {
    if (point.x <= 0 || point.x >= props.width) continue
    segments.push(`L${point.x.toFixed(2)},${valueToY(currentValue).toFixed(2)}`)
    segments.push(`L${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    currentValue = point.v
  }
  segments.push(`L${props.width.toFixed(2)},${valueToY(currentValue).toFixed(2)}`)
  return segments.join(' ')
})

const backgroundPathData = computed(() => {
  if (!lanePoints.value.length || !props.width) return ''
  const y = valueToY(discreteMin.value)
  return `M0,${y.toFixed(2)} L${props.width.toFixed(2)},${y.toFixed(2)}`
})

type DragState = {
  index: number
  lastClientX: number
  lastClientY: number
  startClientX: number
  startClientY: number
  moved: boolean
  createdOnPointerDown: boolean
} | null

const dragState = ref<DragState>(null)
const dragIndicator = ref<{ y: number; label: string } | null>(null)

const discreteGuideLines = computed(() => {
  if (props.collapsed) return []
  const guides: Array<{ value: number; y: number; label: string }> = []
  for (let value = discreteMin.value; value <= discreteMax.value; value += 1) {
    guides.push({
      value,
      y: valueToY(value),
      label: getValueLabel(value),
    })
  }
  return guides
})

function updateDraggedPoint(clientX: number, clientY: number) {
  if (!dragState.value || !surfaceRef.value) return
  const rect = surfaceRef.value.getBoundingClientRect()
  const point = currentPoints()[dragState.value.index]
  if (!point) return
  point.t = applySnap(xToTime(clientX - rect.left, props.width))
  point.v = snapValue(yToValue(clientY - rect.top, rect.height))
  dragState.value.lastClientX = clientX
  dragState.value.lastClientY = clientY
  dragIndicator.value = { y: valueToY(point.v, rect.height), label: getValueLabel(point.v) }
  scheduleEmit()
}

function onPointerMove(event: PointerEvent) {
  if (dragState.value && !dragState.value.moved && Math.hypot(event.clientX - dragState.value.startClientX, event.clientY - dragState.value.startClientY) > 3) {
    dragState.value.moved = true
  }
  updateDraggedPoint(event.clientX, event.clientY)
}

function onPointerUp() {
  if (dragState.value && !dragState.value.moved && !dragState.value.createdOnPointerDown) {
    const points = ensureWorkingPoints()
    const point = points[dragState.value.index]
    if (point) {
      points.splice(dragState.value.index, 1)
      flushEmit()
    }
  } else {
    flushEmit()
  }
  dragState.value = null
  dragIndicator.value = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
}

function startDragging(index: number, clientX: number, clientY: number) {
  startDraggingWithMode(index, clientX, clientY, false)
}

function startDraggingWithMode(index: number, clientX: number, clientY: number, createdOnPointerDown: boolean) {
  dragState.value = {
    index,
    lastClientX: clientX,
    lastClientY: clientY,
    startClientX: clientX,
    startClientY: clientY,
    moved: false,
    createdOnPointerDown,
  }
  const point = currentPoints()[index]
  if (point) {
    dragIndicator.value = { y: valueToY(point.v), label: getValueLabel(point.v) }
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}

function onPointPointerDown(event: PointerEvent, index: number) {
  if (event.ctrlKey || event.metaKey) return
  event.stopPropagation()
  event.preventDefault()
  startDragging(index, event.clientX, event.clientY)
}

function onSurfacePointerDown(event: PointerEvent) {
  if (event.ctrlKey || event.metaKey) return
  if (!surfaceRef.value) return
  if ((event.target as HTMLElement | null)?.closest('.step-point-group')) return
  const rect = surfaceRef.value.getBoundingClientRect()
  const nextT = applySnap(xToTime(event.clientX - rect.left, props.width))
  const points = ensureWorkingPoints()
  points.push({
    t: nextT,
    v: snapValue(yToValue(event.clientY - rect.top, rect.height)),
    kind: 'pos',
  })
  points.sort((a, b) => a.t - b.t)
  const index = points.findIndex(point => Math.abs(point.t - nextT) < 1e-6)
  if (index >= 0) {
    startDraggingWithMode(index, event.clientX, event.clientY, true)
  }
  scheduleEmit()
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
})
</script>

<template>
  <div ref="surfaceRef" class="step-surface" :class="{ collapsed }" @pointerdown="collapsed ? undefined : onSurfacePointerDown($event)">
    <template v-if="!collapsed">
      <div
        v-for="guide in discreteGuideLines"
        :key="guide.value"
        class="lane-range-line"
        :style="{ top: `${guide.y}px`, left: `${LABEL_GUTTER}px` }"
      />
      <div
        v-if="discreteGuideLines.length > 0"
        class="lane-range-label lane-max-label"
        :style="{ top: `${discreteGuideLines[0]!.y}px` }"
      >{{ discreteGuideLines[0]!.label }}</div>
      <div
        v-if="discreteGuideLines.length > 1"
        class="lane-range-label lane-min-label"
        :style="{ top: `${discreteGuideLines[discreteGuideLines.length - 1]!.y}px` }"
      >{{ discreteGuideLines[discreteGuideLines.length - 1]!.label }}</div>
      <div v-if="dragIndicator" class="lane-drag-value" :style="{ top: `${dragIndicator.y}px` }">
        {{ dragIndicator.label }}
      </div>
    </template>

    <svg
      class="step-svg"
      :viewBox="`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path v-if="backgroundPathData" :d="backgroundPathData" class="step-base-line" />
      <path v-if="pathData" :d="pathData" class="step-line" />
      <g
        v-for="point in visibleLanePoints"
        :key="`${point.index}-${point.t}`"
        class="step-point-group"
        :class="{ dragging: dragState?.index === point.index }"
        @pointerdown="collapsed ? undefined : onPointPointerDown($event, point.index)"
      >
        <circle v-if="!collapsed" class="step-point-dot" :cx="point.x" :cy="point.y" :r="POINT_RADIUS" />
        <circle v-if="!collapsed" class="step-point-hit" :cx="point.x" :cy="point.y" :r="POINT_HIT_RADIUS" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.step-surface {
  position: absolute;
  inset: 0;
  cursor: crosshair;
  background: rgba(255,255,255,0.012);
}

.step-svg {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: visible;
}

.lane-range-line {
  position: absolute;
  right: 0;
  height: 0;
  border-top: 0.1rem dotted rgba(255, 255, 255, 0.16);
  pointer-events: none;
  z-index: 1;
}

.lane-range-label {
  position: absolute;
  left: 0.3rem;
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.65);
  pointer-events: none;
  z-index: 3;
  white-space: nowrap;
}

.lane-max-label,
.lane-min-label {
  transform: translateY(-50%);
}

.step-base-line {
  fill: none;
  stroke: v-bind(accentFaintColor);
  stroke-width: 0.1rem;
}

.step-line {
  fill: none;
  stroke: v-bind(accentColor);
  stroke-width: 0.1rem;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.step-point-group {
  cursor: pointer;
}

.step-point-hit {
  opacity: 0;
  transition: opacity 0.12s ease;
  fill: v-bind(accentColor);
}

.step-point-dot {
  fill: v-bind(accentColor);
  stroke: rgba(15, 17, 21, 0.8);
  stroke-width: 0.1rem;
}

.step-point-group:hover .step-point-hit,
.step-point-group.dragging .step-point-hit {
  opacity: 0.45;
}

.lane-drag-value {
  position: absolute;
  right: 0.55rem;
  transform: translateY(-50%);
  font-size: 0.68rem;
  color: rgba(255, 255, 255, 0.86);
  background: rgba(15, 17, 21, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 0.3rem;
  padding: 0.1rem 0.38rem;
  pointer-events: none;
  z-index: 4;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
