import { describe, it, expect } from 'vitest'
import {
  MAX_ROUNDS,
  barless,
  deriveStates,
  findCycle,
  frontier,
  nextAfterLoss,
  parseBar,
  parseBlockedByFallback,
  parseEpicChildrenFallback,
  percentComplete,
  pickNext,
  randomLabel,
  stripFencedCode,
  verdictOutcome,
} from '../src/loopMap.js'
import { LOOP_MAX_ROUNDS, type LoopGhState, type LoopTicket } from '../src/types.js'

// The gauntlet loop's decision logic is pure on purpose: what gets picked, what
// counts as blocked, when a ticket wins, and when the round fuse parks it are all
// decided here, so LoopManager stays a thin process/git shell around them.

function ticket(number: number, over: Partial<LoopTicket> = {}): LoopTicket {
  return {
    runId: 'run-1',
    number,
    title: `Ticket ${number}`,
    body: '',
    url: `https://github.com/acme/app/issues/${number}`,
    ghState: 'open',
    blockedBy: [],
    bar: 'Linear command palette',
    state: 'todo',
    step: null,
    round: 0,
    lastGap: null,
    branch: null,
    worktree: null,
    foldSha: null,
    question: null,
    note: null,
    usage: { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 },
    startedAt: null,
    stepStartedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const ext = (entries: [number, LoopGhState][]): ReadonlyMap<number, LoopGhState> => new Map(entries)

describe('MAX_ROUNDS', () => {
  it('is the shared round fuse from types (6)', () => {
    expect(MAX_ROUNDS).toBe(LOOP_MAX_ROUNDS)
    expect(MAX_ROUNDS).toBe(6)
  })
})

describe('parseBar', () => {
  it('reads a "## Bar" section up to the next heading', () => {
    const body = 'Goal text.\n\n## Bar\nStripe checkout page.\nLoads in under 1s.\n\n## Notes\nother stuff'
    expect(parseBar(body)).toBe('Stripe checkout page.\nLoads in under 1s.')
  })

  it('accepts any heading level, case-insensitively', () => {
    expect(parseBar('### bar\nLinear command palette\n')).toBe('Linear command palette')
    expect(parseBar('# BAR\nthe gh CLI help output')).toBe('the gh CLI help output')
    expect(parseBar('###### Bar:\nsix deep')).toBe('six deep')
  })

  it('keeps deeper sub-headings inside the section and stops at a same-or-higher level', () => {
    expect(parseBar('## Bar\nX\n### Detail\nY\n## Next\nZ')).toBe('X\n### Detail\nY')
    expect(parseBar('### Bar\nX\n# Top\nY')).toBe('X')
  })

  it('does not end the section on a "#" line inside a fenced code block', () => {
    const body = '## Bar\nRun this:\n```sh\n# not a heading\nnpm start\n```\nthen compare\n## Next\nZ'
    expect(parseBar(body)).toBe('Run this:\n```sh\n# not a heading\nnpm start\n```\nthen compare')
  })

  it('reads a "Bar:" line, plain, bold, or bulleted', () => {
    expect(parseBar('Goal: x\nBar: the GitHub CLI help output\nmore')).toBe('the GitHub CLI help output')
    expect(parseBar('**Bar:** Vercel deploy log')).toBe('Vercel deploy log')
    expect(parseBar('**bar**: Raycast store')).toBe('Raycast store')
    expect(parseBar('- BAR: the Zed tab bar')).toBe('the Zed tab bar')
  })

  it('prefers a "## Bar" section over a "Bar:" line', () => {
    expect(parseBar('Bar: line form\n\n## Bar\nsection form')).toBe('section form')
  })

  it('tolerates CRLF line endings (GitHub web-UI bodies)', () => {
    expect(parseBar('## Bar\r\nWindows bar\r\n\r\n## Next\r\nx')).toBe('Windows bar')
    expect(parseBar('Bar: crlf line\r\nnext')).toBe('crlf line')
  })

  it('returns null when there is no bar, or it is empty', () => {
    expect(parseBar('')).toBeNull()
    expect(parseBar('Just a description with no reference.')).toBeNull()
    expect(parseBar('## Bar\n\n## Next\nx')).toBeNull()
    expect(parseBar('Bar:    ')).toBeNull()
  })

  it('does not match near-misses: Sidebar:, Barrier:, or "bar:" mid-sentence', () => {
    expect(parseBar('Sidebar: collapsible')).toBeNull()
    expect(parseBar('Barrier: none')).toBeNull()
    expect(parseBar('The bar: is high here')).toBeNull()
    expect(parseBar('## Barometer\nreadings')).toBeNull()
  })

  it('ignores a bar inside a fenced code block or an HTML comment (issue-template placeholders)', () => {
    expect(parseBar('```\nBar: fake\n```')).toBeNull()
    expect(parseBar('~~~md\n## Bar\nfake\n~~~')).toBeNull()
    expect(parseBar('<!--\nBar: <name the reference to beat>\n-->')).toBeNull()
    expect(parseBar('## Bar\n<!-- name the reference here -->\n')).toBeNull()
  })
})

describe('stripFencedCode', () => {
  it('drops backtick and tilde fences with their contents, keeping prose', () => {
    expect(stripFencedCode('a\n```ts\nx\n```\nb\n~~~\ny\n~~~\nc')).toBe('a\nb\nc')
  })

  it('treats an unclosed fence as running to the end, and only closes on a matching fence', () => {
    expect(stripFencedCode('a\n```\nx\nb')).toBe('a')
    expect(stripFencedCode('a\n````\n```\nx\n````\nb')).toBe('a\nb')
    expect(stripFencedCode('a\n```\n~~~\nx\n```\nb')).toBe('a\nb')
  })

  it('normalizes CRLF', () => {
    expect(stripFencedCode('a\r\n```\r\nx\r\n```\r\nb')).toBe('a\nb')
  })
})

describe('parseBlockedByFallback', () => {
  it('reads "Blocked by #N" and "Depends on #N" lines', () => {
    expect(parseBlockedByFallback('Blocked by #12')).toEqual([12])
    expect(parseBlockedByFallback('depends on #7')).toEqual([7])
    expect(parseBlockedByFallback('**Blocked by:** #4')).toEqual([4])
  })

  it('reads several refs on one line and bulleted lines', () => {
    expect(parseBlockedByFallback('- Blocked by #12, #13')).toEqual([12, 13])
    expect(parseBlockedByFallback('* Depends on #13 and #12')).toEqual([12, 13])
  })

  it('dedupes and sorts ascending across lines', () => {
    expect(parseBlockedByFallback('Blocked by #20\nDepends on #3\nBlocked by #20, #3')).toEqual([3, 20])
  })

  it('only takes the leading ref list, not later prose refs on the same line', () => {
    expect(parseBlockedByFallback('Blocked by #12 (see also #40 for context)')).toEqual([12])
  })

  it('ignores bare #N in prose', () => {
    expect(parseBlockedByFallback('See #12 for context.\nThis relates to #13.')).toEqual([])
    expect(parseBlockedByFallback('This might be blocked by #12 later')).toEqual([])
  })

  it('ignores refs inside inline code spans and fenced code blocks', () => {
    expect(parseBlockedByFallback('Blocked by `#12`')).toEqual([])
    expect(parseBlockedByFallback('`Blocked by #12`')).toEqual([])
    expect(parseBlockedByFallback('```\nBlocked by #12\n```')).toEqual([])
    expect(parseBlockedByFallback('<!-- Blocked by #12 -->')).toEqual([])
  })

  it('tolerates CRLF line endings', () => {
    expect(parseBlockedByFallback('Blocked by #2\r\nDepends on #1\r\n')).toEqual([1, 2])
  })

  it('returns [] for an empty body', () => {
    expect(parseBlockedByFallback('')).toEqual([])
  })
})

describe('parseEpicChildrenFallback', () => {
  it('reads task-list lines in first-seen order', () => {
    expect(parseEpicChildrenFallback('- [ ] #34\n- [x] #12\n* [ ] #40 title text')).toEqual([34, 12, 40])
  })

  it('accepts an upper-case X, nested indentation, and numbered task lists', () => {
    expect(parseEpicChildrenFallback('- [X] #5\n  - [ ] #8 nested\n1. [ ] #9')).toEqual([5, 8, 9])
  })

  it('dedupes, keeping the first-seen position', () => {
    expect(parseEpicChildrenFallback('- [ ] #3\n- [ ] #1\n- [x] #3')).toEqual([3, 1])
  })

  it('ignores prose, plain bullets, and code', () => {
    expect(parseEpicChildrenFallback('#34 is related\n- #35 plain bullet\nsee #36')).toEqual([])
    expect(parseEpicChildrenFallback('```\n- [ ] #34\n```')).toEqual([])
    expect(parseEpicChildrenFallback('- [ ] `#34`')).toEqual([])
    expect(parseEpicChildrenFallback('<!--\n- [ ] #34\n-->')).toEqual([])
  })

  it('tolerates CRLF line endings', () => {
    expect(parseEpicChildrenFallback('- [ ] #2\r\n- [x] #1\r\n')).toEqual([2, 1])
  })
})

describe('deriveStates', () => {
  it('blocks on an unfinished in-map blocker and clears on a done or skipped one', () => {
    const out = deriveStates([
      ticket(1, { state: 'done' }),
      ticket(2, { blockedBy: [1] }),
      ticket(3, { blockedBy: [4] }),
      ticket(4),
      ticket(5, { state: 'skipped' }),
      ticket(6, { blockedBy: [5] }),
    ])
    const byNum = new Map(out.map((t) => [t.number, t.state]))
    expect(byNum.get(2)).toBe('todo')
    expect(byNum.get(3)).toBe('blocked')
    expect(byNum.get(6)).toBe('todo')
  })

  it('treats a closed external blocker as satisfied and an open or unknown one as blocking', () => {
    const tickets = [ticket(1, { blockedBy: [90] }), ticket(2, { blockedBy: [91] }), ticket(3, { blockedBy: [92] })]
    const out = deriveStates(tickets, ext([[90, 'closed'], [91, 'open']]))
    expect(out.map((t) => t.state)).toEqual(['todo', 'blocked', 'blocked'])
    // with no external map at all, an out-of-map blocker blocks
    expect(deriveStates([ticket(1, { blockedBy: [90] })])[0].state).toBe('blocked')
  })

  it('un-blocks a ticket stored as blocked once its blocker is done', () => {
    const out = deriveStates([ticket(1, { state: 'done' }), ticket(2, { state: 'blocked', blockedBy: [1] })])
    expect(out[1].state).toBe('todo')
  })

  it('passes every non-todo/blocked state through untouched', () => {
    const states = [
      'executing',
      'reviewing',
      'validating',
      'finishing',
      'folding',
      'waiting',
      'done',
      'needs-human',
      'skipped',
    ] as const
    const tickets = states.map((state, i) => ticket(i + 1, { state, blockedBy: [99] }))
    expect(deriveStates(tickets).map((t) => t.state)).toEqual([...states])
  })

  it('returns new ticket objects and never mutates its input', () => {
    const input = [ticket(1, { blockedBy: [2] }), ticket(2)]
    const out = deriveStates(input)
    expect(out[0]).not.toBe(input[0])
    expect(out[1]).not.toBe(input[1])
    expect(input[0].state).toBe('todo')
    expect(out[0].state).toBe('blocked')
  })
})

describe('findCycle', () => {
  it('detects A→B→A', () => {
    expect(findCycle([ticket(1, { blockedBy: [2] }), ticket(2, { blockedBy: [1] })])).toEqual([1, 2, 1])
  })

  it('detects a longer cycle and a self-loop', () => {
    const three = [ticket(1, { blockedBy: [2] }), ticket(2, { blockedBy: [3] }), ticket(3, { blockedBy: [1] })]
    expect(findCycle(three)).toEqual([1, 2, 3, 1])
    expect(findCycle([ticket(5, { blockedBy: [5] })])).toEqual([5, 5])
  })

  it('returns only the cycle, not the path that led into it', () => {
    const tickets = [ticket(1, { blockedBy: [2] }), ticket(2, { blockedBy: [3] }), ticket(3, { blockedBy: [2] })]
    expect(findCycle(tickets)).toEqual([2, 3, 2])
  })

  it('returns null for a DAG, and ignores out-of-map blockers', () => {
    const dag = [
      ticket(1),
      ticket(2, { blockedBy: [1] }),
      ticket(3, { blockedBy: [1] }),
      ticket(4, { blockedBy: [2, 3, 77] }),
    ]
    expect(findCycle(dag)).toBeNull()
    expect(findCycle([])).toBeNull()
  })
})

describe('frontier', () => {
  it('keeps only unblocked todo tickets — excludes blocked, skipped, done, needs-human, waiting, and in-flight', () => {
    const tickets = [
      ticket(1, { state: 'done' }),
      ticket(2), // todo, unblocked
      ticket(3, { blockedBy: [4] }), // derived blocked
      ticket(4),
      ticket(5, { state: 'skipped' }),
      ticket(6, { state: 'needs-human' }),
      ticket(7, { state: 'waiting' }),
      ticket(8, { state: 'executing' }),
      ticket(9, { state: 'reviewing' }),
      ticket(10, { state: 'validating' }),
      ticket(11, { state: 'finishing' }),
      ticket(12, { state: 'folding' }),
      ticket(13, { state: 'blocked', blockedBy: [1] }), // stored blocked, blocker now done
    ]
    expect(frontier(tickets).map((t) => t.number)).toEqual([2, 4, 13])
  })

  it('uses the external map for out-of-map blockers', () => {
    const tickets = [ticket(1, { blockedBy: [50] })]
    expect(frontier(tickets)).toEqual([])
    expect(frontier(tickets, ext([[50, 'closed']])).map((t) => t.number)).toEqual([1])
  })
})

describe('pickNext', () => {
  const tickets = [ticket(5), ticket(2), ticket(9), ticket(7), ticket(3)]

  it('orders priority-listed tickets first, then the rest by issue number', () => {
    expect(pickNext(tickets, [9, 3], 5)).toEqual([9, 3, 2, 5, 7])
  })

  it('never returns more than the free slots', () => {
    expect(pickNext(tickets, [9], 2)).toEqual([9, 2])
    expect(pickNext(tickets, [], 0)).toEqual([])
    expect(pickNext(tickets, [], -3)).toEqual([])
  })

  it('skips blocked, barless, and non-todo tickets even when prioritised', () => {
    const mixed = [
      ticket(1, { bar: null }),
      ticket(2, { bar: '   ' }),
      ticket(3, { blockedBy: [4] }),
      ticket(4),
      ticket(5, { state: 'done' }),
      ticket(6, { state: 'executing' }),
    ]
    expect(pickNext(mixed, [1, 2, 3, 5, 6], 3)).toEqual([4])
  })

  it('ignores duplicate priority entries and numbers outside the map', () => {
    expect(pickNext(tickets, [7, 7, 404, 2], 10)).toEqual([7, 2, 3, 5, 9])
  })

  it('honours the external map', () => {
    const t = [ticket(1, { blockedBy: [60] }), ticket(2)]
    expect(pickNext(t, [1], 2)).toEqual([2])
    expect(pickNext(t, [1], 2, ext([[60, 'closed']]))).toEqual([1, 2])
  })
})

describe('barless', () => {
  it('lists frontier tickets with no (or a blank) bar, ascending', () => {
    const tickets = [
      ticket(4, { bar: '' }),
      ticket(1, { bar: null }),
      ticket(2),
      ticket(3, { bar: null, blockedBy: [2] }), // blocked: not frontier
      ticket(5, { bar: null, state: 'done' }),
    ]
    expect(barless(tickets)).toEqual([1, 4])
  })
})

describe('percentComplete', () => {
  it('is 0 for an empty or all-skipped map', () => {
    expect(percentComplete([])).toBe(0)
    expect(percentComplete([ticket(1, { state: 'skipped' })])).toBe(0)
  })

  it('divides done by non-skipped tickets and rounds', () => {
    expect(percentComplete([ticket(1, { state: 'done' }), ticket(2), ticket(3)])).toBe(33)
    expect(percentComplete([ticket(1, { state: 'done' }), ticket(2, { state: 'done' }), ticket(3)])).toBe(67)
    expect(
      percentComplete([
        ticket(1, { state: 'done' }),
        ticket(2, { state: 'done' }),
        ticket(3),
        ticket(4, { state: 'executing' }),
        ticket(5, { state: 'skipped' }),
      ]),
    ).toBe(50)
    expect(percentComplete([ticket(1, { state: 'done' })])).toBe(100)
  })
})

describe('verdictOutcome', () => {
  it('is a WIN only when the chosen letter is ours', () => {
    expect(verdictOutcome('A', 'A')).toBe('WIN')
    expect(verdictOutcome('b', 'B')).toBe('WIN')
    expect(verdictOutcome('  A  ', 'A')).toBe('WIN')
    expect(verdictOutcome('B', 'A')).toBe('LOSE')
    expect(verdictOutcome('a', 'B')).toBe('LOSE')
  })

  it('treats a tie, garbage, or a missing answer as a LOSE (the output must beat the bar)', () => {
    for (const bad of ['TIE', 'tie', 'A/B', 'AB', 'both', '8/10', '', '   ', null, undefined]) {
      expect(verdictOutcome(bad, 'A')).toBe('LOSE')
      expect(verdictOutcome(bad, 'B')).toBe('LOSE')
    }
  })

  it('reads a letter wrapped in markdown emphasis, code, brackets, or a trailing period', () => {
    expect(verdictOutcome('**A**', 'A')).toBe('WIN')
    expect(verdictOutcome('`B`', 'B')).toBe('WIN')
    expect(verdictOutcome('<A>', 'A')).toBe('WIN')
    expect(verdictOutcome('B.', 'B')).toBe('WIN')
    expect(verdictOutcome('**B**', 'A')).toBe('LOSE')
  })
})

describe('nextAfterLoss', () => {
  it('increments the round and carries the gap', () => {
    expect(nextAfterLoss({ round: 1 }, 'no keyboard nav')).toEqual({
      round: 2,
      lastGap: 'no keyboard nav',
      parked: false,
    })
  })

  it('stays live through round 6 and parks when the 6th loss pushes it to round 7', () => {
    expect(nextAfterLoss({ round: 5 }, 'gap').parked).toBe(false)
    expect(nextAfterLoss({ round: 5 }, 'gap').round).toBe(6)
    const fused = nextAfterLoss({ round: 6 }, 'still slower')
    expect(fused).toEqual({ round: 7, lastGap: 'still slower', parked: true })
  })
})

describe('randomLabel', () => {
  it('maps the injected random draw onto A (< 0.5) or B (>= 0.5)', () => {
    expect(randomLabel(() => 0)).toBe('A')
    expect(randomLabel(() => 0.49)).toBe('A')
    expect(randomLabel(() => 0.5)).toBe('B')
    expect(randomLabel(() => 0.99)).toBe('B')
  })

  it('defaults to Math.random and always returns A or B', () => {
    for (let i = 0; i < 20; i++) expect(['A', 'B']).toContain(randomLabel())
  })
})
