import { createApp } from 'vue'
import Controller from 'av-controller'
import { Transports } from 'av-controls'

const BROKER_URL = 'ws://127.0.0.1:18080'
const PANEL_ID = 'e2e-artwork'

const sender = new Transports.WebSocket.Sender(
  BROKER_URL,
  async (panelIds) => panelIds.includes(PANEL_ID) ? PANEL_ID : '',
  { autoReconnect: false },
)

createApp(Controller, { sender }).mount('#app')

window.avControlsControllerUi = {
  sender,
  dispose: () => sender.dispose(),
}

declare global {
  interface Window {
    avControlsControllerUi: {
      sender: Transports.WebSocket.Sender
      dispose: () => void
    }
  }
}
