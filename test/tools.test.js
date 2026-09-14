import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { registerTools } from '../lib/tools.js'

/** A context whose tool registry records what was registered. */
function fakeContext() {
  const tools = []
  return {
    tools,
    ctx: { tools: { register: (tool) => tools.push(tool) } },
  }
}

/**
 * A stand-in for the service.
 *
 * Answers per method so a test states only the calls it cares about; anything
 * unscripted is a test bug and throws.
 */
function fakeClient(handlers = {}) {
  const calls = []
  return {
    calls,
    baseUrl: 'http://127.0.0.1:9223',
    async call(method, params) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (handler === undefined) throw new Error(`unscripted method ${method}`)
      return handler(params)
    },
    async health() {
      calls.push({ method: 'GET /health' })
      return handlers.health?.() ?? { status: 'ok' }
    },
    async status() {
      calls.push({ method: 'GET /debug/status' })
      return handlers.status?.() ?? { data_dir: '/app/data' }
    },
  }
}

/** A captured screenshot as the service returns it: base64 in a JSON field. */
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')

function setup({ handlers, config, attachments = true, supervisor } = {}) {
  const client = fakeClient(handlers)
  const stored = []
  const attachmentsService = attachments
    ? {
        async saveImage({ data, mediaType, name }) {
          stored.push({ bytes: data.byteLength, mediaType, name })
          return { attachmentId: 'att-1', mediaType, bytes: data.byteLength, width: 1440, height: 900, name }
        },
      }
    : undefined
  const { ctx, tools } = fakeContext()

  registerTools(ctx, {
    client,
    supervisor: supervisor ?? { managed: false, dataDir: '/home/u/.dsh/chrome-driverless', inspect: async () => ({ detail: 'running' }) },
    config: config ?? resolveConfig(),
    getAttachments: () => attachmentsService,
    log() {},
  })

  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { client, tools, byName, stored }
}

test('every advertised tool is registered with a valid schema', () => {
  const { tools } = setup({
    handlers: { 'pw/navigate': () => ({ url: 'https://x', image: PNG }) },
  })
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'browser_click',
      'browser_container',
      'browser_elements',
      'browser_evaluate',
      'browser_open',
      'browser_press',
      'browser_profile',
      'browser_save_auth',
      'browser_screenshot',
      'browser_scroll',
      'browser_status',
      'browser_tabs',
      'browser_type',
    ].sort(),
  )
})

test('browser_open returns the page text and a real image block', async () => {
  const { byName, client, stored } = setup({
    handlers: { 'pw/navigate': (params) => ({ status: 'navigated', url: params.url, image: PNG }) },
  })

  const value = await byName.get('browser_open').execute({ url: 'https://example.com/login' })
  assert.equal(value.url, 'https://example.com/login')
  assert.equal(value.image.attachmentId, 'att-1')
  assert.deepEqual(stored, [{ bytes: 8, mediaType: 'image/png', name: 'example.com-login.png' }])

  const blocks = byName.get('browser_open').output.render({ url: 'https://example.com/login' }, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /opened https:\/\/example\.com\/login/)
  assert.deepEqual(blocks[1], {
    type: 'image',
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 8, width: 1440, height: 900, name: 'example.com-login.png' },
  })

  assert.deepEqual(client.calls[0], { method: 'pw/navigate', params: { url: 'https://example.com/login' } })
})

test('undefined arguments are dropped so the service keeps its own defaults', async () => {
  const { byName, client } = setup({
    handlers: { 'pw/click': () => ({ url: 'https://x', image: PNG }) },
  })

  await byName.get('browser_click').execute({ text: 'Sign in' })
  assert.deepEqual(client.calls[0].params, { text: 'Sign in' })
})

test('a click on an explicit tab passes the index through', async () => {
  const { byName, client } = setup({
    handlers: { 'pw/click': () => ({ url: 'https://x', image: PNG }) },
  })
  await byName.get('browser_click').execute({ selector: '#go', tab: 2 })
  assert.deepEqual(client.calls[0].params, { selector: '#go', index: 2 })
})

test('browser_type presses Enter only when asked', async () => {
  const { byName, client } = setup({
    handlers: {
      'pw/type': () => ({ url: 'https://x', image: PNG }),
      'pw/key': () => ({ url: 'https://x', image: PNG }),
    },
  })

  await byName.get('browser_type').execute({ text: 'hello', selector: '#q' })
  assert.deepEqual(client.calls.map((call) => call.method), ['pw/type'])

  await byName.get('browser_type').execute({ text: 'hello', submit: true })
  assert.deepEqual(client.calls.map((call) => call.method), ['pw/type', 'pw/type', 'pw/key'])
  assert.deepEqual(client.calls[2].params, { key: 'Enter' })
})

test('a missing attachment service still returns usable text', async () => {
  const { byName } = setup({
    attachments: false,
    handlers: { 'pw/screenshot': () => ({ url: 'https://x', image: PNG }) },
  })

  const value = await byName.get('browser_screenshot').execute({})
  assert.equal(value.image, undefined)
  assert.equal(value.text, 'screenshot')
})

test('a refused screenshot does not fail the navigation', async () => {
  const client = fakeClient({ 'pw/navigate': () => ({ url: 'https://x', image: PNG }) })
  const { ctx, tools } = fakeContext()
  registerTools(ctx, {
    client,
    supervisor: { managed: false, dataDir: '/tmp', inspect: async () => ({ detail: 'running' }) },
    config: resolveConfig(),
    getAttachments: () => ({
      async saveImage() {
        throw new Error('IMAGE_TOO_LARGE')
      },
    }),
    log() {},
  })
  const tool = tools.find((entry) => entry.name === 'browser_open')

  const value = await tool.execute({ url: 'https://x' })
  assert.equal(value.image, undefined)
  assert.match(value.text, /screenshot rejected: IMAGE_TOO_LARGE/)
})

test('browser_elements lists selectors and coordinates as text', async () => {
  const { byName } = setup({
    handlers: {
      'pw/elements': () => ({
        url: 'https://x',
        elements: [
          { tag: 'input', id: 'user', name: '', type: 'text', text: '用户名', x: 100, y: 200, selector: '#user' },
        ],
      }),
    },
  })

  const value = await byName.get('browser_elements').execute({})
  assert.match(value.text, /input\/text #user @100,200 #user/)
  assert.match(value.text, /用户名/)
  assert.equal(value.image, undefined)
})

test('browser_elements says so when the page has nothing interactive', async () => {
  const { byName } = setup({ handlers: { 'pw/elements': () => ({ url: 'https://x', elements: [] }) } })
  const value = await byName.get('browser_elements').execute({})
  assert.match(value.text, /no interactive elements/)
})

test('browser_evaluate returns the JSON value of the expression', async () => {
  const { byName } = setup({
    handlers: { 'pw/evaluate': () => ({ value: { title: 'x' }, url: 'https://x' }) },
  })
  const value = await byName.get('browser_evaluate').execute({ expression: '() => document.title' })
  assert.deepEqual(value.value, { title: 'x' })
  const blocks = byName.get('browser_evaluate').output.render({}, value)
  assert.match(blocks[0].text, /"title":"x"/)
})

test('browser_tabs list marks the active tab', async () => {
  const { byName } = setup({
    handlers: {
      'pw/tabs': () => ({
        tabs: [
          { index: 0, url: 'https://a', title: 'A', active: true },
          { index: 1, url: 'https://b', title: 'B', active: false },
        ],
      }),
    },
  })
  const value = await byName.get('browser_tabs').execute({ action: 'list' })
  assert.match(value.text, /\* \[0\] A — https:\/\/a/)
  assert.match(value.text, /\[1\] B — https:\/\/b/)
})

test('browser_tabs select and close require an index', async () => {
  const { byName } = setup({ handlers: {} })
  await assert.rejects(() => byName.get('browser_tabs').execute({ action: 'select' }), /index is required/)
  await assert.rejects(() => byName.get('browser_tabs').execute({ action: 'close' }), /index is required/)
})

test('browser_profile refuses to switch without a name', async () => {
  const { byName } = setup({ handlers: {} })
  await assert.rejects(() => byName.get('browser_profile').execute({ action: 'set' }), /name is required/)
})

test('browser_profile set reports whether the profile has saved logins', async () => {
  const { byName } = setup({
    handlers: { 'pw/profile_set': () => ({ status: 'ok', profile: 'work', auth: true, url: 'https://x' }) },
  })
  const value = await byName.get('browser_profile').execute({ action: 'set', name: 'work' })
  assert.match(value.text, /profile work active \(has saved login state\)/)
})

test('browser_status reports an unreachable service instead of throwing', async () => {
  const { byName } = setup({
    handlers: {
      health: () => {
        throw new Error('chrome-driverless GET /health failed: fetch failed')
      },
    },
  })
  const value = await byName.get('browser_status').execute({})
  assert.match(value.text, /health: unreachable — .*fetch failed/)
  assert.match(value.text, /container: not managed by this plugin/)
})

test('browser_container refuses when the container is not ours to manage', async () => {
  const { byName } = setup({ handlers: {} })
  await assert.rejects(() => byName.get('browser_container').execute({ action: 'start' }), /manageContainer is false/)
})
