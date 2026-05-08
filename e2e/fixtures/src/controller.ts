import { ControllerClient, Messages, Transports, type Base } from 'av-controls'

const BROKER_URL = 'ws://127.0.0.1:18080'
const PANEL_ID = new URLSearchParams(window.location.search).get('panelId') ?? 'e2e-artwork'

type ControllerFixtureMessage = Messages.Message & {
  origin?: Messages.UpdateOrigin
  serverSeq?: number
}

let sender: Transports.WebSocket.Sender | null = null
let client: ControllerClient.ControllerClient | null = null
let rootSpec: Messages.RootSpecification | null = null
let storedInitialState: Base.State | null = null
const messages: ControllerFixtureMessage[] = []
const rootSpecs: Messages.RootSpecification[] = []
const updates: Messages.ControlUpdate[] = []
const unknownMessages: Messages.Message[] = []
const initializedStates: { name: string; state: Base.State }[] = []

function connect(clientId = `e2e-controller-${Math.random().toString(36).slice(2, 8)}`) {
  dispose()
  rootSpec = null
  messages.length = 0
  rootSpecs.length = 0
  updates.length = 0
  unknownMessages.length = 0
  initializedStates.length = 0

  sender = new Transports.WebSocket.Sender(
    BROKER_URL,
    async (panelIds) => panelIds.includes(PANEL_ID) ? PANEL_ID : '',
    { autoReconnect: false },
  )

  sender.addListener((message) => {
    messages.push(message as ControllerFixtureMessage)
  })

  client = new ControllerClient.ControllerClient(sender, {
    clientId,
    loadInitialState: () => storedInitialState,
    onInitializedState: (name, state) => {
      initializedStates.push({ name, state })
    },
  })
  client.onRootSpec = (event) => {
    rootSpec = event.rootSpec
    rootSpecs.push(event.rootSpec)
  }
  client.onControlUpdate = (event) => {
    updates.push(event.update)
  }
  client.onUnknownMessage = (message) => {
    unknownMessages.push(message)
  }
}

function dispose() {
  client?.dispose()
  client = null
  sender?.dispose()
  sender = null
}

function sendSignalTree(signal: Messages.ControlSignalTree, origin: Messages.UpdateOrigin = { kind: 'controller', clientId: client?.clientId }) {
  sender?.send(new Messages.ControlSignal(signal, undefined, origin))
}

function senderAt(path: string[]) {
  let current = client?.getRootSender() as any
  for (const part of path) {
    current = current?.senders?.[part]
  }
  return current
}

function setLeafValue(path: string[], value: number | boolean) {
  const leaf = senderAt(path)
  if (!leaf) {
    throw new Error(`No sender at ${path.join('.')}`)
  }
  if (typeof value === 'boolean') {
    leaf.setState({ on: value })
    return
  }
  leaf.setValue(value)
}

function getRootSenderState() {
  return client?.getRootSender()?.getState() ?? null
}

window.avControlsController = {
  connect,
  dispose,
  setStoredInitialState: (state: Base.State | null) => {
    storedInitialState = state
  },
  sendSignalTree,
  setLeafValue,
  getRootSpec: () => rootSpec,
  getRootSpecs: () => [...rootSpecs],
  getMessages: () => [...messages],
  getUpdates: () => [...updates],
  getUnknownMessages: () => [...unknownMessages],
  getInitializedStates: () => [...initializedStates],
  getRootSenderState,
  getClientId: () => client?.clientId ?? null,
}

declare global {
  interface Window {
    avControlsController: {
      connect: (clientId?: string) => void
      dispose: () => void
      setStoredInitialState: (state: Base.State | null) => void
      sendSignalTree: (signal: Messages.ControlSignalTree, origin?: Messages.UpdateOrigin) => void
      setLeafValue: (path: string[], value: number | boolean) => void
      getRootSpec: () => Messages.RootSpecification | null
      getRootSpecs: () => Messages.RootSpecification[]
      getMessages: () => ControllerFixtureMessage[]
      getUpdates: () => Messages.ControlUpdate[]
      getUnknownMessages: () => Messages.Message[]
      getInitializedStates: () => { name: string; state: Base.State }[]
      getRootSenderState: () => Base.State | null
      getClientId: () => string | null
    }
  }
}
