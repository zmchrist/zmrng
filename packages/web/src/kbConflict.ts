// Pure, React-free helpers for the KB block-LWW conflict model and for merging
// live `page.update` block deltas into the open page's block list. Kept out of
// the component so the collision predicate + merge are unit-tested without a DOM.
//
// Block-LWW: the server always accepts the last write. The client's job is
// purely UX — when a `page.update` lands for a block the LOCAL user currently
// has UNSAVED edits in (and the update was authored by someone else), surface a
// toast + restore-from-revision affordance rather than silently clobbering the
// editor.

import type { KbBlock } from './types'

/**
 * True when an incoming `page.update` block collides with the local user's
 * unsaved edits: the block id is in the locally-dirty set AND the update was
 * authored by someone other than the local user (a self-echo is never a
 * conflict). This is the whole point of the block-LWW conflict UX.
 */
export function isBlockConflict(
  incoming: KbBlock,
  dirtyBlockIds: ReadonlySet<number>,
  localAuthor: string,
): boolean {
  return dirtyBlockIds.has(incoming.id) && incoming.updatedBy !== localAuthor
}

/**
 * Merge one live block delta into a page's ordered block list: replace the block
 * with the same id in place, or insert a new block and keep the list sorted by
 * `ord` (ties broken by id) so a freshly appended block lands in position.
 * Returns a new array (never mutates the input).
 */
export function mergeBlock(blocks: KbBlock[], incoming: KbBlock): KbBlock[] {
  const idx = blocks.findIndex((b) => b.id === incoming.id)
  if (idx !== -1) {
    const next = blocks.slice()
    next[idx] = incoming
    return next
  }
  return [...blocks, incoming].sort((a, b) => (a.ord !== b.ord ? a.ord - b.ord : a.id - b.id))
}
