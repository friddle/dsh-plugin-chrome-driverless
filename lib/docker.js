/**
 * Container supervision: the Docker side of the plugin.
 *
 * The image is `friddle/chrome-driverless`: headed Chromium under Xvfb, a
 * Playwright persistent context, an MCP-style HTTP API on 9223, and
 * `VOLUME /app/data` holding every profile and `auth.json`. Login state is the
 * whole point of the container, so the volume is mounted from a host directory
 * instead of an anonymous one and the container is left running by default.
 *
 * Everything external is injected (`spawn`), so the whole lifecycle is testable
 * without a Docker daemon.
 *
 * @module chrome-driverless/docker
 */

import os from 'node:os'
import path from 'node:path'

/** Per-stream capture cap; docker's own diagnostics are far shorter. */
const MAX_CAPTURED_BYTES = 256 * 1024

/** Host directory used when `dataDir` is not configured. */
export const DEFAULT_DATA_DIR = path.join('.dsh', 'chrome-driverless')

/** Container-internal service port; the image's EXPOSE. */
export const CONTAINER_SERVICE_PORT = 9223

/** Container-internal data volume; the image's VOLUME. */
export const CONTAINER_DATA_DIR = '/app/data'

/**
 * Resolve the host directory backing the container's data volume.
 *
 * @param {object} config - resolved plugin config.
 * @param {string} [home] - home directory override for tests.
 * @returns {string} an absolute host path.
 */
export function resolveDataDir(config, home = os.homedir()) {
  if (typeof config.dataDir === 'string' && config.dataDir !== '') {
    return path.resolve(config.dataDir)
  }
  return path.join(home, DEFAULT_DATA_DIR)
}

/**
 * Build the `docker run` argv for one container.
 *
 * Kept as a pure function because the flags are the part that is easy to get
 * subtly wrong (a missing `BROWSER_DATA_DIR` silently writes login state into
 * the container layer, where the next `docker run` loses it).
 *
 * @param {object} config - resolved plugin config.
 * @param {string} dataDir - host path for the data volume.
 * @returns {string[]} argv after the docker executable.
 */
export function buildRunArgv(config, dataDir) {
  const argv = [
    'run',
    '-d',
    '--name',
    config.containerName,
    '--restart',
    'unless-stopped',
    // Bind to the loopback only: this API has no authentication of its own, so
    // publishing it on 0.0.0.0 would hand a logged-in browser to the network.
    '-p',
    `127.0.0.1:${config.port}:${CONTAINER_SERVICE_PORT}`,
    '-v',
    `${dataDir}:${CONTAINER_DATA_DIR}`,
    '-e',
    `BROWSER_DATA_DIR=${CONTAINER_DATA_DIR}`,
    '-e',
    `PROFILE_NAME=${config.profile}`,
  ]
  if (config.proxy !== '') {
    argv.push('-e', `HTTP_PROXY=${config.proxy}`, '-e', `HTTPS_PROXY=${config.proxy}`)
  }
  argv.push(config.image)
  return argv
}

/** Owns the chrome-driverless container's lifecycle. */
export class ContainerSupervisor {
  #spawn
  #config
  #client
  #log
  #warn

  /**
   * @param {object} options - wiring.
   * @param {(spec: object) => object} options.spawn - the subprocess spawner.
   * @param {object} options.config - resolved plugin config.
   * @param {import('./client.js').ChromeDriverlessClient} options.client - health probe.
   * @param {(message: string) => void} options.log - info sink.
   * @param {(message: string) => void} options.warn - warning sink.
   */
  constructor({ spawn, config, client, log, warn }) {
    if (typeof spawn !== 'function') throw new TypeError('ContainerSupervisor requires a spawn function')
    this.#spawn = spawn
    this.#config = config
    this.#client = client
    this.#log = log
    this.#warn = warn
  }

  /** @returns {string} the host directory mounted into the container. */
  get dataDir() {
    return resolveDataDir(this.#config)
  }

  /** @returns {boolean} whether this plugin is responsible for the container. */
  get managed() {
    return this.#config.manageContainer === true
  }

  /**
   * Report what the daemon knows about the container.
   *
   * @returns {Promise<{exists: boolean, running: boolean, detail: string}>} state.
   */
  async inspect() {
    const result = await this.#docker(['inspect', '-f', '{{.State.Running}}', this.#config.containerName], {
      timeoutMs: 15000,
    })
    if (result.code !== 0) {
      const missing = /no such (object|container)/iu.test(result.stderr)
      return { exists: false, running: false, detail: missing ? 'not created' : result.stderr.trim() }
    }
    const running = result.stdout.trim() === 'true'
    return { exists: true, running, detail: running ? 'running' : 'stopped' }
  }

  /**
   * Make sure a usable service answers at `baseUrl`.
   *
   * @param {object} [options] - policy overrides.
   * @param {boolean} [options.create] - create the container when it is missing.
   * @returns {Promise<{managed: boolean, state: string, detail?: string}>} what was done.
   */
  async ensure({ create = true } = {}) {
    if (!this.managed) {
      await this.#client.waitForHealth({ timeoutMs: this.#config.startupTimeoutMs })
      return { managed: false, state: 'external' }
    }

    const state = await this.inspect()
    if (!state.exists) {
      if (!create) return { managed: true, state: 'missing', detail: state.detail }
      const argv = buildRunArgv(this.#config, this.dataDir)
      this.#log(`[chrome-driverless] starting container ${this.#config.containerName} from ${this.#config.image}`)
      const started = await this.#docker(argv, { timeoutMs: this.#config.startupTimeoutMs })
      if (started.code !== 0) {
        throw new Error(`docker run failed (exit ${started.code}): ${tail(started.stderr) || tail(started.stdout)}`)
      }
      await this.#client.waitForHealth({
        timeoutMs: this.#config.startupTimeoutMs,
        onWait: () => this.#log('[chrome-driverless] waiting for /health'),
      })
      return { managed: true, state: 'created' }
    }

    if (!state.running) {
      const started = await this.#docker(['start', this.#config.containerName], { timeoutMs: 60000 })
      if (started.code !== 0) {
        throw new Error(`docker start failed (exit ${started.code}): ${tail(started.stderr)}`)
      }
    }

    await this.#client.waitForHealth({
      timeoutMs: this.#config.startupTimeoutMs,
      onWait: () => this.#log('[chrome-driverless] waiting for /health'),
    })
    return { managed: true, state: state.running ? 'running' : 'restarted' }
  }

  /**
   * Stop the container, leaving its data volume untouched.
   *
   * @returns {Promise<{code: number, stdout: string, stderr: string}>} docker's result.
   */
  async stop() {
    return this.#docker(['stop', this.#config.containerName], { timeoutMs: 60000 })
  }

  /**
   * Restart the container in place.
   *
   * @returns {Promise<{code: number, stdout: string, stderr: string}>} docker's result.
   */
  async restart() {
    const result = await this.#docker(['restart', this.#config.containerName], { timeoutMs: 90000 })
    if (result.code === 0) {
      await this.#client.waitForHealth({ timeoutMs: this.#config.startupTimeoutMs })
    }
    return result
  }

  /**
   * Read the tail of the container log.
   *
   * @param {number} [lines] - how many lines.
   * @returns {Promise<string>} the log tail (docker merges stdout and stderr).
   */
  async logs(lines = 80) {
    const result = await this.#docker(['logs', '--tail', String(lines), this.#config.containerName], {
      timeoutMs: 30000,
    })
    return `${result.stdout}${result.stderr}`.trim()
  }

  /** Stop the container when the operator asked the plugin to own that. */
  async dispose() {
    if (!this.managed || !this.#config.stopOnDispose) return
    try {
      const state = await this.inspect()
      if (!state.running) return
      const result = await this.stop()
      if (result.code !== 0) this.#warn(`[chrome-driverless] docker stop failed: ${tail(result.stderr)}`)
    } catch (error) {
      this.#warn(`[chrome-driverless] could not stop the container: ${error.message}`)
    }
  }

  /**
   * Run one docker command to completion.
   *
   * @param {string[]} args - argv after the docker executable.
   * @param {object} [options] - run policy.
   * @param {number} [options.timeoutMs] - deadline; the child is terminated on expiry.
   * @returns {Promise<{code: number, signal: string|null, stdout: string, stderr: string}>} outcome.
   */
  async #docker(args, { timeoutMs = 60000 } = {}) {
    return runOnce(this.#spawn, { argv: [this.#config.dockerPath, ...args], timeoutMs, cwd: os.tmpdir() })
  }
}

/**
 * Spawn one command and collect its streams to completion.
 *
 * @param {(spec: object) => object} spawn - the subprocess spawner.
 * @param {object} options - command facts.
 * @param {string[]} options.argv - executable plus arguments; never shell-interpreted.
 * @param {number} options.timeoutMs - deadline in milliseconds.
 * @param {string} [options.cwd] - working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - extra environment entries.
 * @returns {Promise<{code: number, signal: string|null, stdout: string, stderr: string}>} outcome.
 */
export async function runOnce(spawn, { argv, timeoutMs, cwd = process.cwd(), env }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let handle
  try {
    handle = spawn({
      argv,
      cwd,
      // Collect mode for both streams: the readers stay valid after exit, which
      // is what makes `docker logs` output survive a fast child.
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_CAPTURED_BYTES },
        stderr: { maxBytes: MAX_CAPTURED_BYTES },
      },
      graceMs: 5000,
      signal: controller.signal,
      ...(env === undefined ? {} : { env }),
    })
  } catch (error) {
    clearTimeout(timer)
    throw new Error(`could not run ${argv[0]}: ${error.message}`)
  }

  let stdout = ''
  let stderr = ''
  handle.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  handle.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  try {
    const outcome = await handle.done
    return {
      code: outcome.exitCode ?? -1,
      signal: outcome.signal ?? null,
      stdout: collectedText(handle.collected?.stdout) ?? stdout,
      stderr: collectedText(handle.collected?.stderr) ?? stderr,
    }
  } catch (error) {
    return { code: -1, signal: controller.signal.aborted ? 'SIGTERM' : null, stdout, stderr: `${stderr}${error.message}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read one collected stream after the child exited.
 *
 * The event-based accumulation above is the fallback: it races a child that
 * exits before its pipes drain, while the collected reader is defined to stay
 * valid past settlement.
 *
 * @param {object|undefined} reader - the handle's collected stream reader.
 * @returns {string|undefined} the retained text, or undefined when unavailable.
 */
function collectedText(reader) {
  if (reader === undefined || reader === null || typeof reader.readFrom !== 'function') return undefined
  try {
    const read = reader.readFrom(0)
    return typeof read?.text === 'string' ? read.text : undefined
  } catch {
    return undefined
  }
}

/**
 * Keep a command's diagnostic tail short enough to sit inside an error message.
 *
 * @param {string} text - raw stream text.
 * @returns {string} the last few lines.
 */
function tail(text) {
  return text.trim().split('\n').slice(-3).join(' | ').slice(0, 500)
}
