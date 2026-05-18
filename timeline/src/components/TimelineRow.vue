<script setup lang="ts">
import { type PropType } from 'vue'
import TimelineRowLabels from './TimelineRowLabels.vue'
import TimelineRowLanes from './TimelineRowLanes.vue'

type RowLike = {
  id: string
  name: string
  depth: number
  isContainer: boolean
  hasValue: boolean
  color?: string
}

const props = defineProps({
  row: {
    type: Object as PropType<RowLike>,
    required: true,
  },
  highlighted: {
    type: Boolean,
    default: false,
  },
  rowDisplay: {
    type: Object as PropType<any>,
    required: true,
  },
  rowStateExpansion: {
    type: String,
    default: 'collapsed',
  },
  controlManualOverrideActive: {
    type: Boolean,
    default: false,
  },
  collapsedRowHeight: {
    type: Number,
    required: true,
  },
  expandedRowHeight: {
    type: Number,
    required: true,
  },
  laneWidthPx: {
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
  audioSnapEnabled: {
    type: Boolean,
    required: true,
  },
  audioMarkers: {
    type: Array as PropType<number[]>,
    required: true,
  },
  getStepOptionLabels: {
    type: Function as PropType<(rowId: string) => string[]>,
    required: true,
  },
  shouldRenderRowLanes: {
    type: Function as PropType<(rowId: string) => boolean>,
    required: true,
  },
  laneHasData: {
    type: Function as PropType<(lane: any) => boolean>,
    required: true,
  },
  getLaneActionId: {
    type: Function as PropType<(rowId: string, laneKey: string) => string>,
    required: true,
  },
  laneClearConfirm: {
    type: Object as PropType<Record<string, boolean>>,
    required: true,
  },
  toggleRowExpanded: {
    type: Function as PropType<(rowId: string) => void>,
    required: true,
  },
  togglePinned: {
    type: Function as PropType<(rowId: string) => void>,
    required: true,
  },
  getBranchManualOverrideRowIds: {
    type: Function as PropType<(rowId: string) => string[]>,
    required: true,
  },
  activateControl: {
    type: Function as PropType<(rowId: string) => void>,
    required: true,
  },
  getBranchKeyframeRowIds: {
    type: Function as PropType<(rowId: string) => string[]>,
    required: true,
  },
  recordManualOverrideKeyframe: {
    type: Function as PropType<(rowId: string) => void>,
    required: true,
  },
  hasActiveKeyframeTarget: {
    type: Function as PropType<(rowId: string) => boolean>,
    required: true,
  },
  onClearLaneClick: {
    type: Function as PropType<(rowId: string, lane: any) => void>,
    required: true,
  },
  clearLaneConfirm: {
    type: Function as PropType<(rowId: string, laneKey: string) => void>,
    required: true,
  },
  addRenderLane: {
    type: Function as PropType<(rowId: string, laneKey: string) => void>,
    required: true,
  },
  removeRenderLane: {
    type: Function as PropType<(rowId: string, laneKey: string) => void>,
    required: true,
  },
  onLanePointsUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, points: any[]) => void>,
    required: true,
  },
  onLaneTriggersUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, triggers: any[]) => void>,
    required: true,
  },
  onLaneKeyframesUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, keyframes: any[]) => void>,
    required: true,
  },
  onLaneEventsUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, events: any[]) => void>,
    required: true,
  },
  createLaneFromButton: {
    type: Function as PropType<(rowId: string, lane: any) => void>,
    required: true,
  },
  onClearRenderLaneClick: {
    type: Function as PropType<(rowId: string, laneKey: string) => void>,
    required: true,
  },
  onRenderLanePointsUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, points: any[]) => void>,
    required: true,
  },
  onRenderLaneTriggersUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, triggers: any[]) => void>,
    required: true,
  },
  onRenderLaneKeyframesUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, keyframes: any[]) => void>,
    required: true,
  },
  onRenderLaneEventsUpdate: {
    type: Function as PropType<(rowId: string, laneKey: string, events: any[]) => void>,
    required: true,
  },
  recordBranchManualOverrideKeyframes: {
    type: Function as PropType<(rowId: string) => void>,
    required: true,
  },
  startRowResize: {
    type: Function as PropType<(event: MouseEvent, rowId: string) => void>,
    required: true,
  },
})

</script>

<template>
  <div
    class="timeline-row"
    :data-row-id="row.id"
    :class="{ highlight: highlighted }"
    :style="rowDisplay?.rowStyle"
  >
    <TimelineRowLabels
      :row="row"
      :row-display="rowDisplay"
      :row-state-expansion="rowStateExpansion"
      :control-manual-override-active="controlManualOverrideActive"
      :toggle-row-expanded="toggleRowExpanded"
      :toggle-pinned="togglePinned"
      :get-branch-manual-override-row-ids="getBranchManualOverrideRowIds"
      :activate-control="activateControl"
      :get-branch-keyframe-row-ids="getBranchKeyframeRowIds"
      :record-manual-override-keyframe="recordManualOverrideKeyframe"
      :record-branch-manual-override-keyframes="recordBranchManualOverrideKeyframes"
      :has-active-keyframe-target="hasActiveKeyframeTarget"
    />
    <TimelineRowLanes
      :row="row"
      :row-display="rowDisplay"
      :collapsed-row-height="collapsedRowHeight"
      :expanded-row-height="expandedRowHeight"
      :lane-width-px="laneWidthPx"
      :seconds-per-width="secondsPerWidth"
      :time-offset="timeOffset"
      :audio-snap-enabled="audioSnapEnabled"
      :audio-markers="audioMarkers"
      :get-step-option-labels="getStepOptionLabels"
      :should-render-row-lanes="shouldRenderRowLanes"
      :lane-has-data="laneHasData"
      :get-lane-action-id="getLaneActionId"
      :lane-clear-confirm="laneClearConfirm"
      :on-clear-lane-click="onClearLaneClick"
      :clear-lane-confirm="clearLaneConfirm"
      :add-render-lane="addRenderLane"
      :remove-render-lane="removeRenderLane"
      :on-lane-points-update="onLanePointsUpdate"
      :on-lane-triggers-update="onLaneTriggersUpdate"
      :on-lane-keyframes-update="onLaneKeyframesUpdate"
      :on-lane-events-update="onLaneEventsUpdate"
      :create-lane-from-button="createLaneFromButton"
      :on-clear-render-lane-click="onClearRenderLaneClick"
      :on-render-lane-points-update="onRenderLanePointsUpdate"
      :on-render-lane-triggers-update="onRenderLaneTriggersUpdate"
      :on-render-lane-keyframes-update="onRenderLaneKeyframesUpdate"
      :on-render-lane-events-update="onRenderLaneEventsUpdate"
      :start-row-resize="startRowResize"
    />
  </div>
  <div
    class="row-gap"
    :class="{ 'is-active': !rowDisplay?.collapsed && row.hasValue }"
    @mousedown.prevent="!rowDisplay?.collapsed && row.hasValue ? startRowResize($event, row.id) : undefined"
  />
</template>

<style scoped>
.row-gap {
  height: 0.4rem;
  flex: 0 0 auto;
}

.row-gap.is-active {
  cursor: ns-resize;
}

.timeline-row {
  display: flex;
  flex: 0 0 auto;
  position: relative;
  z-index: 1;
}

.timeline-row:nth-child(even) .timeline-lane {
  background: rgba(255, 255, 255, 0.02);
}
</style>
