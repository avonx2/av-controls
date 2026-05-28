interface PhaseWaiter {
  targetUnwrappedPhase: number
  callback: (msUntil: number) => void
}

export class PhaseQueue {
  private waiters: PhaseWaiter[] = []

  public onEveryNotify: ((unwrappedPhase: number, phaseRate: number) => void) | null = null
  public onTimeJump: ((delta: number) => void) | null = null

  constructor(
    private lookAheadMs: number = 70
  ) {}

  notify(unwrappedPhase: number, phaseRate: number) {
    if (phaseRate <= 0.001) return

    this.onEveryNotify?.(unwrappedPhase, phaseRate)

    const lookAheadPhase = (this.lookAheadMs / 1000) * phaseRate

    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!
      if (unwrappedPhase + lookAheadPhase >= waiter.targetUnwrappedPhase) {
        const phaseDiff = waiter.targetUnwrappedPhase - unwrappedPhase
        const msUntil = (phaseDiff / phaseRate) * 1000
        waiter.callback(Math.max(0, msUntil))
        this.waiters.shift()
      } else {
        break
      }
    }
  }

  cancelAll() {
    this.waiters = []
  }

  whenPhase(targetUnwrappedPhase: number, callback: (msUntil: number) => void) {
    const waiter: PhaseWaiter = { targetUnwrappedPhase, callback }
    const idx = this.waiters.findIndex(w => w.targetUnwrappedPhase > targetUnwrappedPhase)
    if (idx === -1) {
      this.waiters.push(waiter)
    } else {
      this.waiters.splice(idx, 0, waiter)
    }
  }

  translateWaiters(delta: number): void {
    for (const waiter of this.waiters) {
      waiter.targetUnwrappedPhase += delta
    }
    this.onTimeJump?.(delta)
  }

  getPendingCount(): number {
    return this.waiters.length
  }
}
