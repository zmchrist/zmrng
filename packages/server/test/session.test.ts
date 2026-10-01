import { describe, it, expect } from 'vitest'
import {
  newToken,
  hashToken,
  expiryFrom,
  isExpired,
  shouldRenew,
  SESSION_TTL_MS,
  SESSION_RENEW_BELOW_MS,
  TOKEN_BYTES,
} from '../src/session.js'

const NOW = '2026-09-23T12:00:00.000Z'
const nowMs = Date.parse(NOW)
const iso = (ms: number): string => new Date(ms).toISOString()

describe('newToken', () => {
  it('decodes to TOKEN_BYTES bytes of base64url', () => {
    const token = newToken()
    expect(TOKEN_BYTES).toBe(32)
    expect(Buffer.from(token, 'base64url')).toHaveLength(TOKEN_BYTES)
    // base64url: no padding, no + or / characters (safe in a cookie or header)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is unique across many calls', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 200; i++) tokens.add(newToken())
    expect(tokens.size).toBe(200)
  })
})

describe('hashToken', () => {
  it('is deterministic', () => {
    const token = newToken()
    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('is 64 lowercase hex characters (sha256)', () => {
    expect(hashToken(newToken())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never returns the token itself', () => {
    const token = newToken()
    const digest = hashToken(token)
    expect(digest).not.toBe(token)
    expect(digest).not.toContain(token)
  })

  it('maps different tokens to different digests', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })
})

describe('expiryFrom', () => {
  it('adds exactly SESSION_TTL_MS by default', () => {
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(Date.parse(expiryFrom(NOW)) - nowMs).toBe(SESSION_TTL_MS)
  })

  it('honours an explicit ttl', () => {
    expect(Date.parse(expiryFrom(NOW, 60_000)) - nowMs).toBe(60_000)
  })

  it('returns a parseable ISO string for an unparseable `now` rather than throwing', () => {
    expect(() => expiryFrom('not-a-date')).not.toThrow()
    expect(Number.isNaN(Date.parse(expiryFrom('not-a-date')))).toBe(false)
  })
})

describe('isExpired', () => {
  it('is false while time remains', () => {
    expect(isExpired(iso(nowMs + 1), NOW)).toBe(false)
    expect(isExpired(expiryFrom(NOW), NOW)).toBe(false)
  })

  it('is true exactly at the boundary (now >= expiresAt)', () => {
    expect(isExpired(NOW, NOW)).toBe(true)
  })

  it('is true once past the boundary', () => {
    expect(isExpired(iso(nowMs - 1), NOW)).toBe(true)
  })

  it('fails closed on an unparseable date', () => {
    expect(isExpired('garbage', NOW)).toBe(true)
    expect(isExpired(NOW, 'garbage')).toBe(true)
    expect(isExpired('', '')).toBe(true)
  })
})

describe('shouldRenew', () => {
  it('is false for a brand-new session — no DB write on every request', () => {
    expect(SESSION_RENEW_BELOW_MS).toBe(6 * 24 * 60 * 60 * 1000)
    expect(shouldRenew(expiryFrom(NOW), NOW)).toBe(false)
  })

  it('is false just outside the renewal window', () => {
    expect(shouldRenew(iso(nowMs + SESSION_RENEW_BELOW_MS + 1000), NOW)).toBe(false)
  })

  it('is true once remaining drops below the renewal window', () => {
    expect(shouldRenew(iso(nowMs + SESSION_RENEW_BELOW_MS - 1000), NOW)).toBe(true)
    // one day into a seven-day session
    expect(shouldRenew(expiryFrom(NOW), iso(nowMs + 24 * 60 * 60 * 1000 + 1000))).toBe(true)
  })

  it('is false for an already-expired session', () => {
    expect(shouldRenew(NOW, NOW)).toBe(false)
    expect(shouldRenew(iso(nowMs - 1000), NOW)).toBe(false)
  })

  it('is false for an unparseable date', () => {
    expect(shouldRenew('garbage', NOW)).toBe(false)
    expect(shouldRenew(NOW, 'garbage')).toBe(false)
  })
})
