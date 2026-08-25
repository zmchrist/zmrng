import { useEffect, useRef, useState } from 'react'
import styles from './TeamView.module.css'
import type { WorkspaceMember } from '../types'
import { encodeHello, encodePing, parseWorkspaceServerMsg } from '../workspaceProtocol'
import { emptyRoster, applyWorkspaceMsg } from '../roster'
import {
  loadStoredHandle,
  saveStoredHandle,
  resolveWorkspaceUrl,
  workspaceSocketUrl,
} from '../teamConfig'

interface Props {
  /** Optional server-side default VPS URL (ServerConfig.workspaceUrl). The
   *  per-teammate localStorage value wins over this when set. */
  workspaceUrl: string
}

const PING_MS = 25000
const RECONNECT_MS = 2000

/**
 * The Team mode surface: connects to the configured VPS team-workspace server
 * over ONE multiplexed WebSocket, self-asserts a free-text display-name handle
 * on first connect, and renders the live workspace-wide presence roster. Local
 * task execution is untouched — this tab only talks to the VPS socket.
 *
 * This is connection glue (like WorkspaceGrid) — the wire protocol, roster
 * reducer, and config resolution it composes are each unit-tested in isolation.
 */
export function TeamView({ workspaceUrl }: Props) {
  const socketUrl = workspaceSocketUrl(resolveWorkspaceUrl(workspaceUrl))
  const [handle, setHandle] = useState<string>(() => loadStoredHandle())
  const [draft, setDraft] = useState('')
  const [roster, setRoster] = useState<WorkspaceMember[]>(emptyRoster)
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!handle || !socketUrl) return
    let closed = false
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      try {
        ws = new WebSocket(socketUrl)
      } catch {
        reconnect = setTimeout(connect, RECONNECT_MS)
        return
      }
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        ws?.send(encodeHello(handle))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodePing())
        }, PING_MS)
      }
      ws.onmessage = (ev) => {
        const msg = parseWorkspaceServerMsg(String(ev.data))
        if (msg) setRoster((prev) => applyWorkspaceMsg(prev, msg))
      }
      ws.onclose = () => {
        setConnected(false)
        if (ping) clearInterval(ping)
        if (!closed) reconnect = setTimeout(connect, RECONNECT_MS)
      }
      ws.onerror = () => ws?.close()
    }
    connect()

    return () => {
      closed = true
      if (ping) clearInterval(ping)
      if (reconnect) clearTimeout(reconnect)
      ws?.close()
      wsRef.current = null
      setConnected(false)
      setRoster(emptyRoster())
    }
  }, [handle, socketUrl])

  const onJoin = (e: React.FormEvent) => {
    e.preventDefault()
    const name = draft.trim()
    if (!name) return
    saveStoredHandle(name)
    setHandle(name)
  }

  const onLeave = () => {
    saveStoredHandle('')
    setHandle('')
    setDraft('')
  }

  if (!socketUrl) {
    return (
      <div className={styles.team}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No team workspace configured</p>
          <p className={styles.emptyHint}>
            Set the VPS team-workspace URL in <strong>Settings</strong> to connect.
          </p>
        </div>
      </div>
    )
  }

  if (!handle) {
    return (
      <div className={styles.team}>
        <form className={styles.join} onSubmit={onJoin}>
          <label className={styles.joinLabel} htmlFor="team-handle">
            Pick a display name
          </label>
          <p className={styles.joinHint}>
            A free-text handle — no password. You&apos;ll appear in the team roster.
          </p>
          <div className={styles.joinRow}>
            <input
              id="team-handle"
              className={styles.input}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. Ada"
              maxLength={64}
              autoFocus
            />
            <button type="submit" className={styles.joinBtn} disabled={!draft.trim()}>
              Join
            </button>
          </div>
        </form>
      </div>
    )
  }

  const onlineCount = roster.filter((m) => m.online).length

  return (
    <div className={styles.team}>
      <div className={styles.head}>
        <span className={styles.title}>Team</span>
        <span className={styles.you}>
          <span
            className={`${styles.dot} ${connected ? styles.dotOn : styles.dotOff}`}
            aria-hidden="true"
          />
          {connected ? 'connected' : 'connecting…'} as <strong>{handle}</strong>
        </span>
        <button type="button" className={styles.leaveBtn} onClick={onLeave} title="Change name">
          change name
        </button>
      </div>
      <div className={styles.rosterHead}>
        <span className={styles.rosterTitle}>Roster</span>
        <span className={styles.rosterCount}>
          {onlineCount} online · {roster.length} total
        </span>
      </div>
      <ul className={styles.roster}>
        {roster.length === 0 && <li className={styles.rosterEmpty}>No members yet.</li>}
        {roster.map((m) => (
          <li key={m.id} className={styles.member}>
            <span
              className={`${styles.dot} ${m.online ? styles.dotOn : styles.dotOff}`}
              aria-hidden="true"
            />
            <span className={styles.memberName}>{m.displayName}</span>
            <span className={styles.memberState}>{m.online ? 'online' : 'offline'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
