import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  assistantText,
  summarizeTool,
  summarizeResult,
  partialDelta,
  parseUsage,
  buildUserMessage,
  sanitizeAttachments,
  Runner,
  type RunnerCallbacks,
} from '../src/runner.js'
import type { Attachment } from '../src/types.js'

// Redirect the `claude` binary to a trivial real Node process for the Runner
// exit/send test below — never spawns the actual claude CLI (hermetic).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (_cmd: string, _args: readonly string[], opts: unknown) =>
      actual.spawn(process.execPath, ['-e', 'process.exit(0)'], opts as never),
  }
})

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

// ---- multimodal outbound message (image/PDF drop/paste) ----

/** Pull the `content` block array out of a buildUserMessage() result. */
function contentOf(msg: object): Record<string, unknown>[] {
  const m = msg as { message?: { role?: string; content?: unknown[] } }
  return (m.message?.content ?? []) as Record<string, unknown>[]
}

const img = (over: Partial<Attachment> = {}): Attachment => ({
  kind: 'image',
  mediaType: 'image/png',
  dataBase64: 'aGVsbG8=',
  ...over,
})
const pdf = (over: Partial<Attachment> = {}): Attachment => ({
  kind: 'document',
  mediaType: 'application/pdf',
  dataBase64: 'JVBERi0=',
  ...over,
})

describe('buildUserMessage', () => {
  it('text-only → exactly one text block', () => {
    const content = contentOf(buildUserMessage('hello'))
    expect(content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('one image → image block then text block, in that order', () => {
    const content = contentOf(buildUserMessage('describe this', [img()]))
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: 'describe this' },
    ])
  })

  it('one PDF → document block shape', () => {
    const content = contentOf(buildUserMessage('read it', [pdf()]))
    expect(content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
    })
    expect(content.at(-1)).toEqual({ type: 'text', text: 'read it' })
  })

  it('mixed attachments all precede the single trailing text block', () => {
    const content = contentOf(buildUserMessage('t', [img(), pdf(), img({ mediaType: 'image/webp' })]))
    expect(content.map((b) => b.type)).toEqual(['image', 'document', 'image', 'text'])
  })
})

describe('sanitizeAttachments', () => {
  it('keeps allowed types and derives kind from the media type', () => {
    const out = sanitizeAttachments([
      { kind: 'image', mediaType: 'image/jpeg', dataBase64: 'YQ==' },
      { kind: 'image', mediaType: 'application/pdf', dataBase64: 'Yg==' }, // wrong kind → corrected
    ])
    expect(out).toEqual([
      { kind: 'image', mediaType: 'image/jpeg', dataBase64: 'YQ==' },
      { kind: 'document', mediaType: 'application/pdf', dataBase64: 'Yg==' },
    ])
  })

  it('drops disallowed media types and non-object / malformed entries', () => {
    expect(
      sanitizeAttachments([
        { mediaType: 'image/svg+xml', dataBase64: 'YQ==' },
        { mediaType: 'text/plain', dataBase64: 'YQ==' },
        { mediaType: 'image/png' }, // no data
        'nope',
        null,
        42,
      ]),
    ).toEqual([])
  })

  it('drops an oversized attachment (decoded > 8 MB)', () => {
    const huge = 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 1024) / 3) * 4)
    expect(sanitizeAttachments([{ mediaType: 'image/png', dataBase64: huge }])).toEqual([])
  })

  it('caps the count at MAX_ATTACHMENTS (10)', () => {
    const many = Array.from({ length: 15 }, () => ({ mediaType: 'image/png', dataBase64: 'YQ==' }))
    expect(sanitizeAttachments(many)).toHaveLength(10)
  })

  it('returns [] for a non-array and never throws', () => {
    expect(sanitizeAttachments(undefined)).toEqual([])
    expect(sanitizeAttachments('image')).toEqual([])
    expect(sanitizeAttachments({})).toEqual([])
  })

  it('preserves an optional name field', () => {
    expect(sanitizeAttachments([{ mediaType: 'image/gif', dataBase64: 'YQ==', name: 'cat.gif' }])).toEqual([
      { kind: 'image', mediaType: 'image/gif', dataBase64: 'YQ==', name: 'cat.gif' },
    ])
  })
})

describe('Runner.send after the child has exited', () => {
  // Regression test: sending a turn (or an interrupt) after the underlying
  // `claude` child has already exited must never crash the host process.
  // Writing to a dead child's stdin surfaces as an async EPIPE 'error' event
  // on the stream; with no listener on that stream, Node treats it as an
  // unhandled error and kills the whole server.
  function callbacks(onExit: () => void): RunnerCallbacks {
    return {
      onSession: () => {},
      onAssistantText: () => {},
      onPartial: () => {},
      onResult: () => {},
      onToolUse: () => {},
      onSubagentResult: () => {},
      onExit,
      onSpawnError: () => {},
    }
  }

  it('send() does not throw or crash the process once the child has exited', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      uncaught.push(err)
    }
    process.on('uncaughtException', onUncaught)

    try {
      const exited = new Promise<void>((resolve) => {
        const runner = new Runner(
          { cwd: process.cwd(), model: 'sonnet', effort: 'medium', systemPrompt: 'x' },
          callbacks(() => {
            expect(() => runner.send('hello')).not.toThrow()
            expect(() => runner.interrupt()).not.toThrow()
            resolve()
          }),
        )
      })
      await exited
      // The EPIPE from writing to a dead child's stdin surfaces asynchronously;
      // give it a couple of ticks to (not) blow up as an unhandled exception.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
