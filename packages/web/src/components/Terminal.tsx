import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { encodeInput, encodeResize, parseServerMsg } from '../terminalProtocol'

interface Props {
  /** Stable id for this terminal instance (one PTY / one WebSocket per id). */
  id: string
}

/** Read a CSS custom property off :root, falling back when it reads empty. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * Thin DOM/canvas glue between an xterm.js terminal and a `/ws/terminal`
 * WebSocket-backed PTY. All testable logic lives in `terminalProtocol.ts`; this
 * component is intentionally not unit-tested (jsdom has no canvas). Colors are
 * read from the theme tokens — no hard-coded values.
 */
export function Terminal({ id }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)

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
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal`)

    const fitAndResize = () => {
      try {
        fit.fit()
      } catch {
        // container not measurable yet — ignore
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeResize(term.cols, term.rows))
      }
    }

    term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeInput(d))
    })

    ws.onopen = () => fitAndResize()
    ws.onmessage = (e) => {
      const msg = parseServerMsg(String(e.data))
      if (msg?.type === 'data') term.write(msg.data)
      else if (msg?.type === 'exit') term.write('\r\n[process exited]\r\n')
    }

    const observer = new ResizeObserver(() => fitAndResize())
    observer.observe(host)

    return () => {
      observer.disconnect()
      ws.close()
      term.dispose()
    }
  }, [id])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
