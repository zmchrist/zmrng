import { describe, it, expect } from 'vitest'
import { formatMessageTime } from '../src/teamTime'

// Inputs use a local (offset-less) ISO string so the assertion is timezone
// independent: the string is parsed as local time and read back with the local
// getters, so the wall-clock digits are stable on any CI machine.
describe('formatMessageTime', () => {
  it('renders full ISO date + 12h afternoon time with PM, no seconds', () => {
    expect(formatMessageTime('2026-09-07T15:42:00')).toBe('2026-09-07 3:42 PM')
  })

  it('renders midnight as 12:xx AM', () => {
    expect(formatMessageTime('2026-01-05T00:05:00')).toBe('2026-01-05 12:05 AM')
  })

  it('renders noon as 12:xx PM', () => {
    expect(formatMessageTime('2026-12-25T12:00:00')).toBe('2026-12-25 12:00 PM')
  })

  it('zero-pads month, day, and minutes', () => {
    expect(formatMessageTime('2026-03-04T09:07:00')).toBe('2026-03-04 9:07 AM')
  })

  it('returns empty string for a malformed timestamp', () => {
    expect(formatMessageTime('not-a-date')).toBe('')
    expect(formatMessageTime('')).toBe('')
  })
})
