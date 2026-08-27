// STT Web Worker: runs Whisper (transformers.js, ONNX) off the UI thread. Tries
// WebGPU first, falls back to WASM. Not unit-tested (real ONNX inference + worker
// glue — same policy as Terminal.tsx / WorkspaceGrid.tsx); isolated behind the
// LocalVoiceBackend so VoiceView never sees it.
import { pipeline, type ProgressInfo } from '@huggingface/transformers'
import type { SttRequest, SttResponse } from './workerProtocol'

/** Small Whisper checkpoint — English, low-latency. Change here to trade speed/accuracy. */
const STT_MODEL = 'Xenova/whisper-tiny.en'
const WHISPER_SAMPLE_RATE = 16000

// Minimal typed view of the DedicatedWorkerGlobalScope (the web tsconfig uses the
// DOM lib, which types `self` as Window — cast to the worker surface we use).
const ctx = self as unknown as {
  postMessage(message: SttResponse, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (ev: MessageEvent<SttRequest>) => void): void
}

/** A transformers.js ASR pipeline is a callable; narrow it to what we invoke. */
type Transcriber = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text: string } | Array<{ text: string }>>

let transcriberPromise: Promise<Transcriber> | null = null

async function load(): Promise<Transcriber> {
  const onProgress = (info: ProgressInfo) => {
    if (info.status === 'progress' && typeof info.progress === 'number') {
      ctx.postMessage({ type: 'progress', progress: info.progress / 100 })
    }
  }
  try {
    const p = await pipeline('automatic-speech-recognition', STT_MODEL, {
      device: 'webgpu',
      progress_callback: onProgress,
    })
    return p as unknown as Transcriber
  } catch {
    const p = await pipeline('automatic-speech-recognition', STT_MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: onProgress,
    })
    return p as unknown as Transcriber
  }
}

function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) transcriberPromise = load()
  return transcriberPromise
}

ctx.addEventListener('message', (ev) => {
  const msg = ev.data
  if (msg.type === 'warmup') {
    getTranscriber()
      .then(() => ctx.postMessage({ type: 'ready' }))
      .catch((err: unknown) => ctx.postMessage({ type: 'error', message: String(err) }))
    return
  }
  if (msg.type === 'transcribe') {
    const audio = new Float32Array(msg.buffer)
    getTranscriber()
      .then((transcriber) => transcriber(audio, { sampling_rate: msg.sampleRate || WHISPER_SAMPLE_RATE }))
      .then((out) => {
        const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
        ctx.postMessage({ type: 'result', id: msg.id, text: text.trim() })
      })
      .catch((err: unknown) => ctx.postMessage({ type: 'error', id: msg.id, message: String(err) }))
  }
})
