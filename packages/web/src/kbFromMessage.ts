// Pure, React-free helpers for the Team tab's "Send to KB" affordance (T4, #154):
// promoting a team-channel message into a durable, server-side KB page. Unlike
// the "Send to my zmrng" handoff (a LOCAL task brief), this creates a real page
// row via POST /api/spaces/:id/pages/from-message. These helpers shape the
// PICKER defaults only — the canonical title/body/provenance are (re)built
// server-side. Kept out of the React component so they are unit-testable without
// a DOM, mirroring teamHandoff.ts.

import type { Space } from './types'
import { handoffTitle } from './teamHandoff'

/**
 * The picker's default page title for a promoted message: the first non-empty
 * line of the body, clamped — reuses `handoffTitle` so a KB page defaults to the
 * same label a handoff task would. The human can edit it before submitting, and
 * the server re-derives/falls back if it is left blank.
 */
export function deriveKbTitle(body: string): string {
  return handoffTitle(body)
}

/** Case-insensitive, whitespace-trimmed name key for best-effort matching. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Best-effort default target space for promoting a message from `channelName`:
 * an exact (case-insensitive) channel-name→space-name match wins, else the
 * `general` space, else the first space, else `undefined` (no spaces at all).
 *
 * This is only a PICKER default — the human confirms/changes the target, and
 * the server takes the chosen `spaceId` explicitly. There is deliberately NO
 * server-side channel→space resolution (a channel's `repoId` is a per-machine
 * local registry id; a space's `repoUrl` is a portable GitHub URL — they do not
 * reliably join, decision locked for #154).
 */
export function resolveDefaultSpace(
  channelName: string,
  spaces: Space[],
): Space | undefined {
  if (spaces.length === 0) return undefined
  const target = normalizeName(channelName)
  const exact = spaces.find((s) => normalizeName(s.name) === target)
  if (exact) return exact
  const general = spaces.find((s) => normalizeName(s.name) === 'general')
  if (general) return general
  return spaces[0]
}
