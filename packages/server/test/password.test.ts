import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P } from '../src/password.js'

// scrypt at N=32768 costs ~100ms per derivation, so this suite deliberately
// hashes only a handful of times and reuses one stored string across the
// format assertions rather than re-hashing per case.
const PASSWORD = 'correct horse battery staple'
const STORED = hashPassword(PASSWORD)

describe('hashPassword', () => {
  it('produces the versioned scrypt$N$r$p$salt$key format', () => {
    expect(STORED.startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`)).toBe(true)
    expect(STORED.startsWith('scrypt$32768$8$1$')).toBe(true)
    const fields = STORED.split('$')
    expect(fields).toHaveLength(6)
    expect(Buffer.from(fields[4], 'base64')).toHaveLength(32)
    expect(Buffer.from(fields[5], 'base64')).toHaveLength(64)
  })

  it('never embeds the plaintext password', () => {
    expect(STORED).not.toContain(PASSWORD)
  })

  it('uses a random salt — the same password hashes to two different strings, both valid', () => {
    const a = hashPassword('same-password')
    const b = hashPassword('same-password')
    expect(a).not.toBe(b)
    expect(verifyPassword('same-password', a)).toBe(true)
    expect(verifyPassword('same-password', b)).toBe(true)
  })
})

describe('verifyPassword', () => {
  it('round-trips the correct password', () => {
    expect(verifyPassword(PASSWORD, STORED)).toBe(true)
  })

  it('rejects a wrong password', () => {
    expect(verifyPassword('wrong horse battery staple', STORED)).toBe(false)
  })

  it('rejects rather than throws on a malformed stored hash', () => {
    const malformed = [
      '',
      'not-a-hash',
      'scrypt$32768$8$1', // truncated — missing salt + key
      'scrypt$32768$8$1$', // truncated — empty tail, only 5 fields
      'scrypt$32768$8$1$salt$key$extra', // too many fields
      'argon2id$32768$8$1$c2FsdA==$a2V5', // unknown prefix
      'scrypt$abc$8$1$c2FsdA==$a2V5', // non-numeric N
      'scrypt$32768$r$1$c2FsdA==$a2V5', // non-numeric r
      'scrypt$32768$8$p$c2FsdA==$a2V5', // non-numeric p
      'scrypt$0$8$1$c2FsdA==$a2V5', // out-of-range N
      `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$!!!not base64!!!$!!!nope!!!`, // bad base64
    ]
    for (const stored of malformed) {
      expect(() => verifyPassword(PASSWORD, stored)).not.toThrow()
      expect(verifyPassword(PASSWORD, stored)).toBe(false)
    }
  })

  it('round-trips an empty password', () => {
    const stored = hashPassword('')
    expect(verifyPassword('', stored)).toBe(true)
    expect(verifyPassword('x', stored)).toBe(false)
  })

  it('round-trips a very long password', () => {
    const long = 'a'.repeat(1024)
    const stored = hashPassword(long)
    expect(verifyPassword(long, stored)).toBe(true)
  })

  it('round-trips a unicode password (emoji + accents)', () => {
    const unicode = 'pässwörd–🔐🦀 très sûr'
    const stored = hashPassword(unicode)
    expect(verifyPassword(unicode, stored)).toBe(true)
    expect(verifyPassword('passwörd–🔐🦀 tres sur', stored)).toBe(false)
  })
})
