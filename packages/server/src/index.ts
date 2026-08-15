import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import type { WebSocket } from 'ws'
import { config } from './config.js'
import { Db } from './db.js'
import { WsHub } from './ws.js'
import { TaskManager } from './phases.js'
import { runPreflight } from './preflight.js'
import type { WsEvent, EffortLevel, CaveStyle } from './types.js'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STYLES: readonly CaveStyle[] = [
  'normal',
  'caveman-lite',
  'caveman-full',
  'caveman-ultra',
  'wenyan-full',
]

function asEffort(v: unknown): EffortLevel | undefined {
  return EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : undefined
}
function asStyle(v: unknown): CaveStyle | undefined {
  return STYLES.includes(v as CaveStyle) ? (v as CaveStyle) : undefined
}

const app = Fastify({ logger: true })
const db = new Db(config.dbPath)
const hub = new WsHub()
const manager = new TaskManager(db, (e: WsEvent) => hub.broadcast(e))

await app.register(websocket)

// ---- REST ----

app.get('/api/config', () => ({
  model: config.defaultModel,
  maxLanes: config.maxLanes,
  targetRepo: config.targetRepo,
  defaultRepoId: config.defaultRepoId,
  authMode:
    config.authMode === 'apikey'
      ? 'API key (ANTHROPIC_API_KEY billed per task)'
      : 'Max OAuth (ANTHROPIC_API_KEY stripped from workers)',
  authModeKind: config.authMode,
}))

app.get('/api/repos', () => config.repos)

// Fresh probe every call — advisory only, never a gate on Start.
app.get('/api/preflight', () => runPreflight())

app.get('/api/tasks', () => db.listTasks())

app.post('/api/tasks', (req, reply) => {
  const body = req.body as
    | {
        title?: string
        body?: string
        model?: string
        effort?: string
        style?: string
        repoId?: string
      }
    | undefined
  const title = body?.title?.trim()
  const taskBody = body?.body?.trim()
  if (!title || !taskBody) {
    return reply.code(400).send({ error: 'title and body are required' })
  }
  return manager.createTask(
    title,
    taskBody,
    body?.model,
    asEffort(body?.effort),
    asStyle(body?.style),
    body?.repoId,
  )
})

app.get('/api/tasks/:id/events', (req) => {
  const { id } = req.params as { id: string }
  return db.getEvents(id)
})

app.post('/api/tasks/:id/start', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.start(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/message', (req, reply) => {
  const { id } = req.params as { id: string }
  const body = req.body as { text?: string } | undefined
  const text = body?.text?.trim()
  if (!text) return reply.code(400).send({ error: 'text is required' })
  try {
    manager.message(id, text)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/resume', (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    manager.resume(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/interrupt', (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    manager.interrupt(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/done', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.done(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

app.post('/api/tasks/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string }
  try {
    await manager.cancel(id)
    return { ok: true }
  } catch (err) {
    return reply.code(400).send({ error: errMsg(err) })
  }
})

// ---- WebSocket ----

app.get('/ws', { websocket: true }, (socket: WebSocket) => {
  hub.add(socket)
  hub.send(socket, { type: 'snapshot', tasks: db.listTasks() })
})

// ---- static (production) ----

if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist })
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? ''
    if (url.startsWith('/api') || url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
}

// ---- lifecycle ----

function shutdown(signal: string): void {
  app.log.info({ signal }, 'shutting down — killing live claude workers')
  manager.shutdown()
  app.close().finally(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

try {
  await app.listen({ host: '0.0.0.0', port: config.port })
  for (const warning of config.repoWarnings) app.log.warn({ warning }, 'repo registry')
  app.log.info(
    {
      repos: config.repos.map((r) => r.id),
      defaultRepoId: config.defaultRepoId,
      maxLanes: config.maxLanes,
      model: config.defaultModel,
      dataDir: config.dataDir,
      port: config.port,
    },
    'zmrng server ready',
  )
} catch (err) {
  app.log.error({ err }, 'failed to start')
  process.exit(1)
}
