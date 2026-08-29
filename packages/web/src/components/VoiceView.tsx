import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './VoiceView.module.css'
import { actorColor } from '../status'
import { encodeInput, encodeInterrupt, encodeStart, parseChatServerMsg } from '../chatProtocol'
import {
  appendPartial,
  emptyThread,
  endTurn,
  finalizeAssistant,
  pushToolNote,
  pushUser,
  type ThreadState,
} from '../chatThread'
import { emptyBuffer, flush, push, type SentenceBuffer } from '../voiceSentences'
import { initialTurn, reduce, type VoiceEvent, type VoiceState } from '../voiceTurn'
import { LocalVoiceBackend } from '../voice/localBackend'
import type { VoiceBackend } from '../voice/backend'
import { PcmPlayer } from '../voice/player'
import type { CaveStyle, EffortLevel, ModelAlias, RepoTarget, ServerConfig } from '../types'

// Lazy imports for the mic VAD keep the (heavy) ONNX bundle out of the first
// paint; the module is only pulled once the operator enables voice.
import type { MicVAD } from '@ricky0123/vad-web'

interface Props {
  repos: RepoTarget[]
  config: ServerConfig | null
}

const MODEL_OPTIONS: readonly ModelAlias[] = ['sonnet', 'opus']
const EFFORT_OPTIONS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STYLE_OPTIONS: readonly CaveStyle[] = [
  'normal',
  'caveman-lite',
  'caveman-full',
  'caveman-ultra',
  'wenyan-full',
]

/** The VAD emits 16 kHz mono audio (its fixed output rate). */
const VAD_SAMPLE_RATE = 16000

/** Kokoro TTS emits 24 kHz PCM — used to pre-create the player in the gesture. */
const TTS_SAMPLE_RATE = 24000

// `@ricky0123/vad-web` is the THIRD onnxruntime-web instance in this feature
// (after whisper's transformers.js and kokoro's nested transformers.js). It
// bundles its own ORT for Silero VAD, so Vite/Rolldown pre-bundles its wasm into
// `.vite/deps`, which 404s. Point its worklet + silero `.onnx` (`baseAssetPath`)
// and its ORT wasm (`onnxWASMBasePath`) at a CDN, pinned to the exact installed
// versions — vad-web 0.0.30 and the onnxruntime-web 1.29.0 it depends on. This
// version exposes no `ortConfig` hook, so single-threading relies on ORT's
// `!crossOriginIsolated` auto-clamp (verified). Phase 2 vendors these locally.
const VAD_ASSET_CDN = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/'
const VAD_ORT_WASM_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/'

/** Human-readable label for the current turn state (status line). */
const TURN_LABEL: Record<VoiceState, string> = {
  idle: 'Off',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
}

/**
 * The Voice surface: a hands-free spoken conversation with the same standalone
 * `/ws/chat` agent the text Chat card drives. Owns one `WebSocket` per enabled
 * session (mirroring `ChatPane`/`Terminal`, NOT the `useWs` hub) plus the browser
 * ML pipeline behind the `VoiceBackend` seam. All the unit-tested logic lives in
 * the pure `voiceSentences` / `voiceTurn` / `chatThread` modules; this component
 * is intentionally not unit-tested (mic/VAD/socket/worker glue, same policy as
 * `Terminal.tsx`). Colors come from theme tokens only.
 */
export function VoiceView({ repos, config }: Props) {
  const [model, setModel] = useState<ModelAlias>('sonnet')
  const [effort, setEffort] = useState<EffortLevel>('medium')
  const [style, setStyle] = useState<CaveStyle>('caveman-full')
  const [repoId, setRepoId] = useState<string>(config?.defaultRepoId ?? '')
  const [enabled, setEnabled] = useState(false)
  const [turn, setTurnState] = useState<VoiceState>(initialTurn())
  const [thread, setThread] = useState<ThreadState>(emptyThread())
  const [loadStatus, setLoadStatus] = useState('')
  const [error, setError] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const backendRef = useRef<VoiceBackend | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  const vadRef = useRef<MicVAD | null>(null)
  const turnRef = useRef<VoiceState>(initialTurn())
  const sentBufRef = useRef<SentenceBuffer>(emptyBuffer())
  // A monotonic turn epoch: bumped on every new user turn, barge-in, and Stop so
  // late-resolving synthesis from a superseded turn is dropped, never played.
  const epochRef = useRef(0)
  // Serialize synthesis so sentences are enqueued (and thus played) in order.
  const synthChainRef = useRef<Promise<void>>(Promise.resolve())

  /** Drive the pure turn machine and mirror the result into React state + a ref. */
  const dispatch = useCallback((ev: VoiceEvent) => {
    const next = reduce(turnRef.current, ev)
    turnRef.current = next
    setTurnState(next)
  }, [])

  /** Force the turn state (for the on/off toggle + empty-transcript re-arm). */
  const setTurn = useCallback((next: VoiceState) => {
    turnRef.current = next
    setTurnState(next)
  }, [])

  /** Queue one sentence for speech, dropping it if its turn was superseded. */
  const speakSentence = useCallback((text: string, epoch: number) => {
    synthChainRef.current = synthChainRef.current
      .then(async () => {
        if (epoch !== epochRef.current) return
        const backend = backendRef.current
        const player = playerRef.current
        if (!backend || !player) return
        const pcm = await backend.synthesize(text)
        if (epoch !== epochRef.current) return
        await player.enqueue(pcm, backend.sampleRate)
      })
      .catch((err: unknown) => {
        const msg = String(err)
        // A "voice backend disposed" rejection is a benign teardown race (the
        // engine effect tearing down on disable / a dev HMR reload rejects any
        // in-flight synth) — NOT a real failure, so don't alarm the operator.
        // Surface only genuine synth/playback errors. A single sentence failing
        // should also not break the rest of the stream.
        if (/disposed/i.test(msg)) return
        setError(`Voice playback error: ${msg}`)
      })
  }, [])

  /** Interrupt the in-flight reply: halt playback + interrupt the socket turn. */
  const interrupt = useCallback(() => {
    epochRef.current++
    playerRef.current?.stop()
    sentBufRef.current = emptyBuffer()
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeInterrupt())
    dispatch({ type: 'bargeIn' })
  }, [dispatch])

  // --- socket leg: one /ws/chat session while voice is enabled -------------
  // Re-runs on a config change (respawns the claude session with new controls).
  useEffect(() => {
    if (!enabled) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/chat`)
    wsRef.current = ws

    ws.onopen = () => ws.send(encodeStart(model, effort, style, repoId))
    ws.onmessage = (e) => {
      const msg = parseChatServerMsg(String(e.data))
      if (!msg) return
      switch (msg.type) {
        case 'partial': {
          setThread((s) => appendPartial(s, msg.text))
          dispatch({ type: 'partial' })
          const { buf, ready } = push(sentBufRef.current, msg.text)
          sentBufRef.current = buf
          for (const sentence of ready) speakSentence(sentence, epochRef.current)
          break
        }
        case 'assistant':
          setThread((s) => finalizeAssistant(s, msg.text))
          break
        case 'tool':
          setThread((s) => pushToolNote(s, { name: msg.name, summary: msg.summary, actor: msg.actor }))
          break
        case 'result':
        case 'exit':
        case 'error': {
          const { ready } = flush(sentBufRef.current)
          sentBufRef.current = emptyBuffer()
          for (const sentence of ready) speakSentence(sentence, epochRef.current)
          setThread((s) => endTurn(s))
          dispatch({ type: 'turnEnd' })
          break
        }
        // 'ready' — session established; nothing to render.
      }
    }

    return () => {
      wsRef.current = null
      ws.close()
    }
  }, [enabled, model, effort, style, repoId, dispatch, speakSentence])

  // --- engine leg: backend + player + mic VAD while voice is enabled -------
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const backend = new LocalVoiceBackend()
    // The player is owned OUTSIDE this effect (created + unlocked in the
    // Start-Voice gesture, closed on disable/unmount). We only ensure one
    // exists; we deliberately never close it here, so a spurious effect re-run
    // (e.g. a dev HMR reload) can't discard the gesture-unlocked AudioContext
    // and leave later playback silently suspended.
    if (!playerRef.current) playerRef.current = new PcmPlayer(backend.sampleRate)
    backendRef.current = backend

    const onSpeechStart = () => {
      if (turnRef.current === 'speaking') {
        interrupt() // barge-in
      } else {
        dispatch({ type: 'speechStart' })
      }
    }

    const onSpeechEnd = async (audio: Float32Array) => {
      // Freeze double-guard: never transcribe our own voice while speaking.
      if (turnRef.current === 'speaking') return
      dispatch({ type: 'speechEnd' })
      try {
        const text = await backend.transcribe(audio, VAD_SAMPLE_RATE)
        if (cancelled) return
        if (!text) {
          setTurn('listening')
          return
        }
        setThread((s) => pushUser(s, text))
        epochRef.current++
        sentBufRef.current = emptyBuffer()
        dispatch({ type: 'transcript' })
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeInput(text))
      } catch {
        if (!cancelled) setTurn('listening')
      }
    }

    const run = async () => {
      try {
        setLoadStatus('Loading voice models…')
        setError('')
        await backend.warmup(({ label, progress }) => {
          if (!cancelled) setLoadStatus(`${label} ${Math.round(progress * 100)}%`)
        })
        if (cancelled) return
        setLoadStatus('Requesting microphone…')
        const { MicVAD } = await import('@ricky0123/vad-web')
        if (cancelled) return
        const vad = await MicVAD.new({
          onSpeechStart,
          onSpeechEnd,
          baseAssetPath: VAD_ASSET_CDN,
          onnxWASMBasePath: VAD_ORT_WASM_CDN,
        })
        if (cancelled) {
          void vad.destroy()
          return
        }
        vadRef.current = vad
        await vad.start()
        if (cancelled) return
        setLoadStatus('')
        setTurn('listening')
      } catch (err) {
        if (!cancelled) {
          setError(`Voice unavailable: ${String(err)}`)
          setLoadStatus('')
        }
      }
    }
    void run()

    return () => {
      cancelled = true
      // Invalidate any in-flight synthesis for this session (epochRef is a plain
      // counter, not a rendered node — reading its latest value here is intended).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++
      void vadRef.current?.destroy()
      vadRef.current = null
      // NOTE: the player is intentionally NOT closed here — it is owned by the
      // gesture/disable/unmount path so its unlocked AudioContext survives a
      // spurious effect re-run. Only the backend (workers) is released here.
      backendRef.current?.dispose()
      backendRef.current = null
      sentBufRef.current = emptyBuffer()
    }
  }, [enabled, dispatch, setTurn, interrupt])

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) {
        setTurn('idle')
        setLoadStatus('')
      }
      return !prev
    })
  }, [setTurn])

  // The Start-Voice click is the one guaranteed user gesture. Create + unlock
  // the AudioContext here (synchronously in the gesture) so the agent's spoken
  // reply — which arrives much later, in an async continuation — is not dropped
  // by the browser's autoplay policy. The player is owned here (gesture) and
  // torn down on disable/unmount, NOT inside the enabled effect, so a spurious
  // effect re-run never discards the unlocked context.
  const handleToggle = useCallback(() => {
    if (!enabled) {
      if (!playerRef.current) playerRef.current = new PcmPlayer(TTS_SAMPLE_RATE)
      void playerRef.current.unlock()
    } else {
      void playerRef.current?.close()
      playerRef.current = null
    }
    toggle()
  }, [enabled, toggle])

  // Release the player's AudioContext if the component ever fully unmounts
  // (the enabled effect only releases the ML backend/workers, never the player).
  useEffect(() => {
    return () => {
      void playerRef.current?.close()
      playerRef.current = null
    }
  }, [])

  // A config change respawns the session — clear the visible transcript too.
  const resetForConfigChange = useCallback(() => {
    setThread(emptyThread())
    sentBufRef.current = emptyBuffer()
    epochRef.current++
  }, [])

  const busy = turn === 'thinking' || turn === 'speaking'

  return (
    <div className={styles.pane}>
      <div className={styles.configRow}>
        <select
          className={styles.select}
          aria-label="Model"
          value={model}
          disabled={enabled}
          onChange={(e) => {
            setModel(e.target.value as ModelAlias)
            resetForConfigChange()
          }}
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          aria-label="Effort"
          value={effort}
          disabled={enabled}
          onChange={(e) => {
            setEffort(e.target.value as EffortLevel)
            resetForConfigChange()
          }}
        >
          {EFFORT_OPTIONS.map((eff) => (
            <option key={eff} value={eff}>
              {eff}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          aria-label="Style"
          value={style}
          disabled={enabled}
          onChange={(e) => {
            setStyle(e.target.value as CaveStyle)
            resetForConfigChange()
          }}
        >
          {STYLE_OPTIONS.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          aria-label="Repo"
          value={repoId}
          disabled={enabled}
          onChange={(e) => {
            setRepoId(e.target.value)
            resetForConfigChange()
          }}
        >
          <option value="">Projects root</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.talkBtn} ${enabled ? styles.talkBtnOn : ''}`}
          onClick={handleToggle}
          aria-pressed={enabled}
        >
          {enabled ? 'Stop voice' : 'Start voice'}
        </button>
        {enabled && busy && (
          <button type="button" className={styles.interruptBtn} onClick={interrupt}>
            Interrupt
          </button>
        )}
        <span className={styles.status}>
          <span className={`${styles.dot} ${enabled ? styles.dotOn : ''}`} aria-hidden="true" />
          {loadStatus || TURN_LABEL[turn]}
        </span>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.thread}>
        {thread.items.length === 0 ? (
          <div className={styles.empty}>
            Start voice, grant microphone access, then speak. The agent&apos;s reply is read back
            aloud — talk over it (or press Interrupt) to barge in.
          </div>
        ) : (
          thread.items.map((item, i) => {
            if (item.kind === 'user') {
              return (
                <div key={i} className={`${styles.bubble} ${styles.user}`}>
                  {item.text}
                </div>
              )
            }
            if (item.kind === 'agent') {
              return (
                <div key={i} className={`${styles.bubble} ${styles.agent}`}>
                  {item.text}
                  {item.streaming && <span className={styles.caret} aria-hidden="true" />}
                </div>
              )
            }
            return (
              <div key={i} className={styles.toolNote} style={{ color: actorColor(item.actor) }}>
                <span className={styles.toolName}>{item.name}</span>
                {item.summary && <span className={styles.toolSummary}>{item.summary}</span>}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
