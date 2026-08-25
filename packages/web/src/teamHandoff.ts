// Pure, React-free helpers for the Team tab's "Send to my zmrng" handoff (T3).
// A team-channel message crosses into a teammate's LOCAL zmrng as a rich task
// BRIEF — never a plan file, never a git round-trip. These builders shape that
// brief (title/body/suggested repo) and resolve the channel-suggested repo id
// against the teammate's OWN local registry. Kept out of the React component so
// they are unit-testable without a DOM, mirroring channelThread.ts / roster.ts.

import type { Channel, Message, RepoTarget } from './types'

/** A LOCAL new-task box pre-fill produced from a team-channel message. */
export interface HandoffPrefill {
  title: string
  body: string
  /**
   * A repo the (repo-tied) source channel SUGGESTS. It is only a hint — the
   * human confirms it against their own local registry, and no VPS-supplied
   * repo id is ever auto-bound or auto-created (decision D6).
   */
  suggestedRepoId?: string
}

const MAX_TITLE_LEN = 80

/** Derive a concise task title from a message body: first non-empty line,
 *  whitespace-collapsed and clamped with an ellipsis. */
export function handoffTitle(body: string): string {
  const firstLine =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ')
  if (collapsed.length <= MAX_TITLE_LEN) return collapsed
  return `${collapsed.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`
}

/**
 * Compact, deterministic provenance back-reference stamped into the created
 * task's body. There is no cross-machine permalink in the POC, so this is a
 * stable textual reference (channel name + message id) after a horizontal rule.
 */
export function provenanceLine(channel: Channel, message: Message): string {
  return `\n\n---\nFrom team channel #${channel.name} (message #${message.id})`
}

/**
 * Build the LOCAL new-task pre-fill for a "Send to my zmrng" handoff. The body
 * carries the original message text plus the provenance line; a repo-tied
 * channel's repoId is carried ONLY as a suggestion.
 */
export function buildHandoffPrefill(channel: Channel, message: Message): HandoffPrefill {
  const prefill: HandoffPrefill = {
    title: handoffTitle(message.body),
    body: `${message.body}${provenanceLine(channel, message)}`,
  }
  if (channel.repoId) prefill.suggestedRepoId = channel.repoId
  return prefill
}

/**
 * Resolve a channel-suggested repo id against the teammate's OWN local repo
 * registry. The VPS may suggest a repo, but an id the local machine doesn't
 * have is never auto-bound — an unknown/absent suggestion falls back to `''`
 * (the new-task form's "follow the server default" sentinel).
 */
export function resolveSuggestedRepoId(
  suggestedRepoId: string | undefined,
  repos: RepoTarget[],
): string {
  if (!suggestedRepoId) return ''
  return repos.some((r) => r.id === suggestedRepoId) ? suggestedRepoId : ''
}
