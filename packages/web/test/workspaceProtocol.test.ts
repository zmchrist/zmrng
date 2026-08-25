import { describe, it, expect } from 'vitest'
import {
  encodeHello,
  encodePing,
  parseWorkspaceServerMsg,
} from '../src/workspaceProtocol'
import { MAX_DISPLAY_NAME_LEN } from '../src/types'

describe('client encoders', () => {
  it('encodeHello produces a hello frame carrying the display name', () => {
    expect(JSON.parse(encodeHello('Ada'))).toEqual({ type: 'hello', displayName: 'Ada' })
  })

  it('encodeHello trims surrounding whitespace from the display name', () => {
    expect(JSON.parse(encodeHello('  Ada  '))).toEqual({ type: 'hello', displayName: 'Ada' })
  })

  it('encodeHello clamps an over-long name to the length cap (post-trim)', () => {
    const overCap = `  ${'a'.repeat(MAX_DISPLAY_NAME_LEN + 50)}  `
    const frame = JSON.parse(encodeHello(overCap)) as { type: string; displayName: string }
    expect(frame.type).toBe('hello')
    expect(frame.displayName).toBe('a'.repeat(MAX_DISPLAY_NAME_LEN))
    expect(frame.displayName.length).toBe(MAX_DISPLAY_NAME_LEN)
  })

  it('encodePing produces a bare ping frame', () => {
    expect(JSON.parse(encodePing())).toEqual({ type: 'ping' })
  })
})

describe('parseWorkspaceServerMsg', () => {
  it('decodes a roster frame with members', () => {
    const frame = {
      type: 'roster',
      members: [
        { id: 1, displayName: 'Ada', online: true },
        { id: 2, displayName: 'Bo', online: false },
      ],
    }
    expect(parseWorkspaceServerMsg(JSON.stringify(frame))).toEqual(frame)
  })

  it('decodes an empty roster frame', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'roster', members: [] }))).toEqual({
      type: 'roster',
      members: [],
    })
  })

  it('decodes a pong frame', () => {
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'pong' }))).toEqual({ type: 'pong' })
  })

  it('drops ill-typed member entries inside a roster, keeping the valid ones', () => {
    const raw = JSON.stringify({
      type: 'roster',
      members: [
        { id: 1, displayName: 'Ada', online: true },
        { id: 'x', displayName: 'Bad', online: true }, // bad id
        { id: 2, displayName: 3, online: true }, // bad name
        { id: 3, displayName: 'Cy', online: 'yes' }, // bad online
        { id: 4, displayName: 'Di', online: false },
      ],
    })
    expect(parseWorkspaceServerMsg(raw)).toEqual({
      type: 'roster',
      members: [
        { id: 1, displayName: 'Ada', online: true },
        { id: 4, displayName: 'Di', online: false },
      ],
    })
  })

  it('returns undefined for near-miss cases and never throws', () => {
    expect(parseWorkspaceServerMsg('{not json')).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'nope' }))).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'roster' }))).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify({ type: 'roster', members: 'x' }))).toBeUndefined()
    expect(parseWorkspaceServerMsg('')).toBeUndefined()
    expect(parseWorkspaceServerMsg(JSON.stringify(['roster']))).toBeUndefined()
  })
})
