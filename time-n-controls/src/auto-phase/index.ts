import { Controls } from '@av-controls/protocol'
import {
  createAudioProcessorUrl,
  AUDIO_PROCESSOR_NAME,
  type ModelMeta,
} from 'dance-ai'
import type { AutoPhaseInferenceWorkerResponse } from './inference-worker'
import { AutoPhaseClock } from './phase-clock'
import { PhaseClock } from '../phase-clock'
import { PhaseQueue } from '../phase-queue'

// Re-export the model frontend + worklet helpers from dance-ai for convenience
export { MelFrontend, createAudioProcessorUrl, AUDIO_PROCESSOR_NAME } from 'dance-ai'
export type { ModelMeta, FrameEstimate } from 'dance-ai'
export { AutoPhaseClock } from './phase-clock'

export type AutoPhaseLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type AutoPhaseLogger = (level: AutoPhaseLogLevel, message: string, data?: unknown) => void

export interface AutoPhaseConfig {
  /** Path to the ONNX model file (in artwork's public directory) */
  modelPath: string
  /** Path to the model metadata JSON file (in artwork's public directory) */
  metaPath?: string
  /** Menu control spec - artwork defines position/size, AutoPhase manages options */
  menuSpec: Controls.Menu.Spec
  /** LocalStorage key for device preference */
  storageKey?: string
  /**
   * Model hyperparameters as a parsed {@link ModelMeta}. Prefer `metaPath` for
   * current dance-ai models so metadata is loaded alongside the ONNX file.
   */
  meta?: ModelMeta
  /** Enable dance-ai causal level normalization (default true). */
  normalize?: boolean
  /** Target sample rate (default 24000). Ignored if `meta` is provided. */
  sampleRate?: number
  /** Audio frame size (default 400). Ignored if `meta` is provided. */
  frameSize?: number
  /** FFT frames per mel frame (default 2). Ignored if `meta` is provided. */
  fftFrames?: number
  /** Number of mel bands (default 96). Ignored if `meta` is provided. */
  nMels?: number
  /** Mel filterbank low edge in Hz (default 27.5). Ignored if `meta` is provided. */
  fMin?: number
  /** Mel filterbank high edge in Hz (default 8000). Ignored if `meta` is provided. */
  fMax?: number
  /** Recurrent hidden size (default 512). Ignored if `meta` is provided. */
  hiddenSize?: number
  /** Number of recurrent layers (default 2). Ignored if `meta` is provided. */
  numLayers?: number
  /** Model type string; `phase_lstm_mel` enables LSTM cell state (default `phase_gru_mel`). Ignored if `meta` is provided. */
  modelType?: string
  /** Normalizer floor to cap max gain (default 0.001 for higher sensitivity to quiet inputs). */
  normalizerFloor?: number
  /** Called when an incoming audio frame is dropped in favor of a newer one */
  onAudioFrameDropped?: () => void
  /** Optional logging sink for AutoPhase diagnostics. */
  logger?: AutoPhaseLogger
}

export type AutoPhaseInputMode = 'disabled' | 'audio device input' | 'simulate'

type AudioDeviceInfo = {
  deviceId: string
  label: string
}

/**
 * AutoPhase: Automatic bar-phase detection using ONNX inference.
 *
 * Usage:
 * ```typescript
 * const autoPhase = new AutoPhase({
 *   modelPath: '/model.onnx',
 *   menuSpec: new Controls.Menu.Spec(
 *     new Controls.Base.Args('audio', 90, 55, 10, 5, '#48f'),
 *     ['Grant mic access'],
 *     'Audio input'
 *   )
 * })
 *
 * // Add menu control to your artwork's controls
 * const controls = {
 *   audio: autoPhase.getMenu(),
 *   // ... other controls
 * }
 *
 * // In render loop
 * function render() {
 *   autoPhase.tick()
 *   const phase = autoPhase.getPhase()
 *   // Use phase for animations...
 * }
 * ```
 */
export class AutoPhase implements PhaseClock {
  private readonly grantAccessLabel = 'Grant mic access'
  private readonly syntheticPhaseRate = 0.5 // 4/4 @ 120 BPM => 0.5 bars/sec

  private modelLoadPromise: Promise<void>
  private phaseClock: AutoPhaseClock
  private inferenceWorker: Worker | null = null
  private resolveModelLoad: (() => void) | null = null
  private rejectModelLoad: ((err: unknown) => void) | null = null
  private resolveCurrentInference: (() => void) | null = null

  private audioContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private streamSource: MediaStreamAudioSourceNode | null = null
  private currentStream: MediaStream | null = null

  private menuControl: Controls.Menu.Receiver
  private devices: AudioDeviceInfo[] = []
  private permissionGranted = false
  private modelLoaded = false
  private loadedModelMeta: ModelMeta | null = null
  private isCapturing = false
  private audioLevel = 0
  private phaseOffsetMs = 0
  private enabled = true
  private inputMode: AutoPhaseInputMode = 'audio device input'
  private selectedDeviceId: string | null = null
  private inferenceInFlight = false
  private pendingAudioFrame: Float32Array | null = null
  private droppedAudioFrames = 0
  private lastDropLogAtMs = -Infinity
  private disposed = false

  private readonly modelPath: string
  private readonly modelMeta: ModelMeta | string
  private readonly normalize: boolean
  private readonly normalizerFloor: number
  private readonly storageKey: string
  private readonly onAudioFrameDropped?: () => void
  private readonly logger?: AutoPhaseLogger

  constructor(config: AutoPhaseConfig) {
    this.modelPath = config.modelPath
    this.storageKey = config.storageKey ?? 'avonx-autophase-device'
    this.normalize = config.normalize ?? true
    this.normalizerFloor = config.normalizerFloor ?? 0.001
    this.onAudioFrameDropped = config.onAudioFrameDropped
    this.logger = config.logger

    // Defaults are kept for older call sites that do not provide a .meta.json.
    this.modelMeta = config.metaPath ?? config.meta ?? {
      model_type: config.modelType ?? 'phase_gru_mel',
      samplerate: config.sampleRate ?? 24000,
      frame_size: config.frameSize ?? 400,
      fft_frames: config.fftFrames ?? 2,
      n_mels: config.nMels ?? 96,
      f_min: config.fMin ?? 27.5,
      f_max: config.fMax ?? 8000,
      hidden: config.hiddenSize ?? 512,
      n_layers: config.numLayers ?? 2,
    }

    // Initialize phase clock
    this.phaseClock = new AutoPhaseClock()

    // Create menu control for device selection using artwork-provided spec
    this.menuControl = new Controls.Menu.Receiver(
      config.menuSpec,
      (index, _value) => this.handleMenuSelection(index)
    )
    this.menuControl.setOptions([this.grantAccessLabel], 0)
    this.menuControl.setDescription('Audio input device')

    const savedDeviceId = localStorage.getItem(this.storageKey)
    if (savedDeviceId) {
      this.selectedDeviceId = savedDeviceId
    }

    // Start loading the model
    this.modelLoadPromise = this.loadModel()
  }

  private logDroppedAudioFrames() {
    if (this.droppedAudioFrames <= 0) {
      return
    }
    const nowMs = performance.now()
    if (nowMs - this.lastDropLogAtMs < 1000) {
      return
    }
    this.lastDropLogAtMs = nowMs
    this.log('warn', 'Dropping audio frames, keeping latest only', { dropped: this.droppedAudioFrames })
    this.droppedAudioFrames = 0
  }

  private enqueueAudioFrame(audioFrame: Float32Array) {
    if (this.inferenceInFlight) {
      if (this.pendingAudioFrame) {
        this.droppedAudioFrames++
        this.onAudioFrameDropped?.()
      }
      this.pendingAudioFrame = audioFrame
      this.logDroppedAudioFrames()
      return
    }

    this.inferenceInFlight = true
    void this.processQueuedAudioFrames(audioFrame)
  }

  private async processQueuedAudioFrames(initialFrame: Float32Array) {
    let frame: Float32Array | null = initialFrame

    try {
      while (frame && !this.isDisposed()) {
        await this.processFrameOnWorker(frame)
        frame = this.pendingAudioFrame
        this.pendingAudioFrame = null
      }
    } finally {
      this.inferenceInFlight = false
      if (!this.isDisposed() && this.pendingAudioFrame) {
        const latestFrame = this.pendingAudioFrame
        this.pendingAudioFrame = null
        this.inferenceInFlight = true
        void this.processQueuedAudioFrames(latestFrame)
      }
    }
  }

  private isDisposed() {
    return this.disposed
  }

  private loadModel() {
    this.inferenceWorker = new Worker(new URL('./inference-worker.ts', import.meta.url), { type: 'module' })
    this.inferenceWorker.onmessage = (event: MessageEvent<AutoPhaseInferenceWorkerResponse>) => {
      this.handleInferenceWorkerMessage(event.data)
    }
    this.inferenceWorker.onerror = (event) => {
      this.handleInferenceWorkerError(new Error(event.message || 'AutoPhase inference worker failed'))
    }
    this.inferenceWorker.onmessageerror = () => {
      this.handleInferenceWorkerError(new Error('AutoPhase inference worker message failed'))
    }

    const loadPromise = new Promise<void>((resolve, reject) => {
      this.resolveModelLoad = resolve
      this.rejectModelLoad = reject
    })

    this.inferenceWorker.postMessage({
      type: 'init',
      modelPath: this.modelPath,
      modelMeta: this.modelMeta,
      normalize: this.normalize,
      normalizerFloor: this.normalizerFloor,
    })

    return loadPromise
  }

  private handleInferenceWorkerMessage(message: AutoPhaseInferenceWorkerResponse) {
    if (this.disposed) {
      return
    }

    if (message.type === 'ready') {
      this.loadedModelMeta = message.meta
      this.modelLoaded = true
      this.resolveModelLoad?.()
      this.resolveModelLoad = null
      this.rejectModelLoad = null
      this.log('info', 'Model loaded successfully in inference worker')
      return
    }

    if (message.type === 'error') {
      const err = new Error(message.message)
      if (!this.modelLoaded) {
        this.rejectModelLoad?.(err)
        this.resolveModelLoad = null
        this.rejectModelLoad = null
      }
      this.resolveCurrentInference?.()
      this.resolveCurrentInference = null
      this.log('error', 'Inference worker error', err)
      return
    }

    for (const estimate of message.estimates) {
      this.phaseClock.updateFromInference(
        estimate.phase,
        estimate.barDurationS,
        estimate.expectedPhaseError
      )
    }
    this.resolveCurrentInference?.()
    this.resolveCurrentInference = null
  }

  private handleInferenceWorkerError(err: Error) {
    if (!this.modelLoaded) {
      this.rejectModelLoad?.(err)
      this.resolveModelLoad = null
      this.rejectModelLoad = null
    }
    this.resolveCurrentInference?.()
    this.resolveCurrentInference = null
    this.log('error', 'Inference worker failed', err)
  }

  private log(level: AutoPhaseLogLevel, message: string, data?: unknown) {
    if (this.logger) {
      this.logger(level, message, data)
      return
    }

    const fullMessage = `[AutoPhase] ${message}`
    if (level === 'error') console.error(fullMessage, data ?? '')
    else if (level === 'warn') console.warn(fullMessage, data ?? '')
    else if (level === 'info') console.info(fullMessage, data ?? '')
    else console.debug(fullMessage, data ?? '')
  }

  private async handleMenuSelection(index: number) {
    if (!this.permissionGranted) {
      // Before permission the only option is "Grant mic access"
      await this.requestPermission()
    } else {
      const device = this.devices[index]
      if (device) {
        await this.selectDevice(device.deviceId)
      }
    }
  }

  private async requestPermission() {
    try {
      // Request permission with any audio device
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Stop the temporary stream
      stream.getTracks().forEach(track => track.stop())

      this.permissionGranted = true
      await this.enumerateDevices()
    } catch (err) {
      this.log('error', 'Microphone permission denied', err)
      this.menuControl.setDescription('Microphone access denied')
    }
  }

  private async enumerateDevices() {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices()
      this.devices = allDevices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Device ${d.deviceId.slice(0, 8)}`
        }))

      // Update menu options
      const options = this.devices.map(d => d.label)
      this.menuControl.setOptions(options, 0)
      this.menuControl.setDescription('Select audio input device')

      // Restore saved preference
      const savedDeviceId = localStorage.getItem(this.storageKey)
      if (savedDeviceId) {
        const idx = this.devices.findIndex(d => d.deviceId === savedDeviceId)
        if (idx >= 0) {
          this.menuControl.setOptions(options, idx)
          await this.selectDevice(savedDeviceId)
        }
      }
    } catch (err) {
      this.log('error', 'Failed to enumerate devices', err)
    }
  }

  private async selectDevice(deviceId: string) {
    // Save preference
    localStorage.setItem(this.storageKey, deviceId)
    this.selectedDeviceId = deviceId

    if (this.inputMode === 'audio device input') {
      // Start or switch audio capture
      await this.startCapture(deviceId)
    }
  }

  private stopCapture() {
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(track => track.stop())
      this.currentStream = null
    }
    if (this.streamSource) {
      this.streamSource.disconnect()
      this.streamSource = null
    }
    this.isCapturing = false
    this.audioLevel = 0
  }

  private async startCapture(deviceId: string) {
    try {
      await this.modelLoadPromise
      if (!this.loadedModelMeta) {
        throw new Error('model is not loaded')
      }
      const meta = this.loadedModelMeta

      // Create audio context at target sample rate if not exists
      if (!this.audioContext) {
        this.audioContext = new AudioContext({ sampleRate: meta.samplerate })
      }

      // Resume if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume()
      }

      // Register worklet if not already registered
      if (!this.workletNode) {
        const processorUrl = createAudioProcessorUrl()
        await this.audioContext.audioWorklet.addModule(processorUrl)
        URL.revokeObjectURL(processorUrl)
      }

      // Stop previous stream
      this.stopCapture()

      // Get new stream
      this.currentStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          sampleRate: { ideal: meta.samplerate },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })

      // Create source node
      this.streamSource = this.audioContext.createMediaStreamSource(this.currentStream)

      // Create or reuse worklet node
      if (!this.workletNode) {
        this.workletNode = new AudioWorkletNode(this.audioContext, AUDIO_PROCESSOR_NAME, {
          processorOptions: { frameSize: meta.frame_size }
        })

        this.workletNode.port.onmessage = (event) => {
          this.enqueueAudioFrame(event.data as Float32Array)
        }
      }

      // Connect
      this.streamSource.connect(this.workletNode)
      this.isCapturing = true

      this.log('info', 'Audio capture started')
    } catch (err) {
      this.log('error', 'Failed to start audio capture', err)
      this.isCapturing = false
    }
  }

  private async processFrameOnWorker(audioFrame: Float32Array) {
    // Compute RMS audio level
    let sumSquares = 0
    for (let i = 0; i < audioFrame.length; i++) {
      sumSquares += audioFrame[i]! * audioFrame[i]!
    }
    const rms = Math.sqrt(sumSquares / audioFrame.length)
    // Convert to dB-like scale (0-1 range, with some headroom)
    this.audioLevel = Math.min(1, rms * 5)

    if (this.inputMode !== 'audio device input') {
      return
    }
    if (!this.inferenceWorker || !this.modelLoaded) {
      return
    }
    if (!this.enabled) {
      return
    }

    // Diagnostic logging to inspect quiet mic levels.
    if (this.logger && Math.random() < 0.01) { // Log 1% of frames to avoid flooding (~once per second)
      let frameMax = 0
      for (let i = 0; i < audioFrame.length; i++) {
        const val = Math.abs(audioFrame[i]!)
        if (val > frameMax) frameMax = val
      }
      this.log('debug', 'Audio peak', { peak: Number(frameMax.toFixed(5)) })
    }

    await new Promise<void>((resolve) => {
      const worker = this.inferenceWorker
      if (!worker) {
        resolve()
        return
      }
      this.resolveCurrentInference = resolve
      worker.postMessage({ type: 'frame', audioFrame }, [audioFrame.buffer])
    })
  }

  // PhaseClock interface implementation

  getPhase(): number {
    // Apply phase offset: offset_cycles = offset_ms / 1000 * phaseRate
    const offsetCycles = (this.phaseOffsetMs / 1000) * this.phaseClock.getPhaseRate()
    const phase = this.phaseClock.getPhase() + offsetCycles
    // Wrap to [0, 1)
    return ((phase % 1) + 1) % 1
  }

  getUnwrappedPhase(): number {
    const offsetCycles = (this.phaseOffsetMs / 1000) * this.phaseClock.getPhaseRate()
    return this.phaseClock.getUnwrappedPhase() + offsetCycles
  }

  getPredictedUnwrappedPhase(): number {
    const offsetCycles = (this.phaseOffsetMs / 1000) * this.phaseClock.getPhaseRate()
    return this.phaseClock.getPredictedUnwrappedPhase() + offsetCycles
  }

  getPhaseRate(): number {
    return this.phaseClock.getPhaseRate()
  }

  getSeconds(): number {
    return this.phaseClock.getSeconds()
  }

  getAbsoluteTime(): number {
    // AutoPhase has no external time anchor; report accumulated elapsed time
    // (the TimeClock.getAbsoluteTime contract's documented fallback).
    return this.phaseClock.getSeconds()
  }

  getTickDeltaS(): number {
    return this.phaseClock.getTickDeltaS()
  }

  getCappedTickDeltaS(amount?: number): number {
    return this.phaseClock.getCappedTickDeltaS(amount)
  }

  tick(deltaS?: number): void {
    if (this.enabled && this.inputMode === 'simulate') {
      this.phaseClock.setPhaseRate(this.syntheticPhaseRate)
    }
    this.phaseClock.tick(deltaS)
  }

  registerQueue(queue: PhaseQueue): void {
    this.phaseClock.registerQueue(queue)
  }

  removeQueue(queue: PhaseQueue): void {
    this.phaseClock.removeQueue(queue)
  }

  reset(): void {
    this.phaseClock.reset()
    this.inferenceWorker?.postMessage({ type: 'reset' })
  }

  // Public API

  /**
   * Get the Menu control for device selection.
   * Add this to your artwork's controls dictionary.
   */
  getMenu(): Controls.Menu.Receiver {
    return this.menuControl
  }

  setInputMode(mode: AutoPhaseInputMode): void {
    if (this.inputMode === mode) {
      return
    }

    this.inputMode = mode
    this.reset()

    if (mode === 'disabled') {
      this.stopCapture()
      return
    }

    if (mode === 'simulate') {
      this.stopCapture()
      this.phaseClock.setPhaseRate(this.syntheticPhaseRate)
      return
    }

    // mode === 'audio device input'
    if (this.permissionGranted && this.selectedDeviceId) {
      void this.startCapture(this.selectedDeviceId)
    } else {
      this.stopCapture()
    }
  }

  getInputMode(): AutoPhaseInputMode {
    return this.inputMode
  }

  /**
   * Check if the model is loaded and ready.
   */
  isReady(): boolean {
    return this.modelLoaded
  }

  /**
   * Check if audio capture is active.
   */
  isActive(): boolean {
    return this.isCapturing
  }

  /**
   * Get the current audio input level (0-1 range).
   */
  getAudioLevel(): number {
    return this.audioLevel
  }

  /**
   * Set the phase offset in milliseconds for latency compensation.
   * Positive values shift the phase forward (compensate for visual delay).
   * Negative values shift the phase backward.
   */
  setPhaseOffset(ms: number): void {
    this.phaseOffsetMs = ms
  }

  /**
   * Get the current phase offset in milliseconds.
   */
  getPhaseOffset(): number {
    return this.phaseOffsetMs
  }

  setPhaseSmoothing(value: number): void {
    this.phaseClock.setPhaseSmoothing(value)
  }

  getPhaseSmoothing(): number {
    return this.phaseClock.getPhaseSmoothing()
  }

  /**
   * Enable auto phase inference.
   */
  async start(): Promise<void> {
    this.enabled = true
    if (this.inputMode === 'simulate') {
      this.phaseClock.setPhaseRate(this.syntheticPhaseRate)
    }
  }

  /**
   * Disable auto phase inference while keeping audio input active.
   */
  stop(): void {
    this.enabled = false
    this.reset()
  }

  /**
   * Check if auto phase detection is enabled.
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Feed a silence frame (for background tab or no audio).
   */
  feedSilence() {
    if (!this.modelLoaded || !this.enabled || !this.loadedModelMeta) return

    // Process silence through the estimator
    const silenceFrame = new Float32Array(this.loadedModelMeta.frame_size)
    this.enqueueAudioFrame(silenceFrame)
  }

  /**
   * Stop audio capture and release resources.
   */
  dispose() {
    this.disposed = true
    this.modelLoaded = false
    this.stopCapture()

    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.audioContext) {
      void this.audioContext.close().catch((err: unknown) => {
        this.log('warn', 'Failed to close audio context', err)
      })
      this.audioContext = null
    }

    this.pendingAudioFrame = null
    this.inferenceInFlight = false
    this.resolveCurrentInference?.()
    this.resolveCurrentInference = null
    this.droppedAudioFrames = 0

    this.inferenceWorker?.postMessage({ type: 'dispose' })
    this.inferenceWorker?.terminate()
    this.inferenceWorker = null
    this.loadedModelMeta = null

    this.isCapturing = false
  }
}
