// Pure, React-free reducer for the Workspace tab-pane layout. Every function
// takes a layout and returns a NEW layout, preserving the invariants:
//   - panes.length ∈ {1,2}
//   - split === null  ⇔  panes.length === 1
//   - activePane indexes an existing pane
//   - each pane's activeId refers to a tab that pane owns (or null if empty)
// All the fiddly max-2 / single-axis rules live here so they can be unit-tested
// without a DOM.

import type { WorkspaceLayout, WsPane, WsSplit, WsTab } from './types'

/** A pane edge for split/drop geometry. */
export type Edge = 'left' | 'right' | 'top' | 'bottom'
/** Where a dragged tab landed within a pane: its center (move) or an edge (split). */
export type DropIntent = 'center' | Edge
/** The re-openable singleton panels. */
export type SingletonKind = 'log' | 'notes' | 'chat'

/** Opaque tab id for a file path. The path is never parsed back out of the id —
 *  it lives on `tab.path` — so a path containing `:` is safe. */
export function fileTabId(path: string): string {
  return `file:${path}`
}

function singletonTab(kind: SingletonKind): WsTab {
  return { id: kind, kind }
}

/**
 * Repair any layout back to the invariants: drop empty panes (keeping at least
 * one), clamp to two panes, reconcile `split` with the pane count, clamp
 * `activePane`, and repair each pane's `activeId`. Tolerant of hand-edited /
 * older JSON — never throws on a malformed shape.
 */
function normalize(layout: WorkspaceLayout): WorkspaceLayout {
  const rawPanes = Array.isArray(layout.panes) ? layout.panes : []
  let panes: WsPane[] = rawPanes.map((p) => ({
    tabs: Array.isArray(p?.tabs)
      ? p.tabs.filter((t): t is WsTab => !!t && typeof t.id === 'string')
      : [],
    activeId: p?.activeId ?? null,
  }))

  panes = panes.filter((p) => p.tabs.length > 0)
  if (panes.length === 0) panes = [{ tabs: [], activeId: null }]
  if (panes.length > 2) panes = panes.slice(0, 2)

  const split: WsSplit =
    panes.length === 1 ? null : layout.split === 'column' ? 'column' : 'row'

  let activePane = layout.activePane
  if (!Number.isInteger(activePane) || activePane < 0 || activePane >= panes.length) {
    activePane = 0
  }

  for (const p of panes) {
    if (p.tabs.length === 0) {
      p.activeId = null
    } else if (!p.tabs.some((t) => t.id === p.activeId)) {
      p.activeId = p.tabs[0].id
    }
  }

  return { panes, split, activePane, logMinimized: layout.logMinimized ?? false }
}

/** Default layout: one pane showing the focused Worker Log. */
export function emptyLayout(): WorkspaceLayout {
  return {
    panes: [{ tabs: [singletonTab('log')], activeId: 'log' }],
    split: null,
    activePane: 0,
    logMinimized: false,
  }
}

/**
 * Restore a persisted layout, or seed a default. A well-formed stored layout is
 * returned normalized; a legacy `activePath` (from before tab panes) seeds the
 * default with that file open and focused; otherwise the default is a lone log
 * pane. A malformed stored layout is clamped back to the invariants.
 */
export function hydrateLayout(
  stored?: WorkspaceLayout | null,
  legacyActivePath?: string | null,
): WorkspaceLayout {
  if (stored && Array.isArray(stored.panes) && stored.panes.length > 0) {
    return normalize(stored)
  }
  const base = emptyLayout()
  return legacyActivePath ? openFile(base, legacyActivePath) : base
}

/** The index of the first pane that owns `id`, or -1. */
function paneOf(layout: WorkspaceLayout, id: string): number {
  return layout.panes.findIndex((p) => p.tabs.some((t) => t.id === id))
}

/** Open a file as a tab in the active pane and focus it; if it is already open
 *  anywhere, just focus the existing tab (selecting its pane). */
export function openFile(layout: WorkspaceLayout, path: string): WorkspaceLayout {
  const id = fileTabId(path)
  const existing = paneOf(layout, id)
  if (existing !== -1) return focusTab(layout, existing, id)

  const panes = layout.panes.map((p, i) =>
    i === layout.activePane
      ? { tabs: [...p.tabs, { id, kind: 'file' as const, path }], activeId: id }
      : { tabs: [...p.tabs], activeId: p.activeId },
  )
  return normalize({ ...layout, panes })
}

/** Focus a tab within a pane and make that pane active. No-op if the tab or
 *  pane does not exist. */
export function focusTab(layout: WorkspaceLayout, paneIdx: number, id: string): WorkspaceLayout {
  const pane = layout.panes[paneIdx]
  if (!pane || !pane.tabs.some((t) => t.id === id)) return layout
  const panes = layout.panes.map((p, i) =>
    i === paneIdx ? { tabs: [...p.tabs], activeId: id } : p,
  )
  return normalize({ ...layout, panes, activePane: paneIdx })
}

/** Close a tab. When a pane empties, it collapses and the sibling grows to fill.
 *  Focus falls to the tab to the left (or the new first tab). The `log` tab is
 *  never removed here — the reducer is the backstop for the UI close-guard. */
export function closeTab(layout: WorkspaceLayout, id: string): WorkspaceLayout {
  if (id === 'log') return layout
  const panes = layout.panes.map((p) => {
    const idx = p.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return p
    const tabs = p.tabs.filter((t) => t.id !== id)
    let activeId = p.activeId
    if (activeId === id) {
      const leftIdx = idx > 0 ? idx - 1 : 0
      activeId = tabs.length > 0 ? tabs[Math.min(leftIdx, tabs.length - 1)].id : null
    }
    return { tabs, activeId }
  })
  return normalize({ ...layout, panes })
}

/** Re-open a closed singleton panel into the active pane and focus it; if it is
 *  already open, just focus it. Re-opening the log un-minimizes it. */
export function openPanel(layout: WorkspaceLayout, kind: SingletonKind): WorkspaceLayout {
  const existing = paneOf(layout, kind)
  let next: WorkspaceLayout
  if (existing !== -1) {
    next = focusTab(layout, existing, kind)
  } else {
    const panes = layout.panes.map((p, i) =>
      i === layout.activePane
        ? { tabs: [...p.tabs, singletonTab(kind)], activeId: kind }
        : { tabs: [...p.tabs], activeId: p.activeId },
    )
    next = normalize({ ...layout, panes })
  }
  return kind === 'log' ? { ...next, logMinimized: false } : next
}

/** Move a tab to `targetPane` at position `index` — reorder within a pane or move
 *  between the two existing panes. A source pane emptied by the move collapses. */
export function moveTab(
  layout: WorkspaceLayout,
  id: string,
  targetPane: number,
  index: number,
): WorkspaceLayout {
  const target = layout.panes[targetPane]
  if (!target) return layout
  const moving = layout.panes.flatMap((p) => p.tabs).find((t) => t.id === id)
  if (!moving) return layout

  const panes: WsPane[] = layout.panes.map((p) => ({
    tabs: p.tabs.filter((t) => t.id !== id),
    activeId: p.activeId,
  }))
  const dest = panes[targetPane]
  const at = Math.max(0, Math.min(index, dest.tabs.length))
  dest.tabs.splice(at, 0, moving)
  dest.activeId = id

  return normalize({ ...layout, panes, activePane: targetPane })
}

/** Split the active tab off into a second pane along the dragged edge. Only when
 *  there is a single pane; if a split already exists this degrades to a move into
 *  the other pane (upholding max-2 / single-axis — never a 2×2). No-op when the
 *  tab is the pane's only tab (nothing to split off). */
export function splitWith(layout: WorkspaceLayout, id: string, edge: Edge): WorkspaceLayout {
  const src = paneOf(layout, id)
  if (src === -1) return layout

  // Already split → degrade to a move into the other pane.
  if (layout.panes.length === 2) {
    const other = src === 0 ? 1 : 0
    return moveTab(layout, id, other, layout.panes[other].tabs.length)
  }

  const pane = layout.panes[0]
  if (pane.tabs.length <= 1) return layout

  const moving = pane.tabs.find((t) => t.id === id)
  if (!moving) return layout
  const remaining = pane.tabs.filter((t) => t.id !== id)
  const remActive = pane.activeId === id ? (remaining[0]?.id ?? null) : pane.activeId

  const keepPane: WsPane = { tabs: remaining, activeId: remActive }
  const newPane: WsPane = { tabs: [moving], activeId: id }
  const newLeads = edge === 'left' || edge === 'top'

  return normalize({
    panes: newLeads ? [newPane, keepPane] : [keepPane, newPane],
    split: edge === 'left' || edge === 'right' ? 'row' : 'column',
    activePane: newLeads ? 0 : 1,
    logMinimized: layout.logMinimized ?? false,
  })
}

/** Toggle the log-pane minimized flag. */
export function setLogMinimized(layout: WorkspaceLayout, on: boolean): WorkspaceLayout {
  return { ...layout, logMinimized: on }
}

/** Drop file tabs whose path is no longer present in the worktree tree (the
 *  multi-tab generalization of the old single-path stale-drop). Singleton tabs
 *  are kept; a pane emptied by pruning collapses. */
export function pruneFileTabs(layout: WorkspaceLayout, existingPaths: string[]): WorkspaceLayout {
  const keep = new Set(existingPaths)
  const panes = layout.panes.map((p) => ({
    tabs: p.tabs.filter((t) => t.kind !== 'file' || (t.path != null && keep.has(t.path))),
    activeId: p.activeId,
  }))
  return normalize({ ...layout, panes })
}

/**
 * Map a pointer position within a pane's rect to a drop intent using thirds
 * bands: the middle third on both axes is `center` (move into the strip);
 * otherwise the axis with the larger distance from center wins, so corners
 * resolve to a single edge (never a diagonal). Pure geometry — unit-tested
 * directly so DnD needs no jsdom pixel drag.
 */
export function dropIntent(px: number, py: number, width: number, height: number): DropIntent {
  if (width <= 0 || height <= 0) return 'center'
  const fx = px / width
  const fy = py / height
  const inCenterX = fx >= 1 / 3 && fx <= 2 / 3
  const inCenterY = fy >= 1 / 3 && fy <= 2 / 3
  if (inCenterX && inCenterY) return 'center'
  const dx = fx - 0.5
  const dy = fy - 0.5
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}
