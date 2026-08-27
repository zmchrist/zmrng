// Fully-local VoiceBackend: Whisper STT + Kokoro TTS, each in its own Web Worker
// so inference never blocks the UI thread. Not unit-tested (worker/ML glue) — the
// testable logic lives in the pure voiceSentences / voiceTurn modules, and this
// class stays isolated behind the VoiceBackend interface so VoiceView is clean.
import type { VoiceBackend, VoiceLoadProgress } from './backend'
import type { SttRequest, SttResponse, TtsRequest, TtsResponse } from './workerProtocol'

/** Kokoro emits 24 kHz PCM. */
const TTS_SAMPLE_RATE = 24000

interface Pending<T> {
  resolve: (value: T) => void
  reject: (err: Error) => void
}

export class LocalVoiceBackend implements VoiceBackend {
  readonly sampleRate = TTS_SAMPLE_RATE
  private _ready = false

  private stt: Worker
  private tts: Worker
  private nextId = 1
  private sttPending = new Map<number, Pending<string>>()
  private ttsPending = new Map<number, Pending<Float32Array>>()
  private onProgress: VoiceLoadProgress | undefined

  constructor() {
    this.stt = new Worker(new URL('./sttWorker.ts', import.meta.url), { type: 'module' })
    this.tts = new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' })
    this.stt.addEventListener('message', (ev: MessageEvent<SttResponse>) => this.onStt(ev.data))
    this.tts.addEventListener('message', (ev: MessageEvent<TtsResponse>) => this.onTts(ev.data))
  }

  get ready(): boolean {
    return this._ready
  }

  private onStt(msg: SttResponse): void {
    switch (msg.type) {
      case 'progress':
        this.onProgress?.({ label: 'Loading speech-to-text…', progress: msg.progress })
        break
      case 'result': {
        this.sttPending.get(msg.id)?.resolve(msg.text)
        this.sttPending.delete(msg.id)
        break
      }
      case 'error': {
        if (msg.id !== undefined) {
          this.sttPending.get(msg.id)?.reject(new Error(msg.message))
          this.sttPending.delete(msg.id)
        }
        break
      }
      // 'ready' is awaited via warmup's own dedicated listeners.
    }
  }

  private onTts(msg: TtsResponse): void {
    switch (msg.type) {
      case 'progress':
        this.onProgress?.({ label: 'Loading text-to-speech…', progress: msg.progress })
        break
      case 'result': {
        this.ttsPending.get(msg.id)?.resolve(new Float32Array(msg.buffer))
        this.ttsPending.delete(msg.id)
        break
      }
      case 'error': {
        if (msg.id !== undefined) {
          this.ttsPending.get(msg.id)?.reject(new Error(msg.message))
          this.ttsPending.delete(msg.id)
        }
        break
      }
    }
  }

  /** Resolve once the worker posts a `ready` (or reject on `error`). */
  private waitReady(worker: Worker): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMsg = (ev: MessageEvent<SttResponse | TtsResponse>) => {
        const m = ev.data
        if (m.type === 'ready') {
          worker.removeEventListener('message', onMsg)
          resolve()
        } else if (m.type === 'error' && m.id === undefined) {
          worker.removeEventListener('message', onMsg)
          reject(new Error(m.message))
        }
      }
      worker.addEventListener('message', onMsg)
    })
  }

  async warmup(onProgress?: VoiceLoadProgress): Promise<void> {
    this.onProgress = onProgress
    const sttReady = this.waitReady(this.stt)
    const ttsReady = this.waitReady(this.tts)
    this.post(this.stt, { type: 'warmup' })
    this.post(this.tts, { type: 'warmup' })
    await Promise.all([sttReady, ttsReady])
    this._ready = true
  }

  transcribe(audio: Float32Array, sampleRate: number): Promise<string> {
    const id = this.nextId++
    // Copy into a transferable buffer (the caller keeps ownership of `audio`).
    const copy = new Float32Array(audio.length)
    copy.set(audio)
    return new Promise<string>((resolve, reject) => {
      this.sttPending.set(id, { resolve, reject })
      const req: SttRequest = { type: 'transcribe', id, buffer: copy.buffer, sampleRate }
      this.stt.postMessage(req, [copy.buffer])
    })
  }

  synthesize(text: string, voice?: string): Promise<Float32Array> {
    const id = this.nextId++
    return new Promise<Float32Array>((resolve, reject) => {
      this.ttsPending.set(id, { resolve, reject })
      const req: TtsRequest = { type: 'synthesize', id, text, voice }
      this.tts.postMessage(req)
    })
  }

  private post(worker: Worker, msg: SttRequest | TtsRequest): void {
    worker.postMessage(msg)
  }

  dispose(): void {
    const gone = new Error('voice backend disposed')
    for (const p of this.sttPending.values()) p.reject(gone)
    for (const p of this.ttsPending.values()) p.reject(gone)
    this.sttPending.clear()
    this.ttsPending.clear()
    this.stt.terminate()
    this.tts.terminate()
    this._ready = false
  }
}
