import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseBlockedByFallback, parseEpicChildrenFallback } from './loopMap.js'
import type { LoopGhState } from './types.js'

/**
 * The GitHub seam for the gauntlet loop's ticket map. Every GitHub read goes
 * through `LoopGitHub`, so `LoopManager` tests inject a fake and never run `gh`.
 * The real implementation shells out to `gh api` (the operator's own `gh` login)
 * via `promisify(execFile)` — no shell, the `agentResponder.ts` style.
 *
 * A map is the epic's native SUB-ISSUES, falling back to the `- [ ] #N` task list
 * in the epic body when that endpoint errors or returns nothing. Each ticket's
 * blockers are its native issue-dependency "blocked by" links, falling back to
 * `Blocked by #N` / `Depends on #N` body lines when that endpoint errors.
 */

const exec = promisify(execFile)

/** At most this many `gh` children in flight during one map fetch. */
const GH_CONCURRENCY = 4
/** A hung `gh` must not stall run creation forever. */
const GH_TIMEOUT_MS = 60_000
/** GitHub caps sub-issues at 100 per parent, so one page holds every child. */
const PAGE = 'per_page=100'

export interface GhIssue {
  number: number
  title: string
  body: string
  /** The issue's web URL (REST `html_url`). */
  url: string
  state: LoopGhState
}

export interface GhTicket extends GhIssue {
  /** Blocking issue numbers, deduped and ascending (never the issue itself). */
  blockedBy: number[]
}

export interface LoopMapFetch {
  epic: GhIssue
  tickets: GhTicket[]
  /** GitHub state of every blocker NOT in the map (closed ⇒ satisfied). */
  external: Record<number, LoopGhState>
}

export interface LoopGitHub {
  fetchMap(slug: string, epic: number): Promise<LoopMapFetch>
  fetchIssue(slug: string, n: number): Promise<GhTicket>
}

/** Runs `gh <args>` and resolves its stdout. */
export type GhExec = (args: string[]) => Promise<string>

export const defaultGhExec: GhExec = async (args) => {
  const { stdout } = await exec('gh', args, {
    maxBuffer: 1024 * 1024 * 16,
    timeout: GH_TIMEOUT_MS,
  })
  return stdout
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/**
 * A REST issue object → `GhIssue`, or null when it has no positive integer
 * `number` or no string `title`. `state` is lower-cased, and anything other than
 * `closed` reads as `open` (an unknown state must never count as done); a null
 * `body` becomes `''`; `html_url` becomes `url`.
 */
export function mapIssueJson(raw: unknown): GhIssue | null {
  const r = asRecord(raw)
  if (!r) return null
  const { number, title } = r
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null
  if (typeof title !== 'string') return null
  const state = typeof r.state === 'string' && r.state.toLowerCase() === 'closed' ? 'closed' : 'open'
  return {
    number,
    title,
    body: typeof r.body === 'string' ? r.body : '',
    url: typeof r.html_url === 'string' ? r.html_url : '',
    state,
  }
}

/** An array of issue objects (`sub_issues` / `blocked_by`) → `GhIssue[]`, skipping malformed entries. */
export function mapIssueListJson(raw: unknown): GhIssue[] {
  if (!Array.isArray(raw)) return []
  return raw.map(mapIssueJson).filter((i): i is GhIssue => i !== null)
}

/** Deduped, ascending, positive, and never `self`. */
function cleanNumbers(ns: number[], self: number): number[] {
  return [...new Set(ns)].filter((n) => Number.isInteger(n) && n > 0 && n !== self).sort((a, b) => a - b)
}

/** `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug) || slug.split('/').some((part) => /^\.+$/.test(part))) {
    throw new Error(`invalid GitHub repo slug: ${JSON.stringify(slug)}`)
  }
}

function assertIssueNumber(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid issue number: ${n}`)
}

/** The `gh api`-backed `LoopGitHub`. `exec` is injectable so tests never run `gh`. */
export function ghLoopGitHub(ghExec: GhExec = defaultGhExec): LoopGitHub {
  async function getJson(path: string): Promise<unknown> {
    const stdout = await ghExec(['api', path])
    try {
      return JSON.parse(stdout) as unknown
    } catch {
      throw new Error(`gh api ${path} returned non-JSON output`)
    }
  }

  async function getIssue(slug: string, n: number): Promise<GhIssue> {
    const issue = mapIssueJson(await getJson(`repos/${slug}/issues/${n}`))
    if (!issue) throw new Error(`gh api returned no usable issue for ${slug}#${n}`)
    return issue
  }

  /**
   * An issue's blockers: the native `blocked_by` links (with each blocker's
   * state, which spares a refetch for external ones), or — when that endpoint
   * errors — the `Blocked by #N` / `Depends on #N` lines of the issue body.
   */
  async function blockersOf(
    slug: string,
    issue: GhIssue,
  ): Promise<{ blockedBy: number[]; states: Map<number, LoopGhState> }> {
    try {
      const list = mapIssueListJson(
        await getJson(`repos/${slug}/issues/${issue.number}/dependencies/blocked_by?${PAGE}`),
      )
      return {
        blockedBy: cleanNumbers(list.map((b) => b.number), issue.number),
        states: new Map(list.map((b) => [b.number, b.state])),
      }
    } catch {
      return { blockedBy: cleanNumbers(parseBlockedByFallback(issue.body), issue.number), states: new Map() }
    }
  }

  /** The epic's children: native sub-issues, else the epic body's task list. */
  async function childrenOf(slug: string, epic: GhIssue): Promise<GhIssue[]> {
    let native: GhIssue[]
    try {
      native = mapIssueListJson(await getJson(`repos/${slug}/issues/${epic.number}/sub_issues?${PAGE}`))
    } catch {
      native = [] // no sub-issues API (404) or any other error — use the body
    }
    if (native.length) {
      const seen = new Set<number>([epic.number])
      return native.filter((c) => {
        if (seen.has(c.number)) return false
        seen.add(c.number)
        return true
      })
    }
    const numbers = [...new Set(parseEpicChildrenFallback(epic.body))].filter((n) => n !== epic.number)
    // A listed child that cannot be fetched fails the whole map rather than
    // silently vanishing from it (a dropped ticket would ship an incomplete PR).
    return mapLimit(numbers, GH_CONCURRENCY, (n) => getIssue(slug, n))
  }

  return {
    async fetchMap(slug, epicNumber) {
      assertSlug(slug)
      assertIssueNumber(epicNumber)
      const epic = await getIssue(slug, epicNumber)
      const children = await childrenOf(slug, epic)
      const blockers = await mapLimit(children, GH_CONCURRENCY, (c) => blockersOf(slug, c))
      const tickets: GhTicket[] = children.map((c, i) => ({
        ...c,
        blockedBy: blockers[i]?.blockedBy ?? [],
      }))

      const inMap = new Set(tickets.map((t) => t.number))
      const known = new Map<number, LoopGhState>([[epic.number, epic.state]])
      for (const b of blockers) for (const [n, s] of b.states) known.set(n, s)
      const outside = [...new Set(tickets.flatMap((t) => t.blockedBy))]
        .filter((n) => !inMap.has(n))
        .sort((a, b) => a - b)
      const states = await mapLimit(outside, GH_CONCURRENCY, async (n): Promise<LoopGhState> => {
        const k = known.get(n)
        if (k) return k
        try {
          return (await getIssue(slug, n)).state
        } catch {
          return 'open' // unknown ⇒ unsatisfied, never silently "done"
        }
      })
      const external: Record<number, LoopGhState> = {}
      outside.forEach((n, i) => {
        external[n] = states[i] ?? 'open'
      })
      return { epic, tickets, external }
    },

    async fetchIssue(slug, n) {
      assertSlug(slug)
      assertIssueNumber(n)
      const issue = await getIssue(slug, n)
      const { blockedBy } = await blockersOf(slug, issue)
      return { ...issue, blockedBy }
    },
  }
}
