import { useEffect, useRef, useState } from 'react'
import styles from './Chat.module.css'
import { api } from '../api'
import type { AgentSummary } from '../types'
import { renderMarkdown } from './renderMarkdown'

interface Props {
  taskId: string | null
  /** Configured agents — the parent only renders this card when this is non-empty. */
  agents: AgentSummary[]
}

/** A rendered chat turn (either persisted history or a live-streaming reply). */
interface Turn {
  role: 'user' | 'assistant'
  content: string
}

/** History tagged with the task+agent it was fetched for, so a stale conversation
 *  never shows against the wrong task/agent. */
interface Loaded {
  taskId: string
  agentId: string
  turns: Turn[]
}

export function Chat({ taskId, agents }: Props) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Keep the selected agent valid as the configured set changes.
  const effectiveAgentId = agents.some((a) => a.id === agentId) ? agentId : (agents[0]?.id ?? '')

  useEffect(() => {
    if (!taskId || !effectiveAgentId) return
    let cancelled = false
    api
      .getChat(taskId, effectiveAgentId)
      .then((history) => {
        if (!cancelled) {
          setLoaded({
            taskId,
            agentId: effectiveAgentId,
            turns: history.map((m) => ({ role: m.role, content: m.content })),
          })
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded({ taskId, agentId: effectiveAgentId, turns: [] })
      })
    return () => {
      cancelled = true
    }
  }, [taskId, effectiveAgentId])

  const fresh = loaded && loaded.taskId === taskId && loaded.agentId === effectiveAgentId
  const turns = fresh ? loaded.turns : null

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, streaming])

  if (!taskId) {
    return <div className={styles.empty}>Select a task to chat about it.</div>
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || streaming || !effectiveAgentId || !turns) return
    setError(null)
    setDraft('')
    // Optimistic user bubble + an empty assistant bubble that grows as tokens arrive.
    const base: Turn[] = [...turns, { role: 'user', content }, { role: 'assistant', content: '' }]
    setLoaded({ taskId, agentId: effectiveAgentId, turns: base })
    setStreaming(true)
    const appendToAssistant = (delta: string) => {
      setLoaded((prev) => {
        if (!prev || prev.taskId !== taskId || prev.agentId !== effectiveAgentId) return prev
        const next = prev.turns.slice()
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { role: 'assistant', content: last.content + delta }
        }
        return { ...prev, turns: next }
      })
    }
    try {
      await api.sendChat(taskId, effectiveAgentId, content, appendToAssistant)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat request failed.')
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className={styles.chat}>
      {agents.length > 1 && (
        <select
          className={styles.agentSelect}
          value={effectiveAgentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={streaming}
          aria-label="Chat agent"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}

      <div className={styles.thread}>
        {turns === null ? (
          <div className={styles.empty}>Loading…</div>
        ) : turns.length === 0 ? (
          <div className={styles.empty}>No messages yet.</div>
        ) : (
          turns.map((t, i) => {
            const isUser = t.role === 'user'
            const pending = streaming && i === turns.length - 1 && !t.content
            return (
              <div key={i} className={`${styles.turn} ${isUser ? styles.turnUser : styles.turnAssistant}`}>
                <span className={styles.avatar} aria-hidden="true">
                  {isUser ? 'You' : 'AI'}
                </span>
                <div className={`${styles.bubble} ${isUser ? styles.user : styles.assistant}`}>
                  {isUser ? (
                    <div className={styles.plain}>{t.content}</div>
                  ) : pending ? (
                    <span className={styles.typing}>…</span>
                  ) : (
                    // Escaped in renderMarkdown before any tag is introduced — safe to inject.
                    <div
                      className={styles.markdown}
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(t.content) }}
                    />
                  )}
                </div>
              </div>
            )
          })
        )}
        {error && <div className={styles.error}>{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          value={draft}
          placeholder="Message the agent…"
          rows={2}
          disabled={streaming}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          type="button"
          className={styles.send}
          onClick={() => void send()}
          disabled={streaming || !draft.trim()}
        >
          {streaming ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
