<script setup lang="ts">
import { type PropType } from 'vue'
import AudioTrackRow from './AudioTrackRow.vue'
import TimelineRow from './TimelineRow.vue'

type VisibleRow =
  | { kind: 'row'; row: any }
  | { kind: 'ellipsis'; parentId: string }

defineProps({
  labelWidthPx: {
    type: Number,
    required: true,
  },
  allManualOverrideCount: {
    type: Number,
    required: true,
  },
  recordAllManualOverrideKeyframes: {
    type: Function as PropType<() => void>,
    required: true,
  },
  resetAllManualOverrideLanes: {
    type: Function as PropType<() => void>,
    required: true,
  },
  setLaneHeaderRef: {
    type: Function as PropType<(element: any) => void>,
    required: true,
  },
  setScrubAreaRef: {
    type: Function as PropType<(element: any) => void>,
    required: true,
  },
  setTimelineCursorRef: {
    type: Function as PropType<(element: any) => void>,
    required: true,
  },
  setTimelineScrollRef: {
    type: Function as PropType<(element: any) => void>,
    required: true,
  },
  onLaneWheel: {
    type: Function as PropType<(event: WheelEvent) => void>,
    required: true,
  },
  onLanePointerDown: {
    type: Function as PropType<(event: PointerEvent) => void>,
    required: true,
  },
  onScrubPointerDown: {
    type: Function as PropType<(event: PointerEvent) => void>,
    required: true,
  },
  onTimelineScroll: {
    type: Function as PropType<() => void>,
    required: true,
  },
  startResize: {
    type: Function as PropType<(event: MouseEvent) => void>,
    required: true,
  },
  loopRangeStyle: {
    type: Object as PropType<Record<string, string> | null>,
    default: null,
  },
  headerTimeMarkers: {
    type: Array as PropType<Array<{ time: number; x: number; label: string }>>,
    required: true,
  },
  visibleAudioMarkerXs: {
    type: Array as PropType<Array<{ time: number; x: number; highlighted?: boolean }>>,
    required: true,
  },
  bodyTimeMarkers: {
    type: Array as PropType<Array<{ time: number; x: number }>>,
    required: true,
  },
  visibleRowsWithEllipsis: {
    type: Array as PropType<VisibleRow[]>,
    required: true,
  },
  topSpacerHeight: {
    type: Number,
    default: 0,
  },
  bottomSpacerHeight: {
    type: Number,
    default: 0,
  },
  highlightedRowId: {
    type: String as PropType<string | null>,
    default: null,
  },
  rowById: {
    type: Object as PropType<Map<string, any>>,
    required: true,
  },
  getRowDisplay: {
    type: Function as PropType<(rowId: string) => any>,
    required: true,
  },
  rowStates: {
    type: Object as PropType<Record<string, any>>,
    required: true,
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
  audioExpanded: {
    type: Boolean,
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
  audioWaveform: {
    type: Object as PropType<any>,
    default: null,
  },
  audioDuration: {
    type: Number,
    required: true,
  },
  audioFileName: {
    type: String as PropType<string | null>,
    default: null,
  },
  missingAudioFileName: {
    type: String as PropType<string | null>,
    default: null,
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
  recordBranchManualOverrideKeyframes: {
    type: Function as PropType<(rowId: string) => void>,
    required: true,
  },
  hasActiveKeyframeTarget: {
    type: Function as PropType<(rowId: string) => boolean>,
    required: true,
  },
  controlManualOverride: {
    type: Object as PropType<Record<string, boolean>>,
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
  startRowResize: {
    type: Function as PropType<(event: MouseEvent, rowId: string) => void>,
    required: true,
  },
  expandParentRow: {
    type: Function as PropType<(parentId: string | null) => void>,
    required: true,
  },
  toggleAudioExpanded: {
    type: Function as PropType<() => void>,
    required: true,
  },
  toggleAudioSnap: {
    type: Function as PropType<() => void>,
    required: true,
  },
  onAudioUpload: {
    type: Function as PropType<(payload: { file: File; markerTime?: number }) => void>,
    required: true,
  },
  onAudioHoverTime: {
    type: Function as PropType<(time: number | null) => void>,
    required: true,
  },
  toggleAudioMarker: {
    type: Function as PropType<(time: number) => void>,
    required: true,
  },
})
</script>

<template>
  <div class="timeline-grid" :style="{ '--label-width': labelWidthPx + 'px', '--lane-gap': '0.8rem' }">
    <div class="timeline-header">
      <div class="timeline-labels header">
        <div v-if="allManualOverrideCount > 0" class="header-actions">
          <button
            class="header-action-chip"
            :class="{ active: allManualOverrideCount > 0 }"
            @click.stop="recordAllManualOverrideKeyframes()"
          >
            <span class="header-action-letter">K</span>
            <span class="header-action-label">add keyframes</span>
          </button>
          <button
            class="header-action-chip"
            :class="{ active: allManualOverrideCount > 0 }"
            @click.stop="resetAllManualOverrideLanes()"
          >
            <span class="header-action-letter">R</span>
            <span class="header-action-label">reset lanes</span>
          </button>
        </div>
        <span class="header-title">Controls</span>
      </div>
      <div
        class="timeline-bar header"
        :ref="setLaneHeaderRef"
        @wheel="onLaneWheel"
        @pointerdown="onLanePointerDown"
      >
        <div class="time-markers">
          <div v-if="loopRangeStyle" class="loop-range-overlay header" :style="loopRangeStyle" />
          <div
            v-for="marker in headerTimeMarkers"
            :key="marker.time"
            class="time-marker"
            :style="{ left: `${marker.x}px` }"
          >
            <span class="time-marker-label">{{ marker.label }}</span>
          </div>
        </div>
        <div
          class="scrub-area"
          :ref="setScrubAreaRef"
          draggable="false"
          @pointerdown.prevent="onScrubPointerDown"
          @dragstart.prevent
        />
      </div>
    </div>
    <div class="timeline-resizer" @mousedown.prevent="startResize" />
    <div :ref="setTimelineCursorRef" class="timeline-cursor" />
    <div
      v-for="marker in visibleAudioMarkerXs"
      :key="`audio-marker-${marker.time}`"
      class="timeline-audio-marker"
      :class="{ highlighted: marker.highlighted }"
      :style="{ left: `calc(var(--label-width) + var(--lane-gap) + ${marker.x}px)` }"
    />
    <div class="timeline-body-grid" aria-hidden="true">
      <div v-if="loopRangeStyle" class="loop-range-overlay body" :style="loopRangeStyle" />
      <div
        v-for="marker in bodyTimeMarkers"
        :key="marker.time"
        class="timeline-body-marker"
        :style="{ left: `${marker.x}px` }"
      />
    </div>

    <div class="timeline-scroll" :ref="setTimelineScrollRef" @scroll="onTimelineScroll" @wheel="onLaneWheel" @pointerdown="onLanePointerDown">
      <div v-if="topSpacerHeight > 0" class="timeline-virtual-spacer" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true" />
      <template v-if="visibleRowsWithEllipsis.length">
        <template v-for="entry in visibleRowsWithEllipsis" :key="entry.kind === 'row' ? entry.row.id : `${entry.parentId}-ellipsis`">
          <TimelineRow
            v-if="entry.kind === 'row'"
            :row="entry.row"
            :highlighted="entry.row.id === highlightedRowId"
            :row-display="getRowDisplay(entry.row.id)"
            :row-state-expansion="rowStates[entry.row.id]?.expansion"
            :control-manual-override-active="!!controlManualOverride[entry.row.id]"
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
            :toggle-row-expanded="toggleRowExpanded"
            :toggle-pinned="togglePinned"
            :get-branch-manual-override-row-ids="getBranchManualOverrideRowIds"
            :activate-control="activateControl"
            :get-branch-keyframe-row-ids="getBranchKeyframeRowIds"
            :record-manual-override-keyframe="recordManualOverrideKeyframe"
            :record-branch-manual-override-keyframes="recordBranchManualOverrideKeyframes"
            :has-active-keyframe-target="hasActiveKeyframeTarget"
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
          <template v-else>
            <div
              class="timeline-row ellipsis-row"
              @click="expandParentRow(entry.parentId)"
            >
              <div
                class="timeline-labels row ellipsis-label"
                :style="{ '--label-indent': `${((rowById.get(entry.parentId)?.depth ?? 0) + 1) * 0.8}rem` }"
              >...</div>
              <div class="timeline-lane row ellipsis-lane" />
            </div>
            <div class="row-gap" />
          </template>
        </template>
      </template>
      <div v-else class="timeline-empty">Waiting for controls spec...</div>
      <div v-if="bottomSpacerHeight > 0" class="timeline-virtual-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true" />
    </div>
    <AudioTrackRow
      :width="laneWidthPx"
      :label-width="labelWidthPx"
      :seconds-per-width="secondsPerWidth"
      :time-offset="timeOffset"
      :expanded="audioExpanded"
      :snap-enabled="audioSnapEnabled"
      :waveform="audioWaveform"
      :duration="audioDuration"
      :file-name="audioFileName"
      :missing-file-name="missingAudioFileName"
      @hover:time="onAudioHoverTime"
      @toggle:expanded="toggleAudioExpanded"
      @toggle:snap="toggleAudioSnap"
      @upload="onAudioUpload"
      @toggle:marker="toggleAudioMarker"
      @wheel="onLaneWheel"
    />
  </div>
</template>

<style scoped>
.timeline-grid {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  height: 100%;
  flex: 1 1 auto;
  min-height: 0;
}

.timeline-header {
  display: flex;
  align-items: stretch;
}

.timeline-labels,
.timeline-lane,
.timeline-bar {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  align-items: center;
  height: 100%;
}

.timeline-labels {
  flex: 0 0 auto;
  width: var(--label-width);
  padding: 0 0.4rem;
}

.timeline-bar,
.timeline-lane {
  flex: 1 1 auto;
  padding: 0;
}

.timeline-labels.header,
.timeline-bar.header {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(243, 242, 238, 0.6);
  min-height: 28px;
}

.timeline-labels.header {
  justify-content: flex-start;
  gap: 0.45rem;
  overflow: visible;
  position: relative;
  z-index: 7;
}

.timeline-bar {
  position: relative;
}

.header-title {
  flex: 0 1 auto;
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  overflow: visible;
}

.header-action-chip {
  position: relative;
  width: 1.45rem;
  height: 1.45rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(157, 207, 219, 0.24);
  border-radius: 0.38rem;
  background: linear-gradient(135deg, rgba(74, 116, 125, 0.85), rgba(34, 51, 58, 0.94));
  color: rgba(239, 248, 250, 0.96);
  cursor: pointer;
  padding: 0;
  overflow: visible;
  opacity: 0.58;
  transition: opacity 140ms ease, border-color 140ms ease, background 140ms ease;
}

.header-action-chip.active {
  opacity: 1;
}

.header-action-chip:hover,
.header-action-chip:focus-visible {
  opacity: 1;
}

.header-action-letter {
  position: relative;
  z-index: 2;
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1;
}

.header-action-label {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  min-width: max-content;
  padding: 0.34rem 0.6rem 0.34rem 1.95rem;
  border: 1px solid rgba(157, 207, 219, 0.24);
  border-radius: 0.42rem;
  background: linear-gradient(135deg, rgba(74, 116, 125, 0.96), rgba(34, 51, 58, 0.98));
  color: rgba(239, 248, 250, 0.96);
  opacity: 0;
  pointer-events: none;
  transition: opacity 140ms ease;
  box-shadow: 0 0.35rem 1rem rgba(0, 0, 0, 0.28);
}

.header-action-chip:hover .header-action-label,
.header-action-chip:focus-visible .header-action-label {
  opacity: 1;
}

.timeline-resizer {
  position: absolute;
  top: 0;
  left: var(--label-width);
  width: var(--lane-gap, 0.8rem);
  height: 100%;
  cursor: col-resize;
  z-index: 6;
}

.timeline-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 1px;
  height: 100%;
  background: rgba(255, 255, 255, 0.15);
  transform: translateX(-50%);
}

.timeline-scroll {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  scrollbar-width: none;
}

.timeline-virtual-spacer {
  flex: 0 0 auto;
  width: 100%;
  pointer-events: none;
}

.timeline-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.timeline-body-grid {
  position: absolute;
  top: 28px;
  bottom: 0;
  left: calc(var(--label-width) + var(--lane-gap, 0.8rem));
  right: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 0;
}

.timeline-body-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.loop-range-overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(80, 180, 120, 0.12);
  border-left: 2px solid rgba(80, 180, 120, 0.6);
  border-right: 2px solid rgba(80, 180, 120, 0.6);
  pointer-events: none;
}

.loop-range-overlay.header {
  z-index: 0;
}

.loop-range-overlay.body {
  z-index: 0;
}

.time-markers {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--lane-gap, 0.8rem);
  right: 0;
  pointer-events: none;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  z-index: 1;
}

.time-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.time-marker-label {
  position: absolute;
  top: 50%;
  left: 4px;
  transform: translateY(-50%);
  font-size: 0.62rem;
  letter-spacing: 0.03em;
  color: rgba(243, 242, 238, 0.62);
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
}

.scrub-area {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--lane-gap, 0.8rem);
  right: 0;
  cursor: text;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  z-index: 2;
}

.timeline-cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(var(--label-width) + var(--lane-gap));
  width: 2px;
  background: #fff8;
  opacity: 1;
  pointer-events: none;
  z-index: 3;
  transform: translateX(0);
  will-change: transform;
}

.timeline-audio-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px solid #ffc75c80;
  pointer-events: none;
  z-index: 2;
}

.timeline-audio-marker.highlighted {
  border-left-color: #f88;
}

.timeline-empty {
  padding: 1rem;
  color: rgba(243, 242, 238, 0.5);
  font-style: italic;
}

@media (max-width: 900px) {
  .timeline-grid {
    grid-template-columns: 1fr;
  }
}
</style>
