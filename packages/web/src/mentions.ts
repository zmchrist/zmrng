/**
 * Pure, DOM-free helpers for the Team chat `@`-mention UX (autocomplete dropdown
 * + in-thread pill highlighting). Same style as `dashboardData.ts` /
 * `teamHandoff.ts` / `attachments.ts`: every branch of the matching/parsing logic
 * is proven by `mentions.test.ts`, so `TeamView.tsx` stays thin React glue.
 *
 * Mention matching mirrors the server's `detectMention` word-boundary rule
 * (`(?<!\w)@name(?!\w)`) so the client's visual highlight agrees with the
 * server's actual `@agent` reply trigger. Mentions of people are purely visual;
 * the agent trigger is unchanged and lives server-side.
 */

export interface MentionCandidate {
  name: string
  kind: 'member' | 'agent'
}

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string } // `text` includes the leading '@'

/** A character that `\w` matches (word char), used for boundary checks. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch)
}

/**
 * Build the candidate list from the roster displayNames plus the agent (bot
 * handle with a single leading '@' stripped, matching `botAuthorFromHandle`).
 * Blank/whitespace names are dropped; the agent is de-duplicated against a
 * member of the same name case-insensitively (the member wins).
 */
export function mentionCandidates(
  members: { displayName: string }[],
  botHandle: string,
): MentionCandidate[] {
  const out: MentionCandidate[] = []
  const seen = new Set<string>()
  for (const m of members) {
    const name = m.displayName.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, kind: 'member' })
  }
  const handle = botHandle.trim()
  const agentName = (handle.startsWith('@') ? handle.slice(1) : handle).trim()
  if (agentName && !seen.has(agentName.toLowerCase())) {
    out.push({ name: agentName, kind: 'agent' })
  }
  return out
}

/**
 * The in-progress `@query` ending at `caret`, or null. Scans left from the caret
 * over the query characters (anything but '@' or whitespace-that-breaks-a-line),
 * stopping at the nearest '@'. Returns null when that '@' is preceded by a word
 * char (email local-part like `foo@bar`) — matching `detectMention`'s left
 * boundary. The query may contain spaces so multi-word display names keep
 * filtering, but a newline breaks the run.
 */
export function activeMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') {
      const before = i > 0 ? text[i - 1] : undefined
      if (isWordChar(before)) return null
      return { start: i, query: text.slice(i + 1, caret) }
    }
    if (ch === '\n') return null
    i--
  }
  return null
}

/**
 * Case-insensitive prefix filter over the candidates. An empty query returns all
 * of them; a query no candidate name starts with returns `[]` (which the
 * component uses to close the dropdown).
 */
export function filterCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.toLowerCase()
  if (!q) return candidates
  return candidates.filter((c) => c.name.toLowerCase().startsWith(q))
}

/**
 * Replace the active `@query` (spanning `start`..`caretEnd`) with `@name ` (note
 * the trailing space). Returns the new text and the caret index just past the
 * inserted space. Surrounding text on both sides is preserved.
 */
export function applyMention(
  text: string,
  start: number,
  caretEnd: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `
  const next = text.slice(0, start) + inserted + text.slice(caretEnd)
  return { text: next, caret: start + inserted.length }
}

/**
 * Split a body into text + mention segments. At each '@' with a valid left
 * boundary (start-of-string or a non-word char before it), the following
 * substring is compared case-insensitively against the known names — longest
 * name first (greedy, so `@John Smith` wins over a hypothetical `@John`) — and a
 * match requires the char after it to be end-of-string or a non-word char
 * (`(?!\w)`). The first match wins; otherwise the '@' is literal text. Adjacent
 * text is coalesced, and the concatenated segment text always round-trips to the
 * input body.
 */
export function parseMentions(body: string, names: string[]): MentionSegment[] {
  const sorted = [...names].filter((n) => n.trim()).sort((a, b) => b.length - a.length)
  const lower = body.toLowerCase()
  const segments: MentionSegment[] = []
  let textStart = 0
  let i = 0

  const flushText = (end: number): void => {
    if (end > textStart) segments.push({ type: 'text', text: body.slice(textStart, end) })
  }

  while (i < body.length) {
    if (body[i] === '@' && !isWordChar(body[i - 1])) {
      let matched: string | null = null
      for (const name of sorted) {
        const cand = lower.slice(i + 1, i + 1 + name.length)
        if (cand !== name.toLowerCase()) continue
        const after = body[i + 1 + name.length]
        if (isWordChar(after)) continue
        matched = name
        break
      }
      if (matched) {
        flushText(i)
        const end = i + 1 + matched.length
        segments.push({ type: 'mention', text: body.slice(i, end) })
        i = end
        textStart = i
        continue
      }
    }
    i++
  }
  flushText(body.length)
  return segments
}
