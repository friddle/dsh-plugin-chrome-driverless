/**
 * Web panel — host half.
 *
 * Registers a small JSON surface under `/chrome-driverless/api` so the browser
 * half (`client.js`) can discover where the chrome-driverless UI lives and how
 * healthy it is, without hardcoding the configured port into browser code:
 *
 *   GET /chrome-driverless/api/info   → { ok, value: { baseUrl, reachable, health } }
 *   GET /chrome-driverless/api/ping   → { ok, value: { reachable } }   (cheap poll)
 *
 * The chrome-driverless page itself is embedded by the browser half with a
 * plain iframe pointing at `baseUrl` (the service serves `/` as its own
 * console: live viewport, URL bar, tabs, logs). No proxying: the service binds
 * loopback on the same machine the web GUI runs on, so the browser can reach
 * it directly.
 *
 * @module chrome-driverless/panel
 */

/** Route prefix this plugin owns on the harness webserver. */
export const PANEL_API_PREFIX = '/chrome-driverless/api'

/** Reverse-proxy prefix: the service's own console, same-origin for the GUI. */
export const PANEL_UI_PREFIX = '/chrome-driverless/ui'

/** Hop-by-hop / managed headers that must not be forwarded verbatim. */
const STRIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'expect', 'content-length',
])
const STRIP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'content-length', 'content-security-policy', 'strict-transport-security',
  'x-frame-options',
])

/**
 * Register the panel API routes. The webServer service may not exist in every
 * surface (CLI/TUI), so this is mounted through `ctx.inject` and simply stays
 * dormant where there is no web.
 *
 * Besides the JSON info surface, `/chrome-driverless/ui` reverse-proxies the
 * chrome-driverless console (its `/` page and every relative fetch it makes).
 * The iframe in the browser half uses the proxy path, not `baseUrl`, so the
 * panel keeps working when the GUI is reached from another machine — the
 * service itself stays loopback-only on the harness host.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ baseUrl: string, requestTimeoutMs: number }} settings - resolved config.
 * @param {(message: string) => void} log - logger.
 */
export function registerPanel(ctx, settings, log) {
  ctx.inject(['webServer'], (webCtx) => {
    const web = webCtx.webServer
    if (!web || typeof web.register !== 'function') return

    async function probe() {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(settings.requestTimeoutMs, 5000))
      try {
        const response = await fetch(`${settings.baseUrl}/health`, { signal: controller.signal })
        const body = await response.json().catch(() => null)
        return { reachable: response.ok, health: body }
      } catch (error) {
        return { reachable: false, health: null, error: error?.message ?? String(error) }
      } finally {
        clearTimeout(timer)
      }
    }

    ctx.effect(() =>
      web.register({
        kind: 'prefix',
        path: PANEL_API_PREFIX,
        handler: async (req, res) => {
          const path = String(req.url || '').split('?')[0].replace(/\/+$/, '')
          const method = path === `${PANEL_API_PREFIX}/ping` ? 'ping' : path === `${PANEL_API_PREFIX}/info` ? 'info' : null
          const send = (code, value) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(value))
          }
          if (!method || req.method !== 'GET') {
            send(404, { ok: false, error: { code: 'not_found', message: `unknown panel route ${path}` } })
            return
          }
          const state = await probe()
          const value =
            method === 'ping'
              ? { reachable: state.reachable }
              : { baseUrl: settings.baseUrl, ...state }
          send(200, { ok: true, value })
        },
      }),
    )

    ctx.effect(() =>
      web.register({
        kind: 'prefix',
        path: PANEL_UI_PREFIX,
        handler: async (req, res) => {
          const incoming = new URL(req.url ?? '/', 'http://dsh.invalid')
          let tail = incoming.pathname.slice(PANEL_UI_PREFIX.length) || '/'

          // Canonicalize ONLY the bare prefix (`/chrome-driverless/ui`), whose
          // relative fetches would otherwise resolve one level too high. Any
          // deeper path is passed through untouched — a slash-redirect there
          // turns the service's own /x → /x/ 307s into an infinite loop.
          if (tail === '') {
            res.writeHead(308, { location: PANEL_UI_PREFIX + '/' + incoming.search })
            res.end()
            return
          }
          const target = new URL(settings.baseUrl + tail + incoming.search)

          const headers = {}
          for (const [key, value] of Object.entries(req.headers)) {
            if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue
            headers[key] = value
          }
          // Identity only: HTML responses are rewritten (a <base> is injected),
          // and a gzipped body could not be modified in flight.
          headers['accept-encoding'] = 'identity'

          let body
          if (req.method !== 'GET' && req.method !== 'HEAD') body = req
          let upstream
          try {
            upstream = await fetch(target, {
              method: req.method,
              headers,
              body,
              duplex: body ? 'half' : undefined,
              redirect: 'manual',
            })
          } catch (error) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`chrome-driverless unreachable at ${settings.baseUrl}: ${error?.message ?? error}`)
            return
          }

          const responseHeaders = {}
          upstream.headers.forEach((value, key) => {
            if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return
            responseHeaders[key] = value
          })

          // The service pages use purely relative URLs (upstream change), so
          // no URL rewriting is needed here. Redirect Locations still get the
          // prefix so a service redirect cannot escape the proxy.
          if (upstream.status >= 300 && upstream.status < 400) {
            const location = responseHeaders.location
            if (typeof location === 'string' && location.startsWith('/')) {
              responseHeaders.location = PANEL_UI_PREFIX + location
            }
          }
          const contentType = String(upstream.headers.get('content-type') ?? '')
          if (upstream.status === 200 && contentType.includes('text/html')) {
            delete responseHeaders['content-length']
            // Belt and braces: a cached copy from an older deployment could
            // still reference root-absolute assets.
            responseHeaders['cache-control'] = 'no-store'
          }

          res.writeHead(upstream.status, responseHeaders)
          if (upstream.body) {
            const reader = upstream.body.getReader()
            try {
              for (;;) {
                const { done, value: chunk } = await reader.read()
                if (done) break
                if (!res.write(chunk)) {
                  await new Promise((resolve, reject) => {
                    res.once('drain', resolve)
                    res.once('error', reject)
                  })
                }
              }
            } catch {
              /* client went away mid-stream */
            } finally {
              reader.releaseLock()
            }
          }
          res.end()
        },
      }),
    )

    log(`[chrome-driverless] panel ready: ${PANEL_API_PREFIX} and ${PANEL_UI_PREFIX} → ${settings.baseUrl}`)
  })
}
