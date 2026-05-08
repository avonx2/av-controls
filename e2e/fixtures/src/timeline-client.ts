import { Transports } from 'av-controls'
import { TimelineClient, type TimelineState } from 'av-timeline/src/engine'

const BROKER_URL = 'ws://127.0.0.1:18080'
const PANEL_ID = 'e2e-artwork'

let sender: Transports.WebSocket.Sender | null = null
let timelineClient: TimelineClient | null = null
let rootSpecName: string | null = null
const states: TimelineState[] = []

function connect() {
  dispose()
  rootSpecName = null
  states.length = 0

  sender = new Transports.WebSocket.Sender(
    BROKER_URL,
    async (panelIds) => panelIds.includes(PANEL_ID) ? PANEL_ID : '',
    { autoReconnect: false },
  )
  timelineClient = new TimelineClient(sender, { autoRequestState: false })
  timelineClient.onRootSpec = (spec) => {
    rootSpecName = spec.name
  }
  timelineClient.onState = (event) => {
    states.push(event.state)
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

function applyAutomation(time: number) {
  timelineClient?.applyAutomation(time, { bypassBackpressure: true })
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
  applyAutomation,
  getRootSpecName: () => rootSpecName,
  getStates: () => [...states],
  getLastSentMessage,
}

declare global {
  interface Window {
    avControlsTimeline: {
      connect: () => void
      dispose: () => void
      addVolumeCurve: (points: Array<{ t: number; v: number }>) => void
      addMultiControlCurves: () => void
      applyAutomation: (time: number) => void
      getRootSpecName: () => string | null
      getStates: () => TimelineState[]
      getLastSentMessage: () => null
    }
  }
}
