import { useEffect, useMemo, useState } from 'react'
import styles from './LoopChat.module.css'
import type { LoopEvent } from '../types'
import { appendPartial } from '../chatThread'
import { loopThread } from '../loopState'
import { useAutoScroll } from '../useAutoScroll'
import { NavIcon } from './NavIcon'
import { ThinkingDots } from './ThinkingDots'

interface Props {
  /** The open run's persisted events (only `chat` and `error` ones render here). */
  events: LoopEvent[]
  /** The orchestrator's in-flight reply, streamed as token deltas. */
  partial: string
  /** True while the orchestrator is mid-turn. */
  busy: boolean
  /** False when no orchestrator process is alive (a message respawns it). */
  alive: boolean
  /** Send an operator message; rejects with the server's error text. */
  onSend: (text: string) => Promise<unknown>
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The Loop run's orchestrator thread (left column of the Loop tab): operator
 * and orchestrator bubbles, the orchestrator's tool calls and the loop
 * notifications sent to it as compact notes, the live partial streaming in, and
 * a composer (Enter sends, Shift+Enter is a newline). The transcript lives in
 * App (fed by `loop-event` / `loop-partial` frames); the bubble derivation is
 * the shared `chatThread.ts` reducer via `loopThread`. No attachments, by scope.
 */
export function LoopChat({ events, partial, busy, alive, onSend }: Props) {
  const base = useMemo(() => loopThread(events), [events])
  const items = partial ? appendPartial({ items: base, busy }, partial).items : base
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { ref: threadRef, onScroll, scrollToBottom, notifyContentChanged, hasNew } =
    useAutoScroll<HTMLDivElement>()

  // Bottom-pin: follow new content only if the operator was already at the bottom.
  useEffect(() => {
    notifyContentChanged()
  }, [base, partial, notifyContentChanged])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      await onSend(text)
      setDraft('')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const state = busy ? 'working…' : alive ? 'idle' : 'asleep — a message wakes it'

  return (
    <section className={styles.pane} aria-label="Orchestrator">
      <div className={styles.head}>
        <span className={styles.title}>Orchestrator</span>
        <span className={styles.state} data-busy={busy || undefined}>
          {state}
        </span>
      </div>

      <div className={styles.threadWrap}>
        <div className={styles.thread} ref={threadRef} onScroll={onScroll}>
          {items.length === 0 && !busy && (
            <div className={styles.empty}>
              The orchestrator reads the map and the machine load, then proposes a lane count.
            </div>
          )}
          {items.map((item, i) => {
            if (item.kind === 'user') {
              return (
                <div key={i} className={`${styles.bubble} ${styles.operator}`}>
                  {item.text}
                </div>
              )
            }
            if (item.kind === 'agent') {
              return (
                <div key={i} className={`${styles.bubble} ${styles.orchestrator}`}>
                  {item.text}
                  {item.streaming && <span className={styles.caret} aria-hidden="true" />}
                </div>
              )
            }
            return (
              <div key={i} className={styles.note} data-kind={item.name}>
                <span className={styles.noteName}>{item.name}</span>
                {item.summary && <span className={styles.noteText}>{item.summary}</span>}
              </div>
            )
          })}
          {busy && !partial && (
            <div className={`${styles.bubble} ${styles.orchestrator}`}>
              <ThinkingDots />
            </div>
          )}
        </div>
        {hasNew && (
          <button type="button" className={styles.newMsgPill} onClick={scrollToBottom}>
            <NavIcon name="arrow-down" /> New message
          </button>
        )}
      </div>

      <div className={styles.composer}>
        {error && (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        )}
        <div className={styles.composerRow}>
          <textarea
            className={styles.input}
            aria-label="Message the orchestrator"
            placeholder="Message the orchestrator…  (Enter sends, Shift+Enter for a new line)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
          />
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => void send()}
            disabled={!draft.trim() || sending}
          >
            Send
          </button>
        </div>
      </div>
    </section>
  )
}
