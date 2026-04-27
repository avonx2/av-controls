<script setup lang="ts">
import { ref, watch } from 'vue'
import ControlSearch from './ControlSearch.vue'
import type { StoredProject } from '../storage'

const props = defineProps<{
  isConnected: boolean
  connecting: boolean
  wsUrl: string
  title: string
  lastUpdatedControl: string | null
  searchableControls: Array<{ id: string; name: string }>
  autoFollowRecent: boolean
  projects: StoredProject[]
  selectedProjectKey: string
  currentProjectLabel: string
  projectName: string
  isSaving: boolean
  closeProjectMenuSignal: number
}>()

const emit = defineEmits<{
  'update:wsUrl': [value: string]
  connect: []
  disconnect: []
  focusRow: [rowId: string]
  'update:autoFollowRecent': [value: boolean]
  'update:selectedProjectKey': [value: string]
  'update:projectName': [value: string]
  newProject: []
  saveProject: []
  loadProject: []
  deleteProject: []
  exportProject: []
  importProject: [file: File]
}>()

const showProjectMenu = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)

watch(() => props.closeProjectMenuSignal, () => {
  showProjectMenu.value = false
})

function openImport() {
  fileInputRef.value?.click()
}

function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  emit('importProject', file)
  input.value = ''
}
</script>

<template>
  <header class="top-bar">
    <div class="connection-group">
      <input
        v-if="!isConnected"
        :value="wsUrl"
        @input="emit('update:wsUrl', ($event.target as HTMLInputElement).value)"
        class="input connection-input"
        placeholder="ws://localhost:8080"
        :disabled="connecting"
      />
      <span v-else class="artwork-name">{{ title }}</span>
      <button class="button" @click="isConnected ? emit('disconnect') : emit('connect')">
        {{ isConnected ? 'Disconnect' : connecting ? 'Connecting...' : 'Connect' }}
      </button>
    </div>

    <div v-if="isConnected" class="recent-control-group">
      <div class="recent-control-meta">
        <button
          class="recent-control"
          :class="{ placeholder: !lastUpdatedControl }"
          :disabled="!lastUpdatedControl"
          @click="lastUpdatedControl && emit('focusRow', lastUpdatedControl)"
          :title="lastUpdatedControl ?? 'Most recently used control'"
        >
          {{ lastUpdatedControl ?? '[most recently used control]' }}
        </button>
        <label class="auto-follow-toggle" :title="'Automatically center the most recently used control'">
          <input
            type="checkbox"
            :checked="autoFollowRecent"
            @change="emit('update:autoFollowRecent', ($event.target as HTMLInputElement).checked)"
          />
          <span>auto</span>
        </label>
      </div>
    </div>

    <ControlSearch v-if="isConnected" :controls="searchableControls" @select="emit('focusRow', $event)" />

    <div v-if="isConnected" class="project-menu">
      <span class="project-name-label">{{ currentProjectLabel }}</span>
      <button class="menu-button" @click="showProjectMenu = !showProjectMenu" title="Projects">
        project
      </button>
      <div v-if="showProjectMenu" class="menu-panel">
        <div class="menu-row">
          <input
            :value="projectName"
            @input="emit('update:projectName', ($event.target as HTMLInputElement).value)"
            class="input project-input"
            placeholder="project name"
          />
          <button class="button" :disabled="isSaving || !projectName.trim()" @click="emit('saveProject')">Save</button>
        </div>
        <div class="menu-row">
          <select
            :value="selectedProjectKey"
            @change="emit('update:selectedProjectKey', ($event.target as HTMLSelectElement).value)"
            class="input project-select"
          >
            <option value="" disabled>Select project</option>
            <option v-for="project in projects" :key="project.key" :value="project.key">
              {{ project.name }}
            </option>
          </select>
          <button class="button" :disabled="!selectedProjectKey" @click="emit('loadProject')">Load</button>
        </div>
        <div class="menu-row menu-row-actions">
          <button class="button" :disabled="!selectedProjectKey" @click="emit('exportProject')">Export</button>
          <button class="button" @click="openImport">Import</button>
          <button class="button" :disabled="!selectedProjectKey" @click="emit('deleteProject')">Delete</button>
        </div>
        <div class="menu-row menu-row-full">
          <button class="button menu-full-button" @click="emit('newProject')">new blank project</button>
        </div>
        <input ref="fileInputRef" type="file" accept="application/json" class="file-input" @change="onImportFile" />
      </div>
    </div>
  </header>
</template>

<style scoped>
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.connection-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.connection-input {
  min-width: min(26rem, 100%);
}

.artwork-name {
  font-size: 0.9rem;
  color: rgba(243, 242, 238, 0.6);
  white-space: nowrap;
  padding: 0 0.7rem;
}

.recent-control {
  font-size: 0.8rem;
  color: rgba(123, 220, 255, 0.95);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  max-width: 26rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  text-decoration: underline;
}

.recent-control.placeholder {
  color: rgba(243, 242, 238, 0.42);
  text-decoration: none;
  direction: ltr;
}

.recent-control:disabled {
  cursor: default;
}

.recent-control:visited {
  color: rgba(123, 220, 255, 0.95);
}

.recent-control-group {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  position: relative;
  flex: 0 1 auto;
}

.recent-control-meta {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  flex: 0 1 auto;
}

.auto-follow-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: rgba(243, 242, 238, 0.72);
  white-space: nowrap;
  padding-right: 0.1rem;
}

.auto-follow-toggle input {
  margin: 0;
}

.input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: inherit;
  padding: 0.5rem 0.75rem;
  border-radius: 0.6rem;
}

.button {
  background: linear-gradient(135deg, #222f43, #1a1f2b);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: inherit;
  padding: 0.35rem 0.55rem;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.95rem;
  line-height: 1;
}

.project-menu {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}

.project-name-label {
  font-size: 0.9rem;
  color: rgba(243, 242, 238, 0.6);
  white-space: nowrap;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-button {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  padding: 0.35rem 0.55rem;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.95rem;
  line-height: 1;
}

.menu-panel {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  background: rgba(15, 17, 21, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.7rem;
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 18rem;
  z-index: 10;
}

.menu-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  width: 100%;
}

.menu-row-full {
  display: block;
}

.menu-row-actions > .button {
  flex: 1 1 0;
}

.project-input {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
}

.project-select {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
}

.menu-full-button {
  display: block;
  width: 100%;
}

.file-input {
  display: none;
}

@media (max-width: 900px) {
  .top-bar {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
