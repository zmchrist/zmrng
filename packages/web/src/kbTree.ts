// Pure, React-free helpers for the KB space tree (GET /api/spaces/:id/tree).
// The server assembles `KbTreeNode[]` (folder/page nodes, `path` = `folder/<id>`
// or `page/<id>`); these helpers parse that path, filter the tree by page title,
// enumerate folders for the create/move forms, and build a page breadcrumb.
// Kept out of the component so they are unit-tested without a DOM.

import type { KbTreeNode } from './types'

/** A parsed KB tree node reference: its kind plus numeric id. */
export interface KbNodeRef {
  kind: 'folder' | 'page'
  id: number
}

/**
 * Parse a `KbTreeNode.path` (`folder/<id>` | `page/<id>`) back into its ref, or
 * `null` when the shape is unexpected. This is the id-vs-path seam: `FileTree`
 * selects by the `path` string, but every KB action needs the numeric id.
 */
export function parseKbNodePath(path: string): KbNodeRef | null {
  const slash = path.indexOf('/')
  if (slash === -1) return null
  const kind = path.slice(0, slash)
  const id = Number(path.slice(slash + 1))
  if ((kind !== 'folder' && kind !== 'page') || !Number.isInteger(id) || id <= 0) {
    return null
  }
  return { kind, id }
}

/**
 * Filter a KB tree to the pages whose title matches `query` (case-insensitive,
 * substring), keeping the folder ancestors of any matching page so the tree
 * stays navigable. An empty/whitespace query returns the tree unchanged. A
 * folder whose name matches is kept with all of its descendants.
 */
export function filterKbTree(nodes: KbTreeNode[], query: string): KbTreeNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const walk = (list: KbTreeNode[]): KbTreeNode[] => {
    const out: KbTreeNode[] = []
    for (const node of list) {
      const selfMatch = node.name.toLowerCase().includes(q)
      if (node.kind === 'page') {
        if (selfMatch) out.push(node)
        continue
      }
      // A folder: keep it if its own name matches (with all descendants) or if
      // any descendant survives the filter.
      if (selfMatch) {
        out.push(node)
        continue
      }
      const keptChildren = walk(node.children ?? [])
      if (keptChildren.length > 0) {
        out.push({ ...node, children: keptChildren })
      }
    }
    return out
  }
  return walk(nodes)
}

/** One folder flattened for a select control: id, name, and its slash path. */
export interface KbFolderOption {
  id: number
  name: string
  /** Slash-joined folder-name path from the space root (for indentation/labels). */
  path: string
}

/**
 * Flatten every folder (dir) node in the tree into a depth-ordered list for the
 * create/move folder + page forms. `path` is the folder-name trail from the
 * root, so a nested folder reads e.g. `Design / Specs`.
 */
export function collectFolders(nodes: KbTreeNode[]): KbFolderOption[] {
  const out: KbFolderOption[] = []
  const walk = (list: KbTreeNode[], trail: string[]): void => {
    for (const node of list) {
      if (node.kind !== 'folder') continue
      const nextTrail = [...trail, node.name]
      out.push({ id: node.id, name: node.name, path: nextTrail.join(' / ') })
      walk(node.children ?? [], nextTrail)
    }
  }
  walk(nodes, [])
  return out
}

/**
 * The folder-name breadcrumb trail from the space root to the page with
 * `pageId` (excluding the page title itself), or an empty array when the page
 * sits at the space root or is not found.
 */
export function pageBreadcrumb(nodes: KbTreeNode[], pageId: number): string[] {
  let found: string[] | null = null
  const walk = (list: KbTreeNode[], trail: string[]): void => {
    if (found) return
    for (const node of list) {
      if (node.kind === 'page') {
        if (node.id === pageId) {
          found = trail
          return
        }
        continue
      }
      walk(node.children ?? [], [...trail, node.name])
      if (found) return
    }
  }
  walk(nodes, [])
  return found ?? []
}
