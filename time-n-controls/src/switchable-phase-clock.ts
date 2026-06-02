import { PhaseClock } from './phase-clock'
import { PhaseQueue } from './phase-queue'
import { PhaseQueueManager } from './phase-queue-manager'
import { OffPhaseClock } from './phase-clocks/off-phase-clock'
import { ConstantPhaseClock } from './phase-clocks/constant-phase-clock'
import { BpmTapPhaseClock } from './phase-clocks/bpm-tap-phase-clock'
import { AutoPhase } from './auto-phase'

export type PhaseSource = 'off' | 'constant' | 'auto' | 'tap'

/**
 * SwitchablePhaseClock: Wrapper that allows switching between different phase sources.
 *
 * Contains all 4 phase clocks and forwards method calls to the currently active one.
 * Queues are managed centrally via PhaseQueueManager so they survive source switches
 * without bursting events or losing patterns.
 */
export class SwitchablePhaseClock implements PhaseClock {
  private offClock: OffPhaseClock
  private constantClock: ConstantPhaseClock
  private tapClock: BpmTapPhaseClock
  private autoClock: AutoPhase

  private activeClock: PhaseClock
  private activeSource: PhaseSource
  private queueManager = new PhaseQueueManager()

  constructor(autoPhase: AutoPhase) {
    this.offClock = new OffPhaseClock()
    this.constantClock = new ConstantPhaseClock(120, 4)
    this.tapClock = new BpmTapPhaseClock(120, 4)
    this.autoClock = autoPhase

    this.activeSource = 'auto'
    this.activeClock = this.autoClock
  }

  setActiveSource(source: PhaseSource): void {
    this.activeSource = source
    switch (source) {
      case 'off':
        this.activeClock = this.offClock
        break
      case 'constant':
        this.activeClock = this.constantClock
        break
      case 'tap':
        this.activeClock = this.tapClock
        break
      case 'auto':
        this.activeClock = this.autoClock
        break
    }
    this.activeClock.tick(0)
    this.queueManager.handleTimeJump(this.activeClock.getUnwrappedPhase())
  }

  getActiveSource(): PhaseSource {
    return this.activeSource
  }

  getOffClock(): OffPhaseClock {
    return this.offClock
  }

  getConstantClock(): ConstantPhaseClock {
    return this.constantClock
  }

  getTapClock(): BpmTapPhaseClock {
    return this.tapClock
  }

  getAutoClock(): AutoPhase {
    return this.autoClock
  }

  tickAll(deltaS?: number, now?: number): void {
    this.autoClock.tick(deltaS)
    this.tapClock.tick(deltaS)
  }

  getPhase(): number {
    return this.activeClock.getPhase()
  }

  getUnwrappedPhase(): number {
    return this.activeClock.getUnwrappedPhase()
  }

  getPredictedUnwrappedPhase(): number {
    return this.activeClock.getPredictedUnwrappedPhase()
  }

  getPhaseRate(): number {
    return this.activeClock.getPhaseRate()
  }

  getAbsoluteTime(): number {
    return this.activeClock.getAbsoluteTime()
  }

  getSeconds(): number {
    return this.activeClock.getSeconds()
  }

  getTickDeltaS(): number {
    return this.activeClock.getTickDeltaS()
  }

  getCappedTickDeltaS(amount?: number): number {
    return this.activeClock.getCappedTickDeltaS(amount)
  }

  tick(deltaS?: number, now?: number): void {
    this.activeClock.tick(deltaS, now)
    this.queueManager.notify(this.activeClock.getUnwrappedPhase(), this.activeClock.getPhaseRate())
  }

  reset(): void {
    this.activeClock.reset()
  }

  registerQueue(queue: PhaseQueue): void {
    this.queueManager.registerQueue(queue)
  }

  removeQueue(queue: PhaseQueue): void {
    this.queueManager.removeQueue(queue)
  }

  setUnwrappedPhase(phase: number): void {
    if (this.activeClock.setUnwrappedPhase) {
      this.activeClock.setUnwrappedPhase(phase)
      this.queueManager.handleTimeJump(phase)
    }
  }
}
