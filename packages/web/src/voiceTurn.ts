// Pure, React-free state machine for one voice conversation turn. It encodes the
// two rules that matter for a hands-free loop: the FREEZE rule (while the agent
// is speaking, the user's mic activity must not end a turn — otherwise the agent
// hears itself), and the BARGE-IN / STOP interrupt semantics. The component owns
// the mic/socket/playback effects and drives this reducer with events; the
// reducer only computes the next state. Unit-tested.

/** The turn lifecycle. */
export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

/**
 * Events the component feeds in:
 * - `speechStart`/`speechEnd` — VAD endpointing of the operator's voice.
 * - `transcript` — STT finished; the transcript was sent to the agent.
 * - `partial` — the agent's first/next streamed token (output has begun).
 * - `turnEnd` — the agent's reply finished.
 * - `bargeIn` — the operator explicitly talked over the agent (interrupt).
 * - `stop` — the operator halted the whole loop.
 */
export type VoiceEvent =
  | { type: 'speechStart' }
  | { type: 'speechEnd' }
  | { type: 'transcript' }
  | { type: 'partial' }
  | { type: 'turnEnd' }
  | { type: 'bargeIn' }
  | { type: 'stop' }

/** The machine's starting state — the loop is stopped, mic off. */
export function initialTurn(): VoiceState {
  return 'idle'
}

/**
 * Compute the next state. `stop` always wins → `idle`. Unhandled (state, event)
 * pairs leave the state unchanged, which is where the freeze rule lives: while
 * `speaking`, a `speechStart`/`speechEnd` is absorbed (ignored) — only an
 * explicit `bargeIn` or `turnEnd` leaves the speaking state.
 */
export function reduce(state: VoiceState, ev: VoiceEvent): VoiceState {
  if (ev.type === 'stop') return 'idle'
  switch (state) {
    case 'idle':
      return ev.type === 'speechStart' ? 'listening' : 'idle'
    case 'listening':
      return ev.type === 'speechEnd' ? 'transcribing' : 'listening'
    case 'transcribing':
      if (ev.type === 'transcript') return 'thinking'
      if (ev.type === 'bargeIn') return 'listening'
      return 'transcribing'
    case 'thinking':
      if (ev.type === 'partial') return 'speaking'
      if (ev.type === 'turnEnd') return 'listening'
      if (ev.type === 'bargeIn') return 'listening'
      return 'thinking'
    case 'speaking':
      if (ev.type === 'bargeIn') return 'listening'
      if (ev.type === 'turnEnd') return 'listening'
      // freeze: speechStart / speechEnd are ignored while the agent speaks.
      return 'speaking'
  }
}
