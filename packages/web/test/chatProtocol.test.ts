import { describe, it, expect } from 'vitest'
import {
  encodeInput,
  encodeInterrupt,
  encodeStart,
  parseChatServerMsg,
} from '../src/chatProtocol'

describe('client encoders', () => {
  it('encodeStart produces a start frame with the chosen controls', () => {
    expect(JSON.parse(encodeStart('sonnet', 'medium', 'caveman-full'))).toEqual({
      type: 'start',
      model: 'sonnet',
      effort: 'medium',
      style: 'caveman-full',
    })
  })

  it('encodeInput produces an input frame carrying the text', () => {
    expect(JSON.parse(encodeInput('hello agent'))).toEqual({ type: 'input', text: 'hello agent' })
  })

  it('encodeInterrupt produces a bare interrupt frame', () => {
    expect(JSON.parse(encodeInterrupt())).toEqual({ type: 'interrupt' })
  })
})

describe('parseChatServerMsg', () => {
  it('decodes all seven server frames', () => {
    expect(parseChatServerMsg(JSON.stringify({ type: 'ready', sessionId: 's1' }))).toEqual({
      type: 'ready',
      sessionId: 's1',
    })
    expect(parseChatServerMsg(JSON.stringify({ type: 'partial', text: 'to' }))).toEqual({
      type: 'partial',
      text: 'to',
    })
    expect(parseChatServerMsg(JSON.stringify({ type: 'assistant', text: 'done' }))).toEqual({
      type: 'assistant',
      text: 'done',
    })
    expect(
      parseChatServerMsg(
        JSON.stringify({
          type: 'tool',
          name: 'Read',
          summary: 'file.ts',
          actor: 'main',
          isSubagent: false,
        }),
      ),
    ).toEqual({ type: 'tool', name: 'Read', summary: 'file.ts', actor: 'main', isSubagent: false })
    expect(parseChatServerMsg(JSON.stringify({ type: 'result', isError: false }))).toEqual({
      type: 'result',
      isError: false,
    })
    expect(parseChatServerMsg(JSON.stringify({ type: 'exit', code: 0 }))).toEqual({
      type: 'exit',
      code: 0,
    })
    expect(parseChatServerMsg(JSON.stringify({ type: 'exit', code: null }))).toEqual({
      type: 'exit',
      code: null,
    })
    expect(parseChatServerMsg(JSON.stringify({ type: 'error', text: 'boom' }))).toEqual({
      type: 'error',
      text: 'boom',
    })
  })

  it('returns undefined for near-miss cases and never throws', () => {
    expect(parseChatServerMsg('{not json')).toBeUndefined()
    expect(parseChatServerMsg(JSON.stringify({ type: 'nope' }))).toBeUndefined()
    expect(parseChatServerMsg(JSON.stringify({ type: 'partial', text: 5 }))).toBeUndefined()
    expect(parseChatServerMsg(JSON.stringify({ type: 'ready' }))).toBeUndefined()
    expect(parseChatServerMsg(JSON.stringify({ type: 'result', isError: 'no' }))).toBeUndefined()
    expect(parseChatServerMsg(JSON.stringify({ type: 'tool', name: 'Read' }))).toBeUndefined()
    expect(parseChatServerMsg(JSON.stringify({ type: 'exit', code: 'x' }))).toBeUndefined()
    expect(parseChatServerMsg('')).toBeUndefined()
    expect(parseChatServerMsg(JSON.stringify(['ready']))).toBeUndefined()
  })
})
