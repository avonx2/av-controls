<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Reconcile } from '@av-controls/protocol'

const props = defineProps<{
  diff: Reconcile.ReconcileDiff
  modelValue: Reconcile.MatchMap
}>()

const emit = defineEmits<{
  confirm: [map: Reconcile.MatchMap]
  cancel: []
}>()

const working = ref<Reconcile.MatchMap>({ ...props.modelValue })
const selectedOrphan = ref<string | null>(null)

const specByPath = computed(() => new Map(props.diff.onlyInSpec.map(leaf => [leaf.path, leaf])))
const orphanByPath = computed(() => new Map(props.diff.onlyInFile.map(leaf => [leaf.path, leaf])))

function leafName(path: string) {
  const segments = path.split('/')
  return segments[segments.length - 1] ?? path
}

type Row = {
  key: string
  spec?: Reconcile.SpecLeaf
  orphan?: Reconcile.FileLeaf
  orphanPath?: string
}

const rows = computed<Row[]>(() => {
  const usedSpec = new Set(Object.values(working.value))
  const mappedOrphans = new Set(Object.keys(working.value))

  const paired: Row[] = Object.entries(working.value).map(([orphanPath, specPath]) => ({
    key: `pair:${orphanPath}`,
    orphan: orphanByPath.value.get(orphanPath),
    orphanPath,
    spec: specByPath.value.get(specPath),
  }))
  const specOnly: Row[] = props.diff.onlyInSpec
    .filter(spec => !usedSpec.has(spec.path))
    .map(spec => ({ key: `spec:${spec.path}`, spec }))
  const orphanOnly: Row[] = props.diff.onlyInFile
    .filter(orphan => !mappedOrphans.has(orphan.path))
    .map(orphan => ({ key: `orphan:${orphan.path}`, orphan, orphanPath: orphan.path }))

  return [...paired, ...specOnly, ...orphanOnly]
})

const droppedCount = computed(
  () => props.diff.onlyInFile.filter(o => !(o.path in working.value)).length,
)

function isSelected(path?: string) {
  return !!path && selectedOrphan.value === path
}

function compatible(spec: Reconcile.SpecLeaf) {
  if (!selectedOrphan.value) return false
  const orphan = orphanByPath.value.get(selectedOrphan.value)
  if (orphan?.type && spec.type && orphan.type !== spec.type) return false
  return true
}

function onOrphanClick(path?: string) {
  if (!path) return
  selectedOrphan.value = selectedOrphan.value === path ? null : path
}

function onSpecClick(spec: Reconcile.SpecLeaf) {
  if (!selectedOrphan.value || !compatible(spec)) return
  // a spec target is used by at most one orphan
  for (const [orphanPath, specPath] of Object.entries(working.value)) {
    if (specPath === spec.path) delete working.value[orphanPath]
  }
  working.value[selectedOrphan.value] = spec.path
  selectedOrphan.value = null
}

function clearMapping(orphanPath?: string) {
  if (orphanPath) delete working.value[orphanPath]
}
</script>

<template>
  <div class="reconcile">
    <div class="reconcile-head">
      <h3>Match saved values to current controls</h3>
      <p>
        {{ diff.matched.length }} matched automatically.
        Connect orphaned saved values (right) to current controls (left).
        Unconnected values ({{ droppedCount }}) will be dropped.
      </p>
    </div>

    <div class="reconcile-cols-head">
      <span class="col-spec">Current controls (no saved value)</span>
      <span></span>
      <span class="col-orphan">Saved values (no matching control)</span>
    </div>

    <div class="reconcile-rows">
      <div
        v-for="row in rows"
        :key="row.key"
        class="reconcile-row"
        :class="{ paired: row.spec && row.orphan }"
      >
        <button
          v-if="row.spec"
          class="cell cell-spec"
          :class="{ targetable: selectedOrphan && compatible(row.spec), disabled: selectedOrphan && !compatible(row.spec) }"
          @click="onSpecClick(row.spec)"
        >
          <span class="name">{{ leafName(row.spec.path) }}</span>
          <span class="path">{{ row.spec.path }}</span>
          <span v-if="row.spec.type" class="type">{{ row.spec.type }}</span>
        </button>
        <span v-else class="cell cell-empty"></span>

        <span class="connector">
          <button
            v-if="row.spec && row.orphan"
            class="break"
            title="Break this match"
            @click="clearMapping(row.orphanPath)"
          >↔</button>
        </span>

        <button
          v-if="row.orphan"
          class="cell cell-orphan"
          :class="{ selected: isSelected(row.orphanPath) }"
          @click="onOrphanClick(row.orphanPath)"
        >
          <span class="name">{{ leafName(row.orphan.path) }}</span>
          <span class="path">{{ row.orphan.path }}</span>
          <span v-if="row.orphan.type" class="type">{{ row.orphan.type }}</span>
        </button>
        <span v-else class="cell cell-empty"></span>
      </div>
    </div>

    <div class="reconcile-actions">
      <button class="btn cancel" @click="emit('cancel')">Cancel</button>
      <button class="btn apply" @click="emit('confirm', { ...working })">Apply &amp; import</button>
    </div>
  </div>
</template>

<style scoped>
.reconcile {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  max-height: 80vh;
  color: #d8dde2;

  & h3 {
    margin: 0;
  }

  & p {
    margin: 4px 0 0;
    opacity: 0.75;
    font-size: 0.85em;
  }

  & .reconcile-cols-head,
  & .reconcile-row {
    display: grid;
    grid-template-columns: 1fr 40px 1fr;
    align-items: stretch;
    gap: 8px;
  }

  & .reconcile-cols-head {
    font-size: 0.8em;
    opacity: 0.7;

    & .col-spec { color: #9cd6a3; }
    & .col-orphan { color: #d6b78a; text-align: right; }
  }

  & .reconcile-rows {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  & .cell {
    display: flex;
    flex-direction: column;
    text-align: left;
    gap: 2px;
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    cursor: default;

    & .name { font-weight: 600; }
    & .path { font-size: 0.75em; opacity: 0.6; }
    & .type { font-size: 0.7em; opacity: 0.5; }
  }

  & .cell-empty {
    background: transparent;
  }

  & .cell-spec {
    border-color: rgba(156, 214, 163, 0.3);

    &.targetable {
      cursor: pointer;
      border-color: rgba(156, 214, 163, 0.8);
      background: rgba(156, 214, 163, 0.12);
    }

    &.disabled {
      opacity: 0.35;
    }
  }

  & .cell-orphan {
    cursor: pointer;
    border-color: rgba(214, 183, 138, 0.3);

    &.selected {
      border-color: rgba(214, 183, 138, 0.95);
      background: rgba(214, 183, 138, 0.16);
    }
  }

  & .connector {
    display: flex;
    align-items: center;
    justify-content: center;

    & .link { opacity: 0.6; }

    & .break {
      border: none;
      background: transparent;
      color: #d68a8a;
      cursor: pointer;
    }
  }

  & .reconcile-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;

    & .btn {
      padding: 6px 14px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.06);
      color: inherit;
      cursor: pointer;
    }

    & .apply {
      border-color: rgba(156, 214, 163, 0.6);
      background: rgba(156, 214, 163, 0.18);
    }
  }
}
</style>
