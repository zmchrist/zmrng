// The STT/TTS engine seam. VoiceView talks only to this interface, so the ML
// implementation (local transformers.js today; a cloud or native-sidecar backend
// later) is swappable without touching the component. VAD/mic capture stays
// client-side regardless of the backend — this interface is only the model-free
// speech <-> text conversion.

/** Progress callback shape shared by both model loads (0..1, plus a label). */
export type VoiceLoadProgress = (info: { label: string; progress: number }) => void

export interface VoiceBackend {
  /**
   * Transcribe a mono PCM `Float32Array` (samples in [-1, 1]) to text. The VAD
   * emits 16 kHz audio; `sampleRate` is passed through for backends that resample.
   */
  transcribe(audio: Float32Array, sampleRate: number): Promise<string>
  /**
   * Synthesize `text` to mono PCM at `sampleRate` (see below). `voice` is an
   * optional backend-specific voice id.
   */
  synthesize(text: string, voice?: string): Promise<Float32Array>
  /** Prime both models (download + first inference) so the first real turn is fast. */
  warmup(onProgress?: VoiceLoadProgress): Promise<void>
  /** True once `warmup` has completed and both engines are ready. */
  readonly ready: boolean
  /** Output sample rate of `synthesize` (Kokoro is 24 kHz). */
  readonly sampleRate: number
  /** Release workers / models. */
  dispose(): void
}
