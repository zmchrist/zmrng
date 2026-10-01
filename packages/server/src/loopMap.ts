// Pure decision logic for the gauntlet Loop (Loop mode): parsing a ticket's bar
// and its body-text fallbacks, deriving todo/blocked, the pick frontier and its
// order, the completion percentage, the blind A/B verdict mapping, and the round
// fuse. No IO, no clock, no processes — `LoopManager` (loop.ts) is the shell
// around these, and `loopMap.test.ts` pins every rule.

import { LOOP_MAX_ROUNDS, type LoopGhState, type LoopTicket, type LoopTicketState } from './types.js'

/** The round fuse: losing round MAX_ROUNDS parks the ticket `needs-human`. */
export const MAX_ROUNDS = LOOP_MAX_ROUNDS

// ---- markdown body helpers ----

const FENCE_RE = /^\s*(`{3,}|~{3,})/

/**
 * Normalize an issue body for line parsing: CRLF → LF (GitHub web-UI bodies use
 * CRLF) and HTML comments removed (issue templates park placeholders like
 * `<!-- Bar: … -->` in them, which must never count as real content).
 */
function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Flag each line that sits inside (or delimits) a fenced code block (``` or ~~~,
 * any indentation). An unclosed fence runs to the end, as in CommonMark. A
 * closing fence must use the opening character, be at least as long, and carry
 * nothing else.
 */
function markFenced(lines: string[]): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = []
  let fence: string | null = null
  for (const text of lines) {
    if (fence === null) {
      const open = FENCE_RE.exec(text)
      if (open) fence = open[1]
      out.push({ text, code: open !== null })
      continue
    }
    const trimmed = text.trim()
    if (trimmed.length >= fence.length && trimmed === fence[0].repeat(trimmed.length)) fence = null
    out.push({ text, code: true })
  }
  return out
}

/** Split a normalized issue body into lines, each flagged code / not code. */
function classifyLines(body: string): { text: string; code: boolean }[] {
  return markFenced(normalizeBody(body).split('\n'))
}

/**
 * Drop every fenced code block (fences included) from `text`, CRLF-normalized.
 * Used by `parseStepResult` so a control token quoted inside a fence never fires.
 */
export function stripFencedCode(text: string): string {
  return markFenced(text.replace(/\r\n?/g, '\n').split('\n'))
    .filter((l) => !l.code)
    .map((l) => l.text)
    .join('\n')
}

/** Strip inline code spans (`` `x` ``, ``` ``x`` ```) from one line. */
function stripCodeSpans(line: string): string {
  return line.replace(/(`+).*?\1/g, '')
}

/** Lines outside fenced code, with inline code spans removed. */
function proseLines(body: string): string[] {
  return classifyLines(body)
    .filter((l) => !l.code)
    .map((l) => stripCodeSpans(l.text))
}

// ---- bar ----

/** `## Bar` (any level, optional trailing colon / closing hashes). */
const BAR_HEADING_RE = /^\s{0,3}(#{1,6})\s+bar\s*:?\s*#*\s*$/i
const ANY_HEADING_RE = /^\s{0,3}(#{1,6})(?:\s|$)/
/** `Bar: …`, `**Bar:** …`, `**Bar**: …`, optionally bulleted. */
const BAR_LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*bar:\*\*|\*\*bar\*\*:|__bar:__|__bar__:|bar:)(.*)$/i

/**
 * The ticket's bar — the named reference its output must beat. A `## Bar`
 * section (any heading level, case-insensitive) wins: its text up to the next
 * heading of the same or a higher level, trimmed. Otherwise the rest of a
 * `Bar:` line (plain, bold, or bulleted). Content inside fenced code blocks and
 * HTML comments never counts. Null when there is no bar or it is empty.
 */
export function parseBar(body: string): string | null {
  const lines = classifyLines(body)

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].code) continue
    const head = BAR_HEADING_RE.exec(lines[i].text)
    if (!head) continue
    const level = head[1].length
    const section: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (!next.code) {
        const h = ANY_HEADING_RE.exec(next.text)
        if (h && h[1].length <= level) break
      }
      section.push(next.text)
    }
    const text = section.join('\n').trim()
    if (text) return text
  }

  for (const line of lines) {
    if (line.code) continue
    const m = BAR_LINE_RE.exec(line.text)
    const text = m?.[1].trim()
    if (text) return text
  }
  return null
}

// ---- body-text fallbacks (used when the GitHub API endpoints are unavailable) ----

const BLOCKED_BY_LINE_RE =
  /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)?(?:blocked\s+by|depends\s+on)\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i
/** The run of refs right after the keyword: `#12`, `#12, #13`, `#13 and #12`. */
const REF_RUN_RE = /^#\d+(?:\s*(?:,|&|\/|\band\b)\s*#\d+)*/i

/**
 * `Blocked by #N` / `Depends on #N` lines (case-insensitive, optionally bulleted
 * or bold, several refs per line allowed). Only the ref list directly after the
 * keyword counts; bare `#N` in prose, inline code, fenced code, and HTML comments
 * are ignored. Deduped, ascending.
 */
export function parseBlockedByFallback(body: string): number[] {
  const found = new Set<number>()
  for (const line of proseLines(body)) {
    const m = BLOCKED_BY_LINE_RE.exec(line)
    if (!m) continue
    const run = REF_RUN_RE.exec(m[1].trim())
    if (!run) continue
    for (const ref of run[0].matchAll(/#(\d+)/g)) {
      const n = Number(ref[1])
      if (Number.isSafeInteger(n) && n > 0) found.add(n)
    }
  }
  return [...found].sort((a, b) => a - b)
}

const TASK_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+#(\d+)\b/

/**
 * An epic body's task-list children: `- [ ] #34`, `- [x] #34`, `* [ ] #34 title`
 * (numbered lists and nesting allowed). Prose, plain bullets, code, and HTML
 * comments are ignored. Deduped, first-seen order preserved.
 */
export function parseEpicChildrenFallback(body: string): number[] {
  const found: number[] = []
  for (const line of proseLines(body)) {
    const m = TASK_LINE_RE.exec(line)
    if (!m) continue
    const n = Number(m[1])
    if (Number.isSafeInteger(n) && n > 0 && !found.includes(n)) found.push(n)
  }
  return found
}

// ---- map state ----

const SATISFIED: ReadonlySet<LoopTicketState> = new Set<LoopTicketState>(['done', 'skipped'])

/**
 * Recompute `todo` vs `blocked` for the tickets that are in either state; every
 * other state passes through untouched. A blocker inside the map is satisfied
 * iff it is `done` or `skipped`; one outside the map iff `external` says it is
 * `closed` (unknown or open ⇒ blocking). Returns new ticket objects.
 */
export function deriveStates(
  tickets: LoopTicket[],
  external?: ReadonlyMap<number, LoopGhState>,
): LoopTicket[] {
  const stateOf = new Map(tickets.map((t) => [t.number, t.state]))
  const satisfied = (n: number): boolean => {
    const s = stateOf.get(n)
    return s !== undefined ? SATISFIED.has(s) : external?.get(n) === 'closed'
  }
  return tickets.map((t) => {
    if (t.state !== 'todo' && t.state !== 'blocked') return { ...t }
    return { ...t, state: t.blockedBy.every(satisfied) ? 'todo' : 'blocked' }
  })
}

/**
 * A dependency cycle among in-map tickets (edges run ticket → blocker), as the
 * closed walk e.g. `[1, 2, 1]` for #1 blocked by #2 blocked by #1; null for a DAG.
 * Out-of-map blockers are ignored. Deterministic: tickets and blockers are
 * walked in ascending issue order.
 */
export function findCycle(tickets: LoopTicket[]): number[] | null {
  const edges = new Map<number, number[]>()
  for (const t of tickets) edges.set(t.number, [])
  for (const t of tickets) {
    const inMap = t.blockedBy.filter((b) => edges.has(b))
    edges.set(t.number, [...new Set(inMap)].sort((a, b) => a - b))
  }
  const done = new Set<number>()
  const stack: number[] = []
  const onStack = new Set<number>()

  const visit = (n: number): number[] | null => {
    stack.push(n)
    onStack.add(n)
    for (const b of edges.get(n) ?? []) {
      if (onStack.has(b)) return [...stack.slice(stack.indexOf(b)), b]
      if (done.has(b)) continue
      const found = visit(b)
      if (found) return found
    }
    stack.pop()
    onStack.delete(n)
    done.add(n)
    return null
  }

  for (const n of [...edges.keys()].sort((a, b) => a - b)) {
    if (done.has(n)) continue
    const found = visit(n)
    if (found) return found
  }
  return null
}

/**
 * The pickable frontier: tickets that are `todo` after `deriveStates` — never
 * blocked, skipped, done, needs-human, waiting, or in flight.
 */
export function frontier(
  tickets: LoopTicket[],
  external?: ReadonlyMap<number, LoopGhState>,
): LoopTicket[] {
  return deriveStates(tickets, external).filter((t) => t.state === 'todo')
}

const hasBar = (t: LoopTicket): boolean => (t.bar ?? '').trim().length > 0

/**
 * The next tickets to pick: frontier tickets that carry a bar, the ones listed
 * in `priority` first (in that order), then the rest by issue number. At most
 * `max(0, freeSlots)` issue numbers. Priority can only reorder unblocked work —
 * dependencies stay authoritative.
 */
export function pickNext(
  tickets: LoopTicket[],
  priority: number[],
  freeSlots: number,
  external?: ReadonlyMap<number, LoopGhState>,
): number[] {
  const slots = Number.isFinite(freeSlots) ? Math.max(0, Math.floor(freeSlots)) : 0
  if (slots === 0) return []
  const candidates = new Set(frontier(tickets, external).filter(hasBar).map((t) => t.number))
  const ordered: number[] = []
  for (const n of priority) {
    if (candidates.has(n) && !ordered.includes(n)) ordered.push(n)
  }
  const rest = [...candidates].filter((n) => !ordered.includes(n)).sort((a, b) => a - b)
  return [...ordered, ...rest].slice(0, slots)
}

/**
 * Frontier tickets with no (or a blank) bar, ascending. The manager parks these
 * `needs-human` ("ticket has no bar"): a ticket without a bar is never picked.
 */
export function barless(
  tickets: LoopTicket[],
  external?: ReadonlyMap<number, LoopGhState>,
): number[] {
  return frontier(tickets, external)
    .filter((t) => !hasBar(t))
    .map((t) => t.number)
    .sort((a, b) => a - b)
}

/** Done ÷ non-skipped tickets × 100, rounded; 0 for an empty or all-skipped map. */
export function percentComplete(tickets: LoopTicket[]): number {
  const counted = tickets.filter((t) => t.state !== 'skipped')
  if (counted.length === 0) return 0
  const done = counted.filter((t) => t.state === 'done').length
  return Math.round((done / counted.length) * 100)
}

// ---- the blind A/B and the round fuse ----

export type Verdict = 'WIN' | 'LOSE'

/**
 * Map the critic's chosen letter onto WIN/LOSE. WIN only when the letter is our
 * (server-randomized) label. Surrounding markdown emphasis, code ticks, angle
 * brackets, quotes, and a trailing period are tolerated; a tie, anything else,
 * or no answer is a LOSE — the output must BEAT the bar.
 */
export function verdictOutcome(letter: string | null | undefined, oursLabel: 'A' | 'B'): Verdict {
  if (typeof letter !== 'string') return 'LOSE'
  const core = letter
    .trim()
    .replace(/\.$/, '')
    .replace(/^[*_`<("'[]+/, '')
    .replace(/[*_`>)"'\]]+$/, '')
    .trim()
    .toUpperCase()
  return core === oursLabel ? 'WIN' : 'LOSE'
}

/**
 * After a LOSE (critic verdict, or a failed validate fed back as a gap): the
 * next round and the gap to hand the next builder. `parked` once the round
 * passes MAX_ROUNDS — losing round 6 lands on round 7, which parks the ticket.
 */
export function nextAfterLoss(
  ticket: Pick<LoopTicket, 'round'>,
  gap: string,
): { round: number; lastGap: string; parked: boolean } {
  const round = ticket.round + 1
  return { round, lastGap: gap, parked: round > MAX_ROUNDS }
}

/** The server-randomized label for OUR candidate in the blind A/B. */
export function randomLabel(rand: () => number = Math.random): 'A' | 'B' {
  return rand() < 0.5 ? 'A' : 'B'
}
