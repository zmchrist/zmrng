import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadOpenChannelId,
  saveOpenChannelId,
  initialPane,
  resolveOpenChannelId,
} from '../src/teamNav'

describe('teamNav', () => {
  beforeEach(() => localStorage.clear())

  describe('open-channel persistence', () => {
    it('round-trips a channel id', () => {
      saveOpenChannelId(7)
      expect(loadOpenChannelId()).toBe(7)
    })

    it('returns null when nothing was ever saved', () => {
      expect(loadOpenChannelId()).toBeNull()
    })

    it('clears the stored id when saving null', () => {
      saveOpenChannelId(7)
      saveOpenChannelId(null)
      expect(loadOpenChannelId()).toBeNull()
    })

    it('ignores a garbage stored value', () => {
      localStorage.setItem('zmrng-team-open-channel', 'not-a-number')
      expect(loadOpenChannelId()).toBeNull()
    })
  })

  describe('initialPane', () => {
    it('lands on the thread when a channel was persisted', () => {
      expect(initialPane(3)).toBe('thread')
    })

    it('lands on the list when no channel was persisted', () => {
      expect(initialPane(null)).toBe('list')
    })
  })

  describe('resolveOpenChannelId', () => {
    const channels = [{ id: 1 }, { id: 2 }]

    it('keeps a persisted channel that still exists', () => {
      expect(resolveOpenChannelId(2, channels)).toBe(2)
    })

    it('falls back to the first channel when the persisted one is gone', () => {
      expect(resolveOpenChannelId(99, channels)).toBe(1)
    })

    it('defaults to the first channel when nothing is open', () => {
      expect(resolveOpenChannelId(null, channels)).toBe(1)
    })

    it('stays null when there are no channels at all', () => {
      expect(resolveOpenChannelId(4, [])).toBeNull()
    })
  })
})
