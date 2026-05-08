import type { Messages, Base } from 'av-controls'

declare global {
  interface Window {
    avControlsArtwork: {
      panelId: string
      receiver: unknown
      getChanges: () => Array<{ path: string; value: number | boolean }>
      getEmittedUpdates: () => unknown[]
      getState: () => Base.State
      emitArtworkUpdate: (path: 'main.volume' | 'main.enabled' | 'fx.amount', value: number | boolean) => void
    }
  }
}

export {}
