import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_BASE_URL, DEFAULTS, resolveConfig } from '../lib/config.js'

test('defaults target the local service and leave the container alone', () => {
  const config = resolveConfig()
  assert.equal(config.baseUrl, DEFAULT_BASE_URL)
  assert.equal(config.manageContainer, false)
  assert.equal(config.autoStart, true)
  assert.equal(config.stopOnDispose, false)
  assert.equal(config.port, 9223)
  assert.equal(config.profile, 'debug')
  assert.equal(config.proxy, '')
  assert.equal(config.dataDir, '')
})

test('a trailing slash is stripped so path joins do not double up', () => {
  assert.equal(resolveConfig({ baseUrl: 'http://10.0.0.5:9223///' }).baseUrl, 'http://10.0.0.5:9223')
})

test('unusable values fall back instead of poisoning every tool call', () => {
  const config = resolveConfig({
    baseUrl: '   ',
    port: 70000,
    requestTimeoutMs: -5,
    actionTimeoutMs: 0,
    startupTimeoutMs: 'soon',
    containerName: '',
    image: '   ',
    profile: '',
    dockerPath: '',
  })
  assert.equal(config.baseUrl, DEFAULTS.baseUrl)
  assert.equal(config.port, DEFAULTS.port)
  assert.equal(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs)
  assert.equal(config.actionTimeoutMs, DEFAULTS.actionTimeoutMs)
  assert.equal(config.startupTimeoutMs, DEFAULTS.startupTimeoutMs)
  assert.equal(config.containerName, DEFAULTS.containerName)
  assert.equal(config.image, DEFAULTS.image)
  assert.equal(config.profile, DEFAULTS.profile)
  assert.equal(config.dockerPath, DEFAULTS.dockerPath)
})

test('booleans are coerced from the row config, not from truthiness', () => {
  const config = resolveConfig({ manageContainer: 'yes', autoStart: 'no', stopOnDispose: 1 })
  assert.equal(config.manageContainer, false, 'a string is not a deliberate opt-in')
  assert.equal(config.stopOnDispose, false, 'nor is a number')
  assert.equal(config.autoStart, true, 'a default-on switch is only turned off by an explicit false')
  assert.equal(resolveConfig({ autoStart: false }).autoStart, false)
  assert.equal(resolveConfig({ manageContainer: true, stopOnDispose: true }).stopOnDispose, true)
})

test('the resolved config is frozen', () => {
  assert.ok(Object.isFrozen(resolveConfig()))
})
