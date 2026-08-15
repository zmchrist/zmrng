import { useState } from 'react'
import styles from './FileTree.module.css'
import type { WorktreeFileNode } from '../types'

interface NodeProps {
  node: WorktreeFileNode
  depth: number
}

/** A single tree row: a collapsible dir or a leaf file. */
function TreeNode({ node, depth }: NodeProps) {
  const [open, setOpen] = useState(depth === 0)
  const indent = { paddingLeft: `calc(${depth} * var(--tree-indent) + 10px)` }

  if (node.type === 'file') {
    return (
      <div className={styles.file} style={indent} title={node.path}>
        <span className={styles.glyph} aria-hidden>
          ◦
        </span>
        <span className={styles.label}>{node.name}</span>
      </div>
    )
  }

  const children = node.children ?? []
  return (
    <div className={styles.dirGroup}>
      <button
        type="button"
        className={styles.dir}
        style={indent}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={node.path}
      >
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden>
          ▸
        </span>
        <span className={styles.label}>{node.name}</span>
      </button>
      {open && children.length > 0 && (
        <div className={styles.children}>
          {children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  entries: WorktreeFileNode[]
}

export function FileTree({ entries }: Props) {
  return (
    <div className={styles.tree}>
      {entries.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} />
      ))}
    </div>
  )
}
