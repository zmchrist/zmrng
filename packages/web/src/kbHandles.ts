// Pure, React-free resolution of the KB identity handles from the shared
// `settings.teamHandle` (the SAME self-asserted display name the Team surface
// persists — one identity across Team + KB, no second store).
//
// #150: a teammate must set a non-empty display handle before their FIRST KB
// edit — no KB block may ever be authored as the presence fallback `anon`.
// Presence (read-only viewing) MAY still fall back to `anon`; only EDITING
// requires the real handle. This module keeps those two concerns SPLIT so the
// component can never accidentally feed the presence fallback into the
// block-edit author slot.

export interface KbHandles {
  /**
   * Identity used for the workspace `hello` frame + page-presence roster. Falls
   * back to `anon` when no handle is set — read-only viewing needs no real name.
   */
  presenceHandle: string
  /**
   * Author of block/page edits. EMPTY string when no handle is set, which gates
   * editing OFF — so no KB write is ever authored as the `anon` presence
   * fallback. When non-empty it is the exact trimmed display handle.
   */
  editHandle: string
  /** Whether the local user may make KB edits (has a non-empty display handle). */
  canEdit: boolean
}

/**
 * Derive the KB presence + edit identities from the shared team handle. The
 * presence identity falls back to `anon`; the edit identity never does — it is
 * either the trimmed handle or the empty string (editing gated off).
 */
export function kbHandles(teamHandle: string): KbHandles {
  const trimmed = teamHandle.trim()
  return {
    presenceHandle: trimmed || 'anon',
    editHandle: trimmed,
    canEdit: trimmed !== '',
  }
}
