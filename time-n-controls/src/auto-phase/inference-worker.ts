import * as ort from 'onnxruntime-web'
import {
  DancePhaseEstimator,
  type FrameEstimate,
  type ModelMeta,
} from 'dance-ai'

type InitMessage = {
  type: 'init'
  modelPath: string
  modelMeta: ModelMeta | string
  normalize: boolean
  normalizerFloor: number
}

type FrameMessage = {
  type: 'frame'
  requestId: number
  audioFrame: Float32Array
}

type ResetMessage = {
  type: 'reset'
}

type DisposeMessage = {
  type: 'dispose'
}

type InferenceWorkerMessage = InitMessage | FrameMessage | ResetMessage | DisposeMessage

type ReadyMessage = {
  type: 'ready'
  meta: ModelMeta
}

type EstimatesMessage = {
  type: 'estimates'
  requestId: number
  estimates: FrameEstimate[]
}

type ErrorMessage = {
  type: 'error'
  message: string
}

export type AutoPhaseInferenceWorkerResponse = ReadyMessage | EstimatesMessage | ErrorMessage

let estimator: DancePhaseEstimator | null = null
let disposed = false

function post(message: AutoPhaseInferenceWorkerResponse) {
  self.postMessage(message)
}

async function init(message: InitMessage) {
  disposed = false
  estimator?.dispose()
  estimator = null

  try {
    // This worker is already off the main thread. Keep ORT's own proxy worker
    // disabled so each audio model owns one predictable execution context.
    ort.env.wasm.wasmPaths = undefined
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false

    const nextEstimator = await DancePhaseEstimator.create({
      ort,
      model: message.modelPath,
      meta: message.modelMeta,
      normalize: message.normalize,
      normalizerFloor: message.normalizerFloor,
    })

    if (disposed) {
      nextEstimator.dispose()
      return
    }

    estimator = nextEstimator
    post({ type: 'ready', meta: nextEstimator.meta })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

async function processFrame(requestId: number, audioFrame: Float32Array) {
  if (!estimator || disposed) {
    post({ type: 'estimates', requestId, estimates: [] })
    return
  }

  try {
    post({ type: 'estimates', requestId, estimates: await estimator.feed(audioFrame) })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    post({ type: 'estimates', requestId, estimates: [] })
  }
}

self.onmessage = (event: MessageEvent<InferenceWorkerMessage>) => {
  const message = event.data
  if (message.type === 'init') {
    void init(message)
  } else if (message.type === 'frame') {
    void processFrame(message.requestId, message.audioFrame)
  } else if (message.type === 'reset') {
    estimator?.reset()
  } else if (message.type === 'dispose') {
    disposed = true
    estimator?.dispose()
    estimator = null
  }
}
