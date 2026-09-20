import { describe, it, expect } from 'vitest'
import {
  emptyUnread,
  observeTip,
  observeTips,
  markRead,
  hasUnread,
  type ChannelTip,
} from '../src/teamUnread'

const tip = (channelId: number, messageId: number, author = 'ada'): ChannelTip => ({
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
    const s = observeTip(emptyUnread(), tip(1, 42), 'zc')
    expect(hasUnread(s)).toBe(false)
  })

  it('marks a channel unread when a newer message from someone else appears', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), 'zc')
    s = observeTip(s, tip(1, 43), 'zc')
    expect(hasUnread(s)).toBe(true)
  })

  it('ignores the operator own messages', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), 'zc')
    s = observeTip(s, tip(1, 43, 'zc'), 'zc')
    expect(hasUnread(s)).toBe(false)
  })

  it('counts the agent replies as unread', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), 'zc')
    s = observeTip(s, tip(1, 43, '@agent'), 'zc')
    expect(hasUnread(s)).toBe(true)
  })

  it('does not let an own post swallow an older unread message', () => {
    let s = observeTip(emptyUnread(), tip(1, 42), 'zc')
    s = observeTip(s, tip(1, 43, 'ada'), 'zc')
    s = observeTip(s, tip(1, 44, 'zc'), 'zc')
    expect(hasUnread(s)).toBe(true)
  })

  it('clears a channel only when that channel is read', () => {
    let s = observeTips(emptyUnread(), [tip(1, 10), tip(2, 20)], 'zc')
    s = observeTips(s, [tip(1, 11), tip(2, 21)], 'zc')
    expect(hasUnread(s)).toBe(true)

    s = markRead(s, 1, 11)
    expect(hasUnread(s)).toBe(true) // channel 2 is still unread

    s = markRead(s, 2, 21)
    expect(hasUnread(s)).toBe(false)
  })

  it('is idempotent on a repeated snapshot', () => {
    const seeded = observeTips(emptyUnread(), [tip(1, 10), tip(2, 20)], 'zc')
    const again = observeTips(seeded, [tip(1, 10), tip(2, 20)], 'zc')
    expect(again).toBe(seeded)
    expect(hasUnread(again)).toBe(false)
  })

  it('ignores a stale markRead and never rewinds the read mark', () => {
    let s = observeTip(emptyUnread(), tip(1, 10), 'zc')
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
    expect(observeTip(s, tip(Number.NaN, 1), 'zc')).toBe(s)
    expect(observeTip(s, tip(1, Number.NaN), 'zc')).toBe(s)
    expect(markRead(s, Number.NaN, 1)).toBe(s)
  })
})
