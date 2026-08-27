// End-to-end test: post an @agent mention into #general, wait for the kind='agent' reply.
import WebSocket from '/root/zmrng/node_modules/ws/index.js'

const ws = new WebSocket('ws://127.0.0.1:4500/ws/workspace')
const CHANNEL = 1
let done = false

const timer = setTimeout(() => {
  if (!done) { console.log('TIMEOUT: no agent reply within 120s'); process.exit(2) }
}, 120000)

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', displayName: 'zc-test' }))
  ws.send(JSON.stringify({ type: 'subscribe', channelId: CHANNEL }))
  ws.send(JSON.stringify({
    type: 'message', channelId: CHANNEL, author: 'zc',
    body: '@agent in one sentence, what is the zmrng team workspace for?',
  }))
  console.log('posted @agent mention, waiting for reply...')
})

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(String(raw)) } catch { return }
  if (msg.type === 'message' && msg.message) {
    const m = msg.message
    console.log(`[${m.kind}] ${m.author}: ${m.body}`)
    if (m.kind === 'agent') {
      done = true
      clearTimeout(timer)
      console.log('AGENT_REPLY_OK')
      ws.close()
      process.exit(0)
    }
  }
})

ws.on('error', (e) => { console.log('WS_ERROR', e.message); process.exit(3) })
