import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { encodeAttach, encodeInput, encodeResize, parseServerMsg } from '../terminalProtocol'
import {
  TERMINAL_KEYS,
  TERMINAL_KEYS_EXTRA,
  modSeq,
  type TerminalKey,
} from '../terminalKeys'
import { barOffset, useKeyboardInset } from '../keyboardInset'
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  getFontSize,
  pinchFontSize,
  setFontSize,
  subscribeFontSize,
} from '../terminalFont'
import {
  clampMenuPosition,
  flickVelocity,
  longPressMoved,
  momentumStep,
  pinchDistance,
  pinchScale,
  scrollLinesFor,
  type FlickSample,
  type TouchPoint,
} from '../terminalTouch'
import { useIsMobile } from '../useIsMobile'
import styles from './Terminal.module.css'

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

/** Hold a repeating key this long before the first repeat, then this often. */
const REPEAT_DELAY_MS = 400
const REPEAT_INTERVAL_MS = 60

/** A touch held this long without wandering opens the Paste/Copy menu. */
const LONG_PRESS_MS = 500

/** Roughly the rendered Paste/Copy menu, so it can be clamped before it paints. */
const MENU_SIZE = { width: 140, height: 92 }

/** How many drag samples to keep — enough to cover the flick window. */
const MAX_FLICK_SAMPLES = 12

/** Read a CSS custom property off :root, falling back when it reads empty. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** A short haptic tap. A no-op on iOS Safari, which does not implement vibrate. */
function tap(): void {
  try {
    navigator.vibrate?.(8)
  } catch {
    // unsupported or blocked — haptics are a nicety, never a failure
  }
}

function pointOf(t: Touch): TouchPoint {
  return { x: t.clientX, y: t.clientY }
}

/**
 * Thin DOM/canvas glue between an xterm.js terminal and a `/ws/terminal`
 * WebSocket-backed PTY. The socket ATTACHES to a server-owned session rather than
 * owning the shell: on a transient drop (machine lock, network blip) the effect
 * reconnects with backoff and re-sends the stored session id, so the same shell
 * and its recent output come back.
 *
 * On a phone it also carries the on-screen key bar (`terminalKeys.ts`), the
 * keyboard-inset fix that keeps that bar and the cursor line above the soft
 * keyboard (`keyboardInset.ts`), pinch-to-resize (`terminalFont.ts`) and
 * flick-scroll with momentum plus the long-press Paste/Copy menu
 * (`terminalTouch.ts`). Every one of those is
 * gated on `useIsMobile()` or a phone media block — desktop is untouched.
 *
 * All testable logic lives in those modules; this component is intentionally not
 * unit-tested (jsdom has no canvas + live socket). Colors are read from theme
 * tokens — no hard-coded values.
 */
export function Terminal({ id, sessionId, onSession }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Phone only: an on-screen key bar for the keys a soft keyboard lacks. `Ctrl`
  // and `Alt` are sticky modifiers — armed here, consumed by the next chunk.
  const isMobile = useIsMobile()
  const keyboardInset = useKeyboardInset()
  const fontSize = useSyncExternalStore(
    subscribeFontSize,
    getFontSize,
    () => DEFAULT_TERMINAL_FONT_SIZE,
  )
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [altArmed, setAltArmed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null)
  const ctrlRef = useRef(false)
  const altRef = useRef(false)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const sendRef = useRef<((data: string) => void) | null>(null)
  const focusRef = useRef<(() => void) | null>(null)
  // Capture the mount-time session id and keep the latest onSession without
  // re-running the effect (later sessionId changes originate here).
  const initialSessionRef = useRef(sessionId)
  const onSessionRef = useRef(onSession)
  // Seeded at first render so the XTerm constructor below opens at the stored
  // size; kept current by the font-size effect for later remounts.
  const fontSizeRef = useRef(fontSize)
  // Keep the ref current without touching it during render (react-hooks/refs).
  useEffect(() => {
    onSessionRef.current = onSession
  })

  // A pinch in any terminal tab changes the shared size — apply it live rather
  // than only on remount, since inactive tabs stay mounted.
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    fitRef.current?.()
  }, [fontSize])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: token('--font-mono', 'monospace'),
      fontSize: fontSizeRef.current,
      theme: {
        background: token('--well', '#000000'),
        foreground: token('--text', '#f5f5f5'),
        cursor: token('--accent', '#edff45'),
      },
    })
    termRef.current = term
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
    fitRef.current = fitAndResize

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

    const send = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeInput(data))
    }
    sendRef.current = send
    focusRef.current = () => term.focus()

    term.onData((d) => {
      // The armed modifiers are one-shot: they apply to this chunk and clear.
      if (ctrlRef.current || altRef.current) {
        const mods = { ctrl: ctrlRef.current, alt: altRef.current }
        ctrlRef.current = false
        altRef.current = false
        setCtrlArmed(false)
        setAltArmed(false)
        send(modSeq(d, mods))
        return
      }
      send(d)
    })

    const observer = new ResizeObserver(() => fitAndResize())
    observer.observe(host)

    connect()

    return () => {
      mounted = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      observer.disconnect()
      sendRef.current = null
      focusRef.current = null
      fitRef.current = null
      termRef.current = null
      if (ws) {
        ws.onclose = null // intentional close — do not schedule a reconnect
        ws.close()
      }
      term.dispose()
    }
  }, [id])

  // Keep the key bar (and the cursor line) above the soft keyboard. iOS Safari
  // overlays the keyboard on the layout viewport instead of shrinking it, so
  // padding the wrap by the inset is what shrinks the xterm host — the existing
  // ResizeObserver then refits rows/cols with no extra plumbing.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (!isMobile || keyboardInset === 0) {
      wrap.style.setProperty('--kb-inset', '0px')
      return
    }
    // The wrap does not reach the viewport bottom (the phone shell pads it by
    // env(safe-area-inset-bottom)) — padding is inside the box, so measuring
    // this gap cannot feed back into the measurement.
    const rect = wrap.getBoundingClientRect()
    const gap = Math.max(0, window.innerHeight - rect.bottom)
    wrap.style.setProperty('--kb-inset', `${barOffset(keyboardInset, gap)}px`)
    // iOS sometimes scrolls the layout viewport on focus — pin it back.
    window.scrollTo(0, 0)
  }, [isMobile, keyboardInset])

  // ---- key bar ------------------------------------------------------------

  const repeatRef = useRef<{
    delay: ReturnType<typeof setTimeout> | null
    interval: ReturnType<typeof setInterval> | null
  }>({ delay: null, interval: null })

  const stopRepeat = useCallback(() => {
    const timers = repeatRef.current
    if (timers.delay) clearTimeout(timers.delay)
    if (timers.interval) clearInterval(timers.interval)
    timers.delay = null
    timers.interval = null
  }, [])

  // Cleanup-only effect: drop any pending key repeat when the terminal unmounts.
  useEffect(() => stopRepeat, [stopRepeat])

  const startRepeat = (k: TerminalKey) => {
    const seq = k.seq
    if (!k.repeat || seq === null) return
    stopRepeat()
    repeatRef.current.delay = setTimeout(() => {
      repeatRef.current.delay = null
      repeatRef.current.interval = setInterval(() => sendRef.current?.(seq), REPEAT_INTERVAL_MS)
    }, REPEAT_DELAY_MS)
  }

  const onKey = (k: TerminalKey) => {
    tap()
    if (k.mod === 'ctrl') {
      const next = !ctrlRef.current
      ctrlRef.current = next
      setCtrlArmed(next)
    } else if (k.mod === 'alt') {
      const next = !altRef.current
      altRef.current = next
      setAltArmed(next)
    } else if (k.seq !== null) {
      sendRef.current?.(k.seq)
    }
    focusRef.current?.()
  }

  const armedFor = (k: TerminalKey) =>
    k.mod === 'ctrl' ? ctrlArmed : k.mod === 'alt' ? altArmed : undefined

  // NOTE: only `mousedown` is prevented, never `touchstart`. Preventing
  // touchstart suppresses the compatibility mouse events iOS synthesises —
  // including the `click` that fires these handlers — which would leave every
  // bar key dead on the exact device this bar exists for. Preventing the
  // synthesised `mousedown` is already what stops the button stealing focus
  // from the xterm textarea and closing the soft keyboard.
  const renderKey = (k: TerminalKey) => {
    const armed = armedFor(k)
    return (
      <button
        key={k.id}
        type="button"
        className={`${styles.key} ${armed ? styles.keyArmed : ''}`}
        aria-pressed={k.mod ? armed : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={() => startRepeat(k)}
        onPointerUp={stopRepeat}
        onPointerCancel={stopRepeat}
        onPointerLeave={stopRepeat}
        onClick={() => onKey(k)}
      >
        {k.label}
      </button>
    )
  }

  // ---- touch gestures -----------------------------------------------------

  // Re-registered when the terminal instance is rebuilt (`id`) or the phone
  // breakpoint flips; handlers read `termRef` lazily so they never hold a
  // disposed terminal.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !isMobile) return

    let mode: 'none' | 'pinch' | 'drag' = 'none'
    let pinchStart = 0
    let pinchBase = DEFAULT_TERMINAL_FONT_SIZE
    let pendingScale: number | null = null
    let pinchRaf: number | null = null
    let lastY = 0
    let carry = 0
    let samples: FlickSample[] = []
    let momentumRaf: number | null = null
    let longPressTimer: ReturnType<typeof setTimeout> | null = null
    let longPressAt: TouchPoint | null = null

    const lineHeight = () => {
      const term = termRef.current
      if (!term || term.rows <= 0) return 0
      return host.clientHeight / term.rows
    }

    const scrollBy = (distancePx: number) => {
      const step = scrollLinesFor(distancePx, lineHeight(), carry)
      carry = step.carry
      // Dragging the content down (positive delta) walks back into scrollback.
      if (step.lines !== 0) termRef.current?.scrollLines(-step.lines)
    }

    const stopMomentum = () => {
      if (momentumRaf !== null) cancelAnimationFrame(momentumRaf)
      momentumRaf = null
    }

    const cancelLongPress = () => {
      if (longPressTimer) clearTimeout(longPressTimer)
      longPressTimer = null
      longPressAt = null
    }

    const onTouchStart = (e: TouchEvent) => {
      stopMomentum()
      if (e.touches.length >= 2) {
        cancelLongPress()
        mode = 'pinch'
        pinchStart = pinchDistance(pointOf(e.touches[0]), pointOf(e.touches[1]))
        pinchBase = getFontSize()
        e.preventDefault() // stop iOS page zoom
        return
      }
      if (e.touches.length !== 1) return
      mode = 'drag'
      lastY = e.touches[0].clientY
      carry = 0
      samples = [{ y: lastY, t: e.timeStamp }]
      const at = pointOf(e.touches[0])
      longPressAt = at
      longPressTimer = setTimeout(() => {
        longPressTimer = null
        mode = 'none'
        const wrap = wrapRef.current
        if (!wrap) return
        const rect = wrap.getBoundingClientRect()
        setMenu(
          clampMenuPosition(
            { x: at.x - rect.left, y: at.y - rect.top },
            MENU_SIZE,
            { width: rect.width, height: rect.height },
          ),
        )
        tap()
      }, LONG_PRESS_MS)
    }

    const onTouchMove = (e: TouchEvent) => {
      if (mode === 'pinch' && e.touches.length >= 2) {
        e.preventDefault()
        pendingScale = pinchScale(
          pinchStart,
          pinchDistance(pointOf(e.touches[0]), pointOf(e.touches[1])),
        )
        // Coalesce onto a frame so a drag does not thrash xterm reflows.
        if (pinchRaf === null) {
          pinchRaf = requestAnimationFrame(() => {
            pinchRaf = null
            if (pendingScale !== null) setFontSize(pinchFontSize(pinchBase, pendingScale))
          })
        }
        return
      }
      if (e.touches.length !== 1) return
      const at = pointOf(e.touches[0])
      if (longPressAt && longPressMoved(longPressAt, at)) cancelLongPress()
      if (mode !== 'drag') return
      e.preventDefault()
      const dy = at.y - lastY
      lastY = at.y
      samples.push({ y: at.y, t: e.timeStamp })
      if (samples.length > MAX_FLICK_SAMPLES) samples.shift()
      scrollBy(dy)
    }

    const onTouchEnd = (e: TouchEvent) => {
      cancelLongPress()
      if (e.touches.length > 0) return
      const wasDrag = mode === 'drag'
      mode = 'none'
      if (!wasDrag) return
      let velocity = flickVelocity(samples)
      if (velocity === 0) return
      let last = performance.now()
      const frame = (now: number) => {
        const step = momentumStep(velocity, now - last)
        last = now
        velocity = step.velocity
        scrollBy(step.distance)
        momentumRaf = velocity === 0 ? null : requestAnimationFrame(frame)
      }
      momentumRaf = requestAnimationFrame(frame)
    }

    const onTouchCancel = () => {
      cancelLongPress()
      mode = 'none'
    }

    // Non-passive: the pinch and drag handlers must be able to preventDefault.
    const opts = { passive: false } as const
    host.addEventListener('touchstart', onTouchStart, opts)
    host.addEventListener('touchmove', onTouchMove, opts)
    host.addEventListener('touchend', onTouchEnd, opts)
    host.addEventListener('touchcancel', onTouchCancel, opts)

    return () => {
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      host.removeEventListener('touchcancel', onTouchCancel)
      cancelLongPress()
      stopMomentum()
      if (pinchRaf !== null) cancelAnimationFrame(pinchRaf)
    }
  }, [isMobile, id])

  // ---- long-press menu ----------------------------------------------------

  const paste = async () => {
    setMenu(null)
    try {
      const text = await navigator.clipboard?.readText()
      if (text) sendRef.current?.(text)
    } catch {
      // permission denied or unavailable — fail closed, the menu is already gone
    }
    focusRef.current?.()
  }

  const copy = async () => {
    setMenu(null)
    try {
      const selection = termRef.current?.getSelection()
      if (selection) await navigator.clipboard?.writeText(selection)
    } catch {
      // permission denied or unavailable — fail closed
    }
    focusRef.current?.()
  }

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <div ref={hostRef} className={styles.host} />
      {isMobile && menu && (
        <>
          <div className={styles.menuBackdrop} onPointerDown={() => setMenu(null)} />
          <div
            className={styles.menu}
            style={{ left: menu.left, top: menu.top }}
            role="menu"
            aria-label="Terminal clipboard"
          >
            <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void paste()}>
              Paste
            </button>
            <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void copy()}>
              Copy
            </button>
          </div>
        </>
      )}
      {isMobile && (
        <div className={styles.bar}>
          <div className={styles.row}>
            <div className={styles.keys} role="toolbar" aria-label="Terminal keys">
              {TERMINAL_KEYS.map(renderKey)}
            </div>
            <div className={styles.controls}>
              <button
                type="button"
                className={`${styles.key} ${expanded ? styles.keyArmed : ''}`}
                aria-label="More keys"
                aria-expanded={expanded}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  tap()
                  setExpanded((v) => !v)
                  focusRef.current?.()
                }}
              >
                {expanded ? '⌄' : '⌃'}
              </button>
              <button
                type="button"
                className={styles.key}
                aria-label="Hide keyboard"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  tap()
                  termRef.current?.blur()
                }}
              >
                ⌨
              </button>
            </div>
          </div>
          {expanded && (
            <div
              className={`${styles.keys} ${styles.keysExtra}`}
              role="toolbar"
              aria-label="Terminal function keys"
            >
              {TERMINAL_KEYS_EXTRA.map(renderKey)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
