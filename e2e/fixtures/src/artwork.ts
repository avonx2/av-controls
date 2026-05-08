import { Controls, Transports } from 'av-controls'

const BROKER_URL = 'ws://127.0.0.1:18080'
const PANEL_ID = new URLSearchParams(window.location.search).get('panelId') ?? 'e2e-artwork'

type ChangeRecord = {
  path: string
  value: number | boolean
}

function args(name: string, x = 0, y = 0, width = 100, height = 100, color = '#66aaff') {
  return new Controls.Base.Args(name, x, y, width, height, color)
}

const changes: ChangeRecord[] = []

const volume = new Controls.Fader.Receiver(
  new Controls.Fader.Spec(args('Volume', 0, 0, 50, 100, '#66aaff'), new Controls.Fader.State(0.2), 0, 1, 2),
  (value) => changes.push({ path: 'main.volume', value }),
)

const enabled = new Controls.Switch.Receiver(
  new Controls.Switch.Spec(args('Enabled', 50, 0, 50, 100, '#ffaa66'), new Controls.Switch.State(false)),
  (on) => changes.push({ path: 'main.enabled', value: on }),
)

const amount = new Controls.Knob.Receiver(
  new Controls.Knob.Spec(args('Amount', 0, 0, 100, 100, '#66cc88'), new Controls.Knob.State(0), 0, 1, 2),
  (value) => changes.push({ path: 'fx.amount', value }),
)

const main = new Controls.Group.Receiver(
  new Controls.Group.SpecWithoutControls(args('Main', 0, 0, 70, 100, '#333333')),
  { volume, enabled },
)

const fx = new Controls.Group.Receiver(
  new Controls.Group.SpecWithoutControls(args('FX', 70, 0, 30, 100, '#333333')),
  { amount },
)

const root = new Controls.Group.Receiver(
  new Controls.Group.SpecWithoutControls(args('Root', 0, 0, 100, 100, '#222222')),
  { main, fx },
)

const emittedUpdates: unknown[] = []
root.onUpdate = (update) => {
  emittedUpdates.push(update)
}

function emitArtworkUpdate(path: 'main.volume' | 'main.enabled' | 'fx.amount', value: number | boolean) {
  switch (path) {
    case 'main.volume':
      volume.handleSignal(new Controls.Fader.Signal(value as number))
      break
    case 'main.enabled':
      enabled.handleSignal(new Controls.Switch.Signal(value as boolean))
      break
    case 'fx.amount':
      amount.handleSignal(new Controls.Knob.Signal(value as number))
      break
  }
}

const receiver = new Transports.WebSocket.Receiver(
  { [PANEL_ID]: root },
  BROKER_URL,
  { autoReconnect: false },
)

window.avControlsArtwork = {
  panelId: PANEL_ID,
  receiver,
  getChanges: () => [...changes],
  getEmittedUpdates: () => [...emittedUpdates],
  getState: () => root.getState(),
  emitArtworkUpdate,
}
