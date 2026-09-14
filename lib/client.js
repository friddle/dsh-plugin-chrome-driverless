/**
 * HTTP client for the chrome-driverless control API.
 *
 * The service speaks a JSON envelope rather than JSON-RPC:
 *
 *   POST /mcp  {"method": "pw/navigate", "params": {"url": "..."}}
 *   ->         {"result": {...}}   or   {"error": {"code": -1, "message": "..."}}
 *
 * The envelope carries no request id and there is no `initialize`/`tools/list`,
 * so this is deliberately *not* wired through `@deepseek-ai/dsh-mcp-client`:
 * that client speaks real MCP. Keeping the translation here is what lets the
 * DSH tools expose the service's own verbs (profiles, auth export, AI tasks)
 * instead of a lowest-common-denominator subset.
 *
 * @module chrome-driverless/client
 */

/** A failure reported by chrome-driverless, or by the transport in front of it. */
export class BrowserApiError extends Error {
  /**
   * @param {string} message - model-facing failure text.
   * @param {object} [details] - error facts.
   * @param {number} [details.code] - the service's own error code, when it sent one.
   * @param {number} [details.status] - HTTP status, when the transport failed.
   * @param {string} [details.method] - the control method that failed.
   */
  constructor(message, { code, status, method } = {}) {
    super(message)
    this.name = 'BrowserApiError'
    this.code = code
    this.status = status
    this.method = method
  }
}

export class ChromeDriverlessClient {
  #baseUrl
  #requestTimeoutMs
  #fetch

  /**
   * @param {object} options - client wiring.
   * @param {string} options.baseUrl - service root, no trailing slash.
   * @param {number} options.requestTimeoutMs - default request deadline.
   * @param {typeof fetch} [options.fetchImpl] - transport override for tests.
   */
  constructor({ baseUrl, requestTimeoutMs, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('ChromeDriverlessClient needs a fetch implementation')
    }
    this.#baseUrl = String(baseUrl).replace(/\/+$/u, '')
    this.#requestTimeoutMs = requestTimeoutMs
    this.#fetch = fetchImpl
  }

  /** @returns {string} the configured service root. */
  get baseUrl() {
    return this.#baseUrl
  }

  /**
   * Invoke one control method.
   *
   * @param {string} method - e.g. `pw/navigate`.
   * @param {object} [params] - method arguments; the service treats an absent value as `{}`.
   * @param {object} [options] - per-call overrides.
   * @param {number} [options.timeoutMs] - deadline for slow browser actions.
   * @returns {Promise<object>} the `result` object (never the envelope).
   * @throws {BrowserApiError} on a service-reported error or a transport failure.
   */
  async call(method, params = {}, { timeoutMs } = {}) {
    const payload = await this.#json(
      '/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params: params ?? {} }),
      },
      timeoutMs,
    )

    if (payload !== null && typeof payload === 'object' && payload.error) {
      const { code, message } = payload.error
      throw new BrowserApiError(`${method}: ${message ?? 'unknown browser error'}`, { code, method })
    }
    const result = payload?.result
    return result !== null && typeof result === 'object' ? result : {}
  }

  /** @returns {Promise<object>} the service's `/health` payload. */
  async health({ timeoutMs } = {}) {
    return this.#json('/health', { method: 'GET' }, timeoutMs)
  }

  /** @returns {Promise<object>} the service's `/debug/status` payload. */
  async status({ timeoutMs } = {}) {
    return this.#json('/debug/status', { method: 'GET' }, timeoutMs)
  }

  /** @returns {Promise<object>} the service's `/debug/logs` payload. */
  async logs({ timeoutMs } = {}) {
    return this.#json('/debug/logs', { method: 'GET' }, timeoutMs)
  }

  /**
   * Poll `/health` until the service answers or the deadline passes.
   *
   * A container that just started accepts connections before uvicorn is ready,
   * so "the port is open" is not "the browser service is usable".
   *
   * @param {object} options - wait policy.
   * @param {number} options.timeoutMs - overall budget.
   * @param {number} [options.intervalMs] - poll interval.
   * @param {() => void} [options.onWait] - called before each retry.
   * @returns {Promise<object>} the first successful health payload.
   */
  async waitForHealth({ timeoutMs, intervalMs = 1000, onWait } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError
    for (;;) {
      try {
        return await this.health({ timeoutMs: Math.min(5000, Math.max(1000, timeoutMs)) })
      } catch (error) {
        lastError = error
      }
      if (Date.now() + intervalMs > deadline) {
        throw new BrowserApiError(
          `chrome-driverless did not become healthy within ${timeoutMs}ms at ${this.#baseUrl}: ${lastError?.message ?? 'no response'}`,
          { method: 'health' },
        )
      }
      onWait?.(lastError)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  /**
   * One request, decoded as JSON, with the deadline applied.
   *
   * @param {string} path - service path.
   * @param {RequestInit} init - fetch init.
   * @param {number} [timeoutMs] - per-call deadline override.
   * @returns {Promise<any>} the decoded body.
   */
  async #json(path, init, timeoutMs) {
    const budget = timeoutMs ?? this.#requestTimeoutMs
    let response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(budget),
      })
    } catch (error) {
      // AbortSignal.timeout rejects with the platform's timeout reason; a
      // refused connection rejects with a TypeError. Both mean "not reachable".
      const reason = error?.name === 'TimeoutError' ? `timed out after ${budget}ms` : (error?.message ?? String(error))
      throw new BrowserApiError(`chrome-driverless ${init.method} ${path} failed: ${reason}`, { method: path })
    }

    if (!response.ok) {
      const body = await safeText(response)
      throw new BrowserApiError(
        `chrome-driverless ${init.method} ${path} returned HTTP ${response.status}${body === '' ? '' : `: ${body}`}`,
        { status: response.status, method: path },
      )
    }

    try {
      return await response.json()
    } catch (error) {
      throw new BrowserApiError(`chrome-driverless ${path} returned a non-JSON body: ${error.message}`, {
        method: path,
      })
    }
  }
}

/**
 * Read a response body as text without throwing on a truncated stream.
 *
 * @param {Response} response - the response to drain.
 * @returns {Promise<string>} the trimmed body, or '' when unreadable.
 */
async function safeText(response) {
  try {
    return (await response.text()).trim().slice(0, 500)
  } catch {
    return ''
  }
}
