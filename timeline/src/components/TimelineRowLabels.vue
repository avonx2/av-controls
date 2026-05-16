<script setup lang="ts">
import { computed, type PropType } from 'vue'

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
})

const leafKeyframeActive = computed(() => props.hasActiveKeyframeTarget(props.row.id))
</script>

<template>
  <div
    v-memo="[
      row.id,
      row.name,
      row.depth,
      row.isContainer,
      row.color,
      rowDisplay?.pinned,
      rowDisplay?.manualOverride,
      rowDisplay?.branchManualOverrideCount,
      rowDisplay?.canBranchKeyframe,
      rowStateExpansion,
    ]"
    class="timeline-labels row"
    :class="{ 'is-container': row.isContainer }"
    :style="{
      '--label-indent': `${row.depth * 0.8}rem`,
      backgroundColor: row.color || undefined,
    }"
    @click="toggleRowExpanded(row.id)"
  >
    <div class="label-content">
      <div class="label-title">
        <span class="label-text">{{ row.name }}</span>
      </div>
      <div v-if="!rowDisplay?.collapsed" class="label-actions">
        <button class="label-action action-pin" :class="{ active: rowDisplay?.pinned }" @click.stop="togglePinned(row.id)">Pin</button>
        <template v-if="row.isContainer">
          <button
            class="label-action action-activate"
            :class="{
              active: (rowDisplay?.branchManualOverrideCount ?? 0) > 0,
              disabled: (rowDisplay?.branchManualOverrideCount ?? 0) === 0,
            }"
            @click.stop="getBranchManualOverrideRowIds(row.id).forEach((targetRowId) => activateControl(targetRowId))"
          >Act</button>
          <button
            class="label-action action-keyframe"
            :class="{
              active: !!rowDisplay?.canBranchKeyframe,
              disabled: !rowDisplay?.canBranchKeyframe,
            }"
            @click.stop="recordBranchManualOverrideKeyframes(row.id)"
          >Key</button>
        </template>
        <template v-else-if="row.hasValue">
          <button
            class="label-action action-activate"
            :class="{
              active: controlManualOverrideActive,
              disabled: !controlManualOverrideActive,
            }"
            @click.stop="activateControl(row.id)"
          >Act</button>
          <button
            class="label-action action-keyframe active"
            @click.stop="recordManualOverrideKeyframe(row.id)"
          >Key</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-labels {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  align-items: center;
  height: 100%;
  flex: 0 0 auto;
  width: var(--label-width);
  padding: 0 0.4rem;
}

.timeline-labels.row {
  cursor: pointer;
  overflow: hidden;
  margin-left: var(--label-indent, 0rem);
  width: calc(var(--label-width) - var(--label-indent, 0rem));
  padding: 0.2rem 0.4rem;
  box-sizing: border-box;
  gap: 0.2rem;
  position: relative;
  user-select: none;
  align-items: flex-start;
  border-radius: 0.3rem;
}

.label-text {
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1 1 auto;
  font-weight: 700;
  color: #fff;
}

.label-title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.label-content {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.label-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.label-action {
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  min-width: 2.5rem;
  padding: 0.2rem 0.48rem;
  border-radius: 0.4rem;
  cursor: pointer;
  opacity: 0.5;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}

.label-action.disabled {
  opacity: 0.3;
  cursor: default;
}

.label-action.action-pin.active {
  opacity: 1;
}

.label-action.action-activate.active {
  opacity: 1;
}

.label-action.action-keyframe.active {
  opacity: 1;
}

.action-pin {
  background: rgba(112, 74, 168, 0.8);
}

.action-activate {
  background: rgba(60, 178, 118, 0.7);
}

.action-keyframe {
  background: rgba(212, 154, 52, 0.7);
}

.label-action:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.18);
}
</style>
