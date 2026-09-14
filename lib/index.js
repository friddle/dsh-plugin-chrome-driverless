/**
 * dsh-plugin-chrome-driverless — host half.
 *
 * Gives the agent a real, headed, logged-in browser without leaving DSH: the
 * Chrome lives in a Docker container (friddle/chrome-driverless) and this plugin
 * is the only thing that knows how to talk to it.
 *
 *   - `client.js` speaks the container's control API (`POST /mcp`), which is an
 *     MCP-*style* envelope rather than MCP, so it is not routed through
 *     `dsh-mcp-client`.
 *   - `docker.js` optionally owns the container: create it with the data volume
 *     mounted, wait for `/health`, stop it on request.
 *   - `images.js` turns the service's base64 screenshots into DSH attachments, so
 *     the model receives real image blocks.
 *   - `tools.js` exposes the verbs: open, screenshot, elements, click, type,
 *     press, scroll, evaluate, tabs, profile, save_auth, status, container.
 *
 * Why a plugin instead of the MCP client: the service's own verbs are the value
 * (profile switching, login-state export, AI tasks, the DevTools bridge), and a
 * generic MCP bridge would flatten them into whatever subset the server chose to
 * publish.
 *
 * @module dsh-plugin-chrome-driverless
 */

import { ChromeDriverlessClient } from './client.js'
import { Config, resolveConfig } from './config.js'
import { ContainerSupervisor } from './docker.js'
import { registerTools } from './tools.js'

/** Loader row identity. Must match the `name` in cordis.patch.yml. */
export const name = 'chrome-driverless'

/**
 * Host services this plugin needs before it can work.
 *
 * `subprocess` and `attachments` are deliberately NOT injected: not every
 * profile mounts them, and `inject` would then keep the plugin — and every
 * browser tool — from loading at all. They are picked up through `ctx.inject`
 * / `ctx.get` so the plugin still loads without a Docker CLI, and so a service
 * that arrives *after* this plugin does is still seen.
 */
export const inject = ['tools']

/** Schemastery config schema, surfaced in DSH's configuration UI. */
export { Config }

/**
 * Register the plugin's host-side contributions.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} [config] - this row's config; see config.js for the shape.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  const log = (message) => {
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(message)
    else console.log(message)
  }
  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }

  const client = new ChromeDriverlessClient({
    baseUrl: settings.baseUrl,
    requestTimeoutMs: settings.requestTimeoutMs,
  })

  // The subprocess service is how docker gets started; it may never appear.
  let subprocess

  const supervisor = new ContainerSupervisor({
    spawn: (spec) => {
      if (subprocess === undefined) {
        throw new Error(
          'chrome-driverless: this run has no subprocess service, so the Docker container cannot be managed',
        )
      }
      return subprocess.spawn(spec)
    },
    config: settings,
    client,
    log,
    warn,
  })

  registerTools(ctx, {
    client,
    supervisor,
    config: settings,
    // Read lazily: the attachment service can be mounted after this plugin, and
    // a latched `undefined` would silently disable every screenshot.
    getAttachments: () => ctx.get('attachments'),
    log,
  })

  ctx.inject(['subprocess'], (subCtx) => {
    subprocess = subCtx.subprocess
    if (settings.manageContainer && settings.autoStart) {
      void supervisor.ensure().then(
        (result) => log(`[chrome-driverless] container ${result.state} (${settings.containerName})`),
        (error) => warn(`[chrome-driverless] could not start the container: ${error.message}`),
      )
    }
    return () => {
      subprocess = undefined
    }
  })

  // Stopping the container is opt-in (stopOnDispose): the data volume holds the
  // logins, and a container that survives a DSH restart is the point.
  ctx.effect(() => () => {
    void supervisor.dispose()
  })

  log(
    `[chrome-driverless] loaded; baseUrl=${settings.baseUrl} manageContainer=${settings.manageContainer} ` +
      `image=${settings.image} profile=${settings.profile}` +
      (settings.proxy === '' ? '' : ` proxy=${settings.proxy}`),
  )

  if (settings.manageContainer && !settings.autoStart) {
    log('[chrome-driverless] autoStart is off: call browser_container with action "start" when you need it')
  }
  if (!settings.manageContainer) {
    log('[chrome-driverless] expecting an already-running chrome-driverless service; set manageContainer: true to let DSH own it')
  }
}
