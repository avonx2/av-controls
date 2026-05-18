<script setup lang="ts">
import { computed, ref, type PropType } from 'vue'
import type { TimelineEventLane, TimelineEventPoint } from '../engine/types'
import { snapTimeToMarkers } from '../snap'

const props = defineProps({
  lane: {
    type: Object as PropType<TimelineEventLane>,
    required: true,
  },
  collapsed: {
    type: Boolean,
    default: false,
  },
  manualOverride: {
    type: Boolean,
    default: false,
  },
  height: {
    type: Number,
    required: true,
  },
  width: {
    type: Number,
    required: true,
  },
  secondsPerWidth: {
    type: Number,
    required: true,
  },
  timeOffset: {
    type: Number,
    required: true,
  },
  snapEnabled: {
    type: Boolean,
    default: false,
  },
  snapMarkers: {
    type: Array as PropType<number[]>,
    default: () => [],
  },
})

const emit = defineEmits<{
  'update:events': [events: TimelineEventPoint[]]
}>()

const activePointerId = ref<number | null>(null)
let dragState: null | {
  type: 'event'
  index: number
  startClientX: number
  moved: boolean
} = null

function timeToX(time: number) {
  return ((time - props.timeOffset) / props.secondsPerWidth) * props.width
}

function xToTime(x: number) {
  return (x / props.width) * props.secondsPerWidth + props.timeOffset
}

const events = computed(() => {
  return (props.lane.events || []).map((e, index) => {
    return {
      index,
      ...e,
      x: timeToX(e.t),
    }
  })
})

const visibleEvents = computed(() => {
  return events.value.filter(e => e.x >= -20 && e.x <= props.width + 20)
})

function startDrag(event: PointerEvent, state: typeof dragState) {
  if (activePointerId.value !== null) return
  if (props.manualOverride) return
  const el = event.currentTarget as HTMLElement
  if (el) {
    el.setPointerCapture(event.pointerId)
  }
  activePointerId.value = event.pointerId
  dragState = state
}

function onPointerMove(event: PointerEvent) {
  if (activePointerId.value !== event.pointerId || !dragState) return
  if (props.manualOverride) return

  dragState.moved = true

  const parentRect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const currentX = event.clientX - parentRect.left

  let rawTime = xToTime(currentX)
  if (props.snapEnabled && dragState.type === 'event') {
    rawTime = snapTimeToMarkers(rawTime, props.snapMarkers, props.width, props.secondsPerWidth)
  }
  const t = Math.max(0, rawTime)

  const newEvents = [...props.lane.events]

  if (dragState.type === 'event') {
    const e = newEvents[dragState.index]!
    newEvents[dragState.index] = { ...e, t }
  }

  emit('update:events', newEvents)
}

function onPointerUp(event: PointerEvent) {
  if (activePointerId.value !== event.pointerId) return
  const el = event.currentTarget as HTMLElement
  if (el) {
    el.releasePointerCapture(event.pointerId)
  }
  activePointerId.value = null

  if (dragState && !dragState.moved && dragState.type === 'event') {
    // Delete event on click
    const newEvents = [...props.lane.events]
    newEvents.splice(dragState.index, 1)
    emit('update:events', newEvents)
  }

  dragState = null
}

function addEventAtPointer(event: PointerEvent) {
  if (props.manualOverride) return
  if (event.target !== event.currentTarget) return
  
  const parentRect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = event.clientX - parentRect.left
  let rawTime = xToTime(x)
  if (props.snapEnabled) {
    rawTime = snapTimeToMarkers(rawTime, props.snapMarkers, props.width, props.secondsPerWidth)
  }
  const t = Math.max(0, rawTime)

  const newEvents = [...props.lane.events, { t }]
  emit('update:events', newEvents)
}
</script>

<template>
  <div
    class="event-lane"
    :class="{ collapsed }"
    :style="{ height: `${height}px` }"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerdown="addEventAtPointer"
  >
    <svg class="event-svg" width="100%" height="100%" style="overflow: visible; pointer-events: none;">
      <!-- Base line -->
      <line
        x1="0"
        y1="50%"
        x2="100%"
        y2="50%"
        stroke="rgba(255,255,255,0.1)"
        stroke-width="1"
      />
    </svg>

    <div
      v-for="e in visibleEvents"
      :key="e.index"
      class="event-point-hit"
      :style="{ left: `${e.x}px`, top: '50%' }"
      @pointerdown.stop="startDrag($event, { type: 'event', index: e.index, startClientX: $event.clientX, moved: false })"
    >
      <div class="event-point" />
    </div>
  </div>
</template>

<style scoped>
.event-lane {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.event-svg {
  position: absolute;
  top: 0;
  left: 0;
}

.event-point-hit {
  position: absolute;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -50%);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: auto;
}

.event-point {
  width: 12px;
  height: 12px;
  background: #fa5;
  border-radius: 2px;
  transform: rotate(45deg);
  box-shadow: 0 0 4px rgba(0,0,0,0.5);
  pointer-events: none;
  transition: transform 0.1s;
}

.event-point-hit:hover .event-point {
  transform: scale(1.5) rotate(45deg);
}

.event-lane.collapsed .event-point-hit {
  height: 100%;
  top: 0 !important;
  transform: translateX(-50%);
}
</style>