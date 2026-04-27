<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import * as Timeline from '../engine'
import { snapTimeToMarkers } from '../snap'

const KEYFRAME_RADIUS = 6
const KEYFRAME_HIT_RADIUS = 12
const HANDLE_HALF_HEIGHT = 6
const HANDLE_LENGTH = 12
const HANDLE_HIT_SCALE = 2

const props = defineProps<{
  lane: Timeline.TimelineKeyframeLane
  collapsed?: boolean
  manualOverride?: boolean
  height: number
  width: number
  secondsPerWidth: number
  timeOffset: number
  snapEnabled?: boolean
  snapMarkers?: number[]
}>()

const emit = defineEmits<{
  'update:keyframes': [keyframes: Timeline.TimelineKeyframe[]]
}>()

const accentColor = computed(() => props.manualOverride ? 'rgba(182, 182, 182, 1)' : 'rgba(235, 130, 52, 1)')
const secondaryColor = computed(() => props.manualOverride ? 'rgba(214, 214, 214, 1)' : 'rgba(150, 220, 255, 1)')
const secondaryLineColor = computed(() => props.manualOverride ? 'rgba(214, 214, 214, 0.9)' : 'rgba(150, 220, 255, 0.9)')
const deleteColor = computed(() => props.manualOverride ? 'rgba(126, 126, 126, 1)' : 'rgba(224, 78, 78, 1)')

function timeToX(time: number) {
  if (!props.width) return 0
  return ((time - props.timeOffset) / props.secondsPerWidth) * props.width
}

function xToTime(x: number) {
  if (!props.width) return 0
  return (x / props.width) * props.secondsPerWidth + props.timeOffset
}

function applySnap(time: number) {
  if (!props.snapEnabled) return time
  return snapTimeToMarkers(time, props.snapMarkers ?? [], props.width, props.secondsPerWidth)
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function cloneKeyframes() {
  return props.lane.keyframes.map(keyframe => ({
    ...keyframe,
    value: cloneValue(keyframe.value),
  }))
}

const keyframes = computed(() => {
  return props.lane.keyframes
    .map((keyframe, index) => ({
      ...keyframe,
      index,
      x: timeToX(keyframe.t),
    }))
    .sort((a, b) => a.t - b.t)
})

function trianglePoints(tipX: number, cy: number, direction: 'left' | 'right', scale = 1) {
  const basePoints = direction === 'left'
    ? [
        { x: tipX - HANDLE_LENGTH, y: cy - HANDLE_HALF_HEIGHT },
        { x: tipX - HANDLE_LENGTH, y: cy + HANDLE_HALF_HEIGHT },
        { x: tipX, y: cy },
      ]
    : [
        { x: tipX + HANDLE_LENGTH, y: cy - HANDLE_HALF_HEIGHT },
        { x: tipX + HANDLE_LENGTH, y: cy + HANDLE_HALF_HEIGHT },
        { x: tipX, y: cy },
      ]

  if (scale === 1) {
    return basePoints.map(point => `${point.x} ${point.y}`).join(' ')
  }

  const centroid = {
    x: (basePoints[0]!.x + basePoints[1]!.x + basePoints[2]!.x) / 3,
    y: (basePoints[0]!.y + basePoints[1]!.y + basePoints[2]!.y) / 3,
  }

  return basePoints
    .map(point => ({
      x: centroid.x + (point.x - centroid.x) * scale,
      y: centroid.y + (point.y - centroid.y) * scale,
    }))
    .map(point => `${point.x} ${point.y}`)
    .join(' ')
}

function getPrev(index: number) {
  return keyframes.value[index - 1] ?? null
}

function getNext(index: number) {
  return keyframes.value[index + 1] ?? null
}

function getLeftHandleX(index: number) {
  const keyframe = keyframes.value[index]
  if (!keyframe) return 0
  const prev = getPrev(index)
  if (!prev) return keyframe.x
  const smooth = clamp01(keyframe.leftSmooth ?? 0.5)
  return keyframe.x - ((keyframe.x - prev.x) * 0.5 * smooth)
}

function getRightHandleX(index: number) {
  const keyframe = keyframes.value[index]
  if (!keyframe) return 0
  const next = getNext(index)
  if (!next) return keyframe.x
  const smooth = clamp01(keyframe.rightSmooth ?? 0.5)
  return keyframe.x + ((next.x - keyframe.x) * 0.5 * smooth)
}

type DragState =
  | { type: 'keyframe'; index: number; startClientX: number; moved: boolean }
  | { type: 'left'; index: number; startClientX: number; moved: boolean }
  | { type: 'right'; index: number; startClientX: number; moved: boolean }
  | null

const dragState = ref<DragState>(null)
const pendingDelete = ref<{ type: 'keyframe' | 'left' | 'right'; index: number } | null>(null)

function emitSorted(next: Timeline.TimelineKeyframe[]) {
  emit('update:keyframes', Timeline.sortTimelineKeyframes(next))
}

function updateDrag(clientX: number) {
  if (!dragState.value) return
  const next = cloneKeyframes()
  const rect = laneRef.value?.getBoundingClientRect()
  if (!rect) return
  const localX = clientX - rect.left

  if (dragState.value.type === 'keyframe') {
    const item = next[dragState.value.index]
    if (!item) return
    item.t = Math.max(0, applySnap(xToTime(localX)))
    emitSorted(next)
    return
  }

  const item = next[dragState.value.index]
  if (!item) return
  const currentX = timeToX(item.t)
  if (dragState.value.type === 'left') {
    const prev = keyframes.value[dragState.value.index - 1]
    if (!prev) return
    const maxDistance = Math.max(1e-6, (currentX - prev.x) * 0.5)
    const used = currentX - localX
    item.leftSmooth = clamp01(used / maxDistance)
    emitSorted(next)
    return
  }

  const nextKeyframe = keyframes.value[dragState.value.index + 1]
  if (!nextKeyframe) return
  const maxDistance = Math.max(1e-6, (nextKeyframe.x - currentX) * 0.5)
  const used = localX - currentX
  item.rightSmooth = clamp01(used / maxDistance)
  emitSorted(next)
}

function stopDrag() {
  if (dragState.value && !dragState.value.moved) {
    const pendingType = dragState.value.type
    const pendingKey = { type: pendingType, index: dragState.value.index } as const
    if (pendingDelete.value && pendingDelete.value.type === pendingType && pendingDelete.value.index === dragState.value.index) {
      const next = cloneKeyframes()
      const item = next[dragState.value.index]
      if (item) {
        if (pendingType === 'keyframe') {
          next.splice(dragState.value.index, 1)
        } else if (pendingType === 'left') {
          item.leftSmooth = 0
        } else {
          item.rightSmooth = 0
        }
        pendingDelete.value = null
        emitSorted(next)
      }
    } else {
      pendingDelete.value = pendingKey
    }
  } else if (dragState.value) {
    pendingDelete.value = null
  }
  dragState.value = null
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
}

function onWindowPointerMove(event: PointerEvent) {
  if (dragState.value && !dragState.value.moved && Math.abs(event.clientX - dragState.value.startClientX) > 3) {
    dragState.value.moved = true
  }
  updateDrag(event.clientX)
}

const laneRef = ref<HTMLElement | null>(null)
const laneMidY = computed(() => props.height / 2)

const visibleKeyframes = computed(() => {
  const viewportMin = -Math.max(24, HANDLE_LENGTH * HANDLE_HIT_SCALE)
  const viewportMax = props.width + Math.max(24, HANDLE_LENGTH * HANDLE_HIT_SCALE)

  return keyframes.value.filter((keyframe) => {
    const xs = [keyframe.x]
    if (getPrev(keyframe.index)) xs.push(getLeftHandleX(keyframe.index))
    if (getNext(keyframe.index)) xs.push(getRightHandleX(keyframe.index))
    return xs.some(x => x >= viewportMin && x <= viewportMax)
  })
})

function startDrag(event: PointerEvent, state: Exclude<DragState, null>) {
  event.stopPropagation()
  if (
    !pendingDelete.value
    || pendingDelete.value.type !== state.type
    || pendingDelete.value.index !== state.index
  ) {
    pendingDelete.value = null
  }
  dragState.value = state
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
}

onBeforeUnmount(() => {
  stopDrag()
})
</script>

<template>
  <div ref="laneRef" class="keyframe-lane">
    <div v-if="!collapsed" class="lane-center-line" />
    <svg
      class="keyframe-svg"
      :viewBox="`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line
        v-if="collapsed"
        class="keyframe-collapsed-line"
        x1="0"
        :y1="laneMidY"
        :x2="Math.max(1, width)"
        :y2="laneMidY"
      />
      <template v-for="keyframe in visibleKeyframes" :key="`${keyframe.t}-${keyframe.index}`">
        <line
          v-if="!collapsed && getPrev(keyframe.index)"
          class="keyframe-handle-line"
          :x1="keyframe.x"
          :y1="laneMidY"
          :x2="getLeftHandleX(keyframe.index)"
          :y2="laneMidY"
        />
        <line
          v-if="getNext(keyframe.index)"
          class="keyframe-handle-line"
          :x1="keyframe.x"
          :y1="laneMidY"
          :x2="getRightHandleX(keyframe.index)"
          :y2="laneMidY"
        />
        <g
          v-if="!collapsed && getPrev(keyframe.index)"
          class="keyframe-handle-group"
          :class="{
            dragging: dragState?.type === 'left' && dragState.index === keyframe.index,
            pendingDelete: pendingDelete?.type === 'left' && pendingDelete.index === keyframe.index,
          }"
        >
          <polygon
            class="keyframe-handle"
            :points="trianglePoints(getLeftHandleX(keyframe.index), laneMidY, 'left')"
            @pointerdown.prevent="startDrag($event, { type: 'left', index: keyframe.index, startClientX: $event.clientX, moved: false })"
          />
          <polygon
            class="keyframe-handle-hit"
            :points="trianglePoints(getLeftHandleX(keyframe.index), laneMidY, 'left', HANDLE_HIT_SCALE)"
            @pointerdown.prevent="startDrag($event, { type: 'left', index: keyframe.index, startClientX: $event.clientX, moved: false })"
          />
        </g>
        <g
          v-if="!collapsed && getNext(keyframe.index)"
          class="keyframe-handle-group"
          :class="{
            dragging: dragState?.type === 'right' && dragState.index === keyframe.index,
            pendingDelete: pendingDelete?.type === 'right' && pendingDelete.index === keyframe.index,
          }"
        >
          <polygon
            class="keyframe-handle"
            :points="trianglePoints(getRightHandleX(keyframe.index), laneMidY, 'right')"
            @pointerdown.prevent="startDrag($event, { type: 'right', index: keyframe.index, startClientX: $event.clientX, moved: false })"
          />
          <polygon
            class="keyframe-handle-hit"
            :points="trianglePoints(getRightHandleX(keyframe.index), laneMidY, 'right', HANDLE_HIT_SCALE)"
            @pointerdown.prevent="startDrag($event, { type: 'right', index: keyframe.index, startClientX: $event.clientX, moved: false })"
          />
        </g>
        <g
          v-if="!collapsed"
          class="keyframe-point-group"
          :class="{
            dragging: dragState?.type === 'keyframe' && dragState.index === keyframe.index,
            pendingDelete: pendingDelete?.type === 'keyframe' && pendingDelete.index === keyframe.index,
          }"
        >
          <circle
            class="keyframe-dot"
            :cx="keyframe.x"
            :cy="laneMidY"
            :r="KEYFRAME_RADIUS"
            @pointerdown.prevent="startDrag($event, { type: 'keyframe', index: keyframe.index, startClientX: $event.clientX, moved: false })"
          />
          <circle
            class="keyframe-point-hit"
            :cx="keyframe.x"
            :cy="laneMidY"
            :r="KEYFRAME_HIT_RADIUS"
            @pointerdown.prevent="startDrag($event, { type: 'keyframe', index: keyframe.index, startClientX: $event.clientX, moved: false })"
          />
        </g>
      </template>
    </svg>
  </div>
</template>

<style scoped>
.keyframe-lane {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.keyframe-svg {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.keyframe-point-hit {
  fill: v-bind(accentColor);
  opacity: 0;
  transition: opacity 0.12s ease;
  cursor: grab;
}

.keyframe-handle-line {
  stroke: v-bind(secondaryLineColor);
  stroke-width: 0.1rem;
  pointer-events: none;
}

.keyframe-handle {
  fill: v-bind(secondaryColor);
  cursor: ew-resize;
}

.keyframe-handle-hit {
  fill: v-bind(secondaryColor);
  opacity: 0;
  transition: opacity 0.12s ease;
  cursor: ew-resize;
}

.keyframe-dot {
  fill: v-bind(accentColor);
  stroke: rgba(15, 17, 21, 0.8);
  stroke-width: 0.1rem;
}

.keyframe-collapsed-line {
  stroke: v-bind(accentColor);
  stroke-width: 1;
}

.keyframe-point-group:hover .keyframe-point-hit,
.keyframe-point-group.dragging .keyframe-point-hit {
  opacity: 0.45;
}

.keyframe-point-group.pendingDelete .keyframe-dot {
  fill: v-bind(deleteColor);
}

.keyframe-point-group.pendingDelete .keyframe-point-hit {
  fill: v-bind(deleteColor);
  opacity: 0.45;
}

.keyframe-handle-group.pendingDelete .keyframe-handle {
  fill: v-bind(deleteColor);
}

.keyframe-handle-group.pendingDelete .keyframe-handle-hit {
  fill: v-bind(deleteColor);
  opacity: 0.45;
}

.keyframe-handle-group:hover .keyframe-handle-hit,
.keyframe-handle-group.dragging .keyframe-handle-hit {
  opacity: 0.45;
}
</style>
