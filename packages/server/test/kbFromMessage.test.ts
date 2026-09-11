import { describe, it, expect } from 'vitest'
import {
  pageTitleFromMessage,
  resolvePageTitle,
  messageProvenance,
  buildPageBody,
  DEFAULT_PAGE_TITLE,
} from '../src/kbFromMessage.js'

describe('pageTitleFromMessage', () => {
  it('takes the first non-empty line, whitespace-collapsed', () => {
    expect(pageTitleFromMessage('\n\n  Deploy   the   VPS  \nmore text')).toBe('Deploy the VPS')
  })

  it('returns an empty string for an all-blank body', () => {
    expect(pageTitleFromMessage('   \n\t\n ')).toBe('')
  })

  it('clamps a long first line to 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const out = pageTitleFromMessage(long)
    expect(out).toHaveLength(80)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('resolvePageTitle', () => {
  it('prefers an explicit client title when non-blank (trimmed)', () => {
    expect(resolvePageTitle('  Custom Title  ', 'message body')).toBe('Custom Title')
  })

  it('derives from the message body when the client title is blank/absent', () => {
    expect(resolvePageTitle(undefined, 'First line here\nsecond')).toBe('First line here')
    expect(resolvePageTitle('   ', 'First line here')).toBe('First line here')
  })

  it('falls back to the default title when nothing usable is available', () => {
    expect(resolvePageTitle(undefined, '   \n ')).toBe(DEFAULT_PAGE_TITLE)
  })
})

describe('messageProvenance', () => {
  it('builds a deterministic back-reference from channel name + message id', () => {
    expect(messageProvenance('general', 42)).toBe(
      '\n\n---\nFrom team channel #general (message #42)',
    )
  })
})

describe('buildPageBody', () => {
  it('appends the provenance line to the original message body', () => {
    expect(buildPageBody('Ship it', 'zmrng-dev', 7)).toBe(
      'Ship it\n\n---\nFrom team channel #zmrng-dev (message #7)',
    )
  })
})
