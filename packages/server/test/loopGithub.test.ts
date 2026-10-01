import { describe, it, expect } from 'vitest'
import {
  defaultGhExec,
  ghLoopGitHub,
  mapIssueJson,
  mapIssueListJson,
  type GhExec,
} from '../src/loopGithub.js'

// Hermetic: every test injects a fake `GhExec`. `gh` is NEVER executed and no
// network is touched (defaultGhExec is only asserted to exist, never called).

const SLUG = 'octo/widgets'

/**
 * A real-shaped GitHub REST issue object (`GET /repos/{o}/{r}/issues/{n}`, and the
 * element shape of the `sub_issues` / `dependencies/blocked_by` arrays): the
 * fields the mapper needs plus the noise a real response carries.
 */
function issue(
  number: number,
  title: string,
  opts: { state?: string; body?: string | null } = {},
): Record<string, unknown> {
  return {
    url: `https://api.github.com/repos/${SLUG}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${SLUG}`,
    html_url: `https://github.com/${SLUG}/issues/${number}`,
    id: 900000 + number,
    node_id: `I_kwDO${number}`,
    number,
    title,
    user: { login: 'zc', id: 1, type: 'User' },
    labels: [{ id: 1, name: 'loop', color: 'ededed' }],
    state: opts.state ?? 'open',
    state_reason: opts.state === 'closed' ? 'completed' : null,
    locked: false,
    assignees: [],
    comments: 0,
    created_at: '2026-09-30T10:00:00Z',
    updated_at: '2026-09-30T11:00:00Z',
    closed_at: opts.state === 'closed' ? '2026-09-30T12:00:00Z' : null,
    body: opts.body === undefined ? `## Bar\nBeat ${title}.` : opts.body,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
  }
}

const NOT_FOUND = (): Error => new Error('gh: Not Found (HTTP 404)')

/**
 * A fake `gh` keyed by the REST path (`args[1]`). A route is a JSON-able value
 * (returned stringified, as `gh api` prints it) or an Error (rejected). An
 * unrouted path rejects with a 404, like the real API. Records every call.
 */
function fakeGh(routes: Record<string, unknown>): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: GhExec = async (args) => {
    calls.push(args)
    const route = routes[args[1] ?? '']
    if (route === undefined) throw NOT_FOUND()
    if (route instanceof Error) throw route
    return JSON.stringify(route)
  }
  return { exec, calls }
}

const issuePath = (n: number): string => `repos/${SLUG}/issues/${n}`
const subIssuesPath = (n: number): string => `repos/${SLUG}/issues/${n}/sub_issues?per_page=100`
const blockedByPath = (n: number): string =>
  `repos/${SLUG}/issues/${n}/dependencies/blocked_by?per_page=100`

describe('mapIssueJson', () => {
  it('maps a REST issue: html_url → url, state lower-cased, body carried', () => {
    expect(mapIssueJson({ ...issue(7, 'Build it', { body: 'hi' }), state: 'CLOSED' })).toEqual({
      number: 7,
      title: 'Build it',
      body: 'hi',
      url: `https://github.com/${SLUG}/issues/7`,
      state: 'closed',
    })
  })

  it('maps a null body to the empty string', () => {
    expect(mapIssueJson(issue(7, 'x', { body: null }))?.body).toBe('')
  })

  it('reads an unknown or missing state as open (never as done)', () => {
    expect(mapIssueJson({ ...issue(7, 'x'), state: 'weird' })?.state).toBe('open')
    const noState = issue(7, 'x')
    delete noState.state
    expect(mapIssueJson(noState)?.state).toBe('open')
  })

  it('returns null for a non-object, or a missing/invalid number or title', () => {
    for (const bad of [null, 'x', 7, [], {}]) expect(mapIssueJson(bad)).toBeNull()
    expect(mapIssueJson({ ...issue(7, 'x'), number: 0 })).toBeNull()
    expect(mapIssueJson({ ...issue(7, 'x'), number: 2.5 })).toBeNull()
    expect(mapIssueJson({ ...issue(7, 'x'), number: '7' })).toBeNull()
    expect(mapIssueJson({ ...issue(7, 'x'), title: null })).toBeNull()
  })
})

describe('mapIssueListJson', () => {
  it('maps an array of issue objects, skipping malformed entries', () => {
    const list = mapIssueListJson([issue(1, 'a'), { nope: true }, null, issue(2, 'b', { state: 'closed' })])
    expect(list.map((i) => [i.number, i.state])).toEqual([
      [1, 'open'],
      [2, 'closed'],
    ])
  })

  it('returns [] for a non-array response', () => {
    expect(mapIssueListJson({ message: 'Not Found' })).toEqual([])
    expect(mapIssueListJson(null)).toEqual([])
  })
})

describe('ghLoopGitHub.fetchMap — native sub-issues + blocked-by', () => {
  // Epic #10 → children 11, 12, 13. 12 is blocked by 11 (in the map); 13 is
  // blocked by 11 and by #99, an issue OUTSIDE the map that is already closed.
  const routes = (): Record<string, unknown> => ({
    [issuePath(10)]: issue(10, 'Epic: widgets', { body: 'umbrella' }),
    [subIssuesPath(10)]: [issue(11, 'Base'), issue(12, 'Middle'), issue(13, 'Top', { state: 'closed' })],
    [blockedByPath(11)]: [],
    [blockedByPath(12)]: [issue(11, 'Base')],
    [blockedByPath(13)]: [issue(99, 'Outside', { state: 'closed' }), issue(11, 'Base')],
  })

  it('maps the epic, its children (in sub-issue order), their blockers, and external states', async () => {
    const { exec } = fakeGh(routes())
    const map = await ghLoopGitHub(exec).fetchMap(SLUG, 10)
    expect(map.epic).toEqual({
      number: 10,
      title: 'Epic: widgets',
      body: 'umbrella',
      url: `https://github.com/${SLUG}/issues/10`,
      state: 'open',
    })
    expect(map.tickets.map((t) => [t.number, t.state, t.blockedBy])).toEqual([
      [11, 'open', []],
      [12, 'open', [11]],
      [13, 'closed', [11, 99]],
    ])
    expect(map.tickets[1]).toMatchObject({ title: 'Middle', body: '## Bar\nBeat Middle.' })
    expect(map.external).toEqual({ 99: 'closed' })
  })

  it('passes `gh api` the REST paths, and takes external states from blocked_by without refetching', async () => {
    const { exec, calls } = fakeGh(routes())
    await ghLoopGitHub(exec).fetchMap(SLUG, 10)
    expect(calls.every((a) => a.length === 2 && a[0] === 'api')).toBe(true)
    expect(calls.map((a) => a[1]).sort()).toEqual(
      [issuePath(10), subIssuesPath(10), blockedByPath(11), blockedByPath(12), blockedByPath(13)].sort(),
    )
    expect(calls.some((a) => a[1] === issuePath(99))).toBe(false)
  })

  it('rejects when the epic itself cannot be fetched', async () => {
    const { exec } = fakeGh({})
    await expect(ghLoopGitHub(exec).fetchMap(SLUG, 10)).rejects.toThrow(/404/)
  })

  it('rejects an epic response that is not an issue', async () => {
    const { exec } = fakeGh({ [issuePath(10)]: { message: 'Moved Permanently' } })
    await expect(ghLoopGitHub(exec).fetchMap(SLUG, 10)).rejects.toThrow(/#10/)
  })
})

describe('ghLoopGitHub.fetchMap — body fallbacks', () => {
  const EPIC_BODY = ['Tickets:', '- [ ] #21', '- [x] #22'].join('\n')

  it('falls back to the epic task list when sub_issues rejects with a 404', async () => {
    const { exec, calls } = fakeGh({
      [issuePath(10)]: issue(10, 'Epic', { body: EPIC_BODY }),
      [subIssuesPath(10)]: NOT_FOUND(),
      [issuePath(21)]: issue(21, 'First'),
      [issuePath(22)]: issue(22, 'Second', { state: 'closed' }),
      [blockedByPath(21)]: [],
      [blockedByPath(22)]: [],
    })
    const map = await ghLoopGitHub(exec).fetchMap(SLUG, 10)
    expect(map.tickets.map((t) => [t.number, t.title, t.state])).toEqual([
      [21, 'First', 'open'],
      [22, 'Second', 'closed'],
    ])
    expect(calls.map((a) => a[1])).toEqual(expect.arrayContaining([issuePath(21), issuePath(22)]))
  })

  it('also falls back when sub_issues returns zero children', async () => {
    const { exec } = fakeGh({
      [issuePath(10)]: issue(10, 'Epic', { body: EPIC_BODY }),
      [subIssuesPath(10)]: [],
      [issuePath(21)]: issue(21, 'First'),
      [issuePath(22)]: issue(22, 'Second'),
      [blockedByPath(21)]: [],
      [blockedByPath(22)]: [],
    })
    const map = await ghLoopGitHub(exec).fetchMap(SLUG, 10)
    expect(map.tickets.map((t) => t.number)).toEqual([21, 22])
  })

  it('never lists the epic as its own child', async () => {
    const { exec } = fakeGh({
      [issuePath(10)]: issue(10, 'Epic', { body: '- [ ] #10\n- [ ] #21' }),
      [subIssuesPath(10)]: NOT_FOUND(),
      [issuePath(21)]: issue(21, 'First'),
      [blockedByPath(21)]: [],
    })
    const map = await ghLoopGitHub(exec).fetchMap(SLUG, 10)
    expect(map.tickets.map((t) => t.number)).toEqual([21])
  })

  it('falls back to "Blocked by #N" body lines when blocked_by rejects; external states are fetched', async () => {
    const { exec, calls } = fakeGh({
      [issuePath(10)]: issue(10, 'Epic'),
      [subIssuesPath(10)]: [
        issue(21, 'First'),
        issue(22, 'Second', { body: 'Blocked by #21\nBlocked by #50\n\n## Bar\nx' }),
      ],
      [blockedByPath(21)]: NOT_FOUND(),
      [blockedByPath(22)]: NOT_FOUND(),
      [issuePath(50)]: issue(50, 'Elsewhere', { state: 'closed' }),
    })
    const map = await ghLoopGitHub(exec).fetchMap(SLUG, 10)
    expect(map.tickets.map((t) => [t.number, t.blockedBy])).toEqual([
      [21, []],
      [22, [21, 50]],
    ])
    expect(map.external).toEqual({ 50: 'closed' })
    expect(calls.filter((a) => a[1] === issuePath(50))).toHaveLength(1)
  })

  it('reads an external blocker it cannot fetch as open (unsatisfied)', async () => {
    const { exec } = fakeGh({
      [issuePath(10)]: issue(10, 'Epic'),
      [subIssuesPath(10)]: [issue(21, 'First', { body: 'Depends on #77' })],
      [blockedByPath(21)]: NOT_FOUND(),
    })
    const map = await ghLoopGitHub(exec).fetchMap(SLUG, 10)
    expect(map.tickets[0]?.blockedBy).toEqual([77])
    expect(map.external).toEqual({ 77: 'open' })
  })
})

describe('ghLoopGitHub.fetchIssue', () => {
  it('returns the issue plus its native blockers', async () => {
    const { exec, calls } = fakeGh({
      [issuePath(30)]: issue(30, 'Added later'),
      [blockedByPath(30)]: [issue(12, 'Dep', { state: 'closed' })],
    })
    expect(await ghLoopGitHub(exec).fetchIssue(SLUG, 30)).toEqual({
      number: 30,
      title: 'Added later',
      body: '## Bar\nBeat Added later.',
      url: `https://github.com/${SLUG}/issues/30`,
      state: 'open',
      blockedBy: [12],
    })
    expect(calls.map((a) => a[1]).sort()).toEqual([blockedByPath(30), issuePath(30)].sort())
  })

  it('falls back to body lines when blocked_by rejects', async () => {
    const { exec } = fakeGh({
      [issuePath(30)]: issue(30, 'Added later', { body: 'Blocked by #4' }),
      [blockedByPath(30)]: NOT_FOUND(),
    })
    expect((await ghLoopGitHub(exec).fetchIssue(SLUG, 30)).blockedBy).toEqual([4])
  })

  it('rejects when the issue cannot be fetched', async () => {
    const { exec } = fakeGh({})
    await expect(ghLoopGitHub(exec).fetchIssue(SLUG, 30)).rejects.toThrow(/404/)
  })
})

describe('input validation (before any gh call)', () => {
  it('rejects a malformed slug or a non-positive / non-integer issue number without calling gh', async () => {
    const { exec, calls } = fakeGh({})
    const gh = ghLoopGitHub(exec)
    await expect(gh.fetchMap('not-a-slug', 10)).rejects.toThrow(/slug/)
    await expect(gh.fetchMap('../../evil/x', 10)).rejects.toThrow(/slug/)
    await expect(gh.fetchIssue(SLUG, 0)).rejects.toThrow(/issue number/)
    await expect(gh.fetchIssue(SLUG, 1.5)).rejects.toThrow(/issue number/)
    expect(calls).toEqual([])
  })

  it('rejects when gh prints something that is not JSON', async () => {
    const exec: GhExec = async () => 'gh: something went wrong'
    await expect(ghLoopGitHub(exec).fetchIssue(SLUG, 3)).rejects.toThrow(/JSON/)
  })

  it('exports a default exec (never invoked here)', () => {
    expect(typeof defaultGhExec).toBe('function')
  })
})
