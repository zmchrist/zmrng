// Shared message shapes for the STT/TTS Web Workers. Pure types — no runtime,
// no DOM — so both the worker and the main-thread `LocalVoiceBackend` agree on
// the wire without a shared package. Audio crosses the boundary as a transferable
// `ArrayBuffer` (the underlying buffer of a `Float32Array`) plus its length.

/** Main -> STT worker. */
export type SttRequest =
  | { type: 'warmup' }
  | { type: 'transcribe'; id: number; buffer: ArrayBuffer; sampleRate: number }

/** STT worker -> main. */
export type SttResponse =
  | { type: 'ready' }
  | { type: 'progress'; progress: number }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string }

/** Main -> TTS worker. */
export type TtsRequest =
  | { type: 'warmup' }
  | { type: 'synthesize'; id: number; text: string; voice?: string }

/** TTS worker -> main. `buffer` is the PCM Float32 data; `sampleRate` its rate. */
export type TtsResponse =
  | { type: 'ready' }
  | { type: 'progress'; progress: number }
  | { type: 'result'; id: number; buffer: ArrayBuffer; sampleRate: number }
  | { type: 'error'; id?: number; message: string }
