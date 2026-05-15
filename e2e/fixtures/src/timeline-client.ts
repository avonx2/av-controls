import { Messages, Transports } from 'av-controls'
import { TimelineClient, type TimelineState } from 'av-timeline/src/engine'

const BROKER_URL = 'ws://127.0.0.1:18080'
const PANEL_ID = new URLSearchParams(window.location.search).get('panelId') ?? 'e2e-artwork'

let sender: Transports.WebSocket.Sender | null = null
let timelineClient: TimelineClient | null = null
let rootSpecName: string | null = null
let bufferedAmount = 0
const states: TimelineState[] = []
const updates: Messages.ControlUpdate[] = []

function connect() {
  dispose()
  rootSpecName = null
  states.length = 0
  updates.length = 0

  sender = new Transports.WebSocket.Sender(
    BROKER_URL,
    async (panelIds) => panelIds.includes(PANEL_ID) ? PANEL_ID : '',
    { autoReconnect: false },
  )
  sender.getBufferedAmount = () => bufferedAmount
  timelineClient = new TimelineClient(sender, { autoRequestState: false })
  timelineClient.onRootSpec = (spec) => {
    rootSpecName = spec.name
  }
  timelineClient.onState = (event) => {
    states.push(event.state)
  }
  timelineClient.onControlUpdate = (update) => {
    updates.push(update)
  }
}

function addVolumeCurve(points: Array<{ t: number; v: number }>) {
  timelineClient?.addLane(['main', 'volume'], {
    key: 'value',
    enabled: true,
    points,
  })
}

function addMultiControlCurves() {
  timelineClient?.addLane(['main', 'volume'], {
    key: 'value',
    enabled: true,
    points: [{ t: 0, v: 0.25 }, { t: 1, v: 0.65 }],
  })
  timelineClient?.addLane(['fx', 'amount'], {
    key: 'value',
    enabled: true,
    points: [{ t: 0, v: 0.1 }, { t: 1, v: 0.75 }],
  })
}

function addSwitchTrigger(onTime: number, offTime: number) {
  timelineClient?.addLane(['main', 'enabled'], {
    key: 'value',
    type: 'trigger',
    enabled: true,
    triggers: [
      {
        on: { t: onTime, value: 1 },
        off: { t: offTime },
      },
    ],
  })
}

function addModeSteps(points: Array<{ t: number; v: number }>) {
  timelineClient?.addLane(['main', 'mode'], {
    key: 'index',
    type: 'step',
    enabled: true,
    points,
  })
}

function applyAutomation(time: number) {
  timelineClient?.applyAutomation(time, { bypassBackpressure: true })
}

function applyAutomationWithBackpressure(time: number) {
  timelineClient?.applyAutomation(time)
}

function setBufferedAmount(value: number) {
  bufferedAmount = value
}

function getLastSentMessage() {
  return sender ? null : null
}

function dispose() {
  timelineClient?.dispose()
  timelineClient = null
  sender?.dispose()
  sender = null
}

window.avControlsTimeline = {
  connect,
  dispose,
  addVolumeCurve,
  addMultiControlCurves,
  addSwitchTrigger,
  addModeSteps,
  applyAutomation,
  applyAutomationWithBackpressure,
  setBufferedAmount,
  getRootSpecName: () => rootSpecName,
  getStates: () => [...states],
  getUpdates: () => [...updates],
  getLastSentMessage,
}

declare global {
  interface Window {
    avControlsTimeline: {
      connect: () => void
      dispose: () => void
      addVolumeCurve: (points: Array<{ t: number; v: number }>) => void
      addMultiControlCurves: () => void
      addSwitchTrigger: (onTime: number, offTime: number) => void
      addModeSteps: (points: Array<{ t: number; v: number }>) => void
      applyAutomation: (time: number) => void
      applyAutomationWithBackpressure: (time: number) => void
      setBufferedAmount: (value: number) => void
      getRootSpecName: () => string | null
      getStates: () => TimelineState[]
      getUpdates: () => Messages.ControlUpdate[]
      getLastSentMessage: () => null
    }
  }
}
