// TTS Web Worker: runs Kokoro-82M (kokoro-js, ONNX) off the UI thread. Tries
// WebGPU first, falls back to WASM. Not unit-tested (real ONNX inference + worker
// glue); isolated behind LocalVoiceBackend.
import { KokoroTTS } from 'kokoro-js'
import type { ProgressInfo } from '@huggingface/transformers'
import type { TtsRequest, TtsResponse } from './workerProtocol'

const TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const DEFAULT_VOICE = 'af_heart'

const ctx = self as unknown as {
  postMessage(message: TtsResponse, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (ev: MessageEvent<TtsRequest>) => void): void
}

let ttsPromise: Promise<KokoroTTS> | null = null

async function load(): Promise<KokoroTTS> {
  const progress_callback = (info: ProgressInfo) => {
    if (info.status === 'progress' && typeof info.progress === 'number') {
      ctx.postMessage({ type: 'progress', progress: info.progress / 100 })
    }
  }
  try {
    return await KokoroTTS.from_pretrained(TTS_MODEL, { dtype: 'fp32', device: 'webgpu', progress_callback })
  } catch {
    return await KokoroTTS.from_pretrained(TTS_MODEL, { dtype: 'q8', device: 'wasm', progress_callback })
  }
}

function getTts(): Promise<KokoroTTS> {
  if (!ttsPromise) ttsPromise = load()
  return ttsPromise
}

/** Kokoro's voice ids are a fixed union; validate softly, falling back to default. */
function resolveVoice(tts: KokoroTTS, voice?: string): keyof typeof tts.voices {
  if (voice && voice in tts.voices) return voice as keyof typeof tts.voices
  return DEFAULT_VOICE as keyof typeof tts.voices
}

ctx.addEventListener('message', (ev) => {
  const msg = ev.data
  if (msg.type === 'warmup') {
    getTts()
      .then(() => ctx.postMessage({ type: 'ready' }))
      .catch((err: unknown) => ctx.postMessage({ type: 'error', message: String(err) }))
    return
  }
  if (msg.type === 'synthesize') {
    getTts()
      .then((tts) => tts.generate(msg.text, { voice: resolveVoice(tts, msg.voice) }))
      .then((raw) => {
        // `raw.audio` is a single Float32Array chunk (or, defensively, chunks).
        const pcm = Array.isArray(raw.audio) ? (raw.audio[0] ?? new Float32Array(0)) : raw.audio
        // Copy into a fresh ArrayBuffer we can transfer without detaching model state.
        const copy = new Float32Array(pcm.length)
        copy.set(pcm)
        ctx.postMessage(
          { type: 'result', id: msg.id, buffer: copy.buffer, sampleRate: raw.sampling_rate },
          [copy.buffer],
        )
      })
      .catch((err: unknown) => ctx.postMessage({ type: 'error', id: msg.id, message: String(err) }))
  }
})
