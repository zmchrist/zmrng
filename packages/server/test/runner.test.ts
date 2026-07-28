import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  assistantText,
  summarizeTool,
  summarizeResult,
  partialDelta,
  parseUsage,
} from '../src/runner.js'

// Fed from REAL-shaped captured stream-json lines checked in under fixtures/.
// Each line is one `claude --output-format stream-json` event; we parse the
// file and drive the pure parser helpers with the actual objects, so a shape
// the runner cannot handle would fail here.
type Line = Record<string, unknown>
let lines: Line[]

function firstTextBlockToolUse(name: string): Record<string, unknown> {
  for (const l of lines) {
    const msg = l.message as { content?: unknown[] } | undefined
    for (const b of msg?.content ?? []) {
      const rb = b as Record<string, unknown>
      if (rb.type === 'tool_use' && rb.name === name) return rb.input as Record<string, unknown>
    }
  }
  throw new Error(`no tool_use fixture for ${name}`)
}

beforeAll(() => {
  const raw = readFileSync(new URL('./fixtures/stream-json.jsonl', import.meta.url), 'utf8')
  lines = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)
})

describe('assistantText', () => {
  it('concatenates text blocks of an assistant message', () => {
    const asst = lines.find(
      (l) =>
        l.type === 'assistant' &&
        Array.isArray((l.message as { content?: unknown[] })?.content) &&
        ((l.message as { content: Record<string, unknown>[] }).content[0]?.type === 'text'),
    )!
    expect(assistantText(asst)).toContain('ZMRNG_READY')
  })
  it('returns empty string for a tool-only assistant message', () => {
    const toolMsg = lines.find(
      (l) =>
        l.type === 'assistant' &&
        (l.message as { content: Record<string, unknown>[] }).content[0]?.type === 'tool_use',
    )!
    expect(assistantText(toolMsg)).toBe('')
  })
})

describe('summarizeTool', () => {
  it('summarizes a Bash call by its command', () => {
    expect(summarizeTool('Bash', firstTextBlockToolUse('Bash'))).toBe(
      'npm run typecheck && npm run lint',
    )
  })
  it('summarizes an Edit call by its file_path', () => {
    expect(summarizeTool('Edit', firstTextBlockToolUse('Edit'))).toBe(
      'packages/server/src/phases.ts',
    )
  })
  it('summarizes a Task spawn by its description', () => {
    expect(summarizeTool('Task', firstTextBlockToolUse('Task'))).toBe(
      'review the plan for soundness',
    )
  })
  it('returns empty string for missing input', () => {
    expect(summarizeTool('Bash', undefined)).toBe('')
  })
})

describe('summarizeResult', () => {
  it('summarizes an array tool_result content of text blocks', () => {
    const userMsg = lines.find(
      (l) =>
        l.type === 'user' &&
        Array.isArray(
          ((l.message as { content: Record<string, unknown>[] }).content[0] as { content?: unknown })
            ?.content,
        ),
    )!
    const block = (userMsg.message as { content: Record<string, unknown>[] }).content[0]
    expect(summarizeResult(block.content)).toContain('sound')
  })
  it('summarizes a plain-string tool_result content', () => {
    expect(summarizeResult('typecheck passed')).toBe('typecheck passed')
  })
})

describe('partialDelta', () => {
  it('extracts text from a content_block_delta stream_event', () => {
    const ev = lines.find(
      (l) =>
        l.type === 'stream_event' &&
        (l.event as { type?: string })?.type === 'content_block_delta',
    )!
    expect(partialDelta(ev)).toBe('Scoping ')
  })
  it('returns undefined for a non-text_delta stream_event', () => {
    const ev = lines.find(
      (l) =>
        l.type === 'stream_event' &&
        (l.event as { type?: string })?.type === 'content_block_start',
    )!
    expect(partialDelta(ev)).toBeUndefined()
  })
})

describe('parseUsage', () => {
  it('sums cache tokens and reads cost/turns from a result line', () => {
    const result = lines.find((l) => l.type === 'result' && l.usage)!
    expect(parseUsage(result)).toEqual({
      tokensIn: 1280,
      tokensOut: 356,
      tokensCache: 640, // 512 read + 128 creation
      costUsd: 0.0471,
      turns: 9,
    })
  })
  it('returns undefined for a result line with no usage (e.g. an error turn)', () => {
    const errResult = lines.find((l) => l.type === 'result' && l.is_error === true)!
    expect(parseUsage(errResult)).toBeUndefined()
  })
})
