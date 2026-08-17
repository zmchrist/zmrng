import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './ChatPane.module.css'
import { actorColor } from '../status'
import { encodeInput, encodeInterrupt, encodeStart, parseChatServerMsg } from '../chatProtocol'
import { loadChatThread, saveChatThread, serializeTranscript } from '../chatPersistence'
import { useAttachments } from '../useAttachments'
import { AttachmentTray } from './AttachmentTray'
import {
  appendPartial,
  emptyThread,
  endTurn,
  finalizeAssistant,
  pushToolNote,
  pushUser,
  type ThreadState,
} from '../chatThread'
import type { CaveStyle, EffortLevel, ModelAlias } from '../types'

interface Props {
  /** Stable id for this chat instance (one WebSocket / claude session per id). */
  id: string
}

/** Chat-tab defaults — independent of the task-level DEFAULT_* controls. */
const MODEL_OPTIONS: readonly ModelAlias[] = ['sonnet', 'opus']
const EFFORT_OPTIONS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STYLE_OPTIONS: readonly CaveStyle[] = [
  'normal',
  'caveman-lite',
  'caveman-full',
  'caveman-ultra',
  'wenyan-full',
]

/**
 * The standalone agent-chat pane: a classic messaging thread of user/agent
 * bubbles plus a config row and composer. Owns one `WebSocket` to `/ws/chat`
 * per instance (mirroring `Terminal.tsx`, NOT via the `useWs` hub). All the
 * testable messaging logic lives in the pure `chatThread` / `chatProtocol`
 * modules; this component is intentionally not unit-tested (jsdom has no WS
 * glue worth exercising). Colors come from theme tokens only.
 */
export function ChatPane({ id }: Props) {
  const [model, setModel] = useState<ModelAlias>('sonnet')
  const [effort, setEffort] = useState<EffortLevel>('medium')
  const [style, setStyle] = useState<CaveStyle>('caveman-full')
  // Hydrate from the saved transcript (if any) so history survives a refresh/
  // rebuild/tab-reopen — the underlying `claude` session is gone regardless,
  // so it always starts idle (`busy: false`). Plain state (not a ref) so its
  // initial value is safe to read during render.
  const [saved, setSaved] = useState(() => loadChatThread(id))
  const [thread, setThread] = useState<ThreadState>(() =>
    saved.length > 0 ? { items: saved, busy: false } : emptyThread(),
  )
  // True until the first message is sent after mount — primes that one
  // outgoing turn with the saved transcript so the fresh session picks the
  // conversation back up, without showing the prefix in the displayed bubble.
  const primedRef = useRef(saved.length > 0)
  const [draft, setDraft] = useState('')
  const files = useAttachments()
  const wsRef = useRef<WebSocket | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  // Open (or re-open, on a config change) the socket. Re-runs when id or any
  // control changes; a config change respawns the `claude` session with the new
  // controls. Thread reset lives in the select handlers (kept out of the effect
  // body to satisfy react-hooks/set-state-in-effect).
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/chat`)
    wsRef.current = ws

    ws.onopen = () => ws.send(encodeStart(model, effort, style))
    ws.onmessage = (e) => {
      const msg = parseChatServerMsg(String(e.data))
      if (!msg) return
      switch (msg.type) {
        case 'partial':
          setThread((s) => appendPartial(s, msg.text))
          break
        case 'assistant':
          setThread((s) => finalizeAssistant(s, msg.text))
          break
        case 'tool':
          setThread((s) => pushToolNote(s, { name: msg.name, summary: msg.summary, actor: msg.actor }))
          break
        case 'result':
        case 'exit':
        case 'error':
          setThread((s) => endTurn(s))
          break
        // 'ready' — session established; nothing to render.
      }
    }

    return () => {
      wsRef.current = null
      ws.close()
    }
  }, [id, model, effort, style])

  // Keep the thread scrolled to the latest item.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread])

  // Persist the transcript as it grows, skipping mid-stream token deltas (only
  // once a bubble is closed) so a fast stream doesn't hammer localStorage.
  useEffect(() => {
    const last = thread.items.at(-1)
    if (last && last.kind === 'agent' && last.streaming) return
    saveChatThread(id, thread.items)
  }, [id, thread.items])

  const send = useCallback(() => {
    const text = draft.trim()
    const attachments = files.attachments
    const ws = wsRef.current
    if ((!text && attachments.length === 0) || thread.busy || !ws || ws.readyState !== WebSocket.OPEN)
      return
    // Show what the operator sent — fall back to a marker for an image-only turn.
    const bubble = text || `[${attachments.length} attachment(s)]`
    setThread((s) => pushUser(s, bubble))
    const wireText = primedRef.current ? `${serializeTranscript(saved)}\n\n${text}` : text
    ws.send(encodeInput(wireText, attachments.length > 0 ? attachments : undefined))
    primedRef.current = false
    setDraft('')
    files.clear()
  }, [draft, thread.busy, saved, files])

  const stop = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeInterrupt())
  }, [])

  // A config change respawns the session with a clean slate — clear the
  // primer and the persisted transcript along with the in-memory thread.
  const resetForConfigChange = useCallback(() => {
    primedRef.current = false
    setSaved([])
    setThread(emptyThread())
    saveChatThread(id, [])
  }, [id])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className={styles.pane}>
      <div className={styles.configRow}>
        <select
          className={styles.select}
          aria-label="Model"
          value={model}
          disabled={thread.busy}
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
          disabled={thread.busy}
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
          disabled={thread.busy}
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
      </div>

      <div className={styles.thread} ref={threadRef}>
        {thread.items.map((item, i) => {
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
        })}
      </div>

      <div
        className={styles.composer}
        onDrop={files.onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {(files.attachments.length > 0 || files.error) && (
          <AttachmentTray
            attachments={files.attachments}
            onRemove={files.remove}
            error={files.error}
          />
        )}
        <div className={styles.composerRow}>
          <textarea
            className={styles.input}
            placeholder="Message the agent…  (drop/paste images)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={files.onPaste}
            rows={2}
          />
          {thread.busy ? (
            <button type="button" className={styles.stop} onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className={styles.sendBtn}
              onClick={send}
              disabled={!draft.trim() && files.attachments.length === 0}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
