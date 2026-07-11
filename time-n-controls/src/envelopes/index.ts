import { TimeClock } from '../phase-clock'

export abstract class Envelope {
  constructor(
  ) {
  }
  abstract trigger(v: number): void
  abstract release(): void
  abstract getValue(): number
}

export class ExponentialDecay extends Envelope {
  private lastTriggerTime: number
  private base: number = 0
  private stretch: number = 1

  constructor(
    private decaySeconds: number,
    private clock: TimeClock,
    private sink = 0.001,
    private stackTriggers = 0.5
  ) {
    super()
    this.lastTriggerTime = -decaySeconds
    this.setEnvelope(sink, decaySeconds)
  }

  setEnvelope(sink: number, decay: number) {
    this.base = sink ** (1 / decay)
    this.stretch = 1 / (1 - sink)
  }

  trigger(v: number) {
    const nowValue = this.getValue() * this.stackTriggers + v
    // figure out decay start (can be in the future to allow v > 1)
    // ok the function is usually v(t) = base ** t
    // now we know v(now) = nowValue
    // what is now?
    // nowValue = base ** t
    // t = log(nowValue) / log(base)
    const t = Math.log(nowValue) / Math.log(this.base)
    this.lastTriggerTime = this.clock.getSeconds() - t
  }

  release() {
  }

  getValue() {
    const t = Math.max(0, this.clock.getSeconds() - this.lastTriggerTime)
    if(t < this.decaySeconds) {
      return (this.base ** t - this.sink) * this.stretch
    } else {
      return 0
    }
  }
}

export class LinearDecay extends Envelope {
  private lastTriggerTime: number
  private slope: number

  constructor(
    private decaySeconds: number,
    private clock: TimeClock,
    private stackTriggers = 0.5
  ) {
    super()
    this.lastTriggerTime = -decaySeconds
    this.slope = 1 / decaySeconds
  }

  trigger(v: number) {
    const nowValue = this.getValue() * this.stackTriggers + v
    // I)   v(t) = 1 - t * slope
    // II)  v(now) = nowValue
    // nowValue = 1 - t * slope
    const t = (1 - nowValue) / this.slope
    this.lastTriggerTime = this.clock.getSeconds() - t
  }

  release() {
  }

  getValue() {
    const t = Math.max(0, this.clock.getSeconds() - this.lastTriggerTime)
    if(t < this.decaySeconds) {
      return 1 - t * this.slope
    } else {
      return 0
    }
  }
}

/**
 * Core bump shape function (asymmetric rational bump curve).
 */
export function bumpShape(x: number, s: number = 14): number {
  if (x <= 0 || x >= 1) return 0
  const xs = x * s
  const xsp1 = xs + 1
  return (xs * (1 - x)) / (xsp1 * xsp1)
}

/**
 * Representation of a single active bump.
 */
export interface StaggeredBump {
  start: number
  size: number
}

/**
 * StaggeredBumpEnvelope manages multiple concurrent bumps that propagate
 * across generic positions with a stagger/delay.
 */
export class StaggeredBumpEnvelope extends Envelope {
  private bumps: StaggeredBump[] = []

  constructor(
    public duration: number = 5,
    public versatz: number = 0.5,
    public s: number = 14,
    private clock?: TimeClock
  ) {
    super()
  }

  private getCurrentTime(): number {
    if (!this.clock) return Date.now() / 1000
    if ('getBeat' in this.clock && typeof (this.clock as any).getBeat === 'function') {
      return (this.clock as any).getBeat()
    }
    return this.clock.getSeconds()
  }

  trigger(velocity: number): void {
    this.triggerAt(this.getCurrentTime(), velocity)
  }

  release(): void {
    // No-op
  }

  getValue(): number {
    return this.getValueAt(this.getCurrentTime(), 1.0, 1.0)
  }

  triggerAt(time: number, velocity: number = 1, sizeMultiplier: number = 2): void {
    this.bumps.push({
      start: time,
      size: velocity * sizeMultiplier
    })
  }

  prune(currentTime: number): void {
    const limit = this.duration + this.versatz
    this.bumps = this.bumps.filter(bump => currentTime - bump.start < limit)
  }

  getActiveBumps(): StaggeredBump[] {
    return this.bumps
  }

  getValueAt(currentTime: number, diskP: number, bumpSizeFactor: number = 1): number {
    this.prune(currentTime)
    
    let grow = 0
    for (let i = 0; i < this.bumps.length; i++) {
      const bump = this.bumps[i]
      const x = (currentTime - bump.start - (1 - diskP) * this.versatz) / this.duration
      const y = bumpShape(x, this.s)
      grow += Math.max(0, y * bumpSizeFactor) * bump.size
    }
    
    return grow
  }

  reset(): void {
    this.bumps = []
  }
}

