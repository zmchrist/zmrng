import { describe, it, expect } from 'vitest'
import { parseStreamedText } from '../src/chat.js'

describe('parseStreamedText', () => {
  it('concatenates OpenAI-compatible SSE delta frames', () => {
    const raw =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: [DONE]\n\n'
    expect(parseStreamedText(raw)).toBe('Hello')
  })

  it('ignores role-only opening deltas', () => {
    const raw =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    expect(parseStreamedText(raw)).toBe('hi')
  })

  it('supports a plain {content} SSE shape', () => {
    const raw = 'data: {"content":"a"}\n\ndata: {"content":"b"}\n\n'
    expect(parseStreamedText(raw)).toBe('ab')
  })

  it('treats a non-SSE body as raw streamed text', () => {
    expect(parseStreamedText('just raw tokens here')).toBe('just raw tokens here')
  })

  it('uses the data payload verbatim when it is not JSON', () => {
    expect(parseStreamedText('data: hello\n\ndata: world\n\n')).toBe('helloworld')
  })
})
