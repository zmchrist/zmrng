import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './TerminalDock.module.css'
import { Terminal } from './Terminal'
import { ChatPane } from './ChatPane'
import { addChat, addTab, addTerminal, closeTerminal, emptyDock, focusKind, setActive } from '../terminalDock'
import type { DockState, DockTab } from '../terminalDock'
import { loadChatOrder, removeChatThread, saveChatOrder } from '../chatPersistence'
import { usePanelMount } from '../usePanelMount'

/** Rebuild the dock's chat tabs from the persisted order (auto-reopen on load).
 *  Terminal tabs are never restored — only the chat feature persists. */
function hydrateDock(): DockState {
  const { order, activeId } = loadChatOrder()
  let state = emptyDock()
  for (const id of order) state = addTab(state, id, 'chat')
  if (activeId && state.tabs.some((t) => t.id === activeId)) state = setActive(state, activeId)
  return state
}

/** Next seed above every restored tab's numeric suffix, so a freshly spawned
 *  tab's id never collides with a restored one. */
function nextSeedFrom(tabs: DockTab[]): number {
  let max = -1
  for (const t of tabs) {
    const m = /-(\d+)$/.exec(t.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** Clamp bounds for the dock height (px). */
const MIN_H = 120
const MAX_H = 640

/** Per-kind label ("Terminal N" / "Chat N"), counting prior tabs of the same kind. */
function labelFor(tabs: DockTab[], i: number): string {
  const kind = tabs[i].kind
  const n = tabs.slice(0, i + 1).filter((t) => t.kind === kind).length
  return `${kind === 'chat' ? 'Chat' : 'Terminal'} ${n}`
}

interface Props {
  /** Whether the dock body is expanded (persisted chrome, from App). */
  open: boolean
  /** Dock body height in px (persisted chrome, from App). */
  height: number
  onOpenChange: (v: boolean) => void
  onHeightChange: (h: number) => void
  /** Bottom-nav pane visibility + toggles (the other panes this bar controls). */
  tasksOpen: boolean
  workspaceOpen: boolean
  filesOpen: boolean
  notesOpen: boolean
  settingsOpen: boolean
  onTasksToggle: () => void
  onWorkspaceToggle: () => void
  onFilesToggle: () => void
  onNotesToggle: () => void
  onSettingsToggle: () => void
}

/**
 * The Zed-style bottom bar: a slim always-visible nav bar of pane toggles, plus
 * an expandable terminal body above it. The Terminal button toggles the body of
 * N terminal tabs (each a live `<Terminal>` — one PTY / WebSocket per tab; no
 * terminal is mounted while the dock is closed). The Tasks / Workspace / Settings
 * buttons toggle their regions in place. The ephemeral terminal tab list is owned
 * here via the pure `terminalDock` reducer; only `open`/`height` persist.
 */
export function TerminalDock({
  open,
  height,
  onOpenChange,
  onHeightChange,
  tasksOpen,
  workspaceOpen,
  filesOpen,
  notesOpen,
  settingsOpen,
  onTasksToggle,
  onWorkspaceToggle,
  onFilesToggle,
  onNotesToggle,
  onSettingsToggle,
}: Props) {
  // Chat tabs auto-reopen from localStorage (order.length usually 0 for a
  // fresh session); terminal tabs never restore.
  const [dock, setDock] = useState(hydrateDock)
  // Monotonic seed for stable, collision-free terminal ids (never Math.random),
  // seeded past any restored chat tab's suffix so a new tab never collides.
  const [seed, setSeed] = useState(() => nextSeedFrom(hydrateDock().tabs))
  // Tracks the last `open` value we reacted to, so the auto-seed below fires only
  // on the closed→open transition — not on every render while open.
  const [lastOpen, setLastOpen] = useState(false)

  // Auto-create the first terminal only when the dock *transitions* to open with
  // no tabs — covers a fresh toggle-open and a load with the dock persisted open,
  // but NOT the user closing the last tab (that leaves an empty dock, so they can
  // reopen a shell with `+`). Adjusted during render (the "derive state on a prop
  // change" pattern, mirroring WorkspaceView) to avoid react-hooks/set-state-in-effect.
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open && dock.tabs.length === 0) {
      setDock(addTerminal(dock, `term-${seed}`))
      setSeed(seed + 1)
    }
  }

  const spawn = useCallback(() => {
    setDock((d) => addTerminal(d, `term-${seed}`))
    setSeed((s) => s + 1)
  }, [seed])

  // Open a new chat tab, opening the dock body if it is closed. Appending the
  // chat before flipping `open` means the closed→open auto-seed above sees a
  // non-empty dock and does NOT also spawn a terminal.
  const spawnChat = useCallback(() => {
    setDock((d) => addChat(d, `chat-${seed}`))
    setSeed((s) => s + 1)
    if (!open) onOpenChange(true)
  }, [seed, open, onOpenChange])

  const activeTab = dock.tabs.find((t) => t.id === dock.activeId) ?? null
  const chatActive = open && activeTab?.kind === 'chat'
  const terminalActive = open && activeTab?.kind === 'terminal'

  // Shared nav-bar click behavior for the Terminal/Chat pane toggles: if the
  // dock is open and already focused on a tab of this kind, minimize it. If
  // the dock is open on a different kind, just switch focus (dock stays
  // open). Otherwise open the dock focused on the last-active existing tab
  // of this kind, spawning a fresh one only if none exists yet.
  const focusOrToggleKind = useCallback(
    (kind: 'terminal' | 'chat') => {
      if (open && activeTab?.kind === kind) {
        onOpenChange(false)
        return
      }
      const prefix = kind === 'chat' ? 'chat' : 'term'
      setDock((d) => focusKind(d, kind, `${prefix}-${seed}`))
      setSeed((s) => s + 1)
      if (!open) onOpenChange(true)
    },
    [open, activeTab, seed, onOpenChange],
  )

  // Persist the chat tab order + focused id on every dock change, so a
  // reload can auto-reopen them (`hydrateDock` above).
  useEffect(() => {
    const chatIds = dock.tabs.filter((t) => t.kind === 'chat').map((t) => t.id)
    const activeChatId = dock.activeId && chatIds.includes(dock.activeId) ? dock.activeId : (chatIds[0] ?? null)
    saveChatOrder(chatIds, activeChatId)
  }, [dock.tabs, dock.activeId])

  // Auto-reopen the dock body on load when restored chat tabs exist, so their
  // history is visible without the operator toggling anything. Fires at most
  // once (the ref guard), evaluated against the very first commit's values —
  // it must never re-trigger later, or a deliberate "Hide terminal" click
  // would be forced back open as soon as this effect re-runs on the next
  // dock/open change.
  const autoReopenRanRef = useRef(false)
  useEffect(() => {
    if (autoReopenRanRef.current) return
    autoReopenRanRef.current = true
    if (dock.tabs.length > 0 && !open) onOpenChange(true)
  }, [dock.tabs.length, open, onOpenChange])

  // Ctrl+` toggles the dock (Zed parity). Intercepted at the window level;
  // xterm swallows the same chord so it never reaches a focused PTY.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: height }
      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        const next = Math.max(MIN_H, Math.min(MAX_H, drag.startH + (drag.startY - ev.clientY)))
        onHeightChange(next)
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [height, onHeightChange],
  )

  const clampedHeight = Math.max(MIN_H, Math.min(MAX_H, height))
  const bodyMounted = usePanelMount(open)

  return (
    <div className={styles.dock}>
      {bodyMounted && dock.tabs.length > 0 && (
        <div
          className={`${styles.body} ${open ? styles.paneEnter : styles.paneExit}`}
          style={{ height: clampedHeight }}
        >
          <div
            className={styles.resizeHandle}
            onPointerDown={onResizeStart}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize terminal"
          />
          <div className={styles.tabStrip} role="tablist" aria-label="Terminal and chat tabs">
            {dock.tabs.map((t, i) => {
              const active = t.id === dock.activeId
              const label = labelFor(dock.tabs, i)
              return (
                <div className={styles.tab} role="presentation" key={t.id}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`${styles.tabLabel} ${active ? styles.tabActive : ''}`}
                    onClick={() => setDock((d) => setActive(d, t.id))}
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    className={styles.ctrl}
                    aria-label={`Close ${label.toLowerCase()}`}
                    title="Close"
                    onClick={() => {
                      if (t.kind === 'chat') removeChatThread(t.id)
                      setDock((d) => closeTerminal(d, t.id))
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <button
              type="button"
              className={styles.add}
              aria-label="New terminal"
              title="New terminal"
              onClick={spawn}
            >
              +
            </button>
            <button
              type="button"
              className={styles.add}
              aria-label="New chat"
              title="New chat"
              onClick={spawnChat}
            >
              +💬
            </button>
          </div>
          <div className={styles.terminals}>
            {dock.tabs.map((t) => (
              <div
                key={t.id}
                className={styles.termHost}
                style={{ display: t.id === dock.activeId ? 'block' : 'none' }}
              >
                {t.kind === 'chat' ? <ChatPane id={t.id} /> : <Terminal id={t.id} />}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={styles.navBar} role="toolbar" aria-label="Panes">
        <button
          type="button"
          className={`${styles.navBtn} ${terminalActive ? styles.navBtnActive : ''}`}
          aria-pressed={terminalActive}
          aria-label={terminalActive ? 'Hide terminal' : 'Show terminal'}
          onClick={() => focusOrToggleKind('terminal')}
        >
          <span className={styles.glyph} aria-hidden="true">
            {'>_'}
          </span>
          <span className={styles.navLabel}>Terminal</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${chatActive ? styles.navBtnActive : ''}`}
          aria-pressed={chatActive}
          aria-label={chatActive ? 'Hide chat' : 'Show chat'}
          onClick={() => focusOrToggleKind('chat')}
        >
          <span className={styles.glyph} aria-hidden="true">
            💬
          </span>
          <span className={styles.navLabel}>Chat</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${tasksOpen ? styles.navBtnActive : ''}`}
          aria-pressed={tasksOpen}
          aria-label={tasksOpen ? 'Hide tasks' : 'Show tasks'}
          onClick={onTasksToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ☰
          </span>
          <span className={styles.navLabel}>Tasks</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${workspaceOpen ? styles.navBtnActive : ''}`}
          aria-pressed={workspaceOpen}
          aria-label={workspaceOpen ? 'Hide workspace' : 'Show workspace'}
          onClick={onWorkspaceToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ▦
          </span>
          <span className={styles.navLabel}>Workspace</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${filesOpen ? styles.navBtnActive : ''}`}
          aria-pressed={filesOpen}
          aria-label={filesOpen ? 'Hide files' : 'Show files'}
          onClick={onFilesToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ⌂
          </span>
          <span className={styles.navLabel}>Files</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${notesOpen ? styles.navBtnActive : ''}`}
          aria-pressed={notesOpen}
          aria-label={notesOpen ? 'Hide notes' : 'Show notes'}
          onClick={onNotesToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ▤
          </span>
          <span className={styles.navLabel}>Notes</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${settingsOpen ? styles.navBtnActive : ''}`}
          aria-pressed={settingsOpen}
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
          onClick={onSettingsToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ⚙
          </span>
          <span className={styles.navLabel}>Settings</span>
        </button>
      </div>
    </div>
  )
}
