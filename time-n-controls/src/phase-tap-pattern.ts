import { PhaseClock } from './phase-clock'
import { PhaseQueue } from './phase-queue'
import { defaultModulationScale, getClampedModulationScale, type ModulationScale } from './high-level-controls/modulation-scale'

interface LoopEvent {
  down: number  // absolute bar position [0, phasesPerCycle)
  up: number    // absolute bar position [0, phasesPerCycle)
  velocity: number
}

// Did phase advance from `last` to `current` crossing `target`?
// Handles wrap-around (when current < last, we crossed the cycle boundary).
function phaseCrossed(target: number, last: number, current: number): boolean {
  const wrapped = current < last
  if (wrapped) {
    return target > last || target <= current
  }
  return target > last && target <= current
}

export class PhaseTapPattern {
  private queue: PhaseQueue
  private schedulerToken = 0

  private events: LoopEvent[] = []

  private isRecording = false
  private recordingStartUnwrappedPhase = 0
  private pressedAtBarPos: number | undefined
  private pressedVelocity = 0

  private isPlaying = false
  private outputIsDown = false
  private lastPhaseInCycle: number | null = null

  constructor(
    private clock: PhaseClock,
    public onOn: (velocity: number) => void = () => {},
    public onOff: () => void = () => {},
    private phasesPerCycle = 1,
    lookAheadMs = 70,
    private onProgressUpdate?: (progress: number) => void,
    private modulationScale: ModulationScale = defaultModulationScale,
  ) {
    this.queue = new PhaseQueue(lookAheadMs)

    this.queue.onEveryNotify = (phase, _rate) => {
      this.finalizeRecordingIfNeeded(phase)
      this.tickPlayback(phase)
      this.emitProgress(phase)
    }

    this.queue.onTimeJump = (delta) => {
      if (this.isRecording) {
        this.recordingStartUnwrappedPhase += delta
      }
      // Reset crossing detection to avoid spurious events after a clock switch
      this.lastPhaseInCycle = null
    }

    clock.registerQueue(this.queue)
  }

  tap(velocity = 1) {
    const now = this.clock.getPredictedUnwrappedPhase()
    this.finalizeRecordingIfNeeded(now)

    if (!this.isRecording) {
      this.startRecording(now)
    }

    this.pressedAtBarPos = ((now % this.phasesPerCycle) + this.phasesPerCycle) % this.phasesPerCycle
    this.pressedVelocity = velocity
    this.onOn(this.scaleVelocity(velocity))
  }

  release() {
    const now = this.clock.getPredictedUnwrappedPhase()
    this.finalizeRecordingIfNeeded(now)

    if (!this.isRecording || this.pressedAtBarPos === undefined) {
      return
    }

    const up = ((now % this.phasesPerCycle) + this.phasesPerCycle) % this.phasesPerCycle
    this.events.push({ down: this.pressedAtBarPos, up, velocity: this.pressedVelocity })
    this.pressedAtBarPos = undefined
    this.pressedVelocity = 0
    this.onOff()
  }

  getPhaseInCycle(): number {
    const now = this.clock.getPredictedUnwrappedPhase()

    if (this.isRecording) {
      return Math.min(this.phasesPerCycle, Math.max(0, now - this.recordingStartUnwrappedPhase))
    }

    if (this.isPlaying) {
      return ((now % this.phasesPerCycle) + this.phasesPerCycle) % this.phasesPerCycle
    }

    return 0
  }

  stop() {
    if (this.outputIsDown || this.pressedAtBarPos !== undefined) {
      this.onOff()
    }

    this.schedulerToken++
    this.queue.cancelAll()

    this.isRecording = false
    this.pressedAtBarPos = undefined
    this.pressedVelocity = 0

    this.isPlaying = false
    this.outputIsDown = false
    this.lastPhaseInCycle = null
    this.emitProgress()
  }

  clear() {
    this.stop()
    this.events = []
  }

  getPatternLength(): number {
    return this.events.length
  }

  dispose() {
    this.stop()
    this.clock.removeQueue(this.queue)
  }

  private startRecording(now: number) {
    this.stop()
    this.events = []
    this.isRecording = true
    this.recordingStartUnwrappedPhase = now

    const token = ++this.schedulerToken
    const recordEnd = this.recordingStartUnwrappedPhase + this.phasesPerCycle
    this.queue.whenPhase(recordEnd, (msUntil) => {
      setTimeout(() => {
        if (token !== this.schedulerToken) return
        this.finalizeRecordingIfNeeded(Math.max(recordEnd, this.clock.getPredictedUnwrappedPhase()))
      }, msUntil)
    })
  }

  private finalizeRecordingIfNeeded(now: number) {
    if (!this.isRecording) return

    const recordEnd = this.recordingStartUnwrappedPhase + this.phasesPerCycle
    if (now < recordEnd) return

    if (this.pressedAtBarPos !== undefined) {
      // Note still held at recording end — close it at the cycle boundary (= recording start position)
      const cycleAnchor = ((this.recordingStartUnwrappedPhase % this.phasesPerCycle) + this.phasesPerCycle) % this.phasesPerCycle
      this.events.push({ down: this.pressedAtBarPos, up: cycleAnchor, velocity: this.pressedVelocity })
      this.pressedAtBarPos = undefined
      this.pressedVelocity = 0
      this.onOff()
    }

    this.isRecording = false
    this.emitProgress()

    if (this.events.length === 0) return

    this.events.sort((a, b) => a.down - b.down)
    this.isPlaying = true
    this.lastPhaseInCycle = null
  }

  private emitProgress(unwrappedPhase = this.clock.getPredictedUnwrappedPhase()) {
    if (!this.onProgressUpdate) return

    const progress = this.isRecording
      ? Math.min(1, Math.max(0, (unwrappedPhase - this.recordingStartUnwrappedPhase) / this.phasesPerCycle))
      : 0
    this.onProgressUpdate(progress)
  }

  private tickPlayback(unwrappedPhase: number) {
    if (!this.isPlaying || this.events.length === 0) return

    const currentInCycle = ((unwrappedPhase % this.phasesPerCycle) + this.phasesPerCycle) % this.phasesPerCycle

    if (this.lastPhaseInCycle === null) {
      // First tick after playback start or clock switch — initialize without firing
      this.lastPhaseInCycle = currentInCycle
      // Sync output state: are we currently inside an active event?
      for (const event of this.events) {
        const inside = event.down <= event.up
          ? currentInCycle >= event.down && currentInCycle < event.up
          : currentInCycle >= event.down || currentInCycle < event.up
        if (inside && !this.outputIsDown) {
          this.outputIsDown = true
          this.onOn(this.scaleVelocity(event.velocity))
          break
        }
      }
      return
    }

    const last = this.lastPhaseInCycle
    this.lastPhaseInCycle = currentInCycle
    const wrapped = currentInCycle < last

    type PendingFire = { sortKey: number; type: 'on' | 'off'; velocity: number }
    const toFire: PendingFire[] = []

    // Sort key: temporal order within this tick (first-half-of-wrap before second-half)
    const sortKey = (t: number) =>
      wrapped && t <= last ? this.phasesPerCycle - last + t : t - last

    for (const event of this.events) {
      if (phaseCrossed(event.down, last, currentInCycle)) {
        toFire.push({ sortKey: sortKey(event.down), type: 'on', velocity: event.velocity })
      }
      if (phaseCrossed(event.up, last, currentInCycle)) {
        toFire.push({ sortKey: sortKey(event.up), type: 'off', velocity: 0 })
      }
    }

    toFire.sort((a, b) => a.sortKey - b.sortKey)

    for (const ev of toFire) {
      if (ev.type === 'on' && !this.outputIsDown) {
        this.outputIsDown = true
        this.onOn(this.scaleVelocity(ev.velocity))
      } else if (ev.type === 'off' && this.outputIsDown) {
        this.outputIsDown = false
        this.onOff()
      }
    }
  }

  private scaleVelocity(velocity: number): number {
    return velocity * getClampedModulationScale(this.modulationScale)
  }
}
