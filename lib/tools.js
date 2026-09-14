/**
 * The model-facing tools.
 *
 * Shape of the surface: one tool per verb the service already has, because the
 * alternative — a single `browser(action, params)` tool — makes the model guess
 * an enum and hides the arguments from the schema the model is trained to read.
 *
 * Every tool that moves the page returns the resulting screenshot as a real
 * image block, not a base64 blob in text. Vision is what makes a headed browser
 * worth driving from an agent at all: the model sees what the user sees, and
 * the coordinate-based fallbacks (`x`/`y`) become usable when a locator cannot
 * reach an element behind an overlay.
 *
 * @module chrome-driverless/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { describeScreenshot, imageBlock, saveScreenshot } from './images.js'

/** Canonical value of a stored screenshot, mirrored by every image-returning tool. */
const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

/** Canonical value shared by every tool that reports a page state. */
const PAGE_OUTCOME = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    url: { type: 'string' },
    title: { type: 'string' },
    image: IMAGE_SCHEMA,
  },
}

/** A tool's `tab` argument, repeated on every tool that acts on a page. */
const TAB_PARAMETER = {
  type: 'number',
  description: 'Target tab index as reported by browser_tabs. Defaults to the active tab.',
}

/**
 * Register every browser tool on the host context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with `tools`.
 * @param {object} deps - wiring.
 * @param {import('./client.js').ChromeDriverlessClient} deps.client - control API client.
 * @param {import('./docker.js').ContainerSupervisor} deps.supervisor - container owner.
 * @param {object} deps.config - resolved plugin config.
 * @param {() => object|undefined} deps.getAttachments - reads the attachment service lazily.
 * @param {(message: string) => void} deps.log - info sink.
 */
export function registerTools(ctx, { client, supervisor, config, getAttachments, log }) {
  const action = { timeoutMs: config.actionTimeoutMs }

  /** Store a service screenshot, tolerating a missing or refusing attachment service. */
  const shot = async (result, text) => {
    const outcome = { text, ...(result?.url ? { url: String(result.url) } : {}) }
    try {
      const ref = await saveScreenshot(getAttachments(), result?.image, nameFor(result))
      if (ref !== undefined) outcome.image = ref
    } catch (error) {
      outcome.text = `${text} (${describeScreenshot(undefined, `screenshot rejected: ${error.message}`)})`
    }
    return outcome
  }

  ctx.tools.register(
    pageTool({
      name: 'browser_open',
      description:
        'Open a URL in the shared Chrome and return the rendered page as a screenshot. ' +
        'This is a headed browser behind the chrome-driverless service: it keeps cookies and ' +
        'logins across calls, so signing in once (by hand or with browser_type) lasts.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute URL to open, e.g. https://example.com.' },
        tab: TAB_PARAMETER,
      },
      run: async (args) => {
        const result = await client.call('pw/navigate', pick({ url: args.url, index: args.tab }), action)
        return shot(result, `opened ${args.url}`)
      },
    }),
  )

  ctx.tools.register(
    pageTool({
      name: 'browser_screenshot',
      description:
        'Screenshot the current tab of the shared Chrome without changing it. ' +
        'Use it to see the result of browser_click / browser_type or to read a page the ' +
        'accessibility-oriented tools cannot describe.',
      parameters: { tab: TAB_PARAMETER },
      run: async (args) => {
        const result = await client.call('pw/screenshot', pick({ index: args.tab }), action)
        return shot(result, 'screenshot')
      },
    }),
  )

  ctx.tools.register(
    pageTool({
      name: 'browser_elements',
      description:
        'List the interactive elements of the current page with their selector and centre ' +
        'coordinates. Cheaper and more precise than a screenshot for finding a login form, ' +
        'a search box or a button: feed the returned selector to browser_click / browser_type.',
      parameters: { tab: TAB_PARAMETER },
      run: async (args) => {
        const result = await client.call('pw/elements', pick({ index: args.tab }), action)
        const elements = Array.isArray(result.elements) ? result.elements : []
        return {
          text: formatElements(elements),
          ...(result.url ? { url: String(result.url) } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    pageTool({
      name: 'browser_click',
      description:
        'Click in the current tab. Prefer `selector` from browser_elements, or `text` for a ' +
        'visible label; `x`/`y` are a fallback that reaches elements a locator cannot ' +
        '(overlays, hover-only menus, canvas). Returns a screenshot of the result.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector, e.g. #login or button[type=submit].' },
        text: { type: 'string', description: 'Visible text of the element, matched loosely.' },
        x: { type: 'number', description: 'Viewport x coordinate; pair with y.' },
        y: { type: 'number', description: 'Viewport y coordinate; pair with x.' },
        double: { type: 'boolean', description: 'Double-click instead of a single click.' },
        tab: TAB_PARAMETER,
      },
      run: async (args) => {
        const result = await client.call(
          'pw/click',
          pick({ selector: args.selector, text: args.text, x: args.x, y: args.y, double: args.double, index: args.tab }),
          action,
        )
        const what = args.selector ?? args.text ?? `${args.x},${args.y}`
        return shot(result, `clicked ${what}`)
      },
    }),
  )

  ctx.tools.register(
    pageTool({
      name: 'browser_type',
      description:
        'Type text into the current tab, optionally after clicking `selector` or `x`/`y` first. ' +
        'Set `submit` to press Enter afterwards. Returns a screenshot of the result.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to type.' },
        selector: { type: 'string', description: 'Field to click before typing; omit to type into the focused element.' },
        x: { type: 'number', description: 'Viewport x coordinate of the field; pair with y.' },
        y: { type: 'number', description: 'Viewport y coordinate of the field; pair with x.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        tab: TAB_PARAMETER,
      },
      run: async (args) => {
        const result = await client.call(
          'pw/type',
          pick({ selector: args.selector, x: args.x, y: args.y, text: args.text, index: args.tab }),
          action,
        )
        if (args.submit === true) {
          await client.call('pw/key', pick({ key: 'Enter', index: args.tab }), action)
        }
        return shot(result, `typed ${JSON.stringify(args.text)}${args.submit === true ? ' and pressed Enter' : ''}`)
      },
    }),
  )

  ctx.tools.register(
    pageTool({
      name: 'browser_press',
      description:
        'Press one key in the current tab, e.g. Enter, Escape, Tab, PageDown, or a single ' +
        'character. Returns a screenshot of the result.',
      parameters: {
        key: { type: 'string', required: true, description: 'Key name or single character.' },
        tab: TAB_PARAMETER,
      },
      run: async (args) => {
        const result = await client.call('pw/key', pick({ key: args.key, index: args.tab }), action)
        return shot(result, `pressed ${args.key}`)
      },
    }),
  )

  ctx.tools.register(
    pageTool({
      name: 'browser_scroll',
      description:
        'Scroll the current tab. `dx`/`dy` are wheel deltas (positive dy scrolls down); ' +
        '`x`/`y` optionally move the pointer to that viewport position first. Returns a screenshot.',
      parameters: {
        dx: { type: 'number', description: 'Horizontal wheel delta.' },
        dy: { type: 'number', description: 'Vertical wheel delta; positive scrolls down.' },
        x: { type: 'number', description: 'Viewport x to scroll at.' },
        y: { type: 'number', description: 'Viewport y to scroll at.' },
        tab: TAB_PARAMETER,
      },
      run: async (args) => {
        const result = await client.call(
          'pw/scroll_at',
          pick({ dx: args.dx ?? 0, dy: args.dy ?? 0, x: args.x, y: args.y, index: args.tab }),
          action,
        )
        return shot(result, `scrolled dx=${args.dx ?? 0} dy=${args.dy ?? 0}`)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'browser_evaluate',
      description:
        'Run JavaScript in the current page and return its JSON-serialised value. This is the ' +
        'escape hatch for reading state the other tools do not expose (a table, an app-specific ' +
        'store, a computed style). The expression runs in the page, not in Node.',
      parameters: {
        expression: {
          type: 'string',
          required: true,
          description: 'JavaScript expression or IIFE, e.g. () => document.title.',
        },
        tab: TAB_PARAMETER,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            value: { type: 'json' },
            url: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `${value.text}\n${stringify(value.value)}${value.url === undefined ? '' : `\nurl: ${value.url}`}`,
          },
        ],
      },
      async execute(args) {
        const result = await client.call('pw/evaluate', pick({ expression: args.expression, index: args.tab }), action)
        return {
          text: 'evaluated',
          value: result.value === undefined ? null : result.value,
          ...(result.url ? { url: String(result.url) } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'browser_tabs',
      description:
        'List, open, select or close tabs of the shared Chrome. Every other browser tool acts ' +
        'on the active tab, so select the tab you mean to work in.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'new', 'select', 'close'],
          description: 'Operation to perform.',
        },
        index: { type: 'number', description: 'Tab index from `list`; required for select and close.' },
        url: { type: 'string', description: 'URL to open for `new`; defaults to a blank tab.' },
      },
      output: {
        schema: PAGE_OUTCOME,
        render: pageRender,
      },
      async execute(args) {
        switch (args.action) {
          case 'list': {
            const result = await client.call('pw/tabs')
            const tabs = Array.isArray(result.tabs) ? result.tabs : []
            return {
              text:
                tabs.length === 0
                  ? 'no open tabs'
                  : tabs
                      .map(
                        (tab) =>
                          `${tab.active ? '*' : ' '} [${tab.index}] ${truncate(tab.title ?? '', 60)} — ${tab.url ?? ''}`,
                      )
                      .join('\n'),
            }
          }
          case 'new': {
            const result = await client.call('pw/new_tab', pick({ url: args.url }), action)
            return shot(result, `opened tab ${result.index ?? '?'}`)
          }
          case 'select': {
            requireIndex(args.index, 'select')
            const result = await client.call('pw/tab_select', { index: args.index }, action)
            return shot(result, `selected tab ${args.index}`)
          }
          case 'close': {
            requireIndex(args.index, 'close')
            await client.call('pw/tab_close', { index: args.index }, action)
            return { text: `closed tab ${args.index}` }
          }
          default:
            throw new Error(`browser_tabs: unknown action ${String(args.action)}`)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'browser_profile',
      description:
        'List or switch the browser profile. Each profile keeps its own cookies and login state ' +
        'on the container volume, so switching is how the agent works in a different account ' +
        'without logging out of the first. Switching restarts the browser context.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'set'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'Profile name for `set`; created when it does not exist.' },
      },
      output: {
        schema: PAGE_OUTCOME,
        render: pageRender,
      },
      async execute(args) {
        if (args.action === 'set') {
          if (typeof args.name !== 'string' || args.name.trim() === '') {
            throw new Error('browser_profile: name is required for action "set"')
          }
          const result = await client.call('pw/profile_set', { name: args.name.trim() }, action)
          const loggedIn = result.auth === true ? 'has saved login state' : 'no saved login state yet'
          return {
            text: `profile ${result.profile ?? args.name} active (${loggedIn})`,
            ...(result.url ? { url: String(result.url) } : {}),
          }
        }
        const result = await client.call('pw/profile_list')
        const profiles = Array.isArray(result.profiles) ? result.profiles : []
        return {
          text:
            profiles.length === 0
              ? `no profiles yet; active=${result.active ?? 'unknown'}`
              : `active=${result.active ?? 'unknown'}\n${profiles
                  .map((p) => `${p.active ? '*' : ' '} ${p.name}${p.logged_in ? ' (logged in)' : ''}`)
                  .join('\n')}`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'browser_save_auth',
      description:
        'Export the current profile’s login state (cookies and local storage) to auth.json on the ' +
        'container volume, so later runs — or a script connecting over CDP — start already signed in.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true }, path: { type: 'string' } },
        },
        render: (_args, value) => [
          { type: 'text', text: value.path === undefined ? value.text : `${value.text}: ${value.path}` },
        ],
      },
      async execute() {
        const result = await client.call('pw/save_auth', {}, action)
        return { text: 'login state saved', ...(result.path ? { path: String(result.path) } : {}) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'browser_status',
      description:
        'Report whether the Chrome service is reachable, which URL and profile it is on, and ' +
        'whether the container is running. Call this first when a browser tool reports a ' +
        'connection failure.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute() {
        const lines = [`service: ${client.baseUrl}`]
        let reachable = false
        try {
          const health = await client.health({ timeoutMs: 5000 })
          reachable = true
          lines.push(`health: ${stringify(health)}`)
        } catch (error) {
          lines.push(`health: unreachable — ${error.message}`)
        }
        if (reachable) {
          try {
            const status = await client.status({ timeoutMs: 10000 })
            lines.push(`state: ${stringify(status)}`)
          } catch (error) {
            lines.push(`state: ${error.message}`)
          }
        }
        if (supervisor.managed) {
          try {
            const state = await supervisor.inspect()
            lines.push(`container ${config.containerName}: ${state.detail} (data ${supervisor.dataDir})`)
          } catch (error) {
            lines.push(`container ${config.containerName}: ${error.message}`)
          }
        } else {
          lines.push('container: not managed by this plugin (manageContainer is false)')
        }
        return { text: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'browser_container',
      description:
        'Start, stop, restart or read the log of the chrome-driverless container. Only useful ' +
        'when the plugin manages the container; with manageContainer off these calls fail.',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'stop', 'restart', 'logs'], description: 'Operation to perform.' },
        lines: { type: 'number', description: 'How many log lines to return for action "logs" (default 80).' },
        create: { type: 'boolean', description: 'For action "start": create the container when it is missing (default true).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        if (!supervisor.managed) {
          throw new Error(
            'browser_container: this plugin does not manage the container (manageContainer is false). ' +
              'Set `manageContainer: true` on the chrome-driverless row, or manage the container outside DSH.',
          )
        }
        switch (args.action) {
          case 'start': {
            const result = await supervisor.ensure({ create: args.create !== false })
            return { text: `container ${result.state} (${config.containerName})` }
          }
          case 'stop': {
            const result = await supervisor.stop()
            if (result.code !== 0) throw new Error(`docker stop failed (exit ${result.code}): ${result.stderr.trim()}`)
            return { text: `container stopped (${config.containerName})` }
          }
          case 'restart': {
            const result = await supervisor.restart()
            if (result.code !== 0) throw new Error(`docker restart failed (exit ${result.code}): ${result.stderr.trim()}`)
            return { text: `container restarted (${config.containerName})` }
          }
          case 'logs': {
            const text = await supervisor.logs(args.lines === undefined ? 80 : Number(args.lines))
            return { text: text === '' ? '(no log output)' : text }
          }
          default:
            throw new Error(`browser_container: unknown action ${String(args.action)}`)
        }
      },
    }),
  )

  log(`[chrome-driverless] registered 13 browser tools against ${client.baseUrl}`)
}

/**
 * Build one page-state tool.
 *
 * @param {object} options - tool facts.
 * @param {string} options.name - tool name.
 * @param {string} options.description - model-facing description.
 * @param {object} options.parameters - parameter schema.
 * @param {(args: object) => Promise<object>} options.run - returns the canonical page outcome.
 * @returns {object} a tool definition.
 */
function pageTool({ name, description, parameters, run }) {
  return defineTool({
    name,
    description,
    parameters,
    output: { schema: PAGE_OUTCOME, render: pageRender },
    async execute(args, exec) {
      return run(args, exec)
    },
  })
}

/**
 * Render a page outcome as text plus, when present, the screenshot.
 *
 * @param {object} _args - validated arguments (unused).
 * @param {object} value - the canonical page outcome.
 * @returns {object[]} content blocks.
 */
function pageRender(_args, value) {
  const meta = [value.title === undefined ? '' : `title: ${value.title}`, value.url === undefined ? '' : `url: ${value.url}`]
    .filter((part) => part !== '')
    .join(' · ')
  return [
    { type: 'text', text: meta === '' ? value.text : `${value.text}\n${meta}` },
    ...(value.image === undefined ? [] : [imageBlock(value.image)]),
  ]
}

/**
 * Drop undefined keys so the service sees its own defaults rather than nulls.
 *
 * @param {object} source - candidate parameters.
 * @returns {object} the compacted parameters.
 */
function pick(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined))
}

/**
 * Render the element list as one line per element.
 *
 * @param {object[]} elements - the service's element records.
 * @returns {string} model-facing text.
 */
function formatElements(elements) {
  if (elements.length === 0) return 'no interactive elements found on this page'
  return elements
    .map((el) => {
      const label = truncate(String(el.text ?? ''), 40)
      const id = el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : '')
      const kind = [el.tag, el.type].filter(Boolean).join('/')
      return `${kind} ${id} @${el.x},${el.y} ${el.selector ?? ''} ${label === '' ? '' : `“${label}”`}`.trim()
    })
    .join('\n')
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function requireIndex(index, action) {
  if (!Number.isInteger(index)) throw new Error(`browser_tabs: index is required for action "${action}"`)
}

/** Name a stored screenshot after the page it shows, so traces stay readable. */
function nameFor(result) {
  try {
    const url = new URL(String(result?.url ?? ''))
    const slug = `${url.hostname}${url.pathname}`.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
    return `${slug === '' ? 'screenshot' : slug.slice(0, 60)}.png`
  } catch {
    return 'screenshot.png'
  }
}

function stringify(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  } catch {
    return String(value)
  }
}
