/**
 * M2 chat live test: the per-conversation SSE stream through the relay.
 *
 * Creates a codebase-bound web conversation (or reuses one), opens its stream
 * through the /archon relay, dispatches a real message to the routing agent,
 * and expects at least one SSE frame (heartbeat or text) within the window.
 *
 * Requires a live Archon server with a working AI provider (the scratch server
 * on :3090 has claude). Run: node tests/chat-sse-live.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { handleRelay, archonBaseUrl } from '../lib/host/relay.js'

const baseUrl = archonBaseUrl()
console.log(`chat-sse-live: upstream ${baseUrl}`)

const server = createServer((req, res) => {
  void handleRelay(req, res, baseUrl)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const relayPort = server.address().port
const relay = (path) => `http://127.0.0.1:${relayPort}${path}`

// Pick the first codebase so the conversation is project-bound.
const codebases = await (await fetch(relay('/archon/api/codebases'), { signal: AbortSignal.timeout(8000) })).json()
assert.ok(Array.isArray(codebases) && codebases.length > 0, 'at least one registered codebase (register one first)')
const codebaseId = codebases[0].id

// Create a conversation.
const created = await (await fetch(relay('/archon/api/conversations'), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ codebaseId }),
  signal: AbortSignal.timeout(8000),
})).json()
assert.ok(created.conversationId, 'conversation created')
const convId = created.conversationId
console.log(`  ok: conversation ${convId} on codebase ${codebases[0].name}`)

// Open the per-conversation stream through the relay and read frames until a
// text/heartbeat frame arrives or the window closes.
const sawFrame = await new Promise((resolve, reject) => {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(); resolve(false) }, 30000)
  void (async () => {
    try {
      const res = await fetch(relay('/archon/api/stream/' + encodeURIComponent(convId)), { signal: controller.signal })
      assert.equal(res.status, 200, 'stream status 200')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // Dispatch a message while the stream is open.
      void fetch(relay('/archon/api/conversations/' + encodeURIComponent(convId) + '/message'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Reply with exactly: chat-sse-ok' }),
      }).catch(() => {})
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        if (buffer.indexOf('\n\n') !== -1) {
          clearTimeout(timer)
          controller.abort()
          resolve(true)
          break
        }
      }
      resolve(false)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })()
})
assert.ok(sawFrame, 'per-conversation SSE emitted a frame through the relay')
console.log('  ok: /archon/api/stream/{conversationId} relayed live chat frames')
console.log('chat-sse-live.mjs: OK — M2 per-conversation stream verified')

server.close()
