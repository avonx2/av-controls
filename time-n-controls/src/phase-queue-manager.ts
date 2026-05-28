import { PhaseQueue } from './phase-queue'

/**
 * Manages multiple PhaseQueues independent of specific clocks.
 * Handles notifying queues and translating their waiters during time jumps.
 */
export class PhaseQueueManager {
  private queues: PhaseQueue[] = []
  private lastPhase: number | null = null

  registerQueue(queue: PhaseQueue): void {
    if (!this.queues.includes(queue)) {
      this.queues.push(queue)
    }
  }

  removeQueue(queue: PhaseQueue): void {
    const idx = this.queues.indexOf(queue)
    if (idx > -1) {
      this.queues.splice(idx, 1)
    }
  }

  /**
   * Called every frame by the currently active clock.
   */
  notify(unwrappedPhase: number, phaseRate: number): void {
    if (phaseRate <= 0.001) return

    for (const q of this.queues) {
      q.notify(unwrappedPhase, phaseRate)
    }

    this.lastPhase = unwrappedPhase
  }

  /**
   * Called when switching clocks to translate all pending waiters into the new phase space.
   * This prevents stale events from firing and keeps patterns repeating seamlessly.
   */
  handleTimeJump(newUnwrappedPhase: number): void {
    if (this.lastPhase === null) {
      this.lastPhase = newUnwrappedPhase
      return
    }

    const delta = newUnwrappedPhase - this.lastPhase
    for (const q of this.queues) {
      q.translateWaiters(delta)
    }
    this.lastPhase = newUnwrappedPhase
  }
}
