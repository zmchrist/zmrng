import { useRef, useState } from 'react'
import { NavIcon } from './NavIcon'
import styles from './FileTree.module.css'
import type { WorktreeFileNode } from '../types'

/** Sentinel drop-target id for the tree root (a real path is `folder/…`/`page/…`). */
const ROOT_TARGET = '__root__'

/**
 * Drag-and-drop handlers threaded down to every row when the tree is re-parentable
 * (KB only). `null` for the read-only worktree Files tree, which passes no `onMove`
 * at all. `blocked(path)` is the cycle guard — a folder cannot be dropped onto
 * itself or one of its own descendants — and is only ever called from an event
 * handler (never during render), so its ref read is safe.
 */
interface Dnd {
  enabled: boolean
  onDragStart: (node: WorktreeFileNode, e: React.DragEvent) => void
  onDragEnd: () => void
  blocked: (targetPath: string) => boolean
  dropTarget: string | null
  hover: (target: string) => void
  drop: (targetFolderPath: string | null) => void
}

interface NodeProps {
  node: WorktreeFileNode
  depth: number
  onOpen: (path: string) => void
  selectedPath: string | null
  dnd: Dnd
}

/** A single tree row: a collapsible dir or a leaf file. */
function TreeNode({ node, depth, onOpen, selectedPath, dnd }: NodeProps) {
  const [open, setOpen] = useState(depth === 0)
  const indent = { paddingLeft: `calc(${depth} * var(--tree-indent) + 10px)` }

  const dragProps = dnd.enabled
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.stopPropagation()
          dnd.onDragStart(node, e)
        },
        onDragEnd: dnd.onDragEnd,
      }
    : {}

  if (node.type === 'file') {
    const selected = node.path === selectedPath
    return (
      <button
        type="button"
        className={`${styles.file} ${selected ? styles.fileSelected : ''}`}
        style={indent}
        title={node.path}
        onClick={() => onOpen(node.path)}
        {...dragProps}
      >
        <span className={styles.glyph} aria-hidden>
          ◦
        </span>
        <span className={styles.label}>{node.name}</span>
      </button>
    )
  }

  const children = node.children ?? []
  // A folder is a drop target unless dropping here would create a cycle. The
  // guard is evaluated at EVENT time (not render time): the dragged subtree is
  // only known once a drag starts, so `blocked` reads a ref set on dragStart.
  const dropProps = dnd.enabled
    ? {
        onDragOver: (e: React.DragEvent) => {
          // Always swallow the event at this folder (stopPropagation) so a blocked
          // drop never bubbles to the root drop zone; only a VALID target calls
          // preventDefault, which is what actually enables the drop.
          e.stopPropagation()
          if (dnd.blocked(node.path)) return
          e.preventDefault()
          dnd.hover(node.path)
        },
        onDrop: (e: React.DragEvent) => {
          e.stopPropagation()
          if (dnd.blocked(node.path)) return
          e.preventDefault()
          dnd.drop(node.path)
        },
      }
    : {}
  const dropActive = dnd.dropTarget === node.path
  return (
    <div className={styles.dirGroup}>
      <button
        type="button"
        className={`${styles.dir} ${dropActive ? styles.dropTarget : ''}`}
        style={indent}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={node.path}
        {...dragProps}
        {...dropProps}
      >
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden>
          <NavIcon name="chevron-right" />
        </span>
        <span className={styles.label}>{node.name}</span>
      </button>
      {open && children.length > 0 && (
        <div className={styles.children}>
          {children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} onOpen={onOpen} selectedPath={selectedPath} dnd={dnd} />
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  entries: WorktreeFileNode[]
  onOpen: (path: string) => void
  selectedPath?: string | null
  /**
   * Enable drag-and-drop re-parenting (KB tree only). When set, every row is
   * draggable and folders + the root become drop targets; `onMove` is called with
   * the dragged node's `path` and the destination folder path (`null` = the space
   * root). The worktree Files tree omits this and stays read-only.
   */
  onMove?: (sourcePath: string, targetFolderPath: string | null) => void
}

export function FileTree({ entries, onOpen, selectedPath = null, onMove }: Props) {
  // The dragged node's own path plus all of its descendant paths — the cycle
  // guard: a folder can never be dropped onto itself or anything inside it.
  const draggedSubtreeRef = useRef<Set<string> | null>(null)
  const draggedPathRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // A stable handler bundle. Its methods read the drag refs, but ONLY from event
  // handlers (dragStart/over/drop) — never during render — so the ref access is
  // safe. `enabled` gates every affordance on the presence of `onMove`.
  const dnd: Dnd = {
    enabled: !!onMove,
    onDragStart: (node, e) => {
      draggedPathRef.current = node.path
      draggedSubtreeRef.current = collectSubtreePaths(node)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', node.path)
    },
    onDragEnd: () => {
      draggedPathRef.current = null
      draggedSubtreeRef.current = null
      setDropTarget(null)
    },
    blocked: (targetPath) => draggedSubtreeRef.current?.has(targetPath) ?? false,
    dropTarget,
    hover: (target) => setDropTarget(target),
    drop: (targetFolderPath) => {
      const source = draggedPathRef.current
      setDropTarget(null)
      // The cycle guard already blocks a folder self-drop; this also skips a
      // page/folder dropped back onto its own tree path (a pure no-op).
      if (onMove && source && source !== targetFolderPath) onMove(source, targetFolderPath)
    },
  }

  const rootProps = onMove
    ? {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault()
          dnd.hover(ROOT_TARGET)
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault()
          dnd.drop(null)
        },
      }
    : {}

  return (
    <div
      className={`${styles.tree} ${onMove && dropTarget === ROOT_TARGET ? styles.dropRoot : ''}`}
      {...rootProps}
    >
      {entries.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} onOpen={onOpen} selectedPath={selectedPath} dnd={dnd} />
      ))}
    </div>
  )
}

/** Every `path` in a node's subtree (the node itself + all descendants). */
function collectSubtreePaths(node: WorktreeFileNode): Set<string> {
  const out = new Set<string>()
  const walk = (n: WorktreeFileNode): void => {
    out.add(n.path)
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return out
}
