/**
 * Plugin configuration.
 *
 * Values arrive as the cordis row's `config` — the layer a profile's own
 * cordis.patch.yml targets by row id:
 *
 *   - id: chrome-driverless
 *     config:
 *       baseUrl: http://127.0.0.1:9223
 *       manageContainer: true
 *
 * `DEFAULTS` is duplicated as plain data on purpose. The schema below is what
 * DSH validates and renders; the plain object is what `resolveConfig` merges,
 * so a plugin loaded without the loader's schema pass still behaves the same.
 *
 * @module chrome-driverless/config
 */

import z from '@deepseek-ai/schemastery'

/** Where chrome-driverless listens once its container is up. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:9223'

/** The image CI publishes from friddle/chrome-driverless. */
export const DEFAULT_IMAGE = 'ghcr.io/friddle/chrome-driverless:latest'

/** Container name `manageContainer` creates and reuses. */
export const DEFAULT_CONTAINER_NAME = 'chrome-driverless'

/** Container port the service listens on; the host port is `port`. */
export const SERVICE_PORT = 9223

/** Every knob, with the value used when nothing overrides it. */
export const DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  requestTimeoutMs: 60000,
  actionTimeoutMs: 90000,
  manageContainer: false,
  autoStart: true,
  stopOnDispose: false,
  containerName: DEFAULT_CONTAINER_NAME,
  image: DEFAULT_IMAGE,
  port: SERVICE_PORT,
  dataDir: '',
  profile: 'debug',
  proxy: '',
  dockerPath: 'docker',
  startupTimeoutMs: 120000,
})

/** Schemastery schema for the `chrome-driverless` row. */
export const Config = z.object({
  baseUrl: z
    .string()
    .default(DEFAULTS.baseUrl)
    .description('chrome-driverless 服务地址。默认本机 9223；容器由本插件管理时保持默认即可。'),
  requestTimeoutMs: z
    .natural()
    .default(DEFAULTS.requestTimeoutMs)
    .description('单次控制接口（/mcp、/health）的请求超时毫秒数。'),
  actionTimeoutMs: z
    .natural()
    .default(DEFAULTS.actionTimeoutMs)
    .description('导航 / 点击 / 输入这类浏览器动作的请求超时毫秒数（页面慢时用得上）。'),
  manageContainer: z
    .boolean()
    .default(DEFAULTS.manageContainer)
    .description('由本插件启动/停止 chrome-driverless 容器（需要 docker CLI）。关掉则只连现成服务。'),
  autoStart: z
    .boolean()
    .default(DEFAULTS.autoStart)
    .description('manageContainer 打开时，插件加载即确保容器在跑。'),
  stopOnDispose: z
    .boolean()
    .default(DEFAULTS.stopOnDispose)
    .description('插件卸载时停掉容器。默认关：浏览器（含登录态）应该在 DSH 重启后继续可用。'),
  containerName: z
    .string()
    .default(DEFAULTS.containerName)
    .description('容器名。已存在时复用，不会重建。'),
  image: z
    .string()
    .default(DEFAULTS.image)
    .description('镜像地址，默认 ghcr.io/friddle/chrome-driverless:latest。国内可换自建镜像。'),
  port: z
    .natural()
    .default(DEFAULTS.port)
    .description('宿主机端口，映射到容器的 9223。默认只监听 127.0.0.1。'),
  dataDir: z
    .string()
    .default(DEFAULTS.dataDir)
    .description('持久化目录（profiles / auth.json / 浏览器 profile）。留空用 ~/.dsh/chrome-driverless。'),
  profile: z
    .string()
    .default(DEFAULTS.profile)
    .description('容器启动时激活的 profile 名；每个 profile 保存独立登录态。'),
  proxy: z
    .string()
    .default(DEFAULTS.proxy)
    .description('浏览器代理，例如 http://10.0.0.2:7890。留空表示直连，不写死任何代理地址。'),
  dockerPath: z
    .string()
    .default(DEFAULTS.dockerPath)
    .description('docker CLI 路径，默认取 PATH 上的 docker。'),
  startupTimeoutMs: z
    .natural()
    .default(DEFAULTS.startupTimeoutMs)
    .description('等待容器内服务 /health 就绪的超时毫秒数。'),
})

/**
 * Merge raw row config over the defaults and drop values that cannot work.
 *
 * A bad value here is expensive: a wrong `baseUrl` turns every tool call into a
 * connection error, and a wrong `port` starts a container nothing can reach. So
 * validation happens once, at load, instead of at first use.
 *
 * @param {object} [raw] - the row's config, possibly partial or untrusted.
 * @returns {typeof DEFAULTS} the effective configuration.
 */
export function resolveConfig(raw = {}) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) }

  return Object.freeze({
    baseUrl: trimUrl(merged.baseUrl) || DEFAULTS.baseUrl,
    requestTimeoutMs: toPositive(merged.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    actionTimeoutMs: toPositive(merged.actionTimeoutMs, DEFAULTS.actionTimeoutMs),
    manageContainer: merged.manageContainer === true,
    autoStart: merged.autoStart !== false,
    stopOnDispose: merged.stopOnDispose === true,
    containerName: nonEmpty(merged.containerName, DEFAULTS.containerName),
    image: nonEmpty(merged.image, DEFAULTS.image),
    port: toPort(merged.port, DEFAULTS.port),
    dataDir: typeof merged.dataDir === 'string' ? merged.dataDir.trim() : DEFAULTS.dataDir,
    profile: nonEmpty(merged.profile, DEFAULTS.profile),
    proxy: typeof merged.proxy === 'string' ? merged.proxy.trim() : DEFAULTS.proxy,
    dockerPath: nonEmpty(merged.dockerPath, DEFAULTS.dockerPath),
    startupTimeoutMs: toPositive(merged.startupTimeoutMs, DEFAULTS.startupTimeoutMs),
  })
}

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Strip trailing slashes so path joins never double up. */
function trimUrl(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/u, '')
}

function toPositive(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function toPort(value, fallback) {
  const num = Number(value)
  if (!Number.isInteger(num) || num < 1 || num > 65535) return fallback
  return num
}
