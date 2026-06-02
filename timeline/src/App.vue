<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { Artwork, Controls } from '@av-controls/protocol'
import * as Timeline from './engine'
import {
  listProjects,
  loadAudioAsset,
  loadProject,
  loadWaveform,
  saveAudioAsset,
  saveProject,
  saveWaveform,
  deleteProject,
  sanitizeTimelineStateForPersistence,
  type StoredAudioTrack,
  type StoredProject,
  type StoredWaveform,
} from './storage'
import { useTimelineSession } from './useTimelineSession'
import TimelineHeader from './components/TimelineHeader.vue'
import TimelineFooter from './components/TimelineFooter.vue'
import TimelineGrid from './components/TimelineGrid.vue'
import RenderDialog from './components/RenderDialog.vue'
import RenderProgress from './components/RenderProgress.vue'
import {
  createVirtualLayout,
  findVirtualItemStart,
  getVirtualRange,
  getVirtualWindow,
} from './virtualizer'

type RenderConfig = {
  name: string
  fps: number
  startTime: number
  endTime: number
  outputFormat: 'live' | 'webp' | 'png' | 'mp4-avc' | 'mp4-hevc'
  imageWorkerCount: number
  width?: number
  height?: number
  quality: number
  testMode?: boolean
  frameLimit?: number
}

type ProjectCompatibilityIssue = {
  path: string
  laneKey?: string
  reason: string
}

type PendingProjectCompatibilityAction = {
  title: string
  issues: ProjectCompatibilityIssue[]
  proceed: () => Promise<void>
}

const wsUrl = ref('ws://localhost:8080')
const fps = ref(60)
const rafNow = ref(performance.now())
let rafId = 0
const timelinePointerLog = new URLSearchParams(window.location.search).get('timeline-pointer-log') === '1'
const timelinePlayLog = new URLSearchParams(window.location.search).get('timeline-play-log') === '1'
const timelineRestoreLog = new URLSearchParams(window.location.search).get('timeline-restore-log') === '1'
const timelineRenderLog = new URLSearchParams(window.location.search).get('timeline-render-log') === '1'
const labelWidthPx = ref(220)
const isResizing = ref(false)
let resizeStartX = 0
let resizeStartWidth = 220
const collapsedRowHeight = 28
const expandedRowHeight = collapsedRowHeight * 3
const rowGapPx = 6
const verticalViewportBufferPx = 480
const secondsPerWidth = ref(10)
const timeOffset = ref(0)
const loopFromSec = ref(0)
const laneWidthPx = ref(0)
const timelineScrollTop = ref(0)
const timelineViewportHeight = ref(0)
const laneHeaderRef = ref<HTMLElement | null>(null)
let laneResizeObserver: ResizeObserver | null = null

// X pan/zoom state
let isPanning = false
let panStartX = 0
let panStartOffset = 0

type ExpansionMode = 'collapsed' | 'expanded'

type RowState = {
  expansion: ExpansionMode
  height: number
  pinned: boolean
}

type LaneRange = {
  min: number
  max: number
  key: string
  mapping?: 'linear' | 'square' | 'log'
  wrap?: boolean
}

type LaneKind = 'curve' | 'step' | 'trigger' | 'keyframes' | 'event'

type RenderCurveLane = {
  kind: 'curve'
  key: string
  title: string
  lane: Timeline.TimelineCurveLane
  range: LaneRange
  renderLane: Timeline.TimelineCurveLane | null
}

type RenderStepLane = {
  kind: 'step'
  key: string
  title: string
  lane: Timeline.TimelineStepLane
  range: LaneRange
  renderLane: Timeline.TimelineStepLane | null
}

type RenderTriggerLane = {
  kind: 'trigger'
  key: string
  title: string
  lane: Timeline.TimelineTriggerLane
  range: LaneRange
  renderLane: Timeline.TimelineTriggerLane | null
}

type RenderKeyframeLane = {
  kind: 'keyframes'
  key: string
  title: string
  lane: Timeline.TimelineKeyframeLane
  renderLane: Timeline.TimelineKeyframeLane | null
}

type RenderEventLane = {
  kind: 'event'
  key: string
  title: string
  lane: Timeline.TimelineEventLane
  renderLane: Timeline.TimelineEventLane | null
}

type RenderAbsentLane = {
  kind: 'absent'
  key: string
  title: string
  laneKind: LaneKind
}

type RenderLane = RenderCurveLane | RenderStepLane | RenderTriggerLane | RenderKeyframeLane | RenderEventLane | RenderAbsentLane

const rowStates = reactive<Record<string, RowState>>({})
const controlEnabled = reactive<Record<string, boolean>>({})
const controlManualOverride = reactive<Record<string, boolean>>({})
const latestControlValues: Record<string, Record<string, number>> = {}
const latestControlPayloads: Record<string, unknown> = {}
const laneClearConfirm = reactive<Record<string, boolean>>({})

// Render dialog state
const showRenderDialog = ref(false)
const showRenderProgress = ref(false)
const renderProgress = ref({ frameNumber: 0, totalFrames: 0, currentTime: 0 })
const renderLoopRunning = ref(false)
const rendering = computed(() => renderLoopRunning.value || showRenderProgress.value)
const isTestMode = ref(false)
const activeRenderConfig = ref<RenderConfig | null>(null)
const renderCancelRequested = ref(false)
const renderLiveEnabled = ref(false)
const lastUpdatedControl = ref<string | null>(null)
const highlightedRowId = ref<string | null>(null)
const autoFollowRecent = ref(true)
const liveEnabled = ref(true)
const hasPersistedLivePreference = ref(false)
const pendingFocusRowId = ref<string | null>(null)
const pendingUiState = ref<StoredProject['uiState'] | null>(null)
const restoredUiStateForArtwork = ref<string | null>(null)
let pendingScrollTop: number | null = null
let resizingRowId: string | null = null
let rowResizeStartY = 0
let rowResizeStartHeight = 0

let resolvePanelChoice: ((id: string) => void) | null = null
const projects = ref<StoredProject[]>([])
const selectedProjectKey = ref('')
const projectName = ref('')
const isSaving = ref(false)
const audioTrack = ref<StoredAudioTrack | null>(null)
const audioWaveform = shallowRef<StoredWaveform | null>(null)
const audioDuration = ref(0)
const audioObjectUrl = ref<string | null>(null)
const missingAudioFileName = ref<string | null>(null)
const highlightedAudioMarkerTime = ref<number | null>(null)
const audioElement = typeof Audio !== 'undefined' ? new Audio() : null
if (audioElement) {
  audioElement.preload = 'auto'
}
const closeProjectMenuSignal = ref(0)
const pendingProjectCompatibilityAction = ref<PendingProjectCompatibilityAction | null>(null)
const timelineScrollRef = ref<HTMLElement | null>(null)
const timelineCursorRef = ref<HTMLElement | null>(null)
let isTogglingPlay = false
let requestStateTimer: number | null = null
let playbackAutomationTimer: number | null = null
let uiSaveTimer: number | null = null
let lastAudioPlaybackSyncAt = 0
const UI_STATE_STORAGE_PREFIX = 'avonx-timeline-ui::'
const PROJECT_SELECTION_STORAGE_PREFIX = 'avonx-timeline-project::'
let pendingRenderAck:
  | {
      expectedTime: number
      resolve: (ack: Artwork.ArtworkRenderAck) => void
      reject: (error: Error) => void
    }
  | null = null
let pendingCaptureAck:
  | {
      expectedAction: Artwork.ArtworkCaptureAck['action']
      resolve: (ack: Artwork.ArtworkCaptureAck) => void
      reject: (error: Error) => void
    }
  | null = null

function cloneValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

async function hashAudioFile(file: File) {
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return {
    hash: Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join(''),
    buffer,
  }
}

async function decodeWaveform(arrayBuffer: ArrayBuffer, baseBinSamples = 128) {
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    return {
      duration: 0,
      sampleRate: 44100,
      baseBinSamples,
      levels: [] as StoredWaveform['levels'],
    }
  }
  const context = new AudioContextCtor()
  try {
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0))
    const channelCount = Math.max(1, decoded.numberOfChannels)
    const baseValues = new Array<number>(Math.ceil(decoded.length / baseBinSamples)).fill(0)

    for (let bin = 0; bin < baseValues.length; bin++) {
      const start = bin * baseBinSamples
      const end = Math.min(decoded.length, start + baseBinSamples)
      let total = 0
      let frames = 0
      for (let i = start; i < end; i++) {
        let channelSum = 0
        for (let channel = 0; channel < channelCount; channel++) {
          channelSum += Math.abs(decoded.getChannelData(channel)[i] ?? 0)
        }
        total += channelSum / channelCount
        frames += 1
      }
      baseValues[bin] = frames > 0 ? total / frames : 0
    }

    const levels: StoredWaveform['levels'] = [{
      binSamples: baseBinSamples,
      values: baseValues,
    }]

    while (levels[levels.length - 1]!.values.length > 1) {
      const previous = levels[levels.length - 1]!
      const nextValues: number[] = []
      for (let i = 0; i < previous.values.length; i += 2) {
        const a = previous.values[i] ?? 0
        const b = previous.values[i + 1] ?? a
        nextValues.push((a + b) * 0.5)
      }
      levels.push({
        binSamples: previous.binSamples * 2,
        values: nextValues,
      })
    }

    return {
      duration: decoded.duration,
      sampleRate: decoded.sampleRate,
      baseBinSamples,
      levels,
    }
  } finally {
    void context.close().catch(() => undefined)
  }
}

function buildStoredAudioTrack(): StoredAudioTrack | undefined {
  return audioTrack.value ? cloneValue(audioTrack.value) : undefined
}

function isValidStoredWaveform(waveform: unknown): waveform is StoredWaveform {
  if (!waveform || typeof waveform !== 'object') return false
  const candidate = waveform as Partial<StoredWaveform>
  return Number.isFinite(candidate.duration)
    && Number.isFinite(candidate.sampleRate)
    && Number.isFinite(candidate.baseBinSamples)
    && Array.isArray(candidate.levels)
    && candidate.levels.every(level =>
      level
      && Number.isFinite(level.binSamples)
      && Array.isArray(level.values),
    )
}

function clearAudioObjectUrl() {
  if (!audioObjectUrl.value) return
  URL.revokeObjectURL(audioObjectUrl.value)
  audioObjectUrl.value = null
}

async function applyAudioTrack(nextTrack?: StoredAudioTrack | null) {
  audioTrack.value = nextTrack ? cloneValue(nextTrack) : null
  audioWaveform.value = null
  audioDuration.value = 0
  missingAudioFileName.value = null
  clearAudioObjectUrl()

  if (!audioElement) return
  audioElement.pause()
  audioElement.removeAttribute('src')
  audioElement.load()

  if (!audioTrack.value) return

  const [asset, waveform] = await Promise.all([
    loadAudioAsset(audioTrack.value.assetHash),
    loadWaveform(audioTrack.value.assetHash),
  ])
  if (!audioTrack.value) return
  if (asset?.hash !== audioTrack.value.assetHash) {
    missingAudioFileName.value = audioTrack.value.fileName || 'audio file'
    return
  }

  let resolvedWaveform: StoredWaveform | null = isValidStoredWaveform(waveform) ? waveform : null

  if (!resolvedWaveform && asset) {
    const decoded = await decodeWaveform(await asset.blob.arrayBuffer())
    resolvedWaveform = {
      hash: asset.hash,
      duration: decoded.duration,
      sampleRate: decoded.sampleRate,
      baseBinSamples: decoded.baseBinSamples,
      levels: decoded.levels,
      createdAt: Date.now(),
    }
    await saveWaveform(resolvedWaveform)
  }

  if (resolvedWaveform) {
    audioWaveform.value = resolvedWaveform
    audioDuration.value = resolvedWaveform.duration
  }

  if (asset) {
    audioDuration.value = resolvedWaveform?.duration ?? asset.duration
    audioObjectUrl.value = URL.createObjectURL(asset.blob)
    audioElement.src = audioObjectUrl.value
    audioElement.preload = 'auto'
  }
}

function scheduleProjectSave() {
  if (!timelineState.value || !artworkId.value) return
  const key = selectedProjectKey.value || `${artworkId.value}::autosave`
  const name = projectName.value.trim() || (selectedProjectKey.value ? currentProjectLabel.value : 'autosave')
  void saveProject({
    key,
    artworkId: artworkId.value,
    name,
    state: sanitizeTimelineStateForPersistence(timelineState.value),
    updatedAt: Date.now(),
    uiState: buildUiState(),
    audioTrack: buildStoredAudioTrack(),
  }).then(() => {
    void refreshProjects()
  })
}

function getAudioMarkerHitThresholdSeconds() {
  const thresholdSeconds = (secondsPerWidth.value / Math.max(1, laneWidthPx.value || 1)) * 10
  return thresholdSeconds
}

function toggleAudioMarker(time: number) {
  if (!audioTrack.value) return
  const thresholdSeconds = getAudioMarkerHitThresholdSeconds()
  const existingIndex = audioTrack.value.markers.findIndex(marker => Math.abs(marker - time) <= thresholdSeconds)
  if (existingIndex >= 0) {
    audioTrack.value.markers.splice(existingIndex, 1)
  } else {
    audioTrack.value.markers.push(Math.max(0, time))
    audioTrack.value.markers.sort((a, b) => a - b)
  }
  scheduleProjectSave()
}

function onAudioHoverTime(time: number | null) {
  if (time === null || !audioTrack.value) {
    highlightedAudioMarkerTime.value = null
    return
  }
  const thresholdSeconds = getAudioMarkerHitThresholdSeconds()
  highlightedAudioMarkerTime.value = audioTrack.value.markers.find(marker => Math.abs(marker - time) <= thresholdSeconds) ?? null
}

function toggleAudioExpanded() {
  if (!audioTrack.value) {
    audioTrack.value = { assetHash: '', fileName: '', markers: [], snapEnabled: false, expanded: true }
  } else {
    audioTrack.value.expanded = !audioTrack.value.expanded
  }
  scheduleProjectSave()
}

function toggleAudioSnap() {
  if (!audioTrack.value) {
    audioTrack.value = { assetHash: '', fileName: '', markers: [], snapEnabled: true, expanded: true }
  } else {
    audioTrack.value.snapEnabled = !audioTrack.value.snapEnabled
  }
  scheduleProjectSave()
}

async function onAudioUpload(payload: { file: File; markerTime?: number }) {
  const { file, markerTime } = payload
  const { hash, buffer } = await hashAudioFile(file)
  let asset = await loadAudioAsset(hash)
  let waveform = await loadWaveform(hash)

  if (!isValidStoredWaveform(waveform)) {
    const decoded = await decodeWaveform(buffer)
    waveform = {
      hash,
      duration: decoded.duration,
      sampleRate: decoded.sampleRate,
      baseBinSamples: decoded.baseBinSamples,
      levels: decoded.levels,
      createdAt: Date.now(),
    }
    await saveWaveform(waveform)
  }

  if (!asset) {
    asset = {
      hash,
      fileName: file.name,
      mimeType: file.type || 'audio/*',
      size: file.size,
      duration: waveform.duration,
      blob: file,
      createdAt: Date.now(),
    }
    await saveAudioAsset(asset)
  }

  const nextTrack: StoredAudioTrack = {
    assetHash: hash,
    fileName: asset.fileName,
    markers: markerTime !== undefined ? [Math.max(0, markerTime)] : [],
    snapEnabled: true,
    expanded: true,
  }
  await applyAudioTrack(nextTrack)
  scheduleProjectSave()
}

function syncTimelineAudio() {
  if (!audioElement || !audioTrack.value?.assetHash || !audioObjectUrl.value) return
  const targetTime = Math.max(0, Math.min(displayTime.value, audioDuration.value || displayTime.value))
  const drift = audioElement.currentTime - targetTime
  const absDrift = Math.abs(drift)

  if (rendering.value) {
    if (!audioElement.paused) {
      audioElement.pause()
    }
    audioElement.playbackRate = 1
    return
  }

  if (playing.value) {
    const now = performance.now()
    if (absDrift > 0.35) {
      try {
        audioElement.currentTime = targetTime
      } catch {}
      audioElement.playbackRate = 1
      lastAudioPlaybackSyncAt = now
    } else if (now - lastAudioPlaybackSyncAt >= 120) {
      lastAudioPlaybackSyncAt = now
      const correction = Math.max(-0.04, Math.min(0.04, -drift * 0.25))
      audioElement.playbackRate = Math.max(0.96, Math.min(1.04, 1 + correction))
    }
    if (audioElement.paused) {
      void audioElement.play().catch(() => undefined)
    }
    return
  }

  if (!audioElement.paused) {
    audioElement.pause()
  }
  audioElement.playbackRate = 1
  if (absDrift > 1 / 120) {
    try {
      audioElement.currentTime = targetTime
    } catch {}
  }
}

function logTimelineManualOverride(event: string, data?: unknown) {
  const timestamp = new Date().toISOString()
  console.info(`[${timestamp}] [timeline:manual-override] ${event}`, data ?? {})
}

function logTimelineRestore(event: string, data?: unknown) {
  if (!timelineRestoreLog) return
  console.info(`[timeline:restore] ${event}`, data ?? {})
}

function logTimelineRender(event: string, data?: unknown) {
  if (!timelineRenderLog) return
  const timestamp = new Date().toISOString()
  console.info(`[${timestamp}] [timeline:render] ${event}`, data ?? {})
}

function closeProjectMenu() {
  closeProjectMenuSignal.value += 1
}

function formatLaneKind(lane: Timeline.TimelineLane) {
  if (lane.type === 'keyframes') return 'keyframes'
  if (lane.type === 'trigger') return 'trigger'
  if (lane.type === 'event') return 'event'
  if (lane.type === 'step') return 'step'
  return 'curve'
}

function buildUiState(): NonNullable<StoredProject['uiState']> {
  return {
    expandedRows: Object.fromEntries(
      Object.entries(rowStates).map(([id, state]) => [
        id,
        { expansion: state.expansion, height: state.height, pinned: state.pinned },
      ]),
    ),
    labelWidth: labelWidthPx.value,
    scrollTop: timelineScrollRef.value?.scrollTop ?? 0,
    secondsPerWidth: secondsPerWidth.value,
    timeOffset: timeOffset.value,
    playheadTime: displayTime.value,
    loopFromSec: loopFromSec.value,
    liveEnabled: liveEnabled.value,
  }
}

function getUiStateStorageKey() {
  return `${UI_STATE_STORAGE_PREFIX}${artworkId.value}`
}

function getProjectSelectionStorageKey() {
  return `${PROJECT_SELECTION_STORAGE_PREFIX}${artworkId.value}`
}

function persistUiStateLocally(uiState: NonNullable<StoredProject['uiState']>) {
  if (typeof window === 'undefined' || !artworkId.value) return
  try {
    window.localStorage.setItem(getUiStateStorageKey(), JSON.stringify(uiState))
  } catch {}
}

function persistSelectedProjectKeyLocally(projectKey: string) {
  if (typeof window === 'undefined' || !artworkId.value) return
  try {
    window.localStorage.setItem(getProjectSelectionStorageKey(), projectKey)
  } catch {}
}

function loadStoredSelectedProjectKey() {
  if (typeof window === 'undefined' || !artworkId.value) return ''
  try {
    return window.localStorage.getItem(getProjectSelectionStorageKey()) ?? ''
  } catch {
    return ''
  }
}

function loadStoredUiState() {
  if (typeof window === 'undefined' || !artworkId.value) return null
  try {
    const raw = window.localStorage.getItem(getUiStateStorageKey())
    const parsed = raw ? JSON.parse(raw) as StoredProject['uiState'] : null
    logTimelineRestore('load-local-ui-state', {
      artworkId: artworkId.value,
      found: !!parsed,
      expandedRowCount: Object.keys(parsed?.expandedRows ?? {}).length,
    })
    return parsed
  } catch {
    logTimelineRestore('load-local-ui-state-failed', { artworkId: artworkId.value })
    return null
  }
}

function scheduleUiAutosave(options?: { delayMs?: number; deferLocalStorage?: boolean }) {
  const delayMs = options?.delayMs ?? 150
  const shouldDeferLocalStorage = options?.deferLocalStorage ?? false
  if (!shouldDeferLocalStorage) {
    persistUiStateLocally(buildUiState())
  }
  if (uiSaveTimer !== null) {
    window.clearTimeout(uiSaveTimer)
  }
  uiSaveTimer = window.setTimeout(async () => {
    uiSaveTimer = null
    if (shouldDeferLocalStorage) {
      persistUiStateLocally(buildUiState())
    }
    if (!artworkId.value || !timelineStateRaw.value) return
    await saveProject({
      key: `${artworkId.value}::autosave`,
      artworkId: artworkId.value,
      name: 'autosave',
      state: timelineStateRaw.value,
      updatedAt: Date.now(),
      uiState: buildUiState(),
      audioTrack: buildStoredAudioTrack(),
    })
  }, delayMs)
}

const artworkId = computed(() => {
  return selectedPanelId.value || rootSpec.value?.name || 'default'
})

function getNestedControlPath(payload: any, childKey: 'update' | 'signal', path: string[] = []): string[] {
  if (!payload || typeof payload !== 'object') return path
  if (Array.isArray(payload.path)) return payload.path
  if (typeof payload.controlId === 'string' && payload[childKey]) {
    return getNestedControlPath(payload[childKey], childKey, [...path, payload.controlId])
  }
  if (typeof payload.id === 'string' && payload[childKey]) {
    return getNestedControlPath(payload[childKey], childKey, [...path, payload.id])
  }
  return path
}

function extractLaneValues(payload: any): Record<string, number> {
  if (!payload || typeof payload !== 'object') return {}
  if (payload.update && (typeof payload.controlId === 'string' || typeof payload.id === 'string')) {
    return extractLaneValues(payload.update)
  }
  const values: Record<string, number> = {}
  if (typeof payload.value === 'number') values.value = payload.value
  if (typeof payload.on === 'boolean') values.on = payload.on ? 0 : -0.5
  if (typeof payload.pressed === 'boolean') {
    const velocity = typeof payload.velocity === 'number' ? payload.velocity : (payload.pressed ? 1 : 0)
    values.value = payload.pressed ? Math.max(0, velocity) : -0.5
  }
  if (typeof payload.index === 'number') values.index = payload.index
  if (typeof payload.x === 'number') values.x = payload.x
  if (typeof payload.y === 'number') values.y = payload.y
  if (Array.isArray(payload.position)) {
    if (typeof payload.position[0] === 'number') values.x = payload.position[0]
    if (typeof payload.position[1] === 'number') values.y = payload.position[1]
    if (typeof payload.position[2] === 'number') values.z = payload.position[2]
  }
  if (Array.isArray(payload.rotation)) {
    if (typeof payload.rotation[0] === 'number') values.qx = payload.rotation[0]
    if (typeof payload.rotation[1] === 'number') values.qy = payload.rotation[1]
    if (typeof payload.rotation[2] === 'number') values.qz = payload.rotation[2]
    if (typeof payload.rotation[3] === 'number') values.qw = payload.rotation[3]
  }
  return values
}

function extractAutomationPayload(payload: any): unknown {
  if (!payload || typeof payload !== 'object') return payload
  if (payload.update && (typeof payload.controlId === 'string' || typeof payload.id === 'string')) {
    return extractAutomationPayload(payload.update)
  }
  return cloneValue(payload)
}

function chooseNetPanel(ids: string[]) {
  console.info('[timeline] panel list', ids)
  if (ids.length === 1) {
    selectedPanelId.value = ids[0]!
    console.info('[timeline] auto-select panel', ids[0]!)
    return Promise.resolve(ids[0]!)
  }
  return new Promise<string>((resolve) => {
    resolvePanelChoice = resolve
  })
}

const {
  panelIds,
  selectedPanelId,
  isConnected,
  wsSender,
  timelineClient,
  artworkClient,
  rootSpec,
  connecting,
  timelineStateRaw,
  timelineState,
  artworkMode,
  timelineTime,
  playing,
  alwaysRender,
  loopEnabled,
  loopDurationSec,
  lastStateTime,
  lastStateAt,
  pendingPlaybackIntent,
  title,
  isApplyingProject,
  connect: connectSession,
  disconnect: disconnectSession,
  applyProjectState,
} = useTimelineSession({
  wsUrl,
  artworkId,
  chooseNetPanel,
  refreshProjects,
  buildUiState,
  buildAudioTrack: buildStoredAudioTrack,
  applyUiState,
  normalizeProjectState,
  getNestedControlPath,
  extractLaneValues,
  extractAutomationPayload,
  canAutoSave: () => !pendingUiState.value,
  controlEnabled,
  controlManualOverride,
  latestControlValues,
  latestControlPayloads,
  setLastUpdatedControl: (rowId) => {
    lastUpdatedControl.value = rowId
  },
  shouldUpdateClock: () => !isTogglingPlay,
  onStateProcessed: () => {
    isTogglingPlay = false
  },
  onAutosaveProjectLoaded: (project) => {
    void applyAudioTrack(project?.audioTrack)
  },
})

function connect() {
  console.info('[timeline] connect', wsUrl.value)
  connectSession()
  startStatePolling()
}

function disconnect() {
  disconnectSession()
  stopStatePolling()
}

function cancelProjectCompatibilityAction() {
  pendingProjectCompatibilityAction.value = null
}

async function proceedProjectCompatibilityAction() {
  const action = pendingProjectCompatibilityAction.value
  if (!action) return
  pendingProjectCompatibilityAction.value = null
  await action.proceed()
}

async function applyCompatibleProjectState(
  title: string,
  state: Timeline.TimelineState,
  audioTrackToLoad: StoredAudioTrack | undefined,
  proceed: (compatibleState: Timeline.TimelineState) => Promise<void>,
) {
  const compatible = filterProjectStateForCurrentSpec(state)
  if (audioTrackToLoad?.assetHash && !(await loadAudioAsset(audioTrackToLoad.assetHash))) {
    compatible.issues.push({
      path: 'audio',
      reason: `specified track not available: ${audioTrackToLoad.fileName || audioTrackToLoad.assetHash}`,
    })
  }
  if (!compatible.issues.length) {
    await proceed(compatible.state)
    return
  }
  pendingProjectCompatibilityAction.value = {
    title,
    issues: compatible.issues,
    proceed: () => proceed(compatible.state),
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (pendingProjectCompatibilityAction.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelProjectCompatibilityAction()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void proceedProjectCompatibilityAction()
      return
    }
  }
  if (
    e.code === 'KeyK'
    && !e.ctrlKey
    && !e.metaKey
    && !e.altKey
    && !(e.target instanceof HTMLInputElement)
    && !(e.target instanceof HTMLTextAreaElement)
  ) {
    e.preventDefault()
    recordAllManualOverrideKeyframes()
    return
  }
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
    e.preventDefault()
    if (timelinePlayLog) {
      console.info('[timeline:play:intent]', {
        source: 'space',
        previousPlaying: playing.value,
        nextPlaying: !playing.value,
        currentTime: displayTime.value,
      })
    }
    togglePlay()
  }
}

function onTogglePlayButton() {
  if (timelinePlayLog) {
    console.info('[timeline:play:intent]', {
      source: 'button',
      previousPlaying: playing.value,
      nextPlaying: !playing.value,
      currentTime: displayTime.value,
    })
  }
  togglePlay()
}

onMounted(() => {
  connect()
  startPlaybackAutomationTimer()
  tickRaf()
  window.addEventListener('keydown', onKeyDown)
  laneResizeObserver = new ResizeObserver(() => {
    updateLaneWidth()
    updateTimelineViewportMetrics()
  })
  // Use nextTick to ensure scrubAreaRef is mounted
  nextTick(() => {
    if (scrubAreaRef.value) laneResizeObserver!.observe(scrubAreaRef.value)
    if (timelineScrollRef.value) laneResizeObserver!.observe(timelineScrollRef.value)
    updateLaneWidth()
    updateTimelineViewportMetrics()
  })
})

function applyPanelChoice() {
  if (!selectedPanelId.value || !resolvePanelChoice) return
  console.info('[timeline] selected panel', selectedPanelId.value)
  resolvePanelChoice(selectedPanelId.value)
  resolvePanelChoice = null
  timelineClient.value?.requestState()
}

function togglePlay() {
  if (renderLiveEnabled.value) {
    if (rendering.value) {
      onCancelRender()
      playing.value = false
      timelineClient.value?.setPlaying(false)
    } else {
      startRenderLivePlayback(displayTime.value)
    }
    return
  }

  // Capture current display time BEFORE changing playing state
  // ... rest of togglePlay
  // (displayTime computation depends on playing.value)
  const currentTime = displayTime.value
  const next = !playing.value
  if (timelinePlayLog) {
    console.info('[timeline:play:click]', {
      previousPlaying: playing.value,
      nextPlaying: next,
      currentTime,
      timelineTime: timelineTime.value,
      lastStateTime: lastStateTime.value,
      timelineState: timelineState.value?.state,
    })
  }
  playing.value = next
  lastStateTime.value = currentTime
  lastStateAt.value = performance.now()
  isTogglingPlay = true
  if (timelinePlayLog) {
    console.info('[timeline:play:send]', {
      nextPlaying: next,
      currentTime,
    })
  }
  pendingPlaybackIntent.value = null
  timelineClient.value?.setPlaying(next)
  artworkClient.value?.setMode(next ? 'timeline-live' : (liveEnabled.value ? 'artwork-live' : 'paused'))
}

function toggleRenderLoop() {
  if (rendering.value) {
    onCancelRender()
  } else {
    showRenderDialog.value = true
  }
}

function getRenderTotalFrames(config: RenderConfig) {
  return Math.max(0, Math.ceil((config.endTime - config.startTime) * config.fps))
}

function getAbsoluteRenderFrameNumber(config: RenderConfig, frameIndex: number) {
  return Math.round(config.startTime * Math.max(1, config.fps)) + frameIndex
}

function getRenderFilename(config: RenderConfig, frameIndex: number) {
  const absoluteFrameNumber = getAbsoluteRenderFrameNumber(config, frameIndex)
  const extension = config.outputFormat === 'webp' ? 'webp' : 'png'
  return `${config.name}-${String(absoluteFrameNumber).padStart(6, '0')}.${extension}`
}

function getRenderVideoFilename(config: RenderConfig) {
  return `${config.name}.mp4`
}

function isVideoRenderConfig(config: RenderConfig) {
  return config.outputFormat === 'mp4-avc' || config.outputFormat === 'mp4-hevc'
}

function isImageRenderConfig(config: RenderConfig) {
  return config.outputFormat === 'png' || config.outputFormat === 'webp'
}

function waitForRenderAck(expectedTime: number) {
  if (pendingRenderAck) {
    logTimelineRender('wait-replaced', {
      previousExpectedTime: pendingRenderAck.expectedTime,
      nextExpectedTime: expectedTime,
    })
    pendingRenderAck.reject(new Error('Render ack was replaced by a newer render request'))
    pendingRenderAck = null
  }
  logTimelineRender('wait-register', { expectedTime })
  return new Promise<Artwork.ArtworkRenderAck>((resolve, reject) => {
    pendingRenderAck = { expectedTime, resolve, reject }
  })
}

function waitForCaptureAck(expectedAction: Artwork.ArtworkCaptureAck['action']) {
  if (pendingCaptureAck) {
    pendingCaptureAck.reject(new Error('Capture ack was replaced by a newer capture request'))
    pendingCaptureAck = null
  }
  return new Promise<Artwork.ArtworkCaptureAck>((resolve, reject) => {
    pendingCaptureAck = { expectedAction, resolve, reject }
  })
}

function applyAutomationAt(time: number, options?: { useRenderLanes?: boolean; bypassBackpressure?: boolean }) {
  timelineClient.value?.seek(time)
  timelineClient.value?.applyAutomation(time, options)
}

function previewFrameAtTime(time: number) {
  const nextTime = Math.max(0, time)
  const useRenderLanes = !liveEnabled.value
  timelineTime.value = nextTime
  lastStateTime.value = nextTime
  lastStateAt.value = performance.now()
  applyAutomationAt(nextTime, { useRenderLanes, bypassBackpressure: true })
  if (!liveEnabled.value) {
    artworkClient.value?.setMode('paused')
  }
  artworkClient.value?.setTime(nextTime)
}

async function runRenderLoop(config: RenderConfig, startFrame = 0) {
  if (!timelineClient.value || !artworkClient.value) return
  if (renderLoopRunning.value) {
    console.warn('[timeline] Render loop is already running. Ignoring overlapping request.')
    return
  }

  const totalFrames = getRenderTotalFrames(config)
  const maxFrames = config.testMode && config.frameLimit
    ? Math.min(totalFrames, config.frameLimit)
    : totalFrames

  activeRenderConfig.value = config
  renderCancelRequested.value = false
  renderLoopRunning.value = true
  showRenderProgress.value = config.outputFormat !== 'live'
  renderProgress.value = {
    frameNumber: startFrame,
    totalFrames,
    currentTime: config.startTime + startFrame / Math.max(1, config.fps),
  }

  try {
    artworkClient.value.setMode('timeline-render')
    // Immediately pause audio when rendering starts
    if (audioElement && !audioElement.paused) {
      audioElement.pause()
    }
    
    // Only reset state for actual export renders, not live preview
    if (startFrame === 0 && config.outputFormat !== 'live') {
      artworkClient.value.resetRenderState()
    }
    if (isImageRenderConfig(config) && startFrame === 0) {
      artworkClient.value.configureImageCapture({
        workerCount: config.imageWorkerCount,
      })
    }
    if (isVideoRenderConfig(config) && startFrame === 0) {
      artworkClient.value.startVideoCapture({
        downloadName: getRenderVideoFilename(config),
        fps: config.fps,
        codec: config.outputFormat === 'mp4-avc' ? 'avc' : 'hevc',
        quality: config.quality,
      })
      const startAck = await waitForCaptureAck('start-video')
      if (!startAck.ok) {
        throw new Error(startAck.error || 'Failed to start video capture')
      }
    }
    logTimelineRender('loop-start', {
      startFrame,
      totalFrames,
      maxFrames,
      startTime: config.startTime,
      endTime: config.endTime,
      fps: config.fps,
      testMode: config.testMode,
    })

    for (let frameIndex = startFrame; frameIndex < totalFrames; frameIndex++) {
      if (renderCancelRequested.value) {
        break
      }
      if (frameIndex >= maxFrames) {
        break
      }

      let time = config.startTime + frameIndex / Math.max(1, config.fps)
      if (loopEnabled.value && config.outputFormat === 'live') {
        const min = Math.min(loopFromSec.value, loopDurationSec.value)
        const max = Math.max(loopFromSec.value, loopDurationSec.value)
        if (max > min && time >= max) {
          const loopLength = max - min
          time = min + ((time - max) % loopLength)
        }
      }

      logTimelineRender('frame-dispatch', {
        frameIndex,
        time,
      })
      timelineTime.value = time
      lastStateTime.value = time
      lastStateAt.value = performance.now()

      applyAutomationAt(time, { useRenderLanes: true, bypassBackpressure: true })
      artworkClient.value.render(
        time,
        isImageRenderConfig(config)
          ? { captureDownloadName: getRenderFilename(config, frameIndex) }
          : undefined,
      )

      const ack = await waitForRenderAck(time)
      logTimelineRender('frame-ack-resolved', {
        frameIndex,
        expectedTime: time,
        ackTime: ack.time,
        ok: ack.ok,
        captured: ack.captured,
      })
      if (!ack.ok) {
        throw new Error(ack.error || `Render failed at ${time.toFixed(3)}s`)
      }

      // Only update reactive progress state if actually showing the modal
      if (showRenderProgress.value) {
        renderProgress.value = {
          frameNumber: frameIndex + 1,
          totalFrames,
          currentTime: time,
        }
      } else {
        // Just update local timeline state
        timelineTime.value = time
        lastStateTime.value = time
      }

      // Yield to the event loop to allow UI updates and prevent starvation
      await new Promise(r => setTimeout(r, 0))
    }

    if (renderCancelRequested.value) {
      if (isImageRenderConfig(config)) {
        artworkClient.value.cancelImageCapture()
        const cancelAck = await waitForCaptureAck('cancel-images')
        if (!cancelAck.ok) {
          throw new Error(cancelAck.error || 'Failed to cancel image capture')
        }
      }
      showRenderProgress.value = false
      return
    }

    if (config.testMode && config.frameLimit && renderProgress.value.frameNumber >= Math.min(totalFrames, config.frameLimit)) {
      if (isImageRenderConfig(config)) {
        artworkClient.value.flushImageCapture()
        const flushAck = await waitForCaptureAck('flush-images')
        if (!flushAck.ok) {
          throw new Error(flushAck.error || 'Failed to flush image capture')
        }
      }
      if (isVideoRenderConfig(config)) {
        artworkClient.value.finalizeVideoCapture()
        const finalizeAck = await waitForCaptureAck('finalize-video')
        if (!finalizeAck.ok) {
          throw new Error(finalizeAck.error || 'Failed to finalize video capture')
        }
      }
      return
    }

    if (isImageRenderConfig(config)) {
      artworkClient.value.flushImageCapture()
      const flushAck = await waitForCaptureAck('flush-images')
      if (!flushAck.ok) {
        throw new Error(flushAck.error || 'Failed to flush image capture')
      }
    }

    if (isVideoRenderConfig(config)) {
      artworkClient.value.finalizeVideoCapture()
      const finalizeAck = await waitForCaptureAck('finalize-video')
      if (!finalizeAck.ok) {
        throw new Error(finalizeAck.error || 'Failed to finalize video capture')
      }
    }

    showRenderProgress.value = false
    logTimelineRender('loop-complete', {
      renderedFrames: renderProgress.value.frameNumber,
      totalFrames,
    })
    console.log(`Render complete: ${renderProgress.value.frameNumber} frames`)
  } catch (error) {
    logTimelineRender('loop-error', {
      error: error instanceof Error ? error.message : String(error),
      progress: renderProgress.value,
    })
    showRenderProgress.value = false
    const message = error instanceof Error ? error.message : String(error)
    if (message !== 'Render cancelled') {
      alert(`Render failed: ${message}`)
    }
  } finally {
    if (isImageRenderConfig(config) && renderCancelRequested.value) {
      artworkClient.value.cancelImageCapture()
    }
    if (isVideoRenderConfig(config) && (renderCancelRequested.value || pendingCaptureAck?.expectedAction === 'start-video')) {
      artworkClient.value.cancelVideoCapture()
    }
    logTimelineRender('loop-end', {
      cancelled: renderCancelRequested.value,
      progress: renderProgress.value,
    })
    renderLoopRunning.value = false
  }
}

function onRenderStart(config: RenderConfig) {
  isTestMode.value = false
  showRenderDialog.value = false
  showRenderProgress.value = true
  void runRenderLoop({
    ...config,
    testMode: false,
    frameLimit: undefined,
  })
}

function onRenderTest(config: RenderConfig) {
  isTestMode.value = true
  showRenderDialog.value = false
  showRenderProgress.value = true
  void runRenderLoop(config)
}

function startRenderLivePlayback(startTime: number) {
  let endTime = startTime + 3600 // Default to 1 hour for live preview
  if (timelineState.value) {
    timelineState.value.controls.forEach(c => {
      c.lanes.forEach(l => {
        if (l.type === 'keyframes') {
          l.keyframes.forEach(k => { if (k.time > endTime) endTime = k.time })
        } else if (l.type === 'trigger') {
          l.triggers.forEach(t => { if (t.time > endTime) endTime = t.time })
        } else if (l.points) {
          l.points.forEach(p => { if (p.time > endTime) endTime = p.time })
        }
      })
    })
  }
  playing.value = true
  timelineClient.value?.setPlaying(true)
  void runRenderLoop({
    name: 'Live Preview',
    fps: fps.value,
    startTime,
    endTime: endTime + 1,
    outputFormat: 'live',
    imageWorkerCount: 1,
    quality: 0.9,
  })
}

function toggleRenderLive() {
  renderLiveEnabled.value = !renderLiveEnabled.value
  if (renderLiveEnabled.value) {
    artworkClient.value?.setMode('timeline-render')
    if (playing.value && !rendering.value) {
      // Transition from real-time to render-live seamlessly
      startRenderLivePlayback(displayTime.value)
    }
  } else {
    if (rendering.value) {
      onCancelRender()
      // If we were rendering (active playback in R mode), 
      // we need to resume normal playback if playing.value is still true
      if (playing.value) {
        lastStateTime.value = displayTime.value
        lastStateAt.value = performance.now()
        timelineClient.value?.setPlaying(true)
        artworkClient.value?.setMode('timeline-live')
      }
    } else {
      artworkClient.value?.setMode(playing.value ? 'timeline-live' : (liveEnabled.value ? 'artwork-live' : 'paused'))
    }
  }
}

function onContinueRender() {
  const config = activeRenderConfig.value
  if (!config) return
  isTestMode.value = false
  void runRenderLoop({
    ...config,
    testMode: false,
    frameLimit: undefined,
  }, renderProgress.value.frameNumber)
}

function onCancelRender() {
  renderCancelRequested.value = true
  if (pendingRenderAck) {
    pendingRenderAck.reject(new Error('Render cancelled'))
    pendingRenderAck = null
  }
  showRenderProgress.value = false
}

function toggleLive() {
  const next = !liveEnabled.value
  liveEnabled.value = next
  if (!playing.value) {
    applyAutomationAt(displayTime.value, { useRenderLanes: !next, bypassBackpressure: true })
    artworkClient.value?.setMode(next ? 'artwork-live' : 'paused')
    artworkClient.value?.setTime(displayTime.value)
  }
  scheduleUiAutosave()
}

function toggleLoop() {
  const next = !loopEnabled.value
  loopEnabled.value = next
  timelineClient.value?.setLoopEnabled(next)
}

function updateLoopDuration(value: number) {
  if (!Number.isFinite(value)) return
  const next = Math.max(0.1, value)
  loopDurationSec.value = next
  timelineClient.value?.setLoopDuration(next)
}

function updateLoopFrom(value: number) {
  if (!Number.isFinite(value)) return
  loopFromSec.value = Math.max(0, value)
  scheduleUiAutosave()
}

function updateLoopTo(value: number) {
  if (!Number.isFinite(value)) return
  updateLoopDuration(value)
  scheduleUiAutosave()
}

function seekZero() {
  previewFrameAtTime(0)
}

function stepFrames(deltaFrames: number) {
  const deltaSeconds = deltaFrames / Math.max(1, fps.value)
  previewFrameAtTime(displayTime.value + deltaSeconds)
}

function seekToTime(time: number) {
  previewFrameAtTime(time)
}

type Row = {
  id: string
  name: string
  depth: number
  parentId: string | null
  isContainer: boolean
  color?: string
  hasValue: boolean
  spec?: Controls.Base.Spec
}

function isContainerSpec(spec: Controls.Base.Spec) {
  return spec.type === Controls.Group.Spec.type || spec.type === Controls.Tabs.Spec.type || spec.type === Controls.Modal.Spec.type
}

function isAutomatableSpec(spec: Controls.Base.Spec) {
  if (isContainerSpec(spec)) return false
  return spec.type !== Controls.Cake.Spec.type
    && spec.type !== Controls.Meter.Spec.type
    && spec.type !== Controls.Lamp.Spec.type
}

function collectRows(spec: Controls.Base.Spec, depth = 0, prefix = '', parentId: string | null = null): Row[] {
  const rows: Row[] = []
  if (!isContainerSpec(spec)) {
    rows.push({
      id: prefix || spec.name,
      name: spec.name,
      depth,
      parentId,
      isContainer: false,
      color: spec.baseArgs?.color,
      hasValue: isAutomatableSpec(spec),
      spec,
    })
    return rows
  }
  const groupSpec = spec as Controls.Group.Spec
  for (const key in groupSpec.controlSpecs) {
    const child = groupSpec.controlSpecs[key]
    if (!child) continue
    const rowId = prefix ? `${prefix}.${key}` : key
    const isContainer = isContainerSpec(child)
    rows.push({
      id: prefix ? `${prefix}.${key}` : key,
      name: child.name,
      depth,
      parentId,
      isContainer,
      color: child.baseArgs?.color,
      hasValue: isAutomatableSpec(child),
      spec: child,
    })
    if (isContainer) {
      rows.push(...collectRows(child, depth + 1, rowId, rowId))
    }
  }
  return rows
}

const rows = computed<Row[]>(() => {
  const spec = rootSpec.value?.rootControlSpec
  if (!spec) return []
  const next = collectRows(spec, 0, '')
  for (const row of next) {
    if (!rowStates[row.id]) {
      rowStates[row.id] = {
        expansion: 'collapsed',
        height: expandedRowHeight,
        pinned: false,
      }
    }
  }
  if (pendingFocusRowId.value) {
    const target = resolveRowId(pendingFocusRowId.value)
    if (target) {
      focusRow(target)
      pendingFocusRowId.value = null
    }
  }
  if (pendingUiState.value) {
    if (applyUiState(pendingUiState.value)) {
      pendingUiState.value = null
    }
  }
  if (pendingScrollTop !== null) {
    restoreScrollTopDeferred(pendingScrollTop)
  }
  return next
})

const searchableControls = computed(() =>
  rows.value
    .filter((row) => row.hasValue)
    .map((row) => ({
      id: row.id,
      name: row.name,
    })),
)

const currentProjectLabel = computed(() => {
  const explicitName = projectName.value.trim()
  if (explicitName) return explicitName
  const selectedProject = projects.value.find(project => project.key === selectedProjectKey.value)
  return selectedProject?.name || 'autosave'
})

watch(artworkMode, (mode) => {
  if (rendering.value) return
  if (!playing.value && !hasPersistedLivePreference.value) {
    liveEnabled.value = mode === 'artwork-live'
  }
})

watch([artworkMode, liveEnabled, playing, artworkClient, hasPersistedLivePreference], ([mode, live, isPlaying, client, hasPreference]) => {
  if (!client || isPlaying || !hasPreference || rendering.value) return
  const targetMode = live ? 'artwork-live' : 'paused'
  if (mode === targetMode) return
  client.setMode(targetMode)
})

watch(artworkId, () => {
  hasPersistedLivePreference.value = false
  restoredUiStateForArtwork.value = null
  selectedProjectKey.value = ''
  void applyAudioTrack(null)
  const uiState = loadStoredUiState()
  if (uiState) {
    logTimelineRestore('artwork-id-watch-apply-ui-state', {
      artworkId: artworkId.value,
      expandedRowCount: Object.keys(uiState.expandedRows ?? {}).length,
    })
    applyUiState(uiState)
  }
}, { immediate: true })

watch(selectedProjectKey, (projectKey) => {
  if (!projectKey) return
  persistSelectedProjectKeyLocally(projectKey)
})

watch([rootSpec, timelineState], ([spec, state]) => {
  if (!spec) return
  if (restoredUiStateForArtwork.value === artworkId.value) return
  const uiState = pendingUiState.value ?? loadStoredUiState()
  if (!uiState) return
  logTimelineRestore('root-spec-state-watch-apply-ui-state', {
    artworkId: artworkId.value,
    hasTimelineState: !!state,
    controlCount: state?.controls?.length ?? 0,
    expandedRowCount: Object.keys(uiState.expandedRows ?? {}).length,
    pending: !!pendingUiState.value,
  })
  if (!applyUiState(uiState)) return
  restoredUiStateForArtwork.value = artworkId.value
  pendingUiState.value = null
})

const rowById = computed(() => {
  const map = new Map<string, Row>()
  for (const row of rows.value) {
    map.set(row.id, row)
  }
  return map
})

const visibleRows = computed(() => {
  if (!rows.value.length) return []
  const map = rowById.value
  return rows.value.filter((row) => {
    let parentId = row.parentId
    while (parentId) {
      const parent = map.get(parentId)
      if (!parent) return false
      const parentState = rowStates[parentId]
      if (!parentState) return false
      if (parentState.expansion === 'collapsed' && !rowStates[row.id]?.pinned) return false
      parentId = parent.parentId
    }
    return true
  })
})

type VisibleRow =
  | { kind: 'row'; row: Row }
  | { kind: 'ellipsis'; parentId: string }

function getDescendantStats(parentId: string) {
  let hasHidden = false
  let hasPinned = false
  for (const row of rows.value) {
    if (row.id === parentId) continue
    let current = row.parentId
    while (current) {
      if (current === parentId) {
        if (rowStates[row.id]?.pinned) {
          hasPinned = true
        } else {
          hasHidden = true
        }
        break
      }
      current = rowById.value.get(current)?.parentId ?? null
    }
  }
  return { hasHidden, hasPinned }
}

const visibleRowsWithEllipsis = computed<VisibleRow[]>(() => {
  const base = visibleRows.value
  if (!base.length) return []

  const result: VisibleRow[] = []
  const lastPinnedIndexByParent = new Map<string, number>()
  const parentRowIndex = new Map<string, number>()

  base.forEach((row, index) => {
    result.push({ kind: 'row', row })
    parentRowIndex.set(row.id, index)
    let current = row.parentId
    while (current) {
      const state = rowStates[current]
      if (state?.expansion === 'collapsed' && rowStates[row.id]?.pinned) {
        lastPinnedIndexByParent.set(current, index)
      }
      current = rowById.value.get(current)?.parentId ?? null
    }
  })

  // Insert ellipsis for collapsed parents that still show pinned descendants.
  const insertions: Array<{ index: number; parentId: string }> = []
  for (const row of rows.value) {
    const state = rowStates[row.id]
    if (!state || state.expansion !== 'collapsed') continue
    const { hasHidden, hasPinned } = getDescendantStats(row.id)
    if (!hasHidden || !hasPinned) continue
    const lastPinnedIndex = lastPinnedIndexByParent.get(row.id)
    const parentIndex = parentRowIndex.get(row.id)
    const insertionIndex = lastPinnedIndex !== undefined ? lastPinnedIndex + 1 : (parentIndex !== undefined ? parentIndex + 1 : undefined)
    if (insertionIndex !== undefined) {
      insertions.push({ index: insertionIndex, parentId: row.id })
    }
  }

  // apply insertions in order
  insertions
    .sort((a, b) => a.index - b.index)
    .forEach((ins, offset) => {
      result.splice(ins.index + offset, 0, { kind: 'ellipsis', parentId: ins.parentId })
    })

  return result
})

function getVisibleEntryRowHeight(entry: VisibleRow) {
  if (entry.kind !== 'row') return collapsedRowHeight
  const expandedHeight = getExpandedDisplayRowHeight(entry.row.id, entry.row.hasValue)
  return rowStates[entry.row.id]?.expansion !== 'collapsed' && entry.row.hasValue
    ? expandedHeight
    : collapsedRowHeight
}

function getExpandedDisplayRowHeight(rowId: string, hasValue: boolean) {
  const baseHeight = rowStates[rowId]?.height ?? expandedRowHeight
  if (!hasValue) return baseHeight
  const displayedLanes = displayedRowLanesById.value.get(rowId) ?? []
  const hasRenderOverride = displayedLanes.some(lane => lane.kind !== 'absent' && !!lane.renderLane)
  return Math.max(baseHeight, hasRenderOverride ? expandedRowHeight * 2 : expandedRowHeight)
}

const visibleRowVirtualLayout = computed(() =>
  createVirtualLayout(
    visibleRowsWithEllipsis.value,
    (entry) => getVisibleEntryRowHeight(entry),
    rowGapPx,
  ),
)

const viewportVisibleRowIds = computed(() => {
  const viewportTop = Math.max(0, timelineScrollTop.value - verticalViewportBufferPx)
  const viewportBottom = timelineScrollTop.value + timelineViewportHeight.value + verticalViewportBufferPx
  const layout = visibleRowVirtualLayout.value
  const range = getVirtualRange(layout, viewportTop, viewportBottom)
  const ids = new Set<string>()
  if (!range) return ids
  for (let index = range.firstIndex; index <= range.lastIndex; index += 1) {
    const entry = layout.items[index]
    if (entry?.kind === 'row') {
      ids.add(entry.row.id)
    }
  }
  return ids
})

const virtualizedVisibleRows = computed(() => {
  const layout = visibleRowVirtualLayout.value
  if (!layout.items.length) {
    return {
      entries: [] as VisibleRow[],
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    }
  }

  if (!timelineViewportHeight.value) {
    return {
      entries: [...layout.items],
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    }
  }

  const viewportTop = Math.max(0, timelineScrollTop.value - verticalViewportBufferPx)
  const viewportBottom = timelineScrollTop.value + timelineViewportHeight.value + verticalViewportBufferPx
  return getVirtualWindow(layout, viewportTop, viewportBottom)
})

function shouldRenderRowLanes(rowId: string) {
  return !timelineViewportHeight.value || viewportVisibleRowIds.value.has(rowId) || highlightedRowId.value === rowId
}

const visibleKeyframeTimes = computed<number[]>(() => {
  const times = new Set<number>()
  for (const entry of visibleRowsWithEllipsis.value) {
    if (entry.kind !== 'row') continue
    for (const lane of getRawRowLanes(entry.row.id)) {
      if (lane.type !== 'keyframes') continue
      for (const keyframe of lane.keyframes) {
        if (Number.isFinite(keyframe.t)) times.add(keyframe.t)
      }
    }
  }
  return [...times].sort((a, b) => a - b)
})

function jumpKeyframe(direction: number) {
  const epsilon = Math.max(1e-6, 0.01 / Math.max(1, fps.value))
  const current = displayTime.value
  const keyframes = visibleKeyframeTimes.value
  const nextTime = direction < 0
    ? [...keyframes].reverse().find(time => time < current - epsilon)
    : keyframes.find(time => time > current + epsilon)
  if (nextTime === undefined) return
  seekToTime(nextTime)
}

function startResize(e: MouseEvent) {
  isResizing.value = true
  resizeStartX = e.clientX
  resizeStartWidth = labelWidthPx.value
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', stopResize)
}

function onResizeMove(e: MouseEvent) {
  if (!isResizing.value) return
  const next = resizeStartWidth + (e.clientX - resizeStartX)
  labelWidthPx.value = Math.max(140, Math.min(360, next))
}

function stopResize() {
  isResizing.value = false
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', stopResize)
  scheduleUiAutosave()
}

function toggleRowExpanded(rowId: string) {
  const state = rowStates[rowId]
  const row = rowById.value.get(rowId)
  if (!state || !row) return
  state.expansion = state.expansion === 'collapsed' ? 'expanded' : 'collapsed'
  if (!row.hasValue) return
  if (state.expansion !== 'collapsed' && state.height < expandedRowHeight) {
    state.height = expandedRowHeight
  }
  scheduleUiAutosave()
}

function startRowResize(e: MouseEvent, rowId: string) {
  const state = rowStates[rowId]
  if (!state) return
  resizingRowId = rowId
  rowResizeStartY = e.clientY
  rowResizeStartHeight = state.height
  window.addEventListener('mousemove', onRowResizeMove)
  window.addEventListener('mouseup', stopRowResize)
}

function onRowResizeMove(e: MouseEvent) {
  if (!resizingRowId) return
  const state = rowStates[resizingRowId]
  if (!state) return
  const nextHeight = rowResizeStartHeight + (e.clientY - rowResizeStartY)
  state.height = Math.max(48, Math.min(320, nextHeight))
}

function stopRowResize() {
  resizingRowId = null
  window.removeEventListener('mousemove', onRowResizeMove)
  window.removeEventListener('mouseup', stopRowResize)
  scheduleUiAutosave()
}

function expandParents(rowId: string) {
  let current = rowById.value.get(rowId)
  while (current?.parentId) {
    const parentState = rowStates[current.parentId]
    if (parentState) parentState.expansion = 'expanded'
    current = rowById.value.get(current.parentId)
  }
}

function focusRow(rowId: string) {
  const target = resolveRowId(rowId)
  if (!target || !rowStates[target]) {
    pendingFocusRowId.value = rowId
    return
  }
  expandParents(target)
  rowStates[target].expansion = 'expanded'
  highlightedRowId.value = target
  scrollRowIntoView(target)
  nextTick(() => {
    const el = document.querySelector(`[data-row-id="${target}"]`) as HTMLElement | null
    centerRowInView(el)
  })
}

function getRowScrollTop(rowId: string) {
  return findVirtualItemStart(
    visibleRowVirtualLayout.value,
    (entry) => entry.kind === 'row' && entry.row.id === rowId,
  )
}

function scrollRowIntoView(rowId: string) {
  const scrollEl = timelineScrollRef.value
  if (!scrollEl) return
  const rowTop = getRowScrollTop(rowId)
  if (rowTop === null) return
  const rowHeight = rowStates[rowId]?.expansion !== 'collapsed' && rowById.value.get(rowId)?.hasValue
    ? getExpandedDisplayRowHeight(rowId, true)
    : collapsedRowHeight
  const targetScrollTop = rowTop - (scrollEl.clientHeight - rowHeight) / 2
  const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight)
  scrollEl.scrollTop = Math.max(0, Math.min(maxScrollTop, targetScrollTop))
  updateTimelineViewportMetrics()
}

function centerRowInView(rowEl: HTMLElement | null) {
  const scrollEl = timelineScrollRef.value
  if (!scrollEl || !rowEl) return
  const rowTop = rowEl.offsetTop
  const targetScrollTop = rowTop - (scrollEl.clientHeight - rowEl.offsetHeight) / 2
  const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight)
  scrollEl.scrollTop = Math.max(0, Math.min(maxScrollTop, targetScrollTop))
}

function updateTimelineViewportMetrics() {
  const scrollEl = timelineScrollRef.value
  if (!scrollEl) {
    timelineScrollTop.value = 0
    timelineViewportHeight.value = 0
    return
  }
  timelineScrollTop.value = scrollEl.scrollTop
  timelineViewportHeight.value = scrollEl.clientHeight
}

function onTimelineScroll() {
  updateTimelineViewportMetrics()
  scheduleUiAutosave({ delayMs: 300, deferLocalStorage: true })
}

function resolveRowId(rowId: string) {
  if (rowStates[rowId]) return rowId
  for (const key of Object.keys(rowStates)) {
    if (key.endsWith(rowId)) return key
  }
  return null
}

function getRowPath(rowId: string) {
  return rowId.split('.').filter(Boolean)
}

function isControlEnabled(rowId: string) {
  return controlEnabled[rowId] ?? true
}

function canKeyframe(rowId: string) {
  const row = rowById.value.get(rowId)
  return !!row?.hasValue
}

function hasActiveKeyframeTarget(rowId: string) {
  return canKeyframe(rowId)
    && !!controlManualOverride[rowId]
}

function getBranchKeyframeRowIds(rowId: string) {
  return activeKeyframeTargetIds.value.filter(candidateRowId =>
    candidateRowId === rowId || candidateRowId.startsWith(`${rowId}.`)
  )
}

function getRecordableKeyframePayload(rowId: string): unknown {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return undefined

  const adapter = Timeline.getTimelineAdapter(spec)
  const payload = latestControlPayloads[rowId]
  if (payload !== undefined) {
    return adapter.capturePayload(payload)
  }

  const values = latestControlValues[rowId]
  if (!values) return undefined

  if (spec.type === Controls.Player3D.Spec.type) {
    const x = values.x
    const y = values.y
    const z = values.z
    const qx = values.qx
    const qy = values.qy
    const qz = values.qz
    const qw = values.qw
    if ([x, y, z, qx, qy, qz, qw].every(value => typeof value === 'number' && Number.isFinite(value))) {
      return {
        position: [x!, y!, z!],
        rotation: [qx!, qy!, qz!, qw!],
      }
    }
  }

  return adapter.capturePayload(values)
}

function getCurrentLaneValues(rowId: string) {
  const fromPayload = extractLaneValues(latestControlPayloads[rowId])
  const fromValues = latestControlValues[rowId] ?? {}
  if (!Object.keys(fromPayload).length && !Object.keys(fromValues).length) {
    return null
  }
  return {
    ...fromPayload,
    ...fromValues,
  }
}

function getBranchManualOverrideRowIds(rowId: string) {
  return Object.entries(controlManualOverride)
    .filter(([candidateRowId, manualOverride]) => {
      if (!manualOverride) return false
      if (!rowById.value.get(candidateRowId)?.hasValue) return false
      return candidateRowId === rowId || candidateRowId.startsWith(`${rowId}.`)
    })
    .map(([candidateRowId]) => candidateRowId)
}

function sendCurrentAutomationFrame() {
  if (!timelineClient.value) return
  timelineClient.value.applyAutomation(displayTime.value)
}

function activateControl(rowId: string, sendValue = true) {
  const row = rowById.value.get(rowId)
  if (!row || !row.hasValue) return false
  if (!(controlManualOverride[rowId] ?? false)) return false
  logTimelineManualOverride('activate-control', {
    path: rowId,
    previous: { enabled: controlEnabled[rowId] ?? true, manualOverride: controlManualOverride[rowId] ?? false },
    sendValue,
  })
  controlEnabled[rowId] = true
  controlManualOverride[rowId] = false
  timelineClient.value?.setControlEnabled(getRowPath(rowId), true)
  if (sendValue) {
    sendCurrentAutomationFrame()
  }
  return true
}

function enableAutomation(rowId: string) {
  const row = rowById.value.get(rowId)
  if (!row || !row.hasValue) return
  logTimelineManualOverride('enable-automation', {
    path: rowId,
    previous: { enabled: controlEnabled[rowId] ?? true, manualOverride: controlManualOverride[rowId] ?? false },
  })
  controlEnabled[rowId] = true
  controlManualOverride[rowId] = false
  timelineClient.value?.setControlEnabled(getRowPath(rowId), true)
}

function isCurveTrackRow(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return true
  return Timeline.getTimelineAdapter(spec).kind === 'curve'
}

function isStepTrackRow(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return false
  return Timeline.getTimelineAdapter(spec).kind === 'step'
}

function isTriggerTrackRow(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return false
  return Timeline.getTimelineAdapter(spec).kind === 'trigger'
}

function isKeyframeTrackRow(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return false
  return Timeline.getTimelineAdapter(spec).kind === 'keyframes'
}

function isEventTrackRow(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return false
  return Timeline.getTimelineAdapter(spec).kind === 'event'
}

function getKeyframeLaneKey(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return 'keyframes'
  if (spec.type === Controls.Player3D.Spec.type) return 'pose'
  if (spec.type === Controls.Dots.Spec.type) return 'dots'
  return 'keyframes'
}

function getControlLaneKeys(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return [] as string[]
  if (Timeline.getTimelineAdapter(spec).kind === 'keyframes') return [getKeyframeLaneKey(rowId)]
  if (spec.type === Controls.Pad.Spec.type) return ['value']
  if (spec.type === Controls.Joystick.Spec.type) return ['x', 'y']
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type) return ['on']
  if (spec.type === Controls.Selector.Spec.type) return ['index']
  return ['value']
}

function upsertLanePoint(points: Timeline.TimelinePoint[], time: number, value: number) {
  const next = [...points]
  const existingIndex = next.findIndex(point => (point.kind ?? 'pos') === 'pos' && Math.abs(point.t - time) < 1e-6)
  const point = { t: time, v: value, kind: 'pos' as const }
  if (existingIndex >= 0) {
    next[existingIndex] = point
  } else {
    next.push(point)
    next.sort((a, b) => a.t - b.t)
  }
  return next
}

function flattenTriggerPairs(triggers: Timeline.TimelineTrigger[]) {
  return triggers.flatMap(trigger => ([
    { t: trigger.on.t, v: trigger.on.value, kind: 'pos' as const },
    { t: trigger.off.t, v: -0.5, kind: 'pos' as const },
  ]))
}

function upsertTrigger(triggers: Timeline.TimelineTrigger[], time: number, value: number) {
  if (value < 0) return triggers
  const next = triggers.map(trigger => ({
    on: { ...trigger.on },
    off: { ...trigger.off },
  }))
  const existingIndex = next.findIndex(trigger => Math.abs(trigger.on.t - time) < 1e-6)
  const duration = Math.max(0.05, secondsPerWidth.value / 12)
  const trigger = {
    on: { t: time, value: Math.max(0, value) },
    off: { t: time + duration },
  }
  if (existingIndex >= 0) {
    next[existingIndex] = trigger
  } else {
    next.push(trigger)
    next.sort((a, b) => a.on.t - b.on.t)
  }
  return next
}

function snapStepValue(rowId: string, value: number) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return Math.round(value)
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type) {
    return value < 0 ? -0.5 : 0
  }
  if (spec.type === Controls.Pad.Spec.type) {
    return value < 0 ? -0.5 : Math.max(0, value)
  }
  if (spec.type === Controls.Selector.Spec.type) {
    const maxIndex = Math.max(0, (spec as Controls.Selector.Spec).options.length - 1)
    return Math.max(0, Math.min(maxIndex, Math.round(value)))
  }
  const range = getRowRange(rowId)
  return Math.max(Math.round(range.min), Math.min(Math.round(range.max), Math.round(value)))
}

function upsertKeyframe(keyframes: Timeline.TimelineKeyframe[], time: number, value: unknown) {
  const next = keyframes.map(keyframe => ({ ...keyframe }))
  const existingIndex = next.findIndex(keyframe => Math.abs(keyframe.t - time) < 1e-6)
  const keyframe = {
    t: time,
    value: cloneValue(value),
    leftSmooth: existingIndex >= 0 ? next[existingIndex]!.leftSmooth : 1,
    rightSmooth: existingIndex >= 0 ? next[existingIndex]!.rightSmooth : 1,
  }
  if (existingIndex >= 0) {
    next[existingIndex] = keyframe
  } else {
    next.push(keyframe)
  }
  return Timeline.sortTimelineKeyframes(next)
}

function recordManualOverrideKeyframe(rowId: string) {
  if (!timelineClient.value || !canKeyframe(rowId)) return false
  if (isKeyframeTrackRow(rowId)) {
    const payload = getRecordableKeyframePayload(rowId)
    if (payload === undefined) return false
    const laneKey = getKeyframeLaneKey(rowId)
    const currentLane = getRawRowLanes(rowId).find(candidate => candidate.key === laneKey)
    const nextKeyframes = upsertKeyframe(
      currentLane?.type === 'keyframes' ? currentLane.keyframes : [],
      displayTime.value,
      payload,
    )
    onLaneKeyframesUpdate(rowId, laneKey, nextKeyframes)
    enableAutomation(rowId)
    return true
  }

  const currentValues = getCurrentLaneValues(rowId)
  if (!currentValues) return false

  const path = getRowPath(rowId)
  const currentLanes = getRawRowLanes(rowId)
  let recorded = false

  for (const laneKey of getControlLaneKeys(rowId)) {
    const value = currentValues[laneKey]
    if (typeof value !== 'number' || Number.isNaN(value)) continue
    const lane = currentLanes.find(candidate => candidate.key === laneKey)
    const nextValue = isStepTrackRow(rowId) || isTriggerTrackRow(rowId) ? snapStepValue(rowId, value) : value
    if (isTriggerTrackRow(rowId)) {
      const nextTriggers = upsertTrigger(lane?.type === 'trigger' ? lane.triggers : [], displayTime.value, nextValue)
      if (lane?.type === 'trigger') {
        timelineClient.value.setLaneTriggers(path, laneKey, nextTriggers)
      } else {
        timelineClient.value.addLane(path, {
          type: 'trigger',
          key: laneKey,
          enabled: true,
          triggers: nextTriggers,
        })
      }
    } else {
      const nextPoints = upsertLanePoint(lane && lane.type !== 'keyframes' && lane.type !== 'trigger' ? lane.points : [], displayTime.value, nextValue)
      if (lane && lane.type !== 'keyframes') {
        timelineClient.value.setLanePoints(path, laneKey, nextPoints)
      } else {
        timelineClient.value.addLane(path, {
          type: isStepTrackRow(rowId) ? 'step' : 'curve',
          key: laneKey,
          enabled: true,
          points: nextPoints,
        })
      }
    }
    recorded = true
  }

  if (recorded) {
    enableAutomation(rowId)
  }
  return recorded
}

function recordAndSyncManualOverrideKeyframe(rowId: string) {
  const recorded = recordManualOverrideKeyframe(rowId)
  if (recorded) {
    sendCurrentAutomationFrame()
  }
  return recorded
}

function recordBranchManualOverrideKeyframes(rowId: string) {
  const targetRowIds = [...getBranchKeyframeRowIds(rowId)]
  let recorded = false
  for (const targetRowId of targetRowIds) {
    recorded = recordManualOverrideKeyframe(targetRowId) || recorded
  }
  if (recorded) {
    sendCurrentAutomationFrame()
  }
  return recorded
}

const allManualOverrideRowIds = computed(() => {
  return Object.entries(controlManualOverride)
    .filter(([rowId, manualOverride]) => manualOverride && rowById.value.get(rowId)?.hasValue)
    .map(([rowId]) => rowId)
})

const allManualOverrideCount = computed(() => allManualOverrideRowIds.value.length)

const topLevelRowIds = computed(() => rows.value.filter((row) => row.depth === 0).map((row) => row.id))

function resetAllManualOverrideLanes() {
  let changed = false
  for (const rowId of topLevelRowIds.value) {
    if (rowById.value.get(rowId)?.isContainer) {
      for (const childRowId of getBranchManualOverrideRowIds(rowId)) {
        changed = activateControl(childRowId, false) || changed
      }
    } else if (controlManualOverride[rowId]) {
      changed = activateControl(rowId, false) || changed
    }
  }
  if (changed) {
    sendCurrentAutomationFrame()
  }
}

function recordAllManualOverrideKeyframes() {
  let recorded = false
  for (const rowId of topLevelRowIds.value) {
    if (rowById.value.get(rowId)?.isContainer) {
      recorded = recordBranchManualOverrideKeyframes(rowId) || recorded
    } else if (controlManualOverride[rowId]) {
      recorded = recordManualOverrideKeyframe(rowId) || recorded
    }
  }
  if (recorded) {
    sendCurrentAutomationFrame()
  }
}

onBeforeUnmount(() => {
  renderCancelRequested.value = true
  if (pendingRenderAck) {
    pendingRenderAck.reject(new Error('Render cancelled'))
    pendingRenderAck = null
  }
  if (pendingCaptureAck) {
    pendingCaptureAck.reject(new Error('Render cancelled'))
    pendingCaptureAck = null
  }
  if (uiSaveTimer !== null) {
    window.clearTimeout(uiSaveTimer)
    uiSaveTimer = null
  }
  stopResize()
  stopRowResize()
  stopPlaybackAutomationTimer()
  if (rafId) cancelAnimationFrame(rafId)
  laneResizeObserver?.disconnect()
  stopStatePolling()
  disconnectSession()
  audioElement?.pause()
  clearAudioObjectUrl()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', stopResize)
  window.removeEventListener('mousemove', onRowResizeMove)
  window.removeEventListener('mouseup', stopRowResize)
  window.removeEventListener('pointermove', onPanMove)
  window.removeEventListener('pointerup', onPanEnd)
  window.removeEventListener('pointermove', onScrubPointerMove)
  window.removeEventListener('pointerup', onScrubPointerUp)
  window.removeEventListener('pointercancel', onScrubPointerUp)
})

function startStatePolling() {
  stopStatePolling()
  requestStateTimer = window.setInterval(() => {
    if (!timelineClient.value || !rootSpec.value || rendering.value) return
    timelineClient.value.requestState()
  }, 2000)
}

function stopStatePolling() {
  if (requestStateTimer !== null) {
    clearInterval(requestStateTimer)
    requestStateTimer = null
  }
}

function startPlaybackAutomationTimer() {
  stopPlaybackAutomationTimer()
  const intervalMs = 1000 / Math.max(1, fps.value)
  playbackAutomationTimer = window.setInterval(() => {
    rafNow.value = performance.now()
    if (playing.value && timelineClient.value && !rendering.value) {
      const time = displayTime.value
      timelineClient.value.applyAutomation(time)
      artworkClient.value?.setTime(time)
    }
  }, intervalMs)
}

function stopPlaybackAutomationTimer() {
  if (playbackAutomationTimer !== null) {
    window.clearInterval(playbackAutomationTimer)
    playbackAutomationTimer = null
  }
}

watch(fps, () => {
  startPlaybackAutomationTimer()
})

function tickRaf() {
  if (!rendering.value) {
    rafNow.value = performance.now()
    
    if (playing.value && loopEnabled.value) {
      const min = Math.min(loopFromSec.value, loopDurationSec.value)
      const max = Math.max(loopFromSec.value, loopDurationSec.value)
      if (max > min) {
        const delta = (rafNow.value - lastStateAt.value) / 1000
        const time = Math.max(0, lastStateTime.value + delta)
        if (time >= max) {
          const loopLength = max - min
          const overshoot = (time - max) % loopLength
          const wrappedTime = min + overshoot
          
          lastStateTime.value = wrappedTime
          lastStateAt.value = rafNow.value
          timelineTime.value = wrappedTime
          
          // Send explicit time update for wrap
          artworkClient.value?.setTime(wrappedTime)
          timelineClient.value?.applyAutomation(wrappedTime)
        }
      }
    }
    
    updatePlaybackUi(false)
  }
  rafId = requestAnimationFrame(tickRaf)
}

function updateLaneWidth() {
  const scrubRect = scrubAreaRef.value?.getBoundingClientRect()
  if (scrubRect) {
    laneWidthPx.value = Math.max(0, scrubRect.width)
    return
  }
  const header = laneHeaderRef.value
  if (!header) {
    laneWidthPx.value = 0
    return
  }
  const headerRect = header.getBoundingClientRect()
  const paddingLeft = Number.parseFloat(window.getComputedStyle(header).paddingLeft || '0') || 0
  const paddingRight = Number.parseFloat(window.getComputedStyle(header).paddingRight || '0') || 0
  laneWidthPx.value = Math.max(0, headerRect.width - paddingLeft - paddingRight)
}

function setLaneHeaderElement(element: Element | null) {
  laneHeaderRef.value = element as HTMLElement | null
}

function setScrubAreaElement(element: Element | null) {
  scrubAreaRef.value = element as HTMLElement | null
}

function setTimelineCursorElement(element: Element | null) {
  timelineCursorRef.value = element as HTMLElement | null
}

function setTimelineScrollElement(element: Element | null) {
  timelineScrollRef.value = element as HTMLElement | null
}

function restoreScrollTopDeferred(scrollTop: number) {
  pendingScrollTop = scrollTop
  nextTick(() => {
    requestAnimationFrame(() => {
      if (!timelineScrollRef.value || pendingScrollTop === null) return
      timelineScrollRef.value.scrollTop = pendingScrollTop
      updateTimelineViewportMetrics()
      pendingScrollTop = null
    })
  })
}

const displayTime = computed(() => {
  if (!playing.value || rendering.value) return lastStateTime.value
  const delta = (rafNow.value - lastStateAt.value) / 1000
  let time = Math.max(0, lastStateTime.value + delta)
  
  if (loopEnabled.value) {
    const min = Math.min(loopFromSec.value, loopDurationSec.value)
    const max = Math.max(loopFromSec.value, loopDurationSec.value)
    if (max > min && time >= max) {
      const loopLength = max - min
      time = min + ((time - max) % loopLength)
    }
  }
  
  return time
})

function updatePlaybackUi(forceFooter = false) {
  const time = displayTime.value
  const cursor = timelineCursorRef.value
  if (cursor && laneWidthPx.value > 0) {
    const x = timeToX(time)
    cursor.style.display = x >= 0 && x <= laneWidthPx.value ? '' : 'none'
    cursor.style.transform = `translateX(${x}px)`
  } else if (cursor) {
    cursor.style.display = 'none'
  }
}

const audioSnapEnabled = computed(() => !!audioTrack.value?.snapEnabled)
const audioMarkers = computed(() => audioTrack.value?.markers ?? [])
const audioExpanded = computed(() => audioTrack.value?.expanded ?? true)
const audioFileName = computed(() => audioTrack.value?.fileName || null)

watch([displayTime, playing, rendering, audioObjectUrl], () => {
  syncTimelineAudio()
})

watch([lastStateTime, playing, laneWidthPx, timeOffset, secondsPerWidth], () => {
  updatePlaybackUi(true)
}, { immediate: true })

const loopRangeStyle = computed(() => {
  if (!loopEnabled.value || !laneWidthPx.value) return null
  const start = Math.max(0, loopFromSec.value)
  const end = Math.max(start, loopDurationSec.value)
  const rawLeft = timeToX(start)
  const rawRight = timeToX(end)
  if (rawRight <= 0 || rawLeft >= laneWidthPx.value) return null
  const left = Math.max(0, Math.min(laneWidthPx.value, rawLeft))
  const right = Math.max(0, Math.min(laneWidthPx.value, rawRight))
  return {
    left: `${left}px`,
    width: `${Math.max(0, right - left)}px`,
  }
})

const visibleAudioMarkerXs = computed(() => {
  if (!laneWidthPx.value) return [] as Array<{ time: number; x: number; highlighted: boolean }>
  return audioMarkers.value
    .map(time => ({ time, x: timeToX(time), highlighted: highlightedAudioMarkerTime.value === time }))
    .filter(marker => marker.x >= 0 && marker.x <= laneWidthPx.value)
})

const laneViewWidth = computed(() => Math.max(1, laneWidthPx.value))

function chooseTimeMarkerStep(secondsPerWidthValue: number, widthPx: number) {
  const safeWidth = Math.max(1, widthPx)
  const targetPxPerMarker = 96
  const targetSeconds = (secondsPerWidthValue / safeWidth) * targetPxPerMarker
  const steps = [
    0.05, 0.1, 0.2, 0.5,
    1, 2, 5, 10, 15, 30,
    60, 120, 300, 600, 900, 1800, 3600,
  ]
  for (const step of steps) {
    if (step >= targetSeconds) return step
  }
  return steps[steps.length - 1]!
}

function formatMarkerTime(time: number, step: number) {
  if (step < 1) {
    const decimals = step < 0.1 ? 2 : 1
    return `${time.toFixed(decimals)}s`
  }

  const totalSeconds = Math.max(0, Math.round(time))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const headerTimeMarkers = computed(() => {
  const width = laneWidthPx.value
  if (!width || width <= 0) return [] as { time: number; x: number; label: string }[]

  const start = Math.max(0, timeOffset.value)
  const end = Math.max(start, timeOffset.value + secondsPerWidth.value)
  const step = chooseTimeMarkerStep(secondsPerWidth.value, width)
  const first = Math.ceil(start / step) * step
  const markers: { time: number; x: number; label: string }[] = []

  for (let t = first; t <= end + step * 0.5; t += step) {
    const x = timeToX(t)
    if (x < 0 || x > width) continue
    markers.push({ time: t, x, label: formatMarkerTime(t, step) })
  }

  return markers
})

const bodyTimeMarkers = computed(() => {
  return headerTimeMarkers.value.map(marker => ({ time: marker.time, x: marker.x }))
})

// Compute the rightmost point time across all lanes
const rightmostTime = computed(() => {
  let maxT = 0
  const controls = timelineState.value?.controls ?? []
  for (const control of controls) {
    for (const lane of control.lanes) {
      if (lane.type === 'keyframes') {
        for (const keyframe of lane.keyframes) {
          if (keyframe.t > maxT) maxT = keyframe.t
        }
      } else if (lane.type === 'trigger') {
        for (const trigger of lane.triggers) {
          if (trigger.off.t > maxT) maxT = trigger.off.t
        }
      } else {
        for (const point of lane.points) {
          if (point.t > maxT) maxT = point.t
        }
      }
    }
  }
  return maxT
})

// Constrain pan so center of view stays within bounds
function constrainPan(offset: number, spw: number) {
  const centerTime = offset + spw / 2
  const minCenter = 0
  const maxCenter = Math.max(displayTime.value, rightmostTime.value, spw / 2)
  const constrainedCenter = Math.max(minCenter, Math.min(maxCenter, centerTime))
  return constrainedCenter - spw / 2
}

function getLanePlaneMetrics() {
  const scrubRect = scrubAreaRef.value?.getBoundingClientRect()
  if (scrubRect && laneWidthPx.value > 0) {
    return { left: scrubRect.left, width: laneWidthPx.value }
  }
  const header = laneHeaderRef.value
  if (!header || !laneWidthPx.value) return null
  const headerRect = header.getBoundingClientRect()
  const paddingLeft = Number.parseFloat(window.getComputedStyle(header).paddingLeft || '0') || 0
  return { left: headerRect.left + paddingLeft, width: laneWidthPx.value }
}

function onLaneWheel(e: WheelEvent) {
  const lanePlane = getLanePlaneMetrics()
  if (!lanePlane) return

  if (e.ctrlKey || e.metaKey) {
    // With Ctrl/Cmd: zoom with both horizontal and vertical scroll
    e.preventDefault()

    const mouseX = Math.max(0, Math.min(lanePlane.width, e.clientX - lanePlane.left))

    // Combine deltaY and deltaX for zooming
    // deltaY > 0 (scroll down) = zoom out
    // deltaY < 0 (scroll up) = zoom in
    // deltaX > 0 (scroll right) = zoom in
    // deltaX < 0 (scroll left) = zoom out
    const zoomDelta = e.deltaY + e.deltaX
    const zoomSensitivity = 0.35
    const zoomFactor = Math.pow(1.01, zoomDelta * zoomSensitivity)
    const newSecondsPerWidth = Math.max(0.5, Math.min(600, secondsPerWidth.value * zoomFactor))

    // Adjust offset so mouseTime stays at the same screen position
    const mouseTime = xToTime(mouseX)
    const newOffset = mouseTime - (mouseX / lanePlane.width) * newSecondsPerWidth

    secondsPerWidth.value = newSecondsPerWidth
    timeOffset.value = constrainPan(newOffset, newSecondsPerWidth)
  } else if (e.deltaX !== 0) {
    // Without Ctrl/Cmd: horizontal scroll pans left/right
    e.preventDefault()

    const deltaTime = (e.deltaX / laneWidthPx.value) * secondsPerWidth.value * 0.5
    timeOffset.value = constrainPan(timeOffset.value + deltaTime, secondsPerWidth.value)
  }
}

function onLanePointerDown(e: PointerEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()

  isPanning = true
  panStartX = e.clientX
  panStartOffset = timeOffset.value

  window.addEventListener('pointermove', onPanMove)
  window.addEventListener('pointerup', onPanEnd)
}

function onPanMove(e: PointerEvent) {
  if (!isPanning || !laneWidthPx.value) return

  const deltaX = e.clientX - panStartX
  const deltaTime = (deltaX / laneWidthPx.value) * secondsPerWidth.value
  timeOffset.value = constrainPan(panStartOffset - deltaTime, secondsPerWidth.value)
}

function onPanEnd() {
  isPanning = false
  window.removeEventListener('pointermove', onPanMove)
  window.removeEventListener('pointerup', onPanEnd)
}

function togglePinned(rowId: string) {
  const rowState = rowStates[rowId]
  if (!rowState) return
  rowState.pinned = !rowState.pinned
  scheduleUiAutosave()
}

function expandParentRow(parentId: string | null) {
  if (!parentId) return
  const rowState = rowStates[parentId]
  if (!rowState) return
  rowState.expansion = 'expanded'
  scheduleUiAutosave()
}

// Scrubbing state
const scrubAreaRef = ref<HTMLElement | null>(null)
let isScrubbing = false
let scrubRestoreState: Artwork.ArtworkClientStatus['mode'] = 'paused'
let scrubWasPlaying = false
let lastScrubRenderAt = 0
let scrubRenderInProgress = false
let nextScrubRenderTime: number | null = null

function seekToX(clientX: number) {
  const lanePlane = getLanePlaneMetrics()
  if (!lanePlane) return
  const x = Math.max(0, Math.min(lanePlane.width, clientX - lanePlane.left))
  const time = Math.max(0, xToTime(x))

  if (timelinePointerLog) {
    console.info('[timeline:pointer]', {
      clientX,
      laneLeft: lanePlane.left,
      laneWidth: lanePlane.width,
      x,
      time,
      timeOffset: timeOffset.value,
      secondsPerWidth: secondsPerWidth.value,
    })
  }

  timelineTime.value = time
  lastStateTime.value = time
  lastStateAt.value = performance.now()
  applyAutomationAt(time, { useRenderLanes: renderLiveEnabled.value, bypassBackpressure: true })
  
  if (renderLiveEnabled.value && artworkClient.value) {
    if (renderLoopRunning.value) {
      return
    }
    
    if (scrubRenderInProgress) {
      nextScrubRenderTime = time
      return
    }

    const dispatchRender = async (renderTime: number) => {
      if (!artworkClient.value) return
      scrubRenderInProgress = true
      lastScrubRenderAt = performance.now()
      
      try {
        artworkClient.value.render(renderTime)
        await waitForRenderAck(renderTime)
      } catch (e) {
        console.warn('[timeline:scrub] render failed', e)
      } finally {
        scrubRenderInProgress = false
        if (nextScrubRenderTime !== null) {
          const nextTime = nextScrubRenderTime
          nextScrubRenderTime = null
          void dispatchRender(nextTime)
        }
      }
    }

    void dispatchRender(time)
  } else {
    artworkClient.value?.setTime(time)
  }
}

function onScrubPointerDown(e: PointerEvent) {
  // Don't scrub if ctrl/cmd held (that's for pan/zoom)
  if (e.ctrlKey || e.metaKey) return

  if (e.shiftKey) {
    const lanePlane = getLanePlaneMetrics()
    if (!lanePlane) return
    const x = Math.max(0, Math.min(lanePlane.width, e.clientX - lanePlane.left))
    const clickedTime = Math.max(0, xToTime(x))
    
    const current = displayTime.value
    const newFrom = Math.min(current, clickedTime)
    const newTo = Math.max(current, clickedTime)
    
    updateLoopFrom(newFrom)
    updateLoopTo(newTo)
    if (!loopEnabled.value) {
      toggleLoop()
    }
    return
  }

  scrubWasPlaying = playing.value
  scrubRestoreState = artworkMode.value
  pendingPlaybackIntent.value = null
  timelineClient.value?.setState('scrubbing')
  artworkClient.value?.setMode('paused')
  isScrubbing = true
  seekToX(e.clientX)

  window.addEventListener('pointermove', onScrubPointerMove)
  window.addEventListener('pointerup', onScrubPointerUp)
  window.addEventListener('pointercancel', onScrubPointerUp)
}

function onScrubPointerMove(e: PointerEvent) {
  if (!isScrubbing) return
  seekToX(e.clientX)
}

function onScrubPointerUp() {
  isScrubbing = false
  pendingPlaybackIntent.value = null
  playing.value = scrubWasPlaying
  timelineClient.value?.setPlaying(scrubWasPlaying)
  artworkClient.value?.setMode(scrubRestoreState)
  window.removeEventListener('pointermove', onScrubPointerMove)
  window.removeEventListener('pointerup', onScrubPointerUp)
  window.removeEventListener('pointercancel', onScrubPointerUp)
}

function resetView() {
  secondsPerWidth.value = 10
  timeOffset.value = 0
}

function getLaneActionId(rowId: string, laneKey: string) {
  return `${rowId}:${laneKey}`
}

function clearLaneConfirm(rowId: string, laneKey: string) {
  delete laneClearConfirm[getLaneActionId(rowId, laneKey)]
}

function ensureControlState(state: Timeline.TimelineState | null, rowId: string) {
  if (!state) return null
  let control = state.controls.find(candidate => candidate.path.join('.') === rowId)
  if (control) return control
  control = {
    path: getRowPath(rowId),
    enabled: controlEnabled[rowId] ?? true,
    manualOverride: controlManualOverride[rowId] ?? false,
    lanes: [],
  }
  state.controls.push(control)
  return control
}

function addLaneInState(state: Timeline.TimelineState | null, rowId: string, lane: Timeline.TimelineLane) {
  const control = ensureControlState(state, rowId)
  if (!control) return
  const existing = control.lanes.find(candidate => candidate.key === lane.key)
  if (existing) return
  control.lanes.push(lane)
}

function clearLaneInState(state: Timeline.TimelineState | null, rowId: string, laneKey: string, laneKind: RenderLane['kind']) {
  if (!state) return
  const control = state.controls.find(candidate => candidate.path.join('.') === rowId)
  if (!control) return
  control.lanes = control.lanes.filter(candidate => {
    if (candidate.key !== laneKey) return true
    if (laneKind === 'keyframes' && candidate.type === 'keyframes') return false
    if (laneKind === 'trigger' && candidate.type === 'trigger') return false
    if (laneKind === 'step' && candidate.type === 'step') return false
    if (laneKind === 'event' && candidate.type === 'event') return false
    if (laneKind === 'curve' && candidate.type !== 'keyframes' && candidate.type !== 'trigger' && candidate.type !== 'step' && candidate.type !== 'event') return false
    return true
  })
}

function updateLaneInState(
  state: Timeline.TimelineState | null,
  rowId: string,
  laneKey: string,
  laneKind: RenderLane['kind'],
  payload: Timeline.TimelinePoint[] | Timeline.TimelineTrigger[] | Timeline.TimelineKeyframe[] | Timeline.TimelineEventPoint[],
) {
  if (!state) return
  const control = state.controls.find(candidate => candidate.path.join('.') === rowId)
  if (!control) return
  const lane = control.lanes.find(candidate => candidate.key === laneKey)
  if (!lane) return

  if (laneKind === 'keyframes' && lane.type === 'keyframes') {
    lane.keyframes = payload as Timeline.TimelineKeyframe[]
    return
  }
  if (laneKind === 'trigger' && lane.type === 'trigger') {
    lane.triggers = payload as Timeline.TimelineTrigger[]
    return
  }
  if (laneKind === 'event' && lane.type === 'event') {
    lane.events = payload as Timeline.TimelineEventPoint[]
    return
  }
  if (lane.type !== 'keyframes' && lane.type !== 'trigger' && lane.type !== 'event') {
    lane.points = payload as Timeline.TimelinePoint[]
  }
}

function onClearLaneClick(rowId: string, lane: RenderLane) {
  const actionId = getLaneActionId(rowId, lane.key)
  if (!laneClearConfirm[actionId]) {
    laneClearConfirm[actionId] = true
    return
  }

  clearLaneConfirm(rowId, lane.key)
  clearLaneInState(timelineStateRaw.value, rowId, lane.key, lane.kind)
  clearLaneInState(timelineState.value, rowId, lane.key, lane.kind)
  if (!timelineClient.value) return
  const storedLane = getStoredEditableLane(rowId, lane.key, lane.kind)
  timelineClient.value.removeLane(getRowPath(rowId), storedLane?.key ?? lane.key)
  if (lane.kind === 'keyframes') {
    return
  }
  if (lane.kind === 'trigger') {
    return
  }
}

function onClearRenderLaneClick(rowId: string, laneKey: string) {
  const actionId = getLaneActionId(rowId, `${laneKey}__render`)
  if (!laneClearConfirm[actionId]) {
    laneClearConfirm[actionId] = true
    return
  }

  clearLaneConfirm(rowId, `${laneKey}__render`)
  const storedLane = getStoredEditableLane(rowId, laneKey)
  if (!storedLane || !timelineClient.value) return
  if (storedLane.type === 'keyframes') {
    timelineClient.value.setRenderLaneKeyframes(getRowPath(rowId), laneKey, [])
    return
  }
  if (storedLane.type === 'trigger') {
    timelineClient.value.setRenderLaneTriggers(getRowPath(rowId), laneKey, [])
    return
  }
  if (storedLane.type === 'event') {
    timelineClient.value.setRenderLaneEvents(getRowPath(rowId), laneKey, [])
    return
  }
  timelineClient.value.setRenderLanePoints(getRowPath(rowId), laneKey, [])
}

function laneHasData(lane: RenderLane) {
  if (lane.kind === 'absent') return false
  if (lane.kind === 'keyframes') return lane.lane.keyframes.length > 0
  if (lane.kind === 'trigger') return lane.lane.triggers.length > 0
  if (lane.kind === 'event') return lane.lane.events.length > 0
  return lane.lane.points.length > 0
}

function laneHasAutomation(lane: Timeline.TimelineLane) {
  if (lane.type === 'keyframes') return lane.keyframes.length > 0 || (lane.renderKeyframes?.length ?? 0) > 0
  if (lane.type === 'trigger') return lane.triggers.length > 0 || (lane.renderTriggers?.length ?? 0) > 0
  if (lane.type === 'event') return lane.events.length > 0 || (lane.renderEvents?.length ?? 0) > 0
  if (lane.type === 'step') return lane.points.length > 0 || (lane.renderPoints?.length ?? 0) > 0
  return lane.points.length > 0 || (lane.renderPoints?.length ?? 0) > 0
}

function createLane(rowId: string, lane: RenderAbsentLane) {
  if (!timelineClient.value) return
  const newLane: Timeline.TimelineLane =
    lane.laneKind === 'keyframes'
      ? { type: 'keyframes', key: lane.key, enabled: true, keyframes: [] }
      : lane.laneKind === 'trigger'
      ? { type: 'trigger', key: lane.key, enabled: true, triggers: [] }
      : lane.laneKind === 'event'
      ? { type: 'event', key: lane.key, enabled: true, events: [] }
      : lane.laneKind === 'step'
      ? { type: 'step', key: lane.key, enabled: true, points: [] }
      : { type: 'curve', key: lane.key, enabled: true, points: [] }

  addLaneInState(timelineStateRaw.value, rowId, newLane)
  addLaneInState(timelineState.value, rowId, normalizeLaneForRow(rowId, newLane))
  timelineClient.value.addLane(getRowPath(rowId), newLane)
}

function getInitialLaneValue(rowId: string, laneKey: string) {
  const currentValues = getCurrentLaneValues(rowId)
  const value = currentValues?.[laneKey]
  if (typeof value === 'number' && !Number.isNaN(value)) return value
  const range = getRowRange(rowId)
  return (range.min + range.max) / 2
}

function createLaneFromButton(rowId: string, lane: RenderAbsentLane) {
  if (!timelineClient.value) return
  if (lane.laneKind === 'keyframes') {
    if (recordManualOverrideKeyframe(rowId)) {
      return
    }
    createLane(rowId, lane)
    return
  }

  const time = displayTime.value
  
  if (lane.laneKind === 'event') {
    onLaneEventsUpdate(rowId, lane.key, [{ t: time }])
    return
  }
  
  if (lane.laneKind === 'trigger') {
    const nextValue = Math.max(0, getInitialLaneValue(rowId, lane.key))
    const duration = Math.max(0.05, secondsPerWidth.value / 12)
    onLaneTriggersUpdate(rowId, lane.key, [{
      on: { t: time, value: nextValue },
      off: { t: time + duration },
    }])
    return
  }

  const baseValue = getInitialLaneValue(rowId, lane.key)
  const nextValue = lane.laneKind === 'step' ? snapStepValue(rowId, baseValue) : baseValue
  onLanePointsUpdate(rowId, lane.key, [{
    t: time,
    v: nextValue,
    kind: 'pos',
  }])
}

function timeToX(time: number) {
  if (!laneWidthPx.value) return 0
  return ((time - timeOffset.value) / secondsPerWidth.value) * laneWidthPx.value
}

function xToTime(x: number) {
  if (!laneWidthPx.value) return 0
  return (x / laneWidthPx.value) * secondsPerWidth.value + timeOffset.value
}

const rawRowLanesById = computed(() => {
  const byRowId = new Map<string, Timeline.TimelineLane[]>()
  for (const control of timelineState.value?.controls ?? []) {
    byRowId.set(
      control.path.join('.'),
      control.lanes.map(lane => normalizeLaneForRow(control.path.join('.'), lane)),
    )
  }
  return byRowId
})

function getRawRowLanes(rowId: string) {
  return rawRowLanesById.value.get(rowId) ?? []
}

const storedRowLanesById = computed(() => {
  const byRowId = new Map<string, Timeline.TimelineLane[]>()
  for (const control of timelineStateRaw.value?.controls ?? []) {
    byRowId.set(control.path.join('.'), control.lanes)
  }
  return byRowId
})

const rowHasDirectAutomationById = computed(() => {
  const byRowId = new Map<string, boolean>()
  for (const row of rows.value) {
    byRowId.set(row.id, getRawRowLanes(row.id).some(laneHasAutomation))
  }
  return byRowId
})

const activeKeyframeTargetIds = computed(() => {
  const ids: string[] = []
  for (const row of rows.value) {
    if (row.isContainer || !row.hasValue) continue
    if (hasActiveKeyframeTarget(row.id)) {
      ids.push(row.id)
    }
  }
  return ids
})

const branchActiveKeyframeCountById = computed(() => {
  const byRowId = new Map<string, number>()
  for (const row of rows.value) {
    byRowId.set(row.id, 0)
  }
  for (const targetId of activeKeyframeTargetIds.value) {
    let currentRowId: string | null = targetId
    while (currentRowId) {
      byRowId.set(currentRowId, (byRowId.get(currentRowId) ?? 0) + 1)
      currentRowId = rowById.value.get(currentRowId)?.parentId ?? null
    }
  }
  return byRowId
})

const rowLanesById = computed(() => {
  const byRowId = new Map<string, RenderLane[]>()
  for (const row of rows.value) {
    const rowId = row.id
    const rawLanes = getRawRowLanes(rowId)
    const rawByKey = new Map(rawLanes.map(lane => [lane.key, lane]))
    const renderOverrideKeys = new Set(
      rawLanes
        .filter(lane =>
          (lane.type === 'keyframes' && lane.renderKeyframes !== undefined)
          || (lane.type === 'trigger' && lane.renderTriggers !== undefined)
          || ((lane.type === 'step' || lane.type === 'curve' || lane.type === undefined) && lane.renderPoints !== undefined),
        )
        .map(lane => lane.key),
    )
    const lanes = getControlLaneKeys(rowId).map((laneKey) => {
      const rawLane = rawByKey.get(laneKey)
      if (rawLane) {
        if (rawLane.type === 'keyframes') {
          return {
            kind: 'keyframes',
            key: rawLane.key,
            title: rawLane.key,
            lane: rawLane,
            renderLane: renderOverrideKeys.has(rawLane.key) ? getKeyframeRenderLane(rawLane) : null,
          } satisfies RenderKeyframeLane
        }
        if (rawLane.type === 'event') {
          return {
            kind: 'event',
            key: rawLane.key,
            title: rawLane.key,
            lane: rawLane,
            renderLane: renderOverrideKeys.has(rawLane.key) ? getEventRenderLane(rawLane) : null,
          } satisfies RenderEventLane
        }
        if (rawLane.type === 'step') {
          return {
            kind: 'step',
            key: rawLane.key,
            title: rawLane.key,
            lane: rawLane,
            range: getStepLaneDisplayRange(rowId, rawLane),
            renderLane: renderOverrideKeys.has(rawLane.key) ? getStepRenderLane(rawLane) : null,
          } satisfies RenderStepLane
        }
        if (rawLane.type === 'trigger') {
          return {
            kind: 'trigger',
            key: rawLane.key,
            title: rawLane.key,
            lane: rawLane,
            range: getStepLaneDisplayRange(rowId, rawLane),
            renderLane: renderOverrideKeys.has(rawLane.key) ? getTriggerRenderLane(rawLane) : null,
          } satisfies RenderTriggerLane
        }
        return {
          kind: 'curve',
          key: rawLane.key,
          title: rawLane.key,
          lane: rawLane,
          range: getRowRange(rowId, rawLane),
          renderLane: renderOverrideKeys.has(rawLane.key) ? getCurveRenderLane(rawLane) : null,
        } satisfies RenderCurveLane
      }
      return {
        kind: 'absent',
        key: laneKey,
        title: laneKey,
        laneKind: isKeyframeTrackRow(rowId)
          ? 'keyframes'
          : isEventTrackRow(rowId)
          ? 'event'
          : isTriggerTrackRow(rowId)
          ? 'trigger'
          : isStepTrackRow(rowId)
          ? 'step'
          : 'curve',
        } satisfies RenderAbsentLane    })
    byRowId.set(rowId, lanes)
  }
  return byRowId
})

const displayedRowLanesById = computed(() => {
  const byRowId = new Map<string, RenderLane[]>()
  for (const row of rows.value) {
    const rowId = row.id
    const lanes = rowLanesById.value.get(rowId) ?? []
    byRowId.set(
      rowId,
      isRowCollapsed(rowId)
        ? lanes.filter(lane => lane.kind !== 'absent' && laneHasData(lane)).slice(0, 4)
        : lanes,
    )
  }
  return byRowId
})

const branchManualOverrideCountById = computed(() => {
  const byRowId = new Map<string, number>()
  for (const row of rows.value) {
    byRowId.set(row.id, 0)
  }
  for (const [rowId, manualOverride] of Object.entries(controlManualOverride)) {
    if (!manualOverride) continue
    if (!rowById.value.get(rowId)?.hasValue) continue
    let currentRowId: string | null = rowId
    while (currentRowId) {
      byRowId.set(currentRowId, (byRowId.get(currentRowId) ?? 0) + 1)
      currentRowId = rowById.value.get(currentRowId)?.parentId ?? null
    }
  }
  return byRowId
})

const branchKeyframeableById = computed(() => {
  const byRowId = new Map<string, boolean>()
  for (const row of rows.value) {
    byRowId.set(row.id, (branchActiveKeyframeCountById.value.get(row.id) ?? 0) > 0)
  }
  return byRowId
})

const collapsedLaneHeightById = computed(() => {
  const byRowId = new Map<string, number>()
  for (const row of rows.value) {
    const count = Math.max(1, (displayedRowLanesById.value.get(row.id) ?? []).length)
    byRowId.set(row.id, Math.max(4, (collapsedRowHeight - 2 * Math.max(0, count - 1)) / count))
  }
  return byRowId
})

const rowDisplayById = computed(() => {
  const byRowId = new Map<string, {
    collapsed: boolean
    height: number
    rowStyle: { height: string } | undefined
    pinned: boolean
    manualOverride: boolean
    branchManualOverrideCount: number
    canBranchKeyframe: boolean
    displayedLanes: RenderLane[]
    collapsedLaneHeight: number
    collapsedGroupLineCount: number
  }>()

  for (const row of rows.value) {
    const state = rowStates[row.id]
    const collapsed = state?.expansion === 'collapsed'
    const height = collapsed || !row.hasValue
      ? state?.height ?? expandedRowHeight
      : getExpandedDisplayRowHeight(row.id, row.hasValue)
    byRowId.set(row.id, {
      collapsed,
      height,
      rowStyle: !collapsed && row.hasValue ? { height: `${height}px` } : undefined,
      pinned: state?.pinned ?? false,
      manualOverride: !!controlManualOverride[row.id],
      branchManualOverrideCount: branchManualOverrideCountById.value.get(row.id) ?? 0,
      canBranchKeyframe: branchKeyframeableById.value.get(row.id) ?? false,
      displayedLanes: displayedRowLanesById.value.get(row.id) ?? [],
      collapsedLaneHeight: collapsedLaneHeightById.value.get(row.id) ?? collapsedRowHeight,
      collapsedGroupLineCount: collapsedGroupLineCountById.value.get(row.id) ?? 0,
    })
  }

  return byRowId
})

const collapsedGroupLineCountById = computed(() => {
  const byRowId = new Map<string, number>()
  for (const row of rows.value) {
    if (!row.isContainer) continue
    let count = 0
    for (const candidate of rows.value) {
      if (candidate.parentId !== row.id) continue
      if (!rowHasDirectAutomationById.value.get(candidate.id)) continue
      count += 1
      if (count >= 5) break
    }
    byRowId.set(row.id, count)
  }
  return byRowId
})

function getStoredRowLane(rowId: string, laneKey: string) {
  return storedRowLanesById.value.get(rowId)?.find(lane => lane.key === laneKey) ?? null
}

function getStoredEditableLane(rowId: string, laneKey: string, laneKind?: RenderLane['kind']) {
  const lanes = storedRowLanesById.value.get(rowId)
  if (!lanes) return null

  const exact = lanes.find(lane => lane.key === laneKey) ?? null
  if (exact) return exact

  if (laneKind === 'trigger') {
    return lanes.find(lane => lane.type !== 'keyframes') ?? null
  }

  return null
}

function rowHasDirectAutomation(rowId: string) {
  return rowHasDirectAutomationById.value.get(rowId) ?? false
}

function hasRenderLane(rowId: string, laneKey: string) {
  return (rawRowLanesById.value.get(rowId) ?? []).some((lane) => {
    if (lane.key !== laneKey) return false
    if (lane.type === 'keyframes') return lane.renderKeyframes !== undefined
    if (lane.type === 'trigger') return lane.renderTriggers !== undefined
    return lane.renderPoints !== undefined
  })
}

function getRowLanes(rowId: string): RenderLane[] {
  return rowLanesById.value.get(rowId) ?? []
}

function getDisplayedRowLanes(rowId: string) {
  return displayedRowLanesById.value.get(rowId) ?? []
}

function getRowDisplay(rowId: string) {
  return rowDisplayById.value.get(rowId)
}

function getCollapsedLaneHeight(rowId: string) {
  return collapsedLaneHeightById.value.get(rowId) ?? collapsedRowHeight
}

function getCollapsedGroupLineCount(rowId: string) {
  return collapsedGroupLineCountById.value.get(rowId) ?? 0
}

function getExpectedLaneKeyForSpec(spec: Controls.Base.Spec) {
  if (spec.type === Controls.Pad.Spec.type) return 'value'
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type) return 'on'
  return 'value'
}

function sanitizeTriggerPoints(points: Timeline.TimelinePoint[]) {
  const sorted = [...points].sort((a, b) => a.t - b.t)
  const sanitized: Timeline.TimelineTrigger[] = []
  let pendingOn: Timeline.TimelinePoint | null = null

  for (const point of sorted) {
    const isOn = point.v >= 0
    if (!pendingOn) {
      if (!isOn) continue
      pendingOn = point
      continue
    }
    if (isOn) continue
    sanitized.push({
      on: { t: pendingOn.t, value: Math.max(0, pendingOn.v) },
      off: { t: point.t },
    })
    pendingOn = null
  }

  return sanitized
}

function normalizeLaneForRow(rowId: string, lane: Timeline.TimelineLane): Timeline.TimelineLane {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return lane
  if (Timeline.getTimelineAdapter(spec).kind !== 'trigger') return lane
  if (lane.type === 'keyframes') return lane
  if (lane.type === 'trigger') {
    return {
      ...lane,
      key: getExpectedLaneKeyForSpec(spec),
      triggers: [...lane.triggers].sort((a, b) => a.on.t - b.on.t),
      renderTriggers: lane.renderTriggers ? [...lane.renderTriggers].sort((a, b) => a.on.t - b.on.t) : undefined,
    }
  }
  return {
    type: 'trigger',
    key: getExpectedLaneKeyForSpec(spec),
    enabled: lane.enabled,
    triggers: sanitizeTriggerPoints(lane.points ?? []),
    seq: lane.seq,
    renderTriggers: lane.renderPoints ? sanitizeTriggerPoints(lane.renderPoints) : undefined,
    renderSeq: lane.renderSeq,
  }
}

function isLaneCompatibleWithRow(rowId: string, lane: Timeline.TimelineLane) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!row || !row.hasValue || !spec) {
    return {
      compatible: false,
      reason: row ? 'control is not automatable in the current artwork spec' : 'control is not present in the current artwork spec',
    }
  }

  const expectedKeys = getControlLaneKeys(rowId)
  if (!expectedKeys.includes(lane.key)) {
    return {
      compatible: false,
      reason: `lane key "${lane.key}" is not valid for current ${spec.type} control`,
    }
  }

  const adapterKind = Timeline.getTimelineAdapter(spec).kind
  const laneKind = formatLaneKind(lane)
  const compatible =
    (adapterKind === 'curve' && laneKind === 'curve')
    || (adapterKind === 'step' && laneKind === 'step')
    || (adapterKind === 'trigger' && laneKind === 'trigger')
    || (adapterKind === 'keyframes' && laneKind === 'keyframes')
    || (adapterKind === 'event' && laneKind === 'event')

  return compatible
    ? { compatible: true, reason: '' }
    : {
      compatible: false,
      reason: `saved ${laneKind} lane is incompatible with current ${adapterKind} control`,
    }
}

function filterProjectStateForCurrentSpec(state: Timeline.TimelineState) {
  const issues: ProjectCompatibilityIssue[] = []
  const controls: Timeline.TimelineControl[] = []

  for (const control of state.controls ?? []) {
    const rowId = control.path.join('.')
    const row = rowById.value.get(rowId)
    if (!row) {
      issues.push({
        path: rowId || '(root)',
        reason: 'control is not present in the current artwork spec',
      })
      continue
    }
    if (!row.hasValue) {
      issues.push({
        path: rowId || row.name,
        reason: 'control is not automatable in the current artwork spec',
      })
      continue
    }

    const lanes: Timeline.TimelineLane[] = []
    for (const lane of control.lanes ?? []) {
      const compatibility = isLaneCompatibleWithRow(rowId, lane)
      if (!compatibility.compatible) {
        issues.push({
          path: rowId,
          laneKey: lane.key,
          reason: compatibility.reason,
        })
        continue
      }
      lanes.push(normalizeLaneForRow(rowId, lane))
    }

    if (lanes.length) {
      controls.push({
        ...control,
        lanes,
      })
    }
  }

  return {
    state: {
      ...state,
      controls,
    },
    issues,
  }
}

function normalizeProjectState(state: Timeline.TimelineState): Timeline.TimelineState {
  return filterProjectStateForCurrentSpec(state).state
}

function addRenderLane(rowId: string, laneKey: string) {
  timelineClient.value?.addRenderLane(getRowPath(rowId), laneKey)
}

function removeRenderLane(rowId: string, laneKey: string) {
  timelineClient.value?.removeRenderLane(getRowPath(rowId), laneKey)
}

function getCurveRenderLane(lane: Timeline.TimelineCurveLane): Timeline.TimelineCurveLane {
  return {
    ...lane,
    key: `${lane.key}__render`,
    points: lane.renderPoints ?? [],
  }
}

function getStepRenderLane(lane: Timeline.TimelineStepLane): Timeline.TimelineStepLane {
  return {
    ...lane,
    key: `${lane.key}__render`,
    points: lane.renderPoints ?? [],
  }
}

function getTriggerRenderLane(lane: Timeline.TimelineTriggerLane): Timeline.TimelineTriggerLane {
  return {
    ...lane,
    key: `${lane.key}__render`,
    triggers: lane.renderTriggers ?? [],
  }
}

function getKeyframeRenderLane(lane: Timeline.TimelineKeyframeLane): Timeline.TimelineKeyframeLane {
  return {
    ...lane,
    key: `${lane.key}__render`,
    keyframes: lane.renderKeyframes ?? [],
  }
}

function getEventRenderLane(lane: Timeline.TimelineEventLane): Timeline.TimelineEventLane {
  return {
    ...lane,
    key: `${lane.key}__render`,
    events: lane.renderEvents ?? [],
  }
}

function isRowCollapsed(rowId: string) {
  return rowStates[rowId]?.expansion === 'collapsed'
}

function getStepLaneDisplayRange(rowId: string, lane?: Timeline.TimelineStepLane | Timeline.TimelineTriggerLane) {
  const range = getRowRange(rowId)
  return { min: range.min, max: range.max, key: lane?.key ?? range.key }
}

function getStepOptionLabels(rowId: string) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec || spec.type !== Controls.Selector.Spec.type) return []
  return [...(spec as Controls.Selector.Spec).options]
}

function getVisibleTriggerMaxVelocity(rowId: string) {
  const visibleTimeMin = timeOffset.value
  const visibleTimeMax = timeOffset.value + secondsPerWidth.value
  let maxVelocity = 0
  for (const lane of getRawRowLanes(rowId)) {
    if (lane.type !== 'trigger') continue
    for (const trigger of lane.triggers) {
      if (trigger.on.t < visibleTimeMin || trigger.on.t > visibleTimeMax) continue
      maxVelocity = Math.max(maxVelocity, Math.max(0, trigger.on.value))
    }
  }
  return Math.max(1, maxVelocity)
}

function getTriggerCreateDisplayRange(rowId: string) {
  const targetMax = getVisibleTriggerMaxVelocity(rowId)
  return {
    min: -1,
    max: targetMax * 1.4,
  }
}

function getRowRange(rowId: string, lane?: Timeline.TimelineLane) {
  const row = rowById.value.get(rowId)
  const spec = row?.spec as Controls.Base.Spec | undefined
  if (!spec) return { min: 0, max: 1, key: lane?.key ?? 'value' }
  if (spec.type === Controls.Fader.Spec.type || spec.type === Controls.Knob.Spec.type) {
    const s = spec as Controls.Fader.Spec | Controls.Knob.Spec
    return { min: s.min, max: s.max, key: 'value', mapping: 'mapping' in s ? s.mapping ?? 'linear' : 'linear', wrap: 'wrap' in s ? s.wrap : false }
  }
  if (spec.type === Controls.Switch.Spec.type || spec.type === Controls.ConfirmSwitch.Spec.type) {
    return { min: -1, max: 1, key: 'on' }
  }
  if (spec.type === Controls.Pad.Spec.type) {
    return { min: -1, max: 1, key: 'value' }
  }
  if (spec.type === Controls.Selector.Spec.type) {
    const s = spec as Controls.Selector.Spec
    return { min: 0, max: Math.max(0, s.options.length - 1), key: 'index' }
  }
  if (spec.type === Controls.Joystick.Spec.type) {
    return { min: -1, max: 1, key: 'x' }
  }
  if (spec.type === Controls.Player3D.Spec.type) {
    if (lane?.key === 'qx' || lane?.key === 'qy' || lane?.key === 'qz' || lane?.key === 'qw') {
      return { min: -1, max: 1, key: lane.key }
    }
    return { min: -10, max: 10, key: lane?.key ?? 'x' }
  }
  return { min: 0, max: 1, key: 'value' }
}

function getDisplayRange(range: { min: number; max: number }, points?: Timeline.TimelinePoint[] | null) {
  // Calculate range including control point extremes, matching LaneEnvelope
  let minVal = range.min
  let maxVal = range.max

  if (points) {
    for (const p of points) {
      if ((p.kind ?? 'pos') === 'ctrl') {
        if (p.v < minVal) minVal = p.v
        if (p.v > maxVal) maxVal = p.v
      }
    }
  }

  const center = (minVal + maxVal) / 2
  const halfRange = (maxVal - minVal) / 2 * 1.4

  return { min: center - halfRange, max: center + halfRange }
}

function clampValue(value: number, min: number, max: number) {
  if (min > max) return value
  return Math.max(min, Math.min(max, value))
}

const LOG_CURVE_AMOUNT = 99
const LOG_DENOMINATOR = Math.log1p(LOG_CURVE_AMOUNT)

function mapNormToValue(normValue: number, min: number, max: number, mapping?: 'linear' | 'square' | 'log') {
  if (mapping === 'square') {
    // Handle negative norm values gracefully
    if (normValue < 0) return min - (normValue * normValue) * (max - min)
    return min + (normValue * normValue) * (max - min)
  }
  if (mapping === 'log') {
    const clamped = Math.max(0, Math.min(1, normValue))
    const curved = Math.log1p(LOG_CURVE_AMOUNT * clamped) / LOG_DENOMINATOR
    return min + curved * (max - min)
  }
  return min + normValue * (max - min)
}

function mapValueToNorm(value: number, min: number, max: number, mapping?: 'linear' | 'square' | 'log') {
  const range = max - min
  if (range === 0) return 0
  const norm = (value - min) / range
  if (mapping === 'square') {
    // Handle negative norm values gracefully
    if (norm < 0) return -Math.sqrt(-norm)
    return Math.sqrt(norm)
  }
  if (mapping === 'log') {
    const clamped = Math.max(0, Math.min(1, norm))
    return Math.expm1(clamped * LOG_DENOMINATOR) / LOG_CURVE_AMOUNT
  }
  return norm
}

function valueToY(value: number, height: number, min: number, max: number, mapping?: 'linear' | 'square' | 'log') {
  if (max === min) return height / 2
  const norm = mapValueToNorm(value, min, max, mapping)
  return height - norm * height
}

function yToValue(y: number, height: number, min: number, max: number, mapping?: 'linear' | 'square' | 'log', clamp = true) {
  if (max === min) return min
  const rawNorm = 1 - y / height
  const norm = clamp ? Math.max(0, Math.min(1, rawNorm)) : rawNorm
  return mapNormToValue(norm, min, max, mapping)
}

function evalLinear(points: Timeline.TimelinePoint[], t: number) {
  if (!points.length) return null
  if (points.length === 1) return points[0]!.v
  if (t <= points[0]!.t) return points[0]!.v
  const last = points[points.length - 1]!
  if (t >= last.t) return last.v
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      if (span <= 0) return a.v
      const factor = (t - a.t) / span
      return a.v + (b.v - a.v) * factor
    }
  }
  return last.v
}

// Handler for LaneEnvelope point updates
function onLanePointsUpdate(rowId: string, laneKey: string, points: Timeline.TimelinePoint[]) {
  if (!timelineClient.value) return
  activateControl(rowId)
  const laneKind = isStepTrackRow(rowId) ? 'step' : 'curve'
  const storedLane = getStoredEditableLane(rowId, laneKey, laneKind)
  if (!points.length) {
    if (!storedLane) return
    clearLaneInState(timelineStateRaw.value, rowId, storedLane.key, laneKind)
    clearLaneInState(timelineState.value, rowId, laneKey, laneKind)
    timelineClient.value.removeLane(getRowPath(rowId), storedLane.key)
    sendCurrentAutomationFrame()
    return
  }
  if (!storedLane) {
    const newLane: Timeline.TimelineLane = {
      type: laneKind,
      key: laneKey,
      enabled: true,
      points,
    }
    addLaneInState(timelineStateRaw.value, rowId, newLane)
    addLaneInState(timelineState.value, rowId, normalizeLaneForRow(rowId, newLane))
    timelineClient.value.addLane(getRowPath(rowId), newLane)
    sendCurrentAutomationFrame()
    return
  }
  updateLaneInState(timelineStateRaw.value, rowId, storedLane.key, laneKind, points)
  updateLaneInState(timelineState.value, rowId, laneKey, laneKind, points)
  timelineClient.value.setLanePoints(getRowPath(rowId), laneKey, points)
  sendCurrentAutomationFrame()
}

function onLaneTriggersUpdate(rowId: string, laneKey: string, triggers: Timeline.TimelineTrigger[]) {
  if (!timelineClient.value) return
  activateControl(rowId)
  const storedLane = getStoredEditableLane(rowId, laneKey, 'trigger')
  if (!storedLane) {
    const newLane: Timeline.TimelineTriggerLane = {
      type: 'trigger',
      key: laneKey,
      enabled: true,
      triggers,
    }
    addLaneInState(timelineStateRaw.value, rowId, newLane)
    addLaneInState(timelineState.value, rowId, normalizeLaneForRow(rowId, newLane))
    timelineClient.value.addLane(getRowPath(rowId), newLane)
    sendCurrentAutomationFrame()
    return
  }
  if (storedLane?.type === 'trigger') {
    updateLaneInState(timelineStateRaw.value, rowId, storedLane.key, 'trigger', triggers)
    updateLaneInState(timelineState.value, rowId, laneKey, 'trigger', triggers)
    timelineClient.value.setLaneTriggers(getRowPath(rowId), storedLane.key, triggers)
    sendCurrentAutomationFrame()
    return
  }
  timelineClient.value.setLanePoints(getRowPath(rowId), storedLane?.key ?? laneKey, flattenTriggerPairs(triggers))
  sendCurrentAutomationFrame()
}

function onRenderLanePointsUpdate(rowId: string, laneKey: string, points: Timeline.TimelinePoint[]) {
  if (!timelineClient.value) return
  timelineClient.value.setRenderLanePoints(getRowPath(rowId), laneKey, points)
}

function onRenderLaneTriggersUpdate(rowId: string, laneKey: string, triggers: Timeline.TimelineTrigger[]) {
  if (!timelineClient.value) return
  timelineClient.value.setRenderLaneTriggers(getRowPath(rowId), laneKey, triggers)
}

function onRenderLaneEventsUpdate(rowId: string, laneKey: string, events: Timeline.TimelineEventPoint[]) {
  if (!timelineClient.value) return
  timelineClient.value.setRenderLaneEvents(getRowPath(rowId), laneKey, events)
}

function onLaneEventsUpdate(rowId: string, laneKey: string, events: Timeline.TimelineEventPoint[]) {
  if (!timelineClient.value) return
  activateControl(rowId)
  const storedLane = getStoredEditableLane(rowId, laneKey, 'event')
  if (!storedLane) {
    const newLane: Timeline.TimelineEventLane = {
      type: 'event',
      key: laneKey,
      enabled: true,
      events,
    }
    addLaneInState(timelineStateRaw.value, rowId, newLane)
    addLaneInState(timelineState.value, rowId, newLane)
    timelineClient.value.addLane(getRowPath(rowId), newLane)
    sendCurrentAutomationFrame()
    return
  }
  updateLaneInState(timelineStateRaw.value, rowId, storedLane.key, 'event', events)
  updateLaneInState(timelineState.value, rowId, laneKey, 'event', events)
  timelineClient.value.setLaneEvents(getRowPath(rowId), laneKey, events)
  sendCurrentAutomationFrame()
}

function onRenderLaneKeyframesUpdate(rowId: string, laneKey: string, keyframes: Timeline.TimelineKeyframe[]) {
  if (!timelineClient.value) return
  timelineClient.value.setRenderLaneKeyframes(getRowPath(rowId), laneKey, keyframes)
}

function onLaneKeyframesUpdate(rowId: string, laneKey: string, keyframes: Timeline.TimelineKeyframe[]) {
  if (!timelineClient.value) return
  activateControl(rowId)
  const storedLane = getStoredEditableLane(rowId, laneKey, 'keyframes')
  if (!storedLane) {
    const newLane: Timeline.TimelineKeyframeLane = {
      type: 'keyframes',
      key: laneKey,
      enabled: true,
      keyframes,
    }
    addLaneInState(timelineStateRaw.value, rowId, newLane)
    addLaneInState(timelineState.value, rowId, newLane)
    timelineClient.value.addLane(getRowPath(rowId), newLane)
    sendCurrentAutomationFrame()
    return
  }
  updateLaneInState(timelineStateRaw.value, rowId, storedLane.key, 'keyframes', keyframes)
  updateLaneInState(timelineState.value, rowId, laneKey, 'keyframes', keyframes)
  timelineClient.value.setLaneKeyframes(getRowPath(rowId), laneKey, keyframes)
  sendCurrentAutomationFrame()
}

async function refreshProjects() {
  if (!artworkId.value) return
  projects.value = await listProjects(artworkId.value)
  if (!selectedProjectKey.value && projects.value.length) {
    const storedProjectKey = loadStoredSelectedProjectKey()
    const preferredProject =
      projects.value.find(project => project.key === storedProjectKey)
      ?? projects.value.find(project => project.name !== 'autosave')
      ?? projects.value[0]
    if (preferredProject) {
      selectedProjectKey.value = preferredProject.key
    }
  }
}

async function createNewProject() {
  if (!timelineState.value) return
  projectName.value = ''
  selectedProjectKey.value = ''
  await applyProjectState({
    ...sanitizeTimelineStateForPersistence(timelineState.value),
    controls: [],
  })
  await applyAudioTrack(null)
  closeProjectMenu()
}

async function saveCurrentProject() {
  if (!timelineState.value) return
  const name = projectName.value.trim()
  if (!name) return
  isSaving.value = true
  const key = `${artworkId.value}::${name}`
  await saveProject({
    key,
    artworkId: artworkId.value,
    name,
    state: sanitizeTimelineStateForPersistence(timelineState.value),
    updatedAt: Date.now(),
    uiState: buildUiState(),
    audioTrack: buildStoredAudioTrack(),
  })
  selectedProjectKey.value = key
  await refreshProjects()
  isSaving.value = false
  closeProjectMenu()
}

async function loadSelectedProject() {
  if (!selectedProjectKey.value) return
  const project = await loadProject(selectedProjectKey.value)
  if (!project?.state) return
  await applyCompatibleProjectState(
    `Load "${project.name}"`,
    project.state,
    project.audioTrack,
    async (compatibleState) => {
      projectName.value = project.name
      await applyProjectState(compatibleState)
      await applyAudioTrack(project.audioTrack)
      applyUiState(project.uiState)
      closeProjectMenu()
    },
  )
}

async function deleteSelectedProject() {
  if (!selectedProjectKey.value) return
  await deleteProject(selectedProjectKey.value)
  selectedProjectKey.value = ''
  await refreshProjects()
  closeProjectMenu()
}

function applyUiState(uiState?: StoredProject['uiState']) {
  if (!uiState) return false
  if (!rows.value.length) {
    pendingUiState.value = uiState
    logTimelineRestore('defer-ui-state', {
      artworkId: artworkId.value,
      reason: 'rows-not-ready',
      expandedRowCount: Object.keys(uiState.expandedRows ?? {}).length,
    })
    return false
  }
  logTimelineRestore('apply-ui-state', {
    artworkId: artworkId.value,
    rowCount: rows.value.length,
    expandedRowCount: Object.keys(uiState.expandedRows ?? {}).length,
  })
  if (typeof uiState.labelWidth === 'number') labelWidthPx.value = uiState.labelWidth
  if (typeof uiState.secondsPerWidth === 'number') secondsPerWidth.value = uiState.secondsPerWidth
  if (typeof uiState.timeOffset === 'number') timeOffset.value = uiState.timeOffset
  const restoredLiveEnabled = typeof uiState.liveEnabled === 'boolean' ? uiState.liveEnabled : liveEnabled.value
  if (typeof uiState.playheadTime === 'number' && Number.isFinite(uiState.playheadTime)) {
    const nextTime = Math.max(0, uiState.playheadTime)
    playing.value = false
    timelineTime.value = nextTime
    lastStateTime.value = nextTime
    lastStateAt.value = performance.now()
    timelineClient.value?.seek(nextTime)
    timelineClient.value?.applyAutomation(nextTime, { bypassBackpressure: true })
    timelineClient.value?.setPlaying(false)
    artworkClient.value?.setMode(restoredLiveEnabled ? 'artwork-live' : 'paused')
    artworkClient.value?.setTime(nextTime)
  }
  if (typeof uiState.loopFromSec === 'number') loopFromSec.value = Math.max(0, uiState.loopFromSec)
  if (typeof uiState.liveEnabled === 'boolean') {
    hasPersistedLivePreference.value = true
    liveEnabled.value = uiState.liveEnabled
    if (!playing.value) {
      artworkClient.value?.setMode(uiState.liveEnabled ? 'artwork-live' : 'paused')
    }
  }
  if (uiState.expandedRows) {
    for (const [id, state] of Object.entries(uiState.expandedRows)) {
      const migratedExpansion: ExpansionMode =
        state.expansion === 'collapsed' || state.expansion === 'expanded'
          ? state.expansion
          : state.expansion === 'all'
            ? 'expanded'
            : state.expansion === 'pinned'
              ? 'collapsed'
              : state.expanded
                ? 'expanded'
                : 'collapsed'
      if (!rowStates[id]) {
        rowStates[id] = { expansion: migratedExpansion, height: state.height, pinned: state.pinned ?? false }
      } else {
        rowStates[id].expansion = migratedExpansion
        rowStates[id].height = state.height
        rowStates[id].pinned = state.pinned ?? rowStates[id].pinned
      }
    }
  }
  restoreScrollTopDeferred(uiState.scrollTop ?? 0)
  return true
}

function exportProject() {
  if (!selectedProjectKey.value) return
  const project = projects.value.find(p => p.key === selectedProjectKey.value)
  if (!project) return
  const blob = new Blob([JSON.stringify({
    ...project,
    state: sanitizeTimelineStateForPersistence(project.state),
  }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.name}.timeline.json`
  a.click()
  URL.revokeObjectURL(url)
  closeProjectMenu()
}

async function handleImportProject(file: File) {
  const text = await file.text()
  const project = JSON.parse(text) as StoredProject
  if (!project?.state) return
  const key = `${artworkId.value}::${project.name}`
  await applyCompatibleProjectState(
    `Import "${project.name}"`,
    project.state,
    project.audioTrack,
    async (compatibleState) => {
      await saveProject({
        ...project,
        key,
        artworkId: artworkId.value,
        updatedAt: Date.now(),
      })
      selectedProjectKey.value = key
      await refreshProjects()
      await applyProjectState(compatibleState)
      await applyAudioTrack(project.audioTrack)
      closeProjectMenu()
    },
  )
}

onMounted(() => {
  refreshProjects()
})

watch(lastUpdatedControl, (rowId, previousRowId) => {
  if (!autoFollowRecent.value) return
  if (!rowId || rowId === previousRowId) return
  focusRow(rowId)
})

watch(artworkClient, (client) => {
  if (!client) return
  client.onRenderAck = (ack) => {
    logTimelineRender('ack-received', {
      ackTime: ack.time,
      ok: ack.ok,
      captured: ack.captured,
      probeId: ack.probeId,
      pendingExpectedTime: pendingRenderAck?.expectedTime ?? null,
    })
    if (!pendingRenderAck) return
    if (ack.probeId) {
      logTimelineRender('ack-ignored-probe-during-render', {
        ackTime: ack.time,
        pendingExpectedTime: pendingRenderAck.expectedTime,
        probeId: ack.probeId,
      })
      return
    }
    if (Math.abs(ack.time - pendingRenderAck.expectedTime) > 1e-6) {
      logTimelineRender('ack-mismatch', {
        ackTime: ack.time,
        expectedTime: pendingRenderAck.expectedTime,
        delta: ack.time - pendingRenderAck.expectedTime,
      })
      return
    }
    const next = pendingRenderAck
    pendingRenderAck = null
    next.resolve(ack)
  }
  client.onCaptureAck = (ack) => {
    if (!pendingCaptureAck) return
    if (ack.action !== pendingCaptureAck.expectedAction) return
    const next = pendingCaptureAck
    pendingCaptureAck = null
    next.resolve(ack)
  }
})
</script>

<template>
  <div class="page">
    <TimelineHeader
      :is-connected="isConnected"
      :connecting="connecting"
      :ws-url="wsUrl"
      :title="title"
      :last-updated-control="lastUpdatedControl"
      :searchable-controls="searchableControls"
      :auto-follow-recent="autoFollowRecent"
      :projects="projects"
      :selected-project-key="selectedProjectKey"
      :current-project-label="currentProjectLabel"
      :project-name="projectName"
      :is-saving="isSaving"
      :close-project-menu-signal="closeProjectMenuSignal"
      @update:ws-url="wsUrl = $event"
      @connect="connect"
      @disconnect="disconnect"
      @focus-row="focusRow"
      @update:auto-follow-recent="autoFollowRecent = $event"
      @update:selected-project-key="selectedProjectKey = $event"
      @update:project-name="projectName = $event"
      @new-project="createNewProject"
      @save-project="saveCurrentProject"
      @load-project="loadSelectedProject"
      @delete-project="deleteSelectedProject"
      @export-project="exportProject"
      @import-project="handleImportProject"
    />

    <section class="panel-chooser" v-if="panelIds.length > 1">
      <label for="panel">Select panel</label>
      <select id="panel" v-model="selectedPanelId" class="input">
        <option v-for="id in panelIds" :key="id" :value="id">{{ id }}</option>
      </select>
      <button class="button" @click="applyPanelChoice">Use panel</button>
    </section>

    <section class="timeline">
      <TimelineGrid
        :label-width-px="labelWidthPx"
        :all-manual-override-count="allManualOverrideCount"
        :record-all-manual-override-keyframes="recordAllManualOverrideKeyframes"
        :reset-all-manual-override-lanes="resetAllManualOverrideLanes"
        :set-lane-header-ref="setLaneHeaderElement"
        :set-scrub-area-ref="setScrubAreaElement"
        :set-timeline-cursor-ref="setTimelineCursorElement"
        :set-timeline-scroll-ref="setTimelineScrollElement"
        :on-lane-wheel="onLaneWheel"
        :on-lane-pointer-down="onLanePointerDown"
        :on-scrub-pointer-down="onScrubPointerDown"
        :on-timeline-scroll="onTimelineScroll"
        :start-resize="startResize"
        :loop-range-style="loopRangeStyle"
        :header-time-markers="headerTimeMarkers"
        :visible-audio-marker-xs="visibleAudioMarkerXs"
        :body-time-markers="bodyTimeMarkers"
        :visible-rows-with-ellipsis="virtualizedVisibleRows.entries"
        :top-spacer-height="virtualizedVisibleRows.topSpacerHeight"
        :bottom-spacer-height="virtualizedVisibleRows.bottomSpacerHeight"
        :highlighted-row-id="highlightedRowId"
        :row-by-id="rowById"
        :get-row-display="getRowDisplay"
        :row-states="rowStates"
        :collapsed-row-height="collapsedRowHeight"
        :expanded-row-height="expandedRowHeight"
        :lane-width-px="laneWidthPx"
        :seconds-per-width="secondsPerWidth"
        :time-offset="timeOffset"
        :audio-expanded="audioExpanded"
        :audio-snap-enabled="audioSnapEnabled"
        :audio-markers="audioMarkers"
        :get-step-option-labels="getStepOptionLabels"
        :audio-waveform="audioWaveform"
        :audio-duration="audioDuration"
        :audio-file-name="audioFileName"
        :missing-audio-file-name="missingAudioFileName"
        :should-render-row-lanes="shouldRenderRowLanes"
        :lane-has-data="laneHasData"
        :get-lane-action-id="getLaneActionId"
        :lane-clear-confirm="laneClearConfirm"
        :toggle-row-expanded="toggleRowExpanded"
        :toggle-pinned="togglePinned"
        :get-branch-manual-override-row-ids="getBranchManualOverrideRowIds"
        :activate-control="activateControl"
        :get-branch-keyframe-row-ids="getBranchKeyframeRowIds"
        :record-manual-override-keyframe="recordAndSyncManualOverrideKeyframe"
        :record-branch-manual-override-keyframes="recordBranchManualOverrideKeyframes"
        :has-active-keyframe-target="hasActiveKeyframeTarget"
        :control-manual-override="controlManualOverride"
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
        :expand-parent-row="expandParentRow"
        :toggle-audio-expanded="toggleAudioExpanded"
        :toggle-audio-snap="toggleAudioSnap"
        :on-audio-upload="onAudioUpload"
        :on-audio-hover-time="onAudioHoverTime"
        :toggle-audio-marker="toggleAudioMarker"
      />
      <TimelineFooter
        :last-state-time="lastStateTime"
        :last-state-at="lastStateAt"
        :playing="playing"
        :rendering="rendering"
        :render-live-enabled="renderLiveEnabled"
        :live-enabled="liveEnabled"
        :loop-enabled="loopEnabled"
        :loop-from-sec="loopFromSec"
        :loop-to-sec="loopDurationSec"
        :fps="fps"
        @seek-zero="seekZero"
        @jump-keyframe="jumpKeyframe"
        @step-frames="stepFrames"
        @toggle-play="onTogglePlayButton"
        @toggle-render-loop="toggleRenderLoop"
        @toggle-render-live="toggleRenderLive"
        @toggle-loop="toggleLoop"
        @toggle-live="toggleLive"
        @update:fps="fps = $event"
        @update:loop-from-sec="updateLoopFrom"
        @update:loop-to-sec="updateLoopTo"
      />
    </section>

    <div
      v-if="pendingProjectCompatibilityAction"
      class="compatibility-dialog-overlay"
      @click.self="cancelProjectCompatibilityAction"
    >
      <div class="compatibility-dialog" role="dialog" aria-modal="true" aria-labelledby="compatibility-dialog-title">
        <header class="compatibility-dialog-header">
          <h2 id="compatibility-dialog-title">{{ pendingProjectCompatibilityAction.title }}</h2>
          <p>Some saved automation does not match the current artwork controls and will be ignored for this session.</p>
        </header>
        <div class="compatibility-issue-list">
          <div
            v-for="(issue, index) in pendingProjectCompatibilityAction.issues"
            :key="`${issue.path}:${issue.laneKey ?? ''}:${index}`"
            class="compatibility-issue"
          >
            <div class="compatibility-issue-path">
              {{ issue.path }}<span v-if="issue.laneKey"> / {{ issue.laneKey }}</span>
            </div>
            <div class="compatibility-issue-reason">{{ issue.reason }}</div>
          </div>
        </div>
        <footer class="compatibility-dialog-actions">
          <button class="button" @click="cancelProjectCompatibilityAction">Cancel</button>
          <button class="button compatibility-proceed-button" @click="proceedProjectCompatibilityAction">Proceed</button>
        </footer>
      </div>
    </div>

    <RenderDialog
      v-if="showRenderDialog"
      :loop-duration="loopDurationSec"
      :artwork-name="artworkId"
      @start="onRenderStart"
      @test="onRenderTest"
      @close="showRenderDialog = false"
    />

    <RenderProgress
      v-if="showRenderProgress"
      :frame-number="renderProgress.frameNumber"
      :total-frames="renderProgress.totalFrames"
      :current-time="renderProgress.currentTime"
      :test-mode="isTestMode"
      @continue="onContinueRender"
      @cancel="onCancelRender"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0;
  gap: 0.5rem;
  overflow: hidden;
}

.input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: inherit;
  padding: 0.5rem 0.75rem;
  border-radius: 0.6rem;
}

.time-input {
  width: 6rem;
}

.button {
  background: linear-gradient(135deg, #222f43, #1a1f2b);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: inherit;
  padding: 0.5rem 1rem;
  border-radius: 0.6rem;
  cursor: pointer;
}

.panel-chooser {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.compatibility-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(4, 6, 10, 0.72);
}

.compatibility-dialog {
  width: min(42rem, 100%);
  max-height: min(34rem, calc(100vh - 2rem));
  display: flex;
  flex-direction: column;
  background: #151a22;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 0.5rem;
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.compatibility-dialog-header {
  padding: 1rem 1rem 0.75rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.compatibility-dialog-header h2 {
  margin: 0 0 0.45rem;
  font-size: 1rem;
  font-weight: 650;
}

.compatibility-dialog-header p {
  margin: 0;
  color: rgba(243, 242, 238, 0.72);
  font-size: 0.88rem;
  line-height: 1.35;
}

.compatibility-issue-list {
  overflow: auto;
  padding: 0.35rem 0;
}

.compatibility-issue {
  padding: 0.65rem 1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.compatibility-issue-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.82rem;
  color: rgba(123, 220, 255, 0.95);
  overflow-wrap: anywhere;
}

.compatibility-issue-reason {
  margin-top: 0.2rem;
  color: rgba(243, 242, 238, 0.65);
  font-size: 0.82rem;
  line-height: 1.3;
}

.compatibility-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.compatibility-proceed-button {
  background: linear-gradient(135deg, #285a48, #203f35);
}

.timeline {
  flex: 1;
  background: rgba(15, 17, 21, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 1rem;
  padding: 0 0.75rem 0 0.75rem;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
}
</style>
