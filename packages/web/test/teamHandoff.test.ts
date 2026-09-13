import { describe, it, expect } from 'vitest'
import {
  handoffTitle,
  provenanceLine,
  buildHandoffPrefill,
  resolveSuggestedRepoId,
} from '../src/teamHandoff'
import type { Channel, Message, RepoTarget } from '../src/types'

function channel(over: Partial<Channel> = {}): Channel {
  return { id: 1, name: 'general', repoId: null, createdAt: '2026-08-25T00:00:00.000Z', ...over }
}
function message(over: Partial<Message> = {}): Message {
  return {
    id: 42,
    channelId: 1,
    author: 'Ada',
    body: 'ship the login fix',
    kind: 'human',
    createdAt: '2026-08-25T00:00:00.000Z',
    ...over,
  }
}
const repos: RepoTarget[] = [
  { id: 'zmrng', label: 'zmrng', path: '/p/zmrng', defaultBranch: 'main' },
  { id: 'example-app', label: 'example-app', path: '/p/example-app', defaultBranch: 'main' },
]

describe('handoffTitle', () => {
  it('uses the first non-empty line, whitespace-collapsed', () => {
    expect(handoffTitle('  fix   the   bug \nmore detail')).toBe('fix the bug')
  })
  it('skips leading blank lines', () => {
    expect(handoffTitle('\n\nreal title\nbody')).toBe('real title')
  })
  it('clamps an over-long title with an ellipsis', () => {
    const long = 'x'.repeat(120)
    const title = handoffTitle(long)
    expect(title.length).toBe(80)
    expect(title.endsWith('…')).toBe(true)
  })
  it('returns empty for an empty body', () => {
    expect(handoffTitle('')).toBe('')
  })
})

describe('provenanceLine', () => {
  it('renders a deterministic channel + message back-reference', () => {
    expect(provenanceLine(channel({ name: 'zmrng-dev' }), message({ id: 7 }))).toBe(
      '\n\n---\nFrom team channel #zmrng-dev (message #7)',
    )
  })
})

describe('buildHandoffPrefill', () => {
  it('builds title + body with an appended provenance line', () => {
    const p = buildHandoffPrefill(channel({ name: 'general' }), message({ id: 42, body: 'do X' }))
    expect(p.title).toBe('do X')
    expect(p.body).toBe('do X\n\n---\nFrom team channel #general (message #42)')
  })
  it('carries a repo-tied channel repoId as a suggestion only', () => {
    const p = buildHandoffPrefill(channel({ name: 'zmrng-dev', repoId: 'zmrng' }), message())
    expect(p.suggestedRepoId).toBe('zmrng')
  })
  it('omits suggestedRepoId for a channel with no repo', () => {
    const p = buildHandoffPrefill(channel({ repoId: null }), message())
    expect(p.suggestedRepoId).toBeUndefined()
  })
})

describe('resolveSuggestedRepoId', () => {
  it('keeps a suggestion that exists in the local registry', () => {
    expect(resolveSuggestedRepoId('example-app', repos)).toBe('example-app')
  })
  it('drops a suggestion the local machine does not have (never auto-bind)', () => {
    expect(resolveSuggestedRepoId('unknown-repo', repos)).toBe('')
  })
  it('falls back to the default sentinel when there is no suggestion', () => {
    expect(resolveSuggestedRepoId(undefined, repos)).toBe('')
  })
})
