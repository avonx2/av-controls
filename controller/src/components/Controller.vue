<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, provide, computed, reactive, type Ref } from 'vue';
import Control from './controls/Control.vue'
import Area from './controls/Area.vue'

import {
  Controls,
  Transports,
  Reconcile,
  ControllerClient as ProtocolControllerClient,
} from '@av-controls/protocol'

import { ReconcileMatcher } from '@av-controls/reconcile-ui'

import { loadTabState, applyTabState, watchTabChanges } from '../tab-state-persistence'
import {
  loadControlStateSnapshot,
  scheduleControlStateSnapshotSave,
} from '../control-state-persistence'


import Menu from '../components/Menu.vue'

import { 
  textInputHandler, 
  textInputTitle, 
  textInputPlaceholder, 

  fileInputHandler,
  fileInputTitle,
  fileInputDescription,

  confirmHandler,
  confirmTitle,
  confirmMessage,

  menuActionHandler,
  menu, 
} from '../menu-globals'


import { InputMappings, type InputSource } from '../input-mappings'

import MIDISignalLogger from './SignalLogger.vue'
import TextInputPrompt from './TextInputPrompt.vue'
import FileInputPrompt from './FileInputPrompt.vue'
import ConfirmPrompt from './ConfirmPrompt.vue'

const props = defineProps<{
  sender: Transports.Base.Sender, 
}>()

const emits = defineEmits<{
  (e: 'doneMapping'): void
}>()

const rootSender = ref<Controls.Base.Sender | undefined>()

const reconcileState = ref<{
  diff: Reconcile.ReconcileDiff
  suggestion: Reconcile.MatchMap
  pending: Controls.Base.State
} | null>(null)
const initialControlSpecByPath = ref<Map<string, {
  x: number
  y: number
  width: number
  height: number
  name: string
  color: string
}>>(new Map())
const modalStack = ref<Controls.Modal.Sender[]>([])
const activeModal = computed(() => modalStack.value.length > 0 ? modalStack.value[modalStack.value.length - 1] : null)

const controlledName = ref('')
const inputMappings = ref<InputMappings | undefined>(undefined)
const layoutEditMode = ref(false)
const layoutEditConfig = reactive({
  snapToControls: true,
})
const layoutPanel = reactive({
  x: 8,
  y: 8,
})
const layoutReport = ref('')
const layoutReportVisible = ref(false)
const editControlTarget = ref<Controls.Base.Sender | null>(null)
const controlContextMenu = ref<{ control: Controls.Base.Sender; x: number; y: number } | null>(null)
const editControlDraft = reactive({
  name: '',
  color: '#888888',
})

const onKeyDown = (event: KeyboardEvent) => {
  if (event.defaultPrevented) {
    return
  }
  if (event.key === 'Escape') {
    // Close one layer per press (modal -> control details -> layout edit mode),
    // stopping propagation so a single Escape never cascades through layers.
    if (activeModal.value) {
      closeModal()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (editControlTarget.value) {
      closeControlEditor()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (layoutEditMode.value) {
      disableLayoutEditMode()
      event.preventDefault()
      event.stopPropagation()
      return
    }
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return
  }
  const target = event.target as HTMLElement | null
  if (target) {
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
      return
    }
  }
  if (event.key.toLowerCase() === 'e') {
    layoutEditMode.value = !layoutEditMode.value
    event.preventDefault()
  }
}

function closeModal() {
  modalStack.value.pop()
}

let panelMoveListener: ((event: PointerEvent) => void) | null = null
let panelUpListener: ((event: PointerEvent) => void) | null = null
let controllerClient: ProtocolControllerClient.ControllerClient | null = null

function disposeInputMappings() {
  inputMappings.value?.dispose()
  inputMappings.value = undefined
}

function handleRootSpecification(event: ProtocolControllerClient.ControllerRootSpecEvent) {
  rootSender.value = event.rootSender
  controlledName.value = event.name
  rootSender.value.deepForeach((sender) => {
    sender.onTouch = () => {
      onControllerTouched(sender)
    }
  })

  const initialControlSpec = new Map<string, {
    x: number
    y: number
    width: number
    height: number
    name: string
    color: string
  }>()
  rootSender.value.deepForeach((sender) => {
    const spec = sender.spec
    initialControlSpec.set(getControlPath(sender), {
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      name: spec.name,
      color: spec.color,
    })
  })
  initialControlSpecByPath.value = initialControlSpec
  inputMappings.value = new InputMappings(controlledName.value, '1.0.0', rootSender.value)
  inputMappings.value?.connect()

  loadTabState(controlledName.value).then((tabState) => {
    if (rootSender.value === event.rootSender) {
      applyTabState(rootSender.value, tabState)
      watchTabChanges(rootSender.value, controlledName.value)
    }
  })
}

function startDragLayoutPanel(event: PointerEvent) {
  if (!layoutEditMode.value || event.button !== 0) {
    return
  }
  event.preventDefault()
  event.stopPropagation()

  const startX = event.clientX
  const startY = event.clientY
  const initialX = layoutPanel.x
  const initialY = layoutPanel.y

  panelMoveListener = (moveEvent: PointerEvent) => {
    moveEvent.preventDefault()
    layoutPanel.x = Math.max(0, initialX + (moveEvent.clientX - startX))
    layoutPanel.y = Math.max(0, initialY + (moveEvent.clientY - startY))
  }

  panelUpListener = (upEvent: PointerEvent) => {
    upEvent.preventDefault()
    if (panelMoveListener) {
      window.removeEventListener('pointermove', panelMoveListener)
      panelMoveListener = null
    }
    if (panelUpListener) {
      window.removeEventListener('pointerup', panelUpListener)
      panelUpListener = null
    }
  }

  window.addEventListener('pointermove', panelMoveListener)
  window.addEventListener('pointerup', panelUpListener)
}

// Provide to child components - ref makes it reactive
provide('inputMappings', inputMappings)
provide('layoutEditMode', layoutEditMode as Ref<boolean>)
provide('layoutEditConfig', layoutEditConfig)
provide('openModal', (modal: Controls.Modal.Sender) => {
  modalStack.value.push(modal)
})
provide('openControlEditor', (control: Controls.Base.Sender) => {
  editControlTarget.value = control
  editControlDraft.name = control.spec.name
  editControlDraft.color = normalizeColorInput(control.spec.color)
})
provide('openControlContextMenu', (control: Controls.Base.Sender, event: MouseEvent) => {
  controlContextMenu.value = { control, x: event.clientX, y: event.clientY }
})

onMounted(() => {
  controllerClient = new ProtocolControllerClient.ControllerClient(props.sender, {
    wrapRootSender: (sender) => reactive(sender) as Controls.Base.Sender,
    loadInitialState: async (announcement) => {
      disposeInputMappings()
      controlledName.value = announcement.name
      try {
        return await loadControlStateSnapshot(announcement.name)
      } catch (error) {
        console.warn('Failed to load persisted control state', error)
        return null
      }
    },
    onInitializedState: (name, state) => {
      disposeInputMappings()
      controlledName.value = name
      scheduleControlStateSnapshotSave(name, state)
    },
  })
  controllerClient.onRootSpec = handleRootSpecification
  controllerClient.onControlUpdate = ({ update }) => {
    if (update.origin.kind !== 'artwork' && rootSender.value && controlledName.value) {
      scheduleControlStateSnapshotSave(controlledName.value, rootSender.value.getState())
    }
  }
  controllerClient.onSignal = () => {
    if (rootSender.value && controlledName.value) {
      scheduleControlStateSnapshotSave(controlledName.value, rootSender.value.getState())
    }
  }
  controllerClient.onUnknownMessage = (message) => {
    console.warn('unknown message type in message', message)
  }
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  controllerClient?.dispose()
  controllerClient = null
  disposeInputMappings()
  window.removeEventListener('keydown', onKeyDown)
  if (panelMoveListener) {
    window.removeEventListener('pointermove', panelMoveListener)
    panelMoveListener = null
  }
  if (panelUpListener) {
    window.removeEventListener('pointerup', panelUpListener)
    panelUpListener = null
  }
})

const inputSourceForMapping = ref(null as (null | InputSource))

const removingMapping = ref(false)
function onControllerTouched(sender: Controls.Base.Sender) {
  if(inputMappings.value) {
    if(removingMapping.value) {
      if(inputMappings.value.getMappingCount(sender) > 0) {
        inputMappings.value.removeMappingsFromControl(sender)
        removingMapping.value = false
      }
    } else if(inputSourceForMapping.value !== null) {
      if(inputMappings.value.addMappingToControl(inputSourceForMapping.value, sender)) {
        inputSourceForMapping.value = null
        emits('doneMapping')
      }
    }
  }
}

function manageMappings() {
  if(!inputMappings.value) {
    return
  }
  const mappingNames = inputMappings.value.getSavedMappingsNames()
  menuActionHandler.value = handleMappingMangeMenuAction
  menu.value = {
    name: 'Manage mappings',
    description: 'Save to, load or delete from local storage or export, import midi mappings for ' + controlledName.value,
    items: [
      {
        name: 'save',
        submenu: {
          name: 'Saving mapping as ...', 
          description: 'Overwrite a setting or save the current mappings as a new file',
          items: [
            {
              name: 'new mapping', 
              action: {
                type: 'new'
              },
              color: '#8f8',
            },
            ...mappingNames.map(name => ({
              name: name,
              action: {
                type: 'overwrite', 
                name
              }, 
              color: '#f88',
            })),
          ],
        },
      },
      {
        name: 'load',
        submenu: {
          name: 'Load saved mapping', 
          description: 'Load a saved mapping. This will override the currently active mapping', 
          items: mappingNames.map(name => ({
            name, 
            action: {
              type: 'load', 
              name
            }
          }))
        }
      },
      {
        name: 'delete',
        action: 'delete',
        submenu: {
          name: 'Delete saved mapping', 
          description: 'Delete a mapping. This cannot be undone and the mapping can\'t be loaded anymore afterwards.', 
          items: mappingNames.map(name => ({
            name, 
            action: {
              type: 'delete', 
              name
            }
          }))
        }
      },
      {
        name: 'export to file',
        action: 'export',
      },
      {
        name: 'import from file',
        action: 'import',
      },
    ],
  };
}

function askForConfirmation(name: string) {
  return new Promise<boolean>((resolve, reject) => {
    confirmTitle.value = 'Overwrite mapping'
    confirmMessage.value = 'Are you sure you want to overwrite the mapping ' + name + '?'
    confirmHandler.value = (confirmed: boolean) => {
      resolve(confirmed)
      if(confirmed) {
        confirmHandler.value = undefined
        textInputHandler.value = undefined
        menu.value = null
      }
    }
  })
}

function handleMappingMangeMenuAction(action: any) {
  if(!inputMappings.value) {
    return
  }
  if(action.type == 'new') {
    textInputTitle.value = 'Enter the name for the new mapping'
    textInputPlaceholder.value = 'new mapping name'
    textInputHandler.value = (newMappingName) => {
      inputMappings.value?.saveMappings(newMappingName, askForConfirmation)
    }
  } else if(action.type == 'overwrite') {
    inputMappings.value?.saveMappings(action.name, askForConfirmation)
    menu.value = null
  } else if(action.type == 'load') {
    inputMappings.value?.loadMappings(action.name)
    menu.value = null
  } else if(action.type == 'export') {
    inputMappings.value?.exportMappingsAsFile()
    menu.value = null
  } else if(action.type == 'import') {
    fileInputTitle.value = 'Import mappings'
    fileInputDescription.value = 'Upload a mappings file from your computer in order to import mappings'
    fileInputHandler.value = (file) => {
      inputMappings.value?.importMappingsFromFile(file)
      fileInputHandler.value = undefined
      menu.value = null
    }
  } else if(action.type == 'delete') {
    confirmTitle.value = 'Delete mapping'
    confirmMessage.value = 'Are you sure you want to delete the mapping ' + action.name + '?'
    confirmHandler.value = (confirmed: boolean) => {
      if(confirmed) {
        inputMappings.value?.deleteMapping(action.name)
        confirmHandler.value = undefined
        menu.value = null
      }
    }
  }
}

const showSignalLogger = ref(false)

function mapInputActivity(inputSource: InputSource) {
  showSignalLogger.value = false
  inputSourceForMapping.value = inputSource
}

function setShowSignalMapper(show: boolean) {
  if(inputMappings.value) {
    showSignalLogger.value = show
  }
}

function removeAllMappings() {
  inputMappings.value?.removeAllMappings()
}

function setRemovingMapping(value: boolean) {
  if(inputMappings.value) {
    removingMapping.value = value
  }
}

function setLayoutEditMode(value: boolean) {
  layoutEditMode.value = value
}

function disableLayoutEditMode() {
  layoutEditMode.value = false
}

function getControlPath(sender: Controls.Base.Sender): string {
  const parts: string[] = []
  let current: Controls.Base.Sender | undefined = sender
  while (current) {
    const parent = current.parent as (Controls.Base.Sender & {
      senders?: Record<string, Controls.Base.Sender>
    }) | undefined
    let segment = current.spec.name
    if (parent?.senders) {
      const entry = Object.entries(parent.senders).find(([, child]) => child === current)
      if (entry) {
        segment = entry[0]
      }
    }
    parts.unshift(segment)
    current = current.parent
  }
  return parts.join('/')
}

function formatLayoutValue(value: number): string {
  const rounded = Number(value.toFixed(3))
  const nearestInt = Math.round(rounded)
  if (Math.abs(rounded - nearestInt) <= 0.0015) {
    return nearestInt.toString()
  }
  return rounded.toString()
}

function getLayoutReport(): string {
  const root = rootSender.value
  if (!root) {
    return ''
  }

  const initialControlSpec = initialControlSpecByPath.value
  const eps = 1e-6
  const lines: string[] = []
  root.deepForeach((sender) => {
    const spec = sender.spec
    const path = getControlPath(sender)
    const initial = initialControlSpec.get(path)
    const layoutChanged =
      !initial ||
      Math.abs(spec.x - initial.x) > eps ||
      Math.abs(spec.y - initial.y) > eps ||
      Math.abs(spec.width - initial.width) > eps ||
      Math.abs(spec.height - initial.height) > eps
    const labelChanged = !initial || spec.name !== initial.name
    const colorChanged = !initial || spec.color !== initial.color
    const changed = layoutChanged || labelChanged || colorChanged
    if (changed) {
      const metadata: string[] = []
      if (labelChanged) {
        metadata.push(`label: ${JSON.stringify(spec.name)}`)
      }
      if (colorChanged) {
        metadata.push(`color: ${spec.color}`)
      }
      lines.push(
        `${path}: ${formatLayoutValue(spec.x)}, ${formatLayoutValue(spec.y)}, ${formatLayoutValue(spec.width)}, ${formatLayoutValue(spec.height)}${metadata.length ? `, ${metadata.join(', ')}` : ''}`
      )
    }
  })
  return lines.join('\n')
}

async function generateLayoutReport() {
  const report = getLayoutReport()
  layoutReport.value = report
  layoutReportVisible.value = true
}

function closeLayoutReport() {
  layoutReportVisible.value = false
}

async function copyLayoutReport() {
  try {
    await navigator.clipboard.writeText(layoutReport.value)
  } catch (_err) {
    // Clipboard may be blocked; keep report visible in textarea.
  }
}

function normalizeColorInput(color: string | undefined) {
  const fallback = '#888888'
  if (!color) return fallback
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color
  const short = color.match(/^#([0-9a-fA-F]{3})$/)
  const shortHex = short?.[1]
  if (shortHex) {
    const [r = '8', g = '8', b = '8'] = shortHex.split('')
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return fallback
}

function closeControlEditor() {
  editControlTarget.value = null
}

function closeControlContextMenu() {
  controlContextMenu.value = null
}

async function copyControlValuesFromContextMenu() {
  const control = controlContextMenu.value?.control
  if (!control) return
  // getState() is the canonical value serialization (same shape as export /
  // import) and already recurses through group/tabs/modal children.
  const json = JSON.stringify(control.getState(), null, 2)
  try {
    await navigator.clipboard.writeText(json)
  } catch (error) {
    console.warn('Failed to copy control values to clipboard', error)
  }
  closeControlContextMenu()
}

function saveControlEditor() {
  if (!editControlTarget.value) return
  editControlTarget.value.spec.name = editControlDraft.name.trim() || editControlTarget.value.spec.name
  editControlTarget.value.spec.color = editControlDraft.color
  editControlTarget.value = null
}

function exportControlValues() {
  const root = rootSender.value
  if (!root) return
  const state = root.getState()
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const safeName = (controlledName.value || 'controller').replace(/[^a-z0-9-_]+/gi, '-')
  a.href = url
  a.download = `${safeName}-values.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function importControlValues() {
  if (!rootSender.value) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file || !rootSender.value) return
    try {
      const text = await file.text()
      const state = JSON.parse(text)
      const specLeaves = Reconcile.walkSenderLeaves(rootSender.value)
      const fileLeaves = Reconcile.walkStateLeaves(state)
      const diff = Reconcile.diffPaths(specLeaves, fileLeaves)
      if (diff.onlyInFile.length === 0) {
        rootSender.value.setState(state)
        return
      }
      // Some saved values no longer map to a control - let the user match them.
      reconcileState.value = {
        diff,
        suggestion: Reconcile.suggestMatches(diff),
        pending: state,
      }
    } catch (error) {
      console.error('Failed to import control values', error)
    }
  }
  input.click()
}

function applyReconcile(map: Reconcile.MatchMap) {
  if (reconcileState.value && rootSender.value) {
    const migrated = Reconcile.remapControlState(reconcileState.value.pending, map)
    rootSender.value.setState(migrated)
  }
  reconcileState.value = null
}

function cancelReconcile() {
  reconcileState.value = null
}

defineExpose({
  manageMappings,
  toggleMidiMapper: setShowSignalMapper,
  removeAllMappings,
  setRemovingMapping,
  setLayoutEditMode,
  getLayoutReport,
  exportControlValues,
  importControlValues,
})

</script>

<template>
  <div class=container >
    <MIDISignalLogger
      v-if="showSignalLogger && inputMappings"
      :inputMappings="inputMappings as any"
      @select="mapInputActivity"
    />
    <div v-else class="area">
      <div v-if="!rootSender" class='wait-screen'>
        <p>Waiting for controls...</p>
      </div>
      
      <!-- Main Controls Layer -->
      <div
        v-else
        class="main-controls"
        :class="{ blurred: !!activeModal }"
      >
         <Control :control="rootSender"/> 
      </div>
      <div
        v-if="layoutEditMode"
        class="layout-edit-panel"
        :style="{ left: `${layoutPanel.x}px`, top: `${layoutPanel.y}px` }"
      >
        <div class="layout-edit-header-row">
          <div class="layout-edit-header" @pointerdown="startDragLayoutPanel">layout edit mode</div>
          <button class="layout-edit-close" @click="disableLayoutEditMode" aria-label="close layout edit">x</button>
        </div>
        <label><input type="checkbox" v-model="layoutEditConfig.snapToControls"> snap to controls</label>
        <button
          v-if="!layoutReportVisible"
          class="layout-report-button"
          @click="generateLayoutReport"
        >
          report lines
        </button>
        <div v-else class="layout-report-actions">
          <button class="layout-report-button" @click="generateLayoutReport">refresh</button>
          <button class="layout-report-button" @click="copyLayoutReport">copy</button>
          <button class="layout-report-button" @click="closeLayoutReport">close</button>
        </div>
        <textarea
          v-if="layoutReportVisible"
          class="layout-report-output"
          :value="layoutReport"
          readonly
        />
      </div>

                  <!-- Modal Overlay -->

                  <div v-if="activeModal" class="modal-overlay">

                    <div class="modal-window" :style="{ 

                      borderColor: activeModal.spec.color,

                      width: `${activeModal.spec.modalWidth || 80}%`,

                      height: `${activeModal.spec.modalHeight || 80}%`

                    }">

                                  <div class="modal-header" :style="{ backgroundColor: activeModal.spec.color }">

                                     <span class="modal-title">

                                       {{ activeModal.spec.name }} 

                                       <span style="font-size: 0.8rem; opacity: 0.7;">

                                         ({{ activeModal.spec.modalWidth }}x{{ activeModal.spec.modalHeight }})

                                       </span>

                                     </span>

                                     <button class="modal-close" @click="closeModal">✕</button>

                                  </div>

                       
           <div class="modal-body" :style="{ backgroundColor: activeModal.spec.color }">
             <div class="modal-body-overlay"></div> <!-- Darkens the background color -->
             <div class="modal-content">
                 <Area :controls="activeModal.senders" />
             </div>
           </div>
        </div>
      </div>

    </div>
  </div>
  <Menu 
    v-if="menu" 
    :menu="menu" 
    @back="menu = null"
    @action="menuActionHandler" />
  <TextInputPrompt 
    v-if='textInputHandler !== undefined'
    :title='textInputTitle'
    :placeholder='textInputPlaceholder'
    @submit='textInputHandler'
    @close='textInputHandler = undefined'
    />
  <FileInputPrompt 
    v-if='fileInputHandler !== undefined'
    :title='fileInputTitle'
    :description='fileInputDescription'
    @fileUploaded='fileInputHandler'
    @close='fileInputHandler = undefined'
    />
      <ConfirmPrompt 
    v-if='confirmHandler !== undefined'
    :title='confirmTitle'
    :description='confirmMessage'
    @confirm='confirmHandler(true)'
    @cancel='confirmHandler(false)'
    />
  <div v-if="editControlTarget" class="layout-edit-modal-overlay" @click.self="closeControlEditor">
    <div class="layout-edit-modal">
      <div class="layout-edit-modal-header">
        <span>edit control</span>
        <button class="layout-edit-close" @click="closeControlEditor" aria-label="close edit control">x</button>
      </div>
      <label class="layout-edit-field">
        <span>label</span>
        <input v-model="editControlDraft.name" type="text" />
      </label>
      <label class="layout-edit-field">
        <span>color</span>
        <div class="layout-edit-color-row">
          <input v-model="editControlDraft.color" type="color" />
          <input v-model="editControlDraft.color" type="text" />
        </div>
      </label>
      <div class="layout-edit-modal-actions">
        <button class="layout-report-button" @click="closeControlEditor">cancel</button>
        <button class="layout-report-button" @click="saveControlEditor">save</button>
      </div>
    </div>
  </div>
  <div
    v-if="controlContextMenu"
    class="control-context-menu-backdrop"
    @pointerdown.self="closeControlContextMenu"
    @contextmenu.prevent="closeControlContextMenu"
  >
    <div
      class="control-context-menu"
      :style="{ left: controlContextMenu.x + 'px', top: controlContextMenu.y + 'px' }"
    >
      <div class="control-context-menu-title">{{ controlContextMenu.control.spec.name }}</div>
      <button class="control-context-menu-item" @click="copyControlValuesFromContextMenu">
        copy values as JSON
      </button>
    </div>
  </div>
  <div v-if="reconcileState" class="layout-edit-modal-overlay" @click.self="cancelReconcile">
    <div class="reconcile-window">
      <ReconcileMatcher
        :diff="reconcileState.diff"
        :model-value="reconcileState.suggestion"
        @confirm="applyReconcile"
        @cancel="cancelReconcile"
      />
    </div>
  </div>
</template>

<style scoped>
.container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 0.25rem; 
}

.header {
  position: relative;
  height: 4.5rem;
  width: 100%;
  border-radius: 0.5rem;
  box-sizing: border-box;
  background-color: #fff2;
}

.area {
  flex: 1;
  width: 100%;
  box-sizing: border-box;
  position: relative;
}

.wait-screen {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
}

.main-controls {
  width: 100%;
  height: 100%;
  position: relative;
  transition: filter 0.3s ease;
}

.control-context-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 6000;
}

.control-context-menu {
  position: fixed;
  min-width: 12rem;
  background: #000d;
  color: #fff;
  border: 1px solid #4af;
  border-radius: 0.4rem;
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;

  & .control-context-menu-title {
    padding: 0.25rem 0.5rem;
    font-weight: bold;
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  & .control-context-menu-item {
    text-align: left;
    background: transparent;
    color: inherit;
    border: none;
    border-radius: 0.25rem;
    padding: 0.4rem 0.5rem;
    cursor: pointer;

    &:hover {
      background: #4af;
    }
  }
}

.layout-edit-panel {
  position: absolute;
  z-index: 5000;
  background: #000d;
  color: #fff;
  border: 1px solid #4af;
  border-radius: 0.4rem;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.layout-edit-header {
  cursor: move;
  padding: 0.15rem 0;
  font-size: 0.8rem;
  user-select: none;
}

.layout-edit-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.45rem;
  margin-bottom: 0.15rem;
}

.layout-edit-close {
  width: 1rem;
  height: 1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #4af;
  border-radius: 0.2rem;
  background: #0d2030;
  color: #fff;
  font-size: 0.7rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.layout-edit-panel label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
}

.layout-report-button {
  margin-top: 0.2rem;
  background: #17324a;
  color: #fff;
  border: 1px solid #4af;
  border-radius: 0.3rem;
  padding: 0.2rem 0.45rem;
  cursor: pointer;
  font-size: 0.8rem;
}

.layout-report-actions {
  margin-top: 0.2rem;
  display: flex;
  gap: 0.35rem;
}

.layout-report-actions .layout-report-button {
  margin-top: 0;
}

.layout-report-output {
  min-width: 24rem;
  min-height: 8rem;
  max-height: 16rem;
  resize: vertical;
  background-color: #111;
  color: #ddd;
  border: 1px solid #555;
  border-radius: 0.4rem;
  padding: 0.4rem;
  box-sizing: border-box;
  font-family: monospace;
  font-size: 0.75rem;
}

.blurred {
  filter: blur(5px) brightness(0.7);
  pointer-events: none;
}

.modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: transparent; 
}

.modal-window {
  width: 80%;
  height: 80%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0,0,0,0.8);
  border: 1px solid #fff4;
  border-radius: 4px;
  overflow: hidden;
}

.modal-header {
  height: 4rem; /* Increased height */
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 1.5rem;
  box-sizing: border-box;
  color: white;
  z-index: 1002;
}

.modal-body {
  flex: 1;
  position: relative;
  width: 100%;
  overflow: hidden;
}

.modal-body-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: black;
  opacity: 0.8; /* Darken the background color significantly */
  z-index: 0;
}

.modal-content {
  position: relative;
  width: 100%;
  height: 100%;
  z-index: 1;
}

.modal-title {
  font-size: 1.5rem; /* Larger title */
  font-weight: bold;
  text-transform: uppercase;
}

.modal-close {
  background: none;
  border: none;
  color: white;
  font-size: 2.5rem; /* Larger close button */
  cursor: pointer;
  padding: 0.5rem;
  line-height: 1;
}

.layout-edit-modal-overlay {
  position: absolute;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 0.55);
}

.reconcile-window {
  width: min(48rem, 94vw);
  background: #20242a;
  border-radius: 0.5rem;
  box-shadow: 0 10px 40px rgb(0 0 0 / 0.5);
  overflow: hidden;
}

.layout-edit-modal {
  width: min(28rem, 92vw);
  padding: 1rem;
  border: 1px solid rgb(120 170 190 / 0.45);
  border-radius: 0.5rem;
  background: #14181c;
  box-shadow: 0 1rem 3rem rgb(0 0 0 / 0.45);
  color: #fff;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.layout-edit-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.85rem;
}

.layout-edit-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  color: #fff;
}

.layout-edit-field input {
  background: #111;
  color: #fff;
  border: 1px solid rgb(140 188 204 / 0.34);
  border-radius: 0.35rem;
  padding: 0.5rem 0.65rem;
  box-sizing: border-box;
}

.layout-edit-color-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.layout-edit-color-row input[type="color"] {
  width: 3rem;
  min-width: 3rem;
  height: 2.4rem;
  padding: 0.15rem;
}

.layout-edit-color-row input[type="text"] {
  flex: 1;
}

.layout-edit-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
