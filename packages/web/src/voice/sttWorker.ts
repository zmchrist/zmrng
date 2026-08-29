// STT Web Worker: runs Whisper (transformers.js, ONNX) off the UI thread. Tries
// WebGPU first, falls back to WASM. Not unit-tested (real ONNX inference + worker
// glue — same policy as Terminal.tsx / WorkspaceGrid.tsx); isolated behind the
// LocalVoiceBackend so VoiceView never sees it.
import type { ProgressInfo } from '@huggingface/transformers'
import type { SttRequest, SttResponse } from './workerProtocol'

// Phase 1 loads transformers.js from a CDN at runtime (a `/* @vite-ignore */`
// dynamic import) to sidestep Rolldown's CJS-external interop: bundling the lib
// makes its internal `require('onnxruntime-web/wasm')` execute in the ES worker,
// which has no `require`. The jsDelivr `/+esm` endpoint flattens all bare-import
// deps (transformers → onnxruntime-web) into browser-ready ESM. Phase 2 swaps
// this for a locally-vendored ESM path so the .app runs offline.
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm'

// ORT's WASM runtime, pinned to the exact onnxruntime-web version transformers.js
// v4.2.0 depends on (must match the JS glue in the /+esm bundle above).
const ORT_WASM_CDN =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/'

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
  const url = TRANSFORMERS_CDN
  const { pipeline, env } = (await import(/* @vite-ignore */ url)) as typeof import('@huggingface/transformers')

  // Force single-threaded ORT: the threaded build needs SharedArrayBuffer, which
  // requires COOP/COEP cross-origin isolation we deliberately do not enable. (ORT
  // also auto-clamps to 1 when `!crossOriginIsolated`; this is belt-and-suspenders.)
  const wasmEnv = env.backends?.onnx?.wasm
  if (wasmEnv) {
    wasmEnv.numThreads = 1
    wasmEnv.wasmPaths = ORT_WASM_CDN
  }

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
    // WASM fallback: use fp32, NOT q8. The q8 whisper-tiny.en checkpoint packs its
    // decoder as MatMulNBits block-quant weights, which the pinned onnxruntime-web
    // dev build fails to load ("Missing required scale … TransposeDQWeightsForMatMulNBits").
    // whisper-tiny.en is small enough that fp32 is fine, and it sidesteps the op entirely.
    const p = await pipeline('automatic-speech-recognition', STT_MODEL, {
      device: 'wasm',
      dtype: 'fp32',
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
