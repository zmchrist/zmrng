import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import styles from './WorkspaceTabs.module.css'
import type { AgentSummary, TaskEvent, TaskStatus, WorkspaceLayout, WsPane, WsTab } from '../types'
import {
  closeTab,
  dropIntent,
  focusTab,
  moveTab,
  openPanel,
  setLogMinimized,
  splitWith,
  type DropIntent,
} from '../workspaceLayout'
import { Viewer } from './Viewer'
import { WorkerLogPanel } from './WorkerLogPanel'
import { Chat } from './Chat'

/** Statuses at which the Worker-Log tab becomes freely closeable (PR up / stopped
 *  / cancelled / archived). While the agent is still working it can only be
 *  minimized, never closed. */
const LOG_CLOSEABLE = new Set<TaskStatus>(['review', 'done', 'failed', 'archived'])

const DND_MIME = 'application/x-zmrng-tab'

interface Props {
  taskId: string | null
  /** Title of the task whose Worker Log this pane shows — the log tab is
   *  labeled with it (falls back to "Worker Log" when absent). */
  taskTitle?: string | null
  status: TaskStatus | null
  events: TaskEvent[]
  live: string
  agents: AgentSummary[]
  layout: WorkspaceLayout
  onLayoutChange: (next: WorkspaceLayout) => void
  /** Steer the running worker from the Worker-Log composer (POST …/message).
   *  Absent ⇒ the composer is not shown (e.g. the unit harness). */
  onMessage?: (text: string) => Promise<unknown>
  /** Other tasks currently in a live phase (excluding this pane's own task) —
   *  rendered as extra tabs right next to the Worker Log tab, so a second (or
   *  third) concurrently running task's log is one click away without going
   *  back to the task rail. */
  liveTasks?: { id: string; title: string }[]
  /** Switch the selected task — called when a live-task tab is clicked. */
  onSelectTask?: (id: string) => void
}

const MAX_LABEL_LEN = 24

/** Truncate a title to a tab-friendly length. */
function truncateTitle(title: string): string {
  return title.length > MAX_LABEL_LEN ? `${title.slice(0, MAX_LABEL_LEN - 1)}…` : title
}

/** Truncated labels for a set of task tabs, disambiguated with a short id
 *  suffix only when two entries' truncated titles collide. */
function dedupeTaskLabels(entries: { id: string; title: string }[]): Map<string, string> {
  const truncated = entries.map((e) => ({ id: e.id, label: truncateTitle(e.title) }))
  const counts = new Map<string, number>()
  for (const e of truncated) counts.set(e.label, (counts.get(e.label) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const e of truncated) {
    labels.set(e.id, (counts.get(e.label) ?? 0) > 1 ? `${e.label} #${e.id.slice(0, 4)}` : e.label)
  }
  return labels
}

/** Human label for a tab. Files show their basename; the log tab shows its
 *  task's (deduped, truncated) title; chat is a fixed label. */
function tabLabel(tab: WsTab, logLabel: string): string {
  switch (tab.kind) {
    case 'file':
      return tab.path ? (tab.path.split('/').pop() ?? tab.path) : 'File'
    case 'log':
      return logLabel
    case 'chat':
      return 'Chat'
  }
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

export function WorkspaceTabs({
  taskId,
  taskTitle = null,
  status,
  events,
  live,
  agents,
  layout,
  onLayoutChange,
  onMessage,
  liveTasks = [],
  onSelectTask,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const logCloseable = status != null && LOG_CLOSEABLE.has(status)
  const openKinds = new Set(layout.panes.flatMap((p) => p.tabs.map((t) => t.kind)))

  const logEntryId = taskId ?? '__no-task__'
  const labels = dedupeTaskLabels([{ id: logEntryId, title: taskTitle ?? 'Worker Log' }, ...liveTasks])
  const logLabel = labels.get(logEntryId) ?? 'Worker Log'

  function content(tab: WsTab): ReactNode {
    switch (tab.kind) {
      case 'file':
        return <Viewer path={tab.path ?? null} />
      case 'log':
        return <WorkerLogPanel events={events} live={live} status={status} onMessage={onMessage} />
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
            const label = tabLabel(tab, logLabel)
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
          {pane.tabs.some((t) => t.kind === 'log') &&
            liveTasks.map((t) => (
              <div className={styles.tab} role="presentation" key={`live:${t.id}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={false}
                  className={styles.tabLabel}
                  onClick={() => onSelectTask?.(t.id)}
                >
                  {labels.get(t.id) ?? t.title}
                </button>
              </div>
            ))}
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
        {!openKinds.has('log') && (
          <button
            type="button"
            className={styles.reopen}
            onClick={() => onLayoutChange(openPanel(layout, 'log'))}
          >
            Worker Log
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
