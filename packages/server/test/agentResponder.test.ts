import { describe, it, expect, vi } from 'vitest'
import {
  detectMention,
  botAuthorFromHandle,
  buildAgentMessages,
  parseAgentReply,
  resolveBotAgent,
  AgentResponder,
} from '../src/agentResponder.js'
import type { AgentTarget, Message, MessageKind } from '../src/types.js'

// A no-op structured logger double.
function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function msg(partial: Partial<Message> & { body: string }): Message {
  return {
    id: partial.id ?? 1,
    channelId: partial.channelId ?? 7,
    author: partial.author ?? 'ada',
    body: partial.body,
    kind: partial.kind ?? 'human',
    createdAt: partial.createdAt ?? '2026-08-25T00:00:00.000Z',
  }
}

describe('detectMention', () => {
  it('triggers on a bare mention and mid-sentence mention', () => {
    expect(detectMention('@agent', '@agent')).toBe(true)
    expect(detectMention('hey @agent can you help', '@agent')).toBe(true)
    expect(detectMention('please @agent, look at this', '@agent')).toBe(true)
    expect(detectMention('done: @agent.', '@agent')).toBe(true)
  })

  it('does NOT trigger on a longer handle or an email local part', () => {
    expect(detectMention('@agentsmith is here', '@agent')).toBe(false)
    expect(detectMention('mail me at foo@agent.com', '@agent')).toBe(false)
    expect(detectMention('ping foo@agent', '@agent')).toBe(false)
  })

  it('does NOT trigger when unmentioned', () => {
    expect(detectMention('just a normal message', '@agent')).toBe(false)
    expect(detectMention('the agent is out today', '@agent')).toBe(false)
  })

  it('never matches on a blank handle', () => {
    expect(detectMention('@agent', '')).toBe(false)
    expect(detectMention('@agent', '   ')).toBe(false)
  })
})

describe('botAuthorFromHandle', () => {
  it('drops a single leading @', () => {
    expect(botAuthorFromHandle('@agent')).toBe('agent')
    expect(botAuthorFromHandle('  @bot  ')).toBe('bot')
    expect(botAuthorFromHandle('agent')).toBe('agent')
  })
})

describe('buildAgentMessages', () => {
  it('maps human posts to user (author-prefixed) and agent posts to assistant, in order', () => {
    const history: Message[] = [
      msg({ id: 1, author: 'ada', body: 'hello', kind: 'human' }),
      msg({ id: 2, author: 'agent', body: 'hi there', kind: 'agent' }),
      msg({ id: 3, author: 'bo', body: '@agent status?', kind: 'human' }),
    ]
    expect(buildAgentMessages(history)).toEqual([
      { role: 'user', content: 'ada: hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'bo: @agent status?' },
    ])
  })
})

describe('parseAgentReply', () => {
  it('extracts a reply from common JSON shapes', () => {
    expect(parseAgentReply(JSON.stringify({ reply: 'a' }))).toBe('a')
    expect(parseAgentReply(JSON.stringify({ content: 'b' }))).toBe('b')
    expect(parseAgentReply(JSON.stringify({ text: 'c' }))).toBe('c')
    expect(parseAgentReply(JSON.stringify({ message: 'd' }))).toBe('d')
  })

  it('falls back to raw text when not JSON, and trims', () => {
    expect(parseAgentReply('  plain answer  ')).toBe('plain answer')
    expect(parseAgentReply('')).toBe('')
  })
})

describe('resolveBotAgent', () => {
  const agents: AgentTarget[] = [
    { id: 'a1', label: 'One', url: 'http://one' },
    { id: 'a2', label: 'Two', url: 'http://two' },
  ]
  it('defaults to the first configured agent', () => {
    expect(resolveBotAgent(agents, '')).toEqual(agents[0])
  })
  it('honors an explicit configured id', () => {
    expect(resolveBotAgent(agents, 'a2')).toEqual(agents[1])
  })
  it('falls back to the first when the id is unknown', () => {
    expect(resolveBotAgent(agents, 'nope')).toEqual(agents[0])
  })
  it('returns undefined when no agents are configured', () => {
    expect(resolveBotAgent([], 'a1')).toBeUndefined()
  })
})

const BOT: AgentTarget = { id: 'bot', label: 'Bot', url: 'http://bot/chat', headers: { 'x-k': 'v' } }

function okResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

describe('AgentResponder.handleMention', () => {
  it('pulls, fetches with last-N context, and posts the reply as kind=agent', async () => {
    const history: Message[] = [
      msg({ id: 1, author: 'ada', body: 'hello', kind: 'human' }),
      msg({ id: 2, author: 'bo', body: '@agent what is up', kind: 'human' }),
    ]
    const listMessages = vi.fn(() => history)
    const post = vi.fn(
      (channelId: number, author: string, body: string, kind: MessageKind): Message =>
        msg({ id: 99, channelId, author, body, kind }),
    )
    const fetchFn = vi.fn(async () => okResponse(JSON.stringify({ reply: 'all good' })))
    const pullFn = vi.fn(async () => {})
    const log = fakeLog()

    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 20,
      checkoutPath: '/repo',
      listMessages,
      post,
      log,
      fetchFn: fetchFn as unknown as typeof fetch,
      pullFn,
    })

    await responder.handleMention(7)

    expect(pullFn).toHaveBeenCalledWith('/repo')
    expect(listMessages).toHaveBeenCalledWith(7, null, 20)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://bot/chat')
    expect((init.headers as Record<string, string>)['x-k']).toBe('v')
    const sent = JSON.parse(init.body as string) as {
      messages: { role: string; content: string }[]
      context: { channelId: number; checkoutPath: string }
    }
    expect(sent.messages).toEqual([
      { role: 'user', content: 'ada: hello' },
      { role: 'user', content: 'bo: @agent what is up' },
    ])
    expect(sent.context).toEqual({ channelId: 7, checkoutPath: '/repo' })
    expect(post).toHaveBeenCalledWith(7, 'agent', 'all good', 'agent')
  })

  it('does not throw and does not post when the fetch fails', async () => {
    const post = vi.fn()
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    const log = fakeLog()
    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 20,
      checkoutPath: '/repo',
      listMessages: () => [msg({ body: '@agent hi' })],
      post,
      log,
      fetchFn: fetchFn as unknown as typeof fetch,
      pullFn: async () => {},
    })

    await expect(responder.handleMention(7)).resolves.toBeUndefined()
    expect(post).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalled()
  })

  it('does not post on a non-OK status', async () => {
    const post = vi.fn()
    const fetchFn = vi.fn(async () => new Response('nope', { status: 500 }))
    const log = fakeLog()
    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 20,
      checkoutPath: '',
      listMessages: () => [msg({ body: '@agent hi' })],
      post,
      log,
      fetchFn: fetchFn as unknown as typeof fetch,
      pullFn: async () => {},
    })
    await responder.handleMention(7)
    expect(post).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalled()
  })

  it('does not post when the reply is empty', async () => {
    const post = vi.fn()
    const fetchFn = vi.fn(async () => okResponse('   '))
    const log = fakeLog()
    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 20,
      checkoutPath: '',
      listMessages: () => [msg({ body: '@agent hi' })],
      post,
      log,
      fetchFn: fetchFn as unknown as typeof fetch,
      pullFn: async () => {},
    })
    await responder.handleMention(7)
    expect(post).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
  })

  it('passes an abort signal and aborts a hung fetch after the timeout (no post)', async () => {
    const post = vi.fn()
    const log = fakeLog()
    // A fetch that never resolves on its own — it only settles when the
    // injected abort signal fires, mirroring a hung upstream.
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 5,
      checkoutPath: '',
      timeoutMs: 10,
      listMessages: () => [msg({ body: '@agent hi' })],
      post,
      log,
      fetchFn: fetchFn as unknown as typeof fetch,
      pullFn: async () => {},
    })
    await expect(responder.handleMention(7)).resolves.toBeUndefined()
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(post).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalled()
  })

  it('skips the pull gracefully when the checkout path is unset', async () => {
    const pullFn = vi.fn(async () => {})
    const fetchFn = vi.fn(async () => okResponse(JSON.stringify({ reply: 'ok' })))
    const post = vi.fn(() => msg({ body: 'ok', kind: 'agent' }))
    const log = fakeLog()
    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 5,
      checkoutPath: '',
      listMessages: () => [msg({ body: '@agent hi' })],
      post,
      log,
      fetchFn: fetchFn as unknown as typeof fetch,
      pullFn,
    })
    await responder.handleMention(7)
    expect(pullFn).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalled()
  })

  it('continues to answer when the pull itself fails (best-effort)', async () => {
    const pullFn = vi.fn(async () => {
      throw new Error('not a git repo')
    })
    const fetchFn = vi.fn(async () => okResponse(JSON.stringify({ reply: 'still here' })))
    const post = vi.fn(() => msg({ body: 'still here', kind: 'agent' }))
    const log = fakeLog()
    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 5,
      checkoutPath: '/bad',
      listMessages: () => [msg({ body: '@agent hi' })],
      post,
      log,
      fetchFn: fetchFn as unknown as typeof fetch,
      pullFn,
    })
    await responder.handleMention(7)
    expect(pullFn).toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(7, 'agent', 'still here', 'agent')
  })

  it('mentions() gates on the configured handle', () => {
    const responder = new AgentResponder({
      botAgent: BOT,
      botHandle: '@agent',
      scrollback: 5,
      checkoutPath: '',
      listMessages: () => [],
      post: vi.fn(),
      log: fakeLog(),
      fetchFn: (async () => okResponse('x')) as unknown as typeof fetch,
      pullFn: async () => {},
    })
    expect(responder.mentions('hi @agent')).toBe(true)
    expect(responder.mentions('hi @agentsmith')).toBe(false)
  })
})
