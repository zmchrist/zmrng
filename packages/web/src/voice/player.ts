// PCM playback queue over the Web Audio API. Sentence-sized Float32Array chunks
// are scheduled back-to-back on a single AudioContext so the agent's reply plays
// as one continuous stream; `stop()` cancels everything for barge-in / Stop.
// DOM-adjacent glue — smoke-tested manually, not unit-tested.

export class PcmPlayer {
  private ctx: AudioContext | null = null
  private nextTime = 0
  private sources = new Set<AudioBufferSourceNode>()
  private defaultRate: number

  constructor(sampleRate: number) {
    this.defaultRate = sampleRate
  }

  /** True while at least one chunk is scheduled or playing. */
  get playing(): boolean {
    return this.sources.size > 0
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  /**
   * Queue a mono PCM chunk for gapless playback. The AudioContext resamples the
   * buffer from `sampleRate` (defaults to the rate passed at construction).
   */
  async enqueue(pcm: Float32Array, sampleRate = this.defaultRate): Promise<void> {
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate)
    buffer.getChannelData(0).set(pcm)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime, this.nextTime)
    source.start(startAt)
    this.nextTime = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
    }
  }

  /** Cancel every scheduled/playing chunk and reset the schedule (barge-in / Stop). */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // already stopped — ignore
      }
      source.disconnect()
    }
    this.sources.clear()
    this.nextTime = this.ctx ? this.ctx.currentTime : 0
  }

  /** Tear down: stop playback and close the AudioContext. */
  async close(): Promise<void> {
    this.stop()
    if (this.ctx) {
      try {
        await this.ctx.close()
      } catch {
        // context already closed — ignore
      }
      this.ctx = null
    }
  }
}
