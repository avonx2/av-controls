import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { Artwork, Messages, Transports, Controls } from 'av-controls'
import * as Timeline from './engine'
import { loadProject, saveProject, sanitizeTimelineStateForPersistence, type StoredAudioTrack, type StoredProject } from './storage'

const timelineStateLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('timeline-state-log') === '1'
const timelinePlayLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('timeline-play-log') === '1'
const timelineRestoreLog = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('timeline-restore-log') === '1'

type TimelineSessionOptions = {
  wsUrl: Ref<string>
  artworkId: ComputedRef<string>
  chooseNetPanel: (ids: string[]) => Promise<string>
  refreshProjects: () => Promise<void>
  buildUiState: () => NonNullable<StoredProject['uiState']>
  buildAudioTrack: () => StoredAudioTrack | undefined
  applyUiState: (uiState?: StoredProject['uiState']) => void
  normalizeProjectState: (state: Timeline.TimelineState) => Timeline.TimelineState
  getNestedControlPath: (payload: any, childKey: 'update' | 'signal', path?: string[]) => string[]
  extractLaneValues: (payload: any) => Record<string, number>
  extractAutomationPayload: (payload: any) => unknown
  canAutoSave: () => boolean
  controlEnabled: Record<string, boolean>
  controlManualOverride: Record<string, boolean>
  latestControlValues: Record<string, Record<string, number>>
  latestControlPayloads: Record<string, unknown>
  setLastUpdatedControl: (rowId: string | null) => void
  shouldUpdateClock: () => boolean
  onStateProcessed: () => void
  onAutosaveProjectLoaded?: (project: StoredProject | null) => void
}

function stateHasTimelineData(state: Timeline.TimelineState) {
  return state.controls.some(control =>
    control.lanes.some(lane => {
      if (lane.type === 'keyframes') return lane.keyframes.length > 0
      if (lane.type === 'trigger') return lane.triggers.length > 0
      if (lane.type === 'step') return lane.points.length > 0
      return lane.points.length > 0 || (lane.renderPoints?.length ?? 0) > 0
    }),
  )
}

function logManualOverride(event: string, data?: unknown) {
  const timestamp = new Date().toISOString()
  console.info(`[${timestamp}] [timeline:manual-override] ${event}`, data ?? {})
}

function logRestore(event: string, data?: unknown) {
  if (!timelineRestoreLog) return
  console.info(`[timeline:restore] ${event}`, data ?? {})
}

export function useTimelineSession(options: TimelineSessionOptions) {
  const panelIds = ref<string[]>([])
  const selectedPanelId = ref('')
  const isConnected = ref(false)
  const wsSender = ref<Transports.WebSocket.Sender | null>(null)
  const timelineClient = ref<Timeline.TimelineClient | null>(null)
  const artworkClient = ref<Artwork.ArtworkClient | null>(null)
  const rootSpec = ref<Messages.RootSpecification | null>(null)
  const connecting = ref(false)
  const timelineStateRaw = ref<Timeline.TimelineState | null>(null)
  const timelineState = ref<Timeline.TimelineState | null>(null)
  const artworkMode = ref<Messages.ArtworkMode>('live')
  const timelineTime = ref(0)
  const playing = ref(false)
  const alwaysRender = ref(true)
  const loopEnabled = ref(false)
  const loopDurationSec = ref(4)
  const lastStateTime = ref(0)
  const lastStateAt = ref(performance.now())
  const pendingPlaybackIntent = ref<{ seq: number; kind: 'set-playing' | 'set-state'; target: string } | null>(null)

  const pendingAutosave = ref<StoredProject | null>(null)
  const autosaveLoaded = ref(false)
  const initialRestoreResolved = ref(false)
  const isApplyingProject = ref(false)
  const restoringFromAutosave = ref(false)
  let enforcePausedOnInitialState = false
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  let autosaveStatePending: Timeline.TimelineState | null = null

  function clearAutosaveTimer() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer)
      autosaveTimer = null
    }
  }

  async function autoSave(state: Timeline.TimelineState) {
    if (!options.artworkId.value) return
    const project = {
      key: `${options.artworkId.value}::autosave`,
      artworkId: options.artworkId.value,
      name: 'autosave',
      state: sanitizeTimelineStateForPersistence(state),
      updatedAt: Date.now(),
      uiState: options.buildUiState(),
      audioTrack: options.buildAudioTrack(),
    }
    await saveProject(project)
    pendingAutosave.value = project
  }

  function scheduleAutosave(state: Timeline.TimelineState) {
    autosaveStatePending = state
    clearAutosaveTimer()
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      const nextState = autosaveStatePending
      autosaveStatePending = null
      if (!nextState) return
      void autoSave(nextState)
    }, 500)
  }

  async function applyProjectState(state: Timeline.TimelineState) {
    if (!timelineClient.value) return
    state = options.normalizeProjectState(sanitizeTimelineStateForPersistence(state))
    isApplyingProject.value = true
    timelineClient.value.setLoopEnabled(state.loopEnabled ?? false)
    timelineClient.value.setLoopDuration(state.loopDurationSec ?? 4)

    const current = timelineState.value?.controls ?? []
    const nextKeys = new Set(state.controls.map(control => control.path.join('.')))
    for (const control of current) {
      if (!nextKeys.has(control.path.join('.'))) {
        for (const lane of control.lanes) {
          timelineClient.value.removeLane(control.path, lane.key)
        }
        continue
      }
      const nextControl = state.controls.find(candidate => candidate.path.join('.') === control.path.join('.'))
      if (!nextControl) continue
      for (const lane of control.lanes) {
        if (!nextControl.lanes.find(candidate => candidate.key === lane.key)) {
          timelineClient.value.removeLane(control.path, lane.key)
          continue
        }
        const nextLane = nextControl.lanes.find(candidate => candidate.key === lane.key)
        const hasNextRenderLane = nextLane
          ? nextLane.type === 'keyframes'
            ? nextLane.renderKeyframes !== undefined
            : nextLane.type === 'trigger'
            ? nextLane.renderTriggers !== undefined
            : nextLane.renderPoints !== undefined
          : false
        const hasCurrentRenderLane = lane.type === 'keyframes'
          ? lane.renderKeyframes !== undefined
          : lane.type === 'trigger'
          ? lane.renderTriggers !== undefined
          : lane.renderPoints !== undefined
        if (hasCurrentRenderLane && !hasNextRenderLane) {
          timelineClient.value.removeRenderLane(control.path, lane.key)
        }
      }
    }

    for (const control of state.controls) {
      timelineClient.value.setControlEnabled(control.path, control.enabled)
      for (const lane of control.lanes) {
        timelineClient.value.addLane(control.path, lane)
        timelineClient.value.setLaneEnabled(control.path, lane.key, lane.enabled)
        if (lane.type === 'keyframes') {
          timelineClient.value.setLaneKeyframes(control.path, lane.key, lane.keyframes ?? [])
        } else if (lane.type === 'trigger') {
          timelineClient.value.setLaneTriggers(control.path, lane.key, lane.triggers ?? [])
        } else {
          timelineClient.value.setLanePoints(control.path, lane.key, lane.points ?? [])
        }
        if (lane.type === 'keyframes' && lane.renderKeyframes !== undefined) {
          timelineClient.value.addRenderLane(control.path, lane.key)
          timelineClient.value.setRenderLaneKeyframes(control.path, lane.key, lane.renderKeyframes ?? [])
        } else if (lane.type === 'trigger' && lane.renderTriggers !== undefined) {
          timelineClient.value.addRenderLane(control.path, lane.key)
          timelineClient.value.setRenderLaneTriggers(control.path, lane.key, lane.renderTriggers ?? [])
        } else if (lane.type !== 'keyframes' && lane.type !== 'trigger' && lane.renderPoints !== undefined) {
          timelineClient.value.addRenderLane(control.path, lane.key)
          timelineClient.value.setRenderLanePoints(control.path, lane.key, lane.renderPoints ?? [])
        }
      }
    }
    timelineClient.value.seek(state.time)
    timelineClient.value.applyAutomation(state.time)
    timelineClient.value.setState(state.playing ? 'playing' : 'paused')
    artworkClient.value?.setMode(state.playing ? 'playing' : 'paused')
    artworkClient.value?.render(state.time)
    isApplyingProject.value = false
  }

  async function maybeResolveInitialRestore() {
    if (initialRestoreResolved.value || !autosaveLoaded.value || !timelineStateRaw.value) return
    initialRestoreResolved.value = true
    const autosave = pendingAutosave.value
    logRestore('maybe-resolve-initial-restore', {
      hasAutosave: !!autosave,
      brokerControlCount: timelineStateRaw.value.controls.length,
      brokerHasTimelineData: stateHasTimelineData(timelineStateRaw.value),
      autosaveControlCount: autosave?.state.controls.length ?? 0,
      autosaveExpandedRowCount: Object.keys(autosave?.uiState?.expandedRows ?? {}).length,
    })
    if (!autosave) return
    if (!stateHasTimelineData(timelineStateRaw.value) && autosave.state) {
      restoringFromAutosave.value = true
      logRestore('apply-autosave-project-state', {
        controlCount: autosave.state.controls.length,
        expandedRowCount: Object.keys(autosave.uiState?.expandedRows ?? {}).length,
      })
      await applyProjectState({
        ...autosave.state,
        playing: false,
        state: 'paused',
      })
    }
  }

  function connect() {
    if (!options.wsUrl.value) return
    wsSender.value?.dispose()
    wsSender.value = null
    timelineClient.value?.dispose()
    timelineClient.value = null
    artworkClient.value?.dispose()
    artworkClient.value = null
    connecting.value = true
    clearAutosaveTimer()
    autosaveStatePending = null
    pendingAutosave.value = null
    autosaveLoaded.value = false
    initialRestoreResolved.value = false
    enforcePausedOnInitialState = true
    panelIds.value = []
    selectedPanelId.value = ''
    rootSpec.value = null
    isConnected.value = false
    wsSender.value = new Transports.WebSocket.Sender(options.wsUrl.value, options.chooseNetPanel, {
      autoReconnect: true,
      onPanelList: (ids) => {
        panelIds.value = ids
        if (ids.length === 0) {
          isConnected.value = false
          rootSpec.value = null
        }
        if (selectedPanelId.value && !ids.includes(selectedPanelId.value)) {
          selectedPanelId.value = ''
        }
      },
    })
    timelineClient.value = new Timeline.TimelineClient(wsSender.value, { autoRequestState: false })
    artworkClient.value = new Artwork.ArtworkClient(wsSender.value)
    artworkClient.value.onStatus = (status) => {
      artworkMode.value = status.mode
    }
    timelineClient.value.onRootSpec = (spec) => {
      logRestore('root-spec', {
        artworkId: options.artworkId.value,
        specName: spec.name,
      })
      pendingAutosave.value = null
      autosaveLoaded.value = false
      initialRestoreResolved.value = false
      timelineStateRaw.value = null
      timelineState.value = null
      rootSpec.value = spec
      isConnected.value = true
      connecting.value = false
      timelineClient.value?.requestState()
      void options.refreshProjects().then(async () => {
        const autosaveKey = `${options.artworkId.value}::autosave`
        pendingAutosave.value = await loadProject(autosaveKey)
        autosaveLoaded.value = true
        options.onAutosaveProjectLoaded?.(pendingAutosave.value)
        logRestore('autosave-loaded', {
          autosaveKey,
          found: !!pendingAutosave.value,
          controlCount: pendingAutosave.value?.state.controls.length ?? 0,
          expandedRowCount: Object.keys(pendingAutosave.value?.uiState?.expandedRows ?? {}).length,
        })
        void maybeResolveInitialRestore()
      })
    }
    timelineClient.value.onState = (event) => {
      const state = event.state
      let effectiveState = state
      logRestore('state-received', {
        source: event.source,
        seq: event.seq,
        state: state.state,
        playing: state.playing,
        controlCount: state.controls.length,
        enforcePausedOnInitialState,
      })
      if (timelinePlayLog) {
        console.info('[timeline:play:recv]', {
          source: event.source,
          seq: event.seq,
          stateSeq: event.stateSeq,
          time: state.time,
          state: state.state,
          playing: state.playing,
          localLastStateTime: lastStateTime.value,
          localLastStateAt: lastStateAt.value,
          localPlaying: playing.value,
          pendingPlaybackIntent: pendingPlaybackIntent.value,
        })
      }
      if (timelineStateLog) {
        console.info('[timeline:state]', {
          time: state.time,
          state: state.state,
          playing: state.playing,
          loopEnabled: state.loopEnabled,
          loopDurationSec: state.loopDurationSec,
        })
      }
      if (restoringFromAutosave.value && !stateHasTimelineData(state)) {
        return
      }
      if (restoringFromAutosave.value && stateHasTimelineData(state)) {
        restoringFromAutosave.value = false
      }
      if (enforcePausedOnInitialState) {
        enforcePausedOnInitialState = false
        if (state.playing) {
          logRestore('force-pause-initial-state', {
            source: event.source,
            seq: event.seq,
            time: state.time,
          })
          timelineClient.value?.setPlaying(false)
          effectiveState = {
            ...state,
            playing: false,
            state: 'paused',
          }
        }
      }
      timelineTime.value = effectiveState.time
      playing.value = effectiveState.playing
      alwaysRender.value = effectiveState.alwaysRender
      loopEnabled.value = effectiveState.loopEnabled
      loopDurationSec.value = effectiveState.loopDurationSec
      timelineStateRaw.value = effectiveState
      timelineState.value = options.normalizeProjectState(effectiveState)
      if (options.shouldUpdateClock()) {
        lastStateTime.value = effectiveState.time
        lastStateAt.value = performance.now()
        if (timelinePlayLog) {
          console.info('[timeline:play:clock-sync]', {
            time: effectiveState.time,
            state: effectiveState.state,
            playing: effectiveState.playing,
          })
        }
      }
      if (pendingPlaybackIntent.value && event.source === 'edit-echo' && event.seq === pendingPlaybackIntent.value.seq) {
        pendingPlaybackIntent.value = null
      }
      options.onStateProcessed()
      for (const control of effectiveState.controls) {
        const key = control.path.join('.')
        if (
          options.controlManualOverride[key] !== undefined
          && options.controlManualOverride[key] !== control.manualOverride
        ) {
          logManualOverride('state-transition', {
            path: key,
            previous: options.controlManualOverride[key],
            next: control.manualOverride,
            enabled: control.enabled,
            source: event.source,
            seq: event.seq,
            stateSeq: event.stateSeq,
          })
        }
        options.controlEnabled[key] = control.enabled
        options.controlManualOverride[key] = control.manualOverride
      }
      void maybeResolveInitialRestore()
      if (
        !isApplyingProject.value
        && initialRestoreResolved.value
        && options.canAutoSave()
        && !state.playing
        && state.state !== 'rendering'
      ) {
        scheduleAutosave(state)
      }
    }
    timelineClient.value.onControlUpdate = (update) => {
      Messages.walkUpdateTree(update.update, (path, leaf) => {
        if (path.length) {
          options.latestControlValues[path.join('.')] = {
            ...(options.latestControlValues[path.join('.')] ?? {}),
            ...options.extractLaneValues(leaf),
          }
          options.latestControlPayloads[path.join('.')] = options.extractAutomationPayload(leaf)
        }
        if (update.origin?.kind === 'controller' && path.length) {
          options.setLastUpdatedControl(path.join('.'))
        }
      })
    }
    timelineClient.value.requestState()
  }

  function disconnect() {
    timelineClient.value?.dispose()
    artworkClient.value?.dispose()
    wsSender.value?.dispose()
    clearAutosaveTimer()
    autosaveStatePending = null
    enforcePausedOnInitialState = false
    wsSender.value = null
    timelineClient.value = null
    artworkClient.value = null
    artworkMode.value = 'live'
    isConnected.value = false
    connecting.value = false
    panelIds.value = []
    selectedPanelId.value = ''
    rootSpec.value = null
    pendingAutosave.value = null
    autosaveLoaded.value = false
    initialRestoreResolved.value = false
    options.onAutosaveProjectLoaded?.(null)
  }

  const title = computed(() => rootSpec.value?.name ?? 'timeline')

  return {
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
    title,
    isApplyingProject,
    connect,
    disconnect,
    applyProjectState,
    pendingPlaybackIntent,
  }
}
