import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserApiError, ChromeDriverlessClient } from '../lib/client.js'

/** Build a client over a scripted fetch. */
function clientWith(handler, options = {}) {
  const calls = []
  const client = new ChromeDriverlessClient({
    baseUrl: 'http://127.0.0.1:9223',
    requestTimeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return handler(url, init)
    },
    ...options,
  })
  return { client, calls }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('call() posts the envelope and unwraps result', async () => {
  const { client, calls } = clientWith(() => json({ result: { url: 'https://example.com', image: 'AAAA' } }))
  const result = await client.call('pw/navigate', { url: 'https://example.com' })

  assert.deepEqual(result, { url: 'https://example.com', image: 'AAAA' })
  assert.equal(calls[0].url, 'http://127.0.0.1:9223/mcp')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    method: 'pw/navigate',
    params: { url: 'https://example.com' },
  })
})

test('an error envelope becomes a BrowserApiError carrying the service code', async () => {
  const { client } = clientWith(() => json({ error: { code: -2, message: 'url is required' } }))
  const error = await client.call('pw/navigate', {}).then(
    () => null,
    (thrown) => thrown,
  )

  assert.ok(error instanceof BrowserApiError)
  assert.equal(error.code, -2)
  assert.equal(error.method, 'pw/navigate')
  assert.match(error.message, /pw\/navigate: url is required/)
})

test('a non-2xx response reports the status and the body', async () => {
  const { client } = clientWith(() => new Response('boom', { status: 502 }))
  const error = await client.call('pw/screenshot').then(
    () => null,
    (thrown) => thrown,
  )
  assert.ok(error instanceof BrowserApiError)
  assert.equal(error.status, 502)
  assert.match(error.message, /HTTP 502: boom/)
})

test('a dead service reports the transport reason instead of a parse error', async () => {
  const { client } = clientWith(() => {
    throw new TypeError('fetch failed')
  })
  const error = await client.health().then(
    () => null,
    (thrown) => thrown,
  )
  assert.ok(error instanceof BrowserApiError)
  assert.match(error.message, /fetch failed/)
})

test('waitForHealth retries until the service answers', async () => {
  let attempts = 0
  const { client } = clientWith(() => {
    attempts += 1
    if (attempts < 3) throw new TypeError('ECONNREFUSED')
    return json({ status: 'ok' })
  })

  const waits = []
  const health = await client.waitForHealth({ timeoutMs: 5000, intervalMs: 1, onWait: () => waits.push(1) })
  assert.deepEqual(health, { status: 'ok' })
  assert.equal(attempts, 3)
  assert.equal(waits.length, 2)
})

test('waitForHealth gives up with the last transport failure in the message', async () => {
  const { client } = clientWith(() => {
    throw new TypeError('ECONNREFUSED')
  })
  const error = await client.waitForHealth({ timeoutMs: 20, intervalMs: 5 }).then(
    () => null,
    (thrown) => thrown,
  )
  assert.ok(error instanceof BrowserApiError)
  assert.match(error.message, /did not become healthy within 20ms/)
  assert.match(error.message, /ECONNREFUSED/)
})
