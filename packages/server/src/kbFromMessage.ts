// Pure, IO-free helpers for the KB "Send to KB" promotion (T4, #154): turning a
// team-channel message into a durable KB page. These shape the CANONICAL page
// title, body, and provenance line SERVER-SIDE from the looked-up message +
// channel — never trusting the client for provenance. Kept out of the route so
// they are unit-testable without a Fastify/db harness (the repo has no HTTP
// inject harness, #91), mirroring the web-side teamHandoff.ts structure.

const MAX_TITLE_LEN = 80

/**
 * Derive a concise page title from a message body: first non-empty line,
 * whitespace-collapsed and clamped with an ellipsis. Mirrors the web-side
 * `handoffTitle` so a promoted page reads the same as a handoff task. Returns
 * an empty string for an all-blank body (the caller supplies a fallback).
 */
export function pageTitleFromMessage(body: string): string {
  const firstLine =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ')
  if (collapsed.length <= MAX_TITLE_LEN) return collapsed
  return `${collapsed.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`
}

/** Fallback title for a page promoted from an all-blank / title-less message. */
export const DEFAULT_PAGE_TITLE = 'Untitled page'

/**
 * Resolve the final page title: an explicit client-supplied title wins (trimmed)
 * when non-empty, otherwise derive from the message body, otherwise fall back to
 * a stable default. The title is a convenience/label (editable later), NOT
 * provenance — so honoring a client title is safe.
 */
export function resolvePageTitle(clientTitle: string | undefined, messageBody: string): string {
  const trimmed = clientTitle?.trim()
  if (trimmed) return trimmed
  const derived = pageTitleFromMessage(messageBody)
  return derived || DEFAULT_PAGE_TITLE
}

/**
 * Compact, deterministic provenance back-reference stamped onto the promoted
 * page's body. Built SERVER-SIDE from the canonical channel name + message id
 * (never trusted from the client). There is no cross-machine permalink in the
 * POC, so this is a stable textual reference after a rule.
 */
export function messageProvenance(channelName: string, messageId: number): string {
  return `\n\n---\nFrom team channel #${channelName} (message #${messageId})`
}

/**
 * Compose the body for a promoted page: the original message text followed by
 * the server-built provenance line.
 */
export function buildPageBody(
  messageBody: string,
  channelName: string,
  messageId: number,
): string {
  return `${messageBody}${messageProvenance(channelName, messageId)}`
}
