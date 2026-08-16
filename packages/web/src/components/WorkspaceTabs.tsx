import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import styles from './WorkspaceTabs.module.css'
import type { AgentSummary, TaskEvent, TaskStatus, WorkspaceLayout, WsPane, WsTab } from '../types'
import {
  closeTab,
  dropIntent,
  focusTab,
  moveTab,
  openFile,
  openPanel,
  setLogMinimized,
  splitWith,
  type DropIntent,
} from '../workspaceLayout'
import { Viewer } from './Viewer'
import { WorkerLog } from './WorkerLog'
import { Notes } from './Notes'
import { Chat } from './Chat'

/** Statuses at which the Worker-Log tab becomes freely closeable (PR up / stopped
 *  / cancelled / archived). While the agent is still working it can only be
 *  minimized, never closed. */
const LOG_CLOSEABLE = new Set<TaskStatus>(['review', 'done', 'failed', 'archived'])

const DND_MIME = 'application/x-zmrng-tab'

interface Props {
  taskId: string | null
  status: TaskStatus | null
  events: TaskEvent[]
  live: string
  agents: AgentSummary[]
  layout: WorkspaceLayout
  onLayoutChange: (next: WorkspaceLayout) => void
}

/** Human label for a tab. Files show their basename; singletons a fixed label. */
function tabLabel(tab: WsTab): string {
  switch (tab.kind) {
    case 'file':
      return tab.path ? (tab.path.split('/').pop() ?? tab.path) : 'File'
    case 'log':
      return 'Worker Log'
    case 'notes':
      return 'Notes'
    case 'chat':
      return 'Chat'
  }
}

/** The active file path in the active pane, if any — feeds Notes' `selectedPath`. */
function activeFilePath(layout: WorkspaceLayout): string | null {
  const pane = layout.panes[layout.activePane]
  const tab = pane?.tabs.find((t) => t.id === pane.activeId)
  return tab?.kind === 'file' ? (tab.path ?? null) : null
}

/** Grid template so the split axis (and a minimized log pane) size correctly. */
function gridStyle(layout: WorkspaceLayout): CSSProperties {
  if (layout.split === null) return {}
  const size = (i: number) =>
    layout.logMinimized && layout.panes[i]?.activeId === 'log' ? 'auto' : 'minmax(0, 1fr)'
  return layout.split === 'row'
    ? { gridTemplateColumns: `${size(0)} ${size(1)}` }
    : { gridTemplateRows: `${size(0)} ${size(1)}` }
}

/** Resolve a drop over a pane to a single reducer call. */
function applyDrop(
  layout: WorkspaceLayout,
  id: string,
  paneIdx: number,
  intent: DropIntent,
): WorkspaceLayout {
  if (intent === 'center') {
    return moveTab(layout, id, paneIdx, layout.panes[paneIdx]?.tabs.length ?? 0)
  }
  return splitWith(layout, id, intent)
}

export function WorkspaceTabs({ taskId, status, events, live, agents, layout, onLayoutChange }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const logCloseable = status != null && LOG_CLOSEABLE.has(status)
  const openKinds = new Set(layout.panes.flatMap((p) => p.tabs.map((t) => t.kind)))
  const selectedPath = activeFilePath(layout)

  const onOpenFile = (path: string) => onLayoutChange(openFile(layout, path))

  function content(tab: WsTab): ReactNode {
    switch (tab.kind) {
      case 'file':
        return <Viewer taskId={taskId} path={tab.path ?? null} />
      case 'log':
        return <WorkerLog events={events} live={live} />
      case 'notes':
        return <Notes taskId={taskId} selectedPath={selectedPath} onOpen={onOpenFile} />
      case 'chat':
        return <Chat taskId={taskId} agents={agents} />
    }
  }

  function renderPane(pane: WsPane, paneIdx: number) {
    const minimized = !!layout.logMinimized && pane.activeId === 'log'
    if (minimized) {
      return (
        <button
          key={paneIdx}
          type="button"
          className={styles.miniStrip}
          aria-label="Expand worker log"
          onClick={() => onLayoutChange(setLogMinimized(layout, false))}
        >
          Worker Log
        </button>
      )
    }

    const active = pane.tabs.find((t) => t.id === pane.activeId)

    const onDrop = (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      const id = e.dataTransfer.getData(DND_MIME) || draggingId
      setDraggingId(null)
      if (!id) return
      const rect = e.currentTarget.getBoundingClientRect()
      const intent = dropIntent(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
      onLayoutChange(applyDrop(layout, id, paneIdx, intent))
    }

    return (
      <section
        key={paneIdx}
        className={`${styles.pane} ${paneIdx === layout.activePane ? styles.paneActive : ''}`}
        onDragOver={(e) => draggingId && e.preventDefault()}
        onDrop={onDrop}
      >
        <div className={styles.tabStrip} role="tablist" aria-label="Open tabs">
          {pane.tabs.map((tab) => {
            const label = tabLabel(tab)
            const selected = tab.id === pane.activeId
            const isLog = tab.kind === 'log'
            const showClose = !isLog || logCloseable
            return (
              <div className={styles.tab} role="presentation" key={tab.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`${styles.tabLabel} ${selected ? styles.tabActive : ''}`}
                  draggable
                  onClick={() => onLayoutChange(focusTab(layout, paneIdx, tab.id))}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DND_MIME, tab.id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDraggingId(tab.id)
                  }}
                  onDragEnd={() => setDraggingId(null)}
                >
                  {label}
                </button>
                {isLog && (
                  <button
                    type="button"
                    className={styles.ctrl}
                    aria-label="Minimize worker log"
                    title="Minimize"
                    onClick={() => onLayoutChange(setLogMinimized(layout, true))}
                  >
                    –
                  </button>
                )}
                {showClose && (
                  <button
                    type="button"
                    className={styles.ctrl}
                    aria-label={`Close ${label}`}
                    title="Close"
                    onClick={() => onLayoutChange(closeTab(layout, tab.id))}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <div className={styles.paneBody} role="tabpanel">
          {active ? (
            content(active)
          ) : (
            <div className={styles.empty}>Empty pane — open a file or a panel.</div>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className={styles.tabArea}>
      <div className={styles.buttonBar}>
        <span className={styles.barLabel}>Panels</span>
        {!openKinds.has('log') && (
          <button
            type="button"
            className={styles.reopen}
            onClick={() => onLayoutChange(openPanel(layout, 'log'))}
          >
            Worker Log
          </button>
        )}
        {!openKinds.has('notes') && (
          <button
            type="button"
            className={styles.reopen}
            onClick={() => onLayoutChange(openPanel(layout, 'notes'))}
          >
            Notes
          </button>
        )}
        {agents.length > 0 && !openKinds.has('chat') && (
          <button
            type="button"
            className={styles.reopen}
            onClick={() => onLayoutChange(openPanel(layout, 'chat'))}
          >
            Chat
          </button>
        )}
      </div>
      <div className={styles.grid} style={gridStyle(layout)} data-split={layout.split ?? 'none'}>
        {layout.panes.map((pane, i) => renderPane(pane, i))}
      </div>
    </div>
  )
}
