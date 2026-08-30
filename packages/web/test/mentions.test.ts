import { describe, it, expect } from 'vitest'
import {
  mentionCandidates,
  activeMention,
  filterCandidates,
  applyMention,
  parseMentions,
  type MentionCandidate,
} from '../src/mentions'

function members(...names: string[]): { displayName: string }[] {
  return names.map((displayName) => ({ displayName }))
}

describe('mentionCandidates', () => {
  it('includes every roster displayName plus the agent (bot handle minus one leading @)', () => {
    const out = mentionCandidates(members('Ada', 'John Smith'), '@agent')
    expect(out).toEqual<MentionCandidate[]>([
      { name: 'Ada', kind: 'member' },
      { name: 'John Smith', kind: 'member' },
      { name: 'agent', kind: 'agent' },
    ])
  })

  it('handles a bot handle without a leading @', () => {
    const out = mentionCandidates(members(), 'bot')
    expect(out).toEqual<MentionCandidate[]>([{ name: 'bot', kind: 'agent' }])
  })

  it('de-dups a member named like the agent, case-insensitively (member kept, agent dropped)', () => {
    const out = mentionCandidates(members('Agent'), '@agent')
    expect(out).toEqual<MentionCandidate[]>([{ name: 'Agent', kind: 'member' }])
  })

  it('drops blank/whitespace names and a blank bot handle', () => {
    const out = mentionCandidates(members('Ada', '   ', ''), '   ')
    expect(out).toEqual<MentionCandidate[]>([{ name: 'Ada', kind: 'member' }])
  })
})

describe('activeMention', () => {
  it('returns the in-progress query for a bare @ at the caret', () => {
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('returns the query for @Jo', () => {
    expect(activeMention('hi @Jo', 6)).toEqual({ start: 3, query: 'Jo' })
  })

  it('spans a space so a multi-word name keeps filtering', () => {
    expect(activeMention('@John Sm', 8)).toEqual({ start: 0, query: 'John Sm' })
  })

  it('returns null for an email local-part (word char before the @)', () => {
    expect(activeMention('foo@bar', 7)).toBeNull()
  })

  it('returns null when there is no @ before the caret', () => {
    expect(activeMention('hello world', 11)).toBeNull()
  })

  it('picks the @ nearest the caret', () => {
    // caret after "b" — nearest @ starts the "@b" run
    expect(activeMention('@a @b', 5)).toEqual({ start: 3, query: 'b' })
  })

  it('is null when a newline separates the @ from the caret', () => {
    expect(activeMention('@a\nfoo', 6)).toBeNull()
  })
})

describe('filterCandidates', () => {
  const cands: MentionCandidate[] = [
    { name: 'Ada', kind: 'member' },
    { name: 'John Smith', kind: 'member' },
    { name: 'agent', kind: 'agent' },
  ]

  it('returns all candidates for an empty query', () => {
    expect(filterCandidates(cands, '')).toEqual(cands)
  })

  it('prefix-filters case-insensitively', () => {
    expect(filterCandidates(cands, 'a')).toEqual([
      { name: 'Ada', kind: 'member' },
      { name: 'agent', kind: 'agent' },
    ])
    expect(filterCandidates(cands, 'john s')).toEqual([{ name: 'John Smith', kind: 'member' }])
  })

  it('returns [] for a query past every candidate (drives dropdown auto-close)', () => {
    expect(filterCandidates(cands, 'zzz')).toEqual([])
  })
})

describe('applyMention', () => {
  it('replaces the active @query with @name and a trailing space, reporting the caret past it', () => {
    const r = applyMention('@Jo', 0, 3, 'John Smith')
    expect(r.text).toBe('@John Smith ')
    expect(r.caret).toBe('@John Smith '.length)
  })

  it('preserves surrounding text on both sides', () => {
    const text = 'hey @Jo how are you'
    const r = applyMention(text, 4, 7, 'John')
    expect(r.text).toBe('hey @John  how are you')
    expect(r.caret).toBe('hey @John '.length)
  })
})

describe('parseMentions', () => {
  const names = ['John Smith', 'Ada', 'agent']

  it('greedily highlights a multi-word @John Smith', () => {
    expect(parseMentions('hi @John Smith!', names)).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', text: '@John Smith' },
      { type: 'text', text: '!' },
    ])
  })

  it('highlights @agent', () => {
    expect(parseMentions('yo @agent', names)).toEqual([
      { type: 'text', text: 'yo ' },
      { type: 'mention', text: '@agent' },
    ])
  })

  it('leaves a bare @ and an email as plain text', () => {
    expect(parseMentions('a @ b foo@bar', names)).toEqual([
      { type: 'text', text: 'a @ b foo@bar' },
    ])
  })

  it('does not match @Johns (word char after the candidate boundary, near-miss guard)', () => {
    expect(parseMentions('@Johns', names)).toEqual([{ type: 'text', text: '@Johns' }])
  })

  it('interleaves segments in order and round-trips to the original body', () => {
    const body = '@Ada and @agent talk to @John Smith end'
    const segs = parseMentions(body, names)
    expect(segs.map((s) => s.text).join('')).toBe(body)
    expect(segs.filter((s) => s.type === 'mention').map((s) => s.text)).toEqual([
      '@Ada',
      '@agent',
      '@John Smith',
    ])
  })

  it('is case-insensitive on the name match but preserves the typed casing', () => {
    expect(parseMentions('@ada', names)).toEqual([{ type: 'mention', text: '@ada' }])
  })

  it('returns a single text segment when there are no names', () => {
    expect(parseMentions('@Ada hi', [])).toEqual([{ type: 'text', text: '@Ada hi' }])
  })
})
