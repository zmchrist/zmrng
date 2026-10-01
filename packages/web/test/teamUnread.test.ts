import { describe, it, expect } from 'vitest'
import {
  emptyUnread,
  observeTip,
  observeTips,
  markRead,
  hasUnread,
  type ChannelTip,
} from '../src/teamUnread'

// Own-post suppression is keyed on the AUTHENTICATED user's display name — the
// name the server stamps on every message it persists for that session. There
// is no self-asserted handle left to key it on, so these fixtures deliberately
// use a display name that differs from the username (`zc`) to prove which of
// the two the caller must pass.
const ME = 'Zoe Clark'
const SOMEONE_ELSE = 'Ada Lovelace'
const AGENT = '@agent'

const tip = (channelId: number, messageId: number, author = SOMEONE_ELSE): ChannelTip => ({
  channelId,
  messageId,
  author,
})

describe('teamUnread', () => {
  it('starts with nothing unread', () => {
    expect(hasUnread(emptyUnread())).toBe(false)
  })

  it('treats the first observation of a channel as a read baseline', () => {
    // Otherwise every app start would light the orb for the whole of history.
    const s = observeTip(emptyUnread(), tip(1, 42), ME)
    expect(hasUnread(s)).toBe(false)
  })

  it('marks a channel unread when a newer message from someone else appears', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), ME)
    s = observeTip(s, tip(1, 43), ME)
    expect(hasUnread(s)).toBe(true)
  })

  it('ignores the operator own messages', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), ME)
    s = observeTip(s, tip(1, 43, ME), ME)
    expect(hasUnread(s)).toBe(false)
  })

  it('counts another user post as unread while the same post from you does not', () => {
    // The whole point of keying on the authenticated display name: two
    // identical snapshots differ ONLY in the author, and only the other
    // person's post lights the orb.
    const seeded = observeTip(emptyUnread(), tip(1, 42, ME), ME)
    expect(hasUnread(observeTip(seeded, tip(1, 43, SOMEONE_ELSE), ME))).toBe(true)
    expect(hasUnread(observeTip(seeded, tip(1, 43, ME), ME))).toBe(false)
  })

  it('does not treat the username as the identity — only the display name matches', () => {
    // `zc` is the login username; the messages carry the display name. Passing
    // the wrong one would make every one of the operator own posts unread.
    let s = observeTip(emptyUnread(), tip(1, 42, ME), ME)
    s = observeTip(s, tip(1, 43, ME), 'zc')
    expect(hasUnread(s)).toBe(true)
  })

  it('counts the agent replies as unread', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), ME)
    s = observeTip(s, tip(1, 43, AGENT), ME)
    expect(hasUnread(s)).toBe(true)
  })

  it('does not let an own post swallow an older unread message', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), ME)
    s = observeTip(s, tip(1, 43, SOMEONE_ELSE), ME)
    s = observeTip(s, tip(1, 44, ME), ME)
    expect(hasUnread(s)).toBe(true)
  })

  it('clears a channel only when that channel is read', () => {
    let s = observeTips(emptyUnread(), [tip(1, 10), tip(2, 20)], ME)
    s = observeTips(s, [tip(1, 11), tip(2, 21)], ME)
    expect(hasUnread(s)).toBe(true)

    s = markRead(s, 1, 11)
    expect(hasUnread(s)).toBe(true) // channel 2 is still unread

    s = markRead(s, 2, 21)
    expect(hasUnread(s)).toBe(false)
  })

  it('is idempotent on a repeated snapshot', () => {
    const seeded = observeTips(emptyUnread(), [tip(1, 10), tip(2, 20)], ME)
    const again = observeTips(seeded, [tip(1, 10), tip(2, 20)], ME)
    expect(again).toBe(seeded)
    expect(hasUnread(again)).toBe(false)
  })

  it('ignores a stale markRead and never rewinds the read mark', () => {
    let s = observeTip(emptyUnread(), tip(1, 10), ME)
    s = markRead(s, 1, 20)
    const before = s
    s = markRead(s, 1, 5)
    expect(s).toBe(before)
    expect(hasUnread(s)).toBe(false)
  })

  it('marking an unseen channel read seeds it without lighting the orb', () => {
    const s = markRead(emptyUnread(), 7, 3)
    expect(hasUnread(s)).toBe(false)
  })

  it('tolerates malformed ids', () => {
    const s = emptyUnread()
    expect(observeTip(s, tip(Number.NaN, 1), ME)).toBe(s)
    expect(observeTip(s, tip(1, Number.NaN), ME)).toBe(s)
    expect(markRead(s, Number.NaN, 1)).toBe(s)
  })
})
