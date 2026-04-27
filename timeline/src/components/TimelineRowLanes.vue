<script setup lang="ts">
import { computed, type PropType } from 'vue'
import LaneEnvelope from './LaneEnvelope.vue'
import KeyframeLane from './KeyframeLane.vue'
import StepLane from './StepLane.vue'
import TriggerLane from './TriggerLane.vue'
import GroupLane from './GroupLane.vue'

type RowLike = {
  id: string
  isContainer: boolean
  hasValue: boolean
}

const props = defineProps({
  row: {
    type: Object as PropType<RowLike>,
    required: true,
  },
  rowDisplay: {
    type: Object as PropType<any>,
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
  startRowResize: {
    type: Function as PropType<(event: MouseEvent, rowId: string) => void>,
    required: true,
  },
})

const expandedPaneCount = computed(() => {
  if (props.rowDisplay?.collapsed) return Math.max(1, (props.rowDisplay?.displayedLanes ?? []).length)
  return Math.max(
    1,
    (props.rowDisplay?.displayedLanes ?? []).reduce((count: number, lane: any) => {
      if (lane.kind === 'absent') return count + 1
      return count + 1 + (lane.renderLane ? 1 : 0)
    }, 0),
  )
})

const expandedPaneHeight = computed(() => {
  if (props.rowDisplay?.collapsed) {
    return props.rowDisplay?.collapsedLaneHeight ?? props.collapsedRowHeight
  }
  const totalHeight = props.rowDisplay?.height ?? props.expandedRowHeight
  const paneCount = Math.max(1, expandedPaneCount.value)
  const gapPx = 6
  const availableHeight = totalHeight - Math.max(0, paneCount - 1) * gapPx
  return Math.max(28, availableHeight / paneCount)
})

function getPaneHeight() {
  return expandedPaneHeight.value
}
</script>

<template>
  <div class="timeline-lane row">
    <GroupLane
      v-if="row.isContainer && rowDisplay?.collapsed && (rowDisplay?.collapsedGroupLineCount ?? 0) > 0"
      :width="laneWidthPx"
      :height="collapsedRowHeight"
      :line-count="rowDisplay?.collapsedGroupLineCount ?? 0"
    />
    <div
      v-else-if="row.hasValue && shouldRenderRowLanes(row.id)"
      class="lane-stack"
      :class="{ collapsed: rowDisplay?.collapsed }"
    >
      <div
        v-for="lane in rowDisplay?.displayedLanes ?? []"
        :key="lane.key"
        class="lane-block"
        :class="{ collapsed: rowDisplay?.collapsed }"
        :style="rowDisplay?.collapsed ? { height: `${rowDisplay?.collapsedLaneHeight ?? collapsedRowHeight}px` } : undefined"
      >
        <div v-if="!rowDisplay?.collapsed" class="lane-entry-header">
          <button
            v-if="laneHasData(lane)"
            class="lane-entry-btn clear"
            :class="{ confirm: laneClearConfirm[getLaneActionId(row.id, lane.key)] }"
            @click.stop="onClearLaneClick(row.id, lane)"
            @blur="clearLaneConfirm(row.id, lane.key)"
          >{{ laneClearConfirm[getLaneActionId(row.id, lane.key)] ? 'confirm' : 'clear' }}</button>
          <button
            v-if="lane.kind !== 'absent' && lane.kind !== 'curve' ? !lane.renderLane : lane.kind === 'curve' && !lane.renderLane"
            class="lane-entry-btn"
            @click.stop="addRenderLane(row.id, lane.key)"
          >+ render</button>
          <button
            v-else-if="lane.kind !== 'absent' && lane.renderLane"
            class="lane-entry-btn remove"
            @click.stop="removeRenderLane(row.id, lane.key)"
          >x render</button>
        </div>
        <div class="lane-variant-stack" :class="{ collapsed: rowDisplay?.collapsed }">
          <div class="lane-pane">
            <LaneEnvelope
              v-if="lane.kind === 'curve'"
              :lane="lane.lane"
              :lane-key="lane.key"
              :collapsed="!!rowDisplay?.collapsed"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :range="lane.range"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              :option-labels="getStepOptionLabels(row.id)"
              @update:points="(points) => onLanePointsUpdate(row.id, lane.key, points)"
            />
            <StepLane
              v-else-if="lane.kind === 'step'"
              :lane="lane.lane"
              :collapsed="!!rowDisplay?.collapsed"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :range="lane.range"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              @update:points="(points) => onLanePointsUpdate(row.id, lane.key, points)"
            />
            <TriggerLane
              v-else-if="lane.kind === 'trigger'"
              :lane="lane.lane"
              :collapsed="!!rowDisplay?.collapsed"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :range="lane.range"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              @update:triggers="(triggers) => onLaneTriggersUpdate(row.id, lane.key, triggers)"
            />
            <KeyframeLane
              v-else-if="lane.kind === 'keyframes'"
              :lane="lane.lane"
              :collapsed="!!rowDisplay?.collapsed"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              @update:keyframes="(keyframes) => onLaneKeyframesUpdate(row.id, lane.key, keyframes)"
            />
            <button
              v-else-if="lane.kind === 'absent' && !rowDisplay?.collapsed"
              class="lane-create-btn"
              @click.stop="createLaneFromButton(row.id, lane)"
            >click to create lane</button>
          </div>
          <div v-if="lane.kind === 'curve' && lane.renderLane && !rowDisplay?.collapsed" class="lane-pane render-override">
            <div class="lane-entry-header render-override-header">
              <button
                v-if="lane.renderLane.points.length > 0"
                class="lane-entry-btn clear"
                :class="{ confirm: laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] }"
                @click.stop="onClearRenderLaneClick(row.id, lane.key)"
                @blur="clearLaneConfirm(row.id, `${lane.key}__render`)"
              >{{ laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] ? 'confirm' : 'clear' }}</button>
            </div>
            <LaneEnvelope
              :lane="lane.renderLane"
              :lane-key="`${lane.key}__render`"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :range="lane.range"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              :option-labels="getStepOptionLabels(row.id)"
              @update:points="(points) => onRenderLanePointsUpdate(row.id, lane.key, points)"
            />
          </div>
          <div v-if="lane.kind === 'step' && lane.renderLane && !rowDisplay?.collapsed" class="lane-pane render-override">
            <div class="lane-entry-header render-override-header">
              <button
                v-if="lane.renderLane.points.length > 0"
                class="lane-entry-btn clear"
                :class="{ confirm: laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] }"
                @click.stop="onClearRenderLaneClick(row.id, lane.key)"
                @blur="clearLaneConfirm(row.id, `${lane.key}__render`)"
              >{{ laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] ? 'confirm' : 'clear' }}</button>
            </div>
            <StepLane
              :lane="lane.renderLane"
              :collapsed="false"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :range="lane.range"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              @update:points="(points) => onRenderLanePointsUpdate(row.id, lane.key, points)"
            />
          </div>
          <div v-if="lane.kind === 'trigger' && lane.renderLane && !rowDisplay?.collapsed" class="lane-pane render-override">
            <div class="lane-entry-header render-override-header">
              <button
                v-if="lane.renderLane.triggers.length > 0"
                class="lane-entry-btn clear"
                :class="{ confirm: laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] }"
                @click.stop="onClearRenderLaneClick(row.id, lane.key)"
                @blur="clearLaneConfirm(row.id, `${lane.key}__render`)"
              >{{ laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] ? 'confirm' : 'clear' }}</button>
            </div>
            <TriggerLane
              :lane="lane.renderLane"
              :collapsed="false"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :range="lane.range"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              @update:triggers="(triggers) => onRenderLaneTriggersUpdate(row.id, lane.key, triggers)"
            />
          </div>
          <div v-if="lane.kind === 'keyframes' && lane.renderLane && !rowDisplay?.collapsed" class="lane-pane render-override">
            <div class="lane-entry-header render-override-header">
              <button
                v-if="lane.renderLane.keyframes.length > 0"
                class="lane-entry-btn clear"
                :class="{ confirm: laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] }"
                @click.stop="onClearRenderLaneClick(row.id, lane.key)"
                @blur="clearLaneConfirm(row.id, `${lane.key}__render`)"
              >{{ laneClearConfirm[getLaneActionId(row.id, `${lane.key}__render`)] ? 'confirm' : 'clear' }}</button>
            </div>
            <KeyframeLane
              :lane="lane.renderLane"
              :collapsed="false"
              :manual-override="!!rowDisplay?.manualOverride"
              :height="getPaneHeight()"
              :width="laneWidthPx"
              :seconds-per-width="secondsPerWidth"
              :time-offset="timeOffset"
              :snap-enabled="audioSnapEnabled"
              :snap-markers="audioMarkers"
              @update:keyframes="(keyframes) => onRenderLaneKeyframesUpdate(row.id, lane.key, keyframes)"
            />
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="row.hasValue" class="lane-stack lane-stack-placeholder" aria-hidden="true" />
  </div>
</template>

<style scoped>
.timeline-lane {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  align-items: center;
  height: 100%;
  flex: 1 1 auto;
  padding: 0;
  position: relative;
  padding-left: var(--lane-gap, 0.8rem);
}

.lane-stack {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  gap: 0.35rem;
  position: relative;
  min-height: 0;
}

.lane-stack.collapsed {
  gap: 2px;
  justify-content: center;
  padding: 0;
}

.lane-stack-placeholder {
  pointer-events: none;
}

.lane-block {
  display: flex;
  flex-direction: column;
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

.lane-block.collapsed {
  flex: 0 0 auto;
}

.lane-variant-stack {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-height: 0;
  flex: 1 1 auto;
}

.lane-variant-stack.collapsed {
  gap: 0;
}

.lane-pane {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
}

.lane-entry-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  z-index: 5;
  pointer-events: none;
}

.render-override-header {
  right: 0.25rem;
}

.lane-entry-btn {
  background: rgba(97, 147, 168, 0.18);
  border: 1px solid rgba(128, 180, 201, 0.24);
  color: rgba(218, 239, 244, 0.92);
  border-radius: 0.35rem;
  padding: 0.16rem 0.45rem;
  font-size: 0.7rem;
  cursor: pointer;
  pointer-events: auto;
}

.lane-entry-btn.remove {
  background: rgba(82, 118, 132, 0.24);
}

.lane-entry-btn.clear.confirm {
  background: rgba(200, 60, 60, 0.8);
  border-color: rgba(255, 100, 100, 0.6);
  color: white;
}

.lane-create-btn {
  position: absolute;
  inset: 0;
  border: 1px dashed rgba(140, 188, 204, 0.22);
  border-radius: 0.5rem;
  background: rgba(255, 255, 255, 0.015);
  color: rgba(220, 237, 242, 0.6);
  font-size: 0.78rem;
  cursor: pointer;
}

.lane-create-btn:hover {
  background: rgba(255, 255, 255, 0.03);
  color: rgba(220, 237, 242, 0.82);
  border-color: rgba(140, 188, 204, 0.34);
}

.render-override {
  background: rgba(78, 118, 164, 0.13);
  border: 1px solid rgba(118, 170, 224, 0.22);
  border-radius: 0.45rem;
}
</style>
