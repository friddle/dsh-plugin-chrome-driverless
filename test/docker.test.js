import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { buildRunArgv, ContainerSupervisor, resolveDataDir, runOnce } from '../lib/docker.js'

/** A spawner that answers each command from a script, recording every argv. */
function fakeSpawn(script) {
  const calls = []
  const spawn = (spec) => {
    const argv = [...spec.argv]
    calls.push(argv)
    const answer = script(argv) ?? { code: 0, stdout: '', stderr: '' }
    const stdout = Readable.from(answer.stdout === undefined ? [] : [answer.stdout])
    const stderr = Readable.from(answer.stderr === undefined ? [] : [answer.stderr])
    // Resolve `done` only after both pipes drained: the real seam documents that
    // a child may exit before its streams are consumed, and a fake that settled
    // first would hide exactly that race.
    let open = 2
    const done = new Promise((resolve) => {
      const settle = () => {
        open -= 1
        if (open === 0) resolve({ exitCode: answer.code, signal: null })
      }
      stdout.on('end', settle)
      stderr.on('end', settle)
    })
    return { stdout, stderr, done }
  }
  return { spawn, calls }
}

/** A client whose health probe always succeeds unless told otherwise. */
function fakeClient({ healthy = true } = {}) {
  const waits = []
  return {
    waits,
    async waitForHealth() {
      waits.push(1)
      if (!healthy) throw new Error('not healthy')
      return { status: 'ok' }
    },
  }
}

test('the data volume lives under ~/.dsh unless overridden', () => {
  assert.equal(resolveDataDir(resolveConfig(), '/home/u'), '/home/u/.dsh/chrome-driverless')
  assert.equal(resolveDataDir(resolveConfig({ dataDir: '/srv/browser' }), '/home/u'), '/srv/browser')
})

test('docker run mounts the volume and keeps the API on the loopback', () => {
  const config = resolveConfig({ manageContainer: true, port: 9333, profile: 'work', proxy: 'http://10.0.0.2:7890' })
  const argv = buildRunArgv(config, '/srv/browser')

  assert.deepEqual(argv.slice(0, 2), ['run', '-d'])
  assert.ok(argv.includes('chrome-driverless'))
  assert.ok(argv.includes('127.0.0.1:9333:9223'), 'a browser with no auth must not be published widely')
  assert.ok(argv.includes('/srv/browser:/app/data'))
  assert.ok(argv.includes('BROWSER_DATA_DIR=/app/data'), 'without it, logins land in the container layer')
  assert.ok(argv.includes('PROFILE_NAME=work'))
  assert.ok(argv.includes('HTTP_PROXY=http://10.0.0.2:7890'))
  assert.ok(argv.includes('HTTPS_PROXY=http://10.0.0.2:7890'))
  assert.equal(argv.at(-1), config.image)
})

test('no proxy configured means no proxy variables', () => {
  const argv = buildRunArgv(resolveConfig({ manageContainer: true }), '/srv/browser')
  assert.equal(argv.some((entry) => entry.includes('_PROXY=')), false)
})

test('an unmanaged supervisor only probes the service', async () => {
  const { spawn, calls } = fakeSpawn(() => assert.fail('docker must not run'))
  const client = fakeClient()
  const supervisor = new ContainerSupervisor({
    spawn,
    config: resolveConfig(),
    client,
    log() {},
    warn() {},
  })

  assert.deepEqual(await supervisor.ensure(), { managed: false, state: 'external' })
  assert.equal(calls.length, 0)
  assert.equal(client.waits.length, 1)
})

test('a missing container is created and then awaited', async () => {
  const { spawn, calls } = fakeSpawn((argv) => {
    if (argv[1] === 'inspect') return { code: 1, stderr: 'Error: No such object: chrome-driverless' }
    return { code: 0, stdout: 'container-id\n' }
  })
  const client = fakeClient()
  const supervisor = new ContainerSupervisor({
    spawn,
    config: resolveConfig({ manageContainer: true }),
    client,
    log() {},
    warn() {},
  })

  assert.deepEqual(await supervisor.ensure(), { managed: true, state: 'created' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1], 'run')
  assert.equal(client.waits.length, 1)
})

test('an existing stopped container is started, not recreated', async () => {
  const { spawn, calls } = fakeSpawn((argv) => {
    if (argv[1] === 'inspect') return { code: 0, stdout: 'false\n' }
    return { code: 0 }
  })
  const supervisor = new ContainerSupervisor({
    spawn,
    config: resolveConfig({ manageContainer: true }),
    client: fakeClient(),
    log() {},
    warn() {},
  })

  assert.deepEqual(await supervisor.ensure(), { managed: true, state: 'restarted' })
  assert.deepEqual(calls[1].slice(1), ['start', 'chrome-driverless'])
})

test('a running container is left alone', async () => {
  const { spawn, calls } = fakeSpawn(() => ({ code: 0, stdout: 'true\n' }))
  const supervisor = new ContainerSupervisor({
    spawn,
    config: resolveConfig({ manageContainer: true }),
    client: fakeClient(),
    log() {},
    warn() {},
  })

  assert.deepEqual(await supervisor.ensure(), { managed: true, state: 'running' })
  assert.equal(calls.length, 1)
})

test('a failing docker run surfaces the daemon error', async () => {
  const { spawn } = fakeSpawn((argv) =>
    argv[1] === 'inspect' ? { code: 1, stderr: 'Error: No such object' } : { code: 125, stderr: 'docker: invalid reference format' },
  )
  const supervisor = new ContainerSupervisor({
    spawn,
    config: resolveConfig({ manageContainer: true }),
    client: fakeClient(),
    log() {},
    warn() {},
  })

  await assert.rejects(() => supervisor.ensure(), /docker run failed \(exit 125\).*invalid reference format/s)
})

test('dispose only stops the container when asked to own it', async () => {
  const stopped = []
  const { spawn } = fakeSpawn((argv) => {
    if (argv[1] === 'inspect') return { code: 0, stdout: 'true\n' }
    stopped.push(argv[1])
    return { code: 0 }
  })
  const config = resolveConfig({ manageContainer: true, stopOnDispose: true })
  const supervisor = new ContainerSupervisor({ spawn, config, client: fakeClient(), log() {}, warn() {} })

  await supervisor.dispose()
  assert.deepEqual(stopped, ['stop'])

  const keeper = new ContainerSupervisor({
    spawn,
    config: resolveConfig({ manageContainer: true }),
    client: fakeClient(),
    log() {},
    warn() {},
  })
  stopped.length = 0
  await keeper.dispose()
  assert.deepEqual(stopped, [], 'login state should survive a DSH restart by default')
})

test('runOnce collects both streams and reports the exit code', async () => {
  const { spawn } = fakeSpawn(() => ({ code: 3, stdout: 'out\n', stderr: 'err\n' }))
  const result = await runOnce(spawn, { argv: ['docker', 'logs', 'x'], timeoutMs: 1000 })
  assert.deepEqual(result, { code: 3, signal: null, stdout: 'out\n', stderr: 'err\n' })
})

test('runOnce reports a spawn failure rather than hanging', async () => {
  const failure = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  await assert.rejects(
    () => runOnce(() => {
      throw failure
    }, { argv: ['docker', 'ps'], timeoutMs: 100 }),
    /could not run docker: ENOENT/,
  )
})
