import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { encodeAttach, encodeInput, encodeResize, parseServerMsg } from '../terminalProtocol'

interface Props {
  /** Stable id for this terminal instance (one tab / one xterm per id). */
  id: string
  /**
   * Persisted PTY session id to reattach to on mount, if the tab has one (from
   * `TerminalTabMeta.sessionId`). Only the value at mount is used — later changes
   * originate from this component and must not remount it.
   */
  sessionId?: string
  /** Called with the server-assigned session id once resolved, so the parent can
   *  persist it into `terminalTabs` for reattach across a page reload. */
  onSession?: (sessionId: string) => void
}

/** localStorage key prefix backing the per-tab session id (reload/reconnect). */
const SESSION_KEY_PREFIX = 'zmrng-term-'

/** Read a CSS custom property off :root, falling back when it reads empty. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * Thin DOM/canvas glue between an xterm.js terminal and a `/ws/terminal`
 * WebSocket-backed PTY. The socket ATTACHES to a server-owned session rather than
 * owning the shell: on a transient drop (machine lock, network blip) the effect
 * reconnects with backoff and re-sends the stored session id, so the same shell
 * and its recent output come back. All testable logic lives in
 * `terminalProtocol.ts`; this component is intentionally not unit-tested (jsdom
 * has no canvas + live socket). Colors are read from theme tokens — no hard-coded
 * values.
 */
export function Terminal({ id, sessionId, onSession }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // Capture the mount-time session id and keep the latest onSession without
  // re-running the effect (later sessionId changes originate here).
  const initialSessionRef = useRef(sessionId)
  const onSessionRef = useRef(onSession)
  // Keep the ref current without touching it during render (react-hooks/refs).
  useEffect(() => {
    onSessionRef.current = onSession
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: token('--font-mono', 'monospace'),
      fontSize: 13,
      theme: {
        background: token('--well', '#000000'),
        foreground: token('--text', '#f5f5f5'),
        cursor: token('--accent', '#edff45'),
      },
    })
    // Swallow the ctrl+` dock-toggle chord so it never reaches the PTY; the
    // dock handles it at the window level.
    term.attachCustomKeyEventHandler((e) => !(e.ctrlKey && e.key === '`'))

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // Session id to attach with: the persisted prop wins, else the localStorage
    // backup, else undefined (server spawns a fresh shell and returns its id).
    let currentSession: string | undefined =
      initialSessionRef.current || localStorage.getItem(SESSION_KEY_PREFIX + id) || undefined

    let ws: WebSocket | null = null
    let mounted = true
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoff = 1000

    const fitAndResize = () => {
      try {
        fit.fit()
      } catch {
        // container not measurable yet — ignore
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeResize(term.cols, term.rows))
      }
    }

    const connect = () => {
      if (!mounted) return
      ws = new WebSocket(`${proto}://${location.host}/ws/terminal`)
      ws.onopen = () => {
        backoff = 1000
        try {
          fit.fit()
        } catch {
          // not measurable yet — the server still gets the default 80x24
        }
        ws?.send(encodeAttach(currentSession, term.cols, term.rows))
      }
      ws.onmessage = (e) => {
        const msg = parseServerMsg(String(e.data))
        if (!msg) return
        if (msg.type === 'session') {
          currentSession = msg.sessionId
          try {
            localStorage.setItem(SESSION_KEY_PREFIX + id, msg.sessionId)
          } catch {
            // storage disabled — reconnect still works, only reload-reattach is lost
          }
          onSessionRef.current?.(msg.sessionId)
        } else if (msg.type === 'data') {
          term.write(msg.data)
        } else if (msg.type === 'exit') {
          term.write('\r\n[process exited]\r\n')
          // The shell is gone — forget the id so a reconnect spawns a fresh one.
          currentSession = undefined
          try {
            localStorage.removeItem(SESSION_KEY_PREFIX + id)
          } catch {
            // ignore
          }
        }
      }
      ws.onclose = () => {
        if (!mounted) return
        // Transient drop — reconnect and reattach to the same session (backoff).
        reconnectTimer = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30000)
      }
    }

    term.onData((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeInput(d))
    })

    const observer = new ResizeObserver(() => fitAndResize())
    observer.observe(host)

    connect()

    return () => {
      mounted = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      observer.disconnect()
      if (ws) {
        ws.onclose = null // intentional close — do not schedule a reconnect
        ws.close()
      }
      term.dispose()
    }
  }, [id])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
