import { describe, it, expect } from 'vitest'
import { initialTurn, reduce, type VoiceState } from '../src/voiceTurn'

describe('voiceTurn', () => {
  it('starts idle', () => {
    expect(initialTurn()).toBe('idle')
  })

  it('runs the normal turn cycle', () => {
    let s: VoiceState = 'listening'
    s = reduce(s, { type: 'speechEnd' })
    expect(s).toBe('transcribing')
    s = reduce(s, { type: 'transcript' })
    expect(s).toBe('thinking')
    s = reduce(s, { type: 'partial' })
    expect(s).toBe('speaking')
    s = reduce(s, { type: 'turnEnd' })
    expect(s).toBe('listening')
  })

  it('freezes: ignores speechEnd while speaking', () => {
    expect(reduce('speaking', { type: 'speechEnd' })).toBe('speaking')
  })

  it('freezes: ignores speechStart while speaking', () => {
    expect(reduce('speaking', { type: 'speechStart' })).toBe('speaking')
  })

  it('barge-in transitions speaking -> listening', () => {
    expect(reduce('speaking', { type: 'bargeIn' })).toBe('listening')
  })

  it('barge-in during thinking -> listening', () => {
    expect(reduce('thinking', { type: 'bargeIn' })).toBe('listening')
  })

  it('stop returns to idle from any state', () => {
    for (const s of ['listening', 'transcribing', 'thinking', 'speaking'] as VoiceState[]) {
      expect(reduce(s, { type: 'stop' })).toBe('idle')
    }
  })

  it('speaking absorbs further partials', () => {
    expect(reduce('speaking', { type: 'partial' })).toBe('speaking')
  })

  it('an empty reply (turnEnd from thinking) re-arms listening', () => {
    expect(reduce('thinking', { type: 'turnEnd' })).toBe('listening')
  })

  it('speechStart while idle begins listening', () => {
    expect(reduce('idle', { type: 'speechStart' })).toBe('listening')
  })

  it('ignores a stray transcript outside transcribing', () => {
    expect(reduce('listening', { type: 'transcript' })).toBe('listening')
    expect(reduce('speaking', { type: 'transcript' })).toBe('speaking')
  })

  it('idle absorbs unrelated events', () => {
    expect(reduce('idle', { type: 'partial' })).toBe('idle')
    expect(reduce('idle', { type: 'turnEnd' })).toBe('idle')
    expect(reduce('idle', { type: 'bargeIn' })).toBe('idle')
  })
})
