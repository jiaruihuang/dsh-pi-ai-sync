/**
 * Smoke boot: validate the compiled plugin contract and that `apply()` runs
 * against a structural cordis-shaped context without throwing, then dispose
 * cleanly. This is intentionally host-free (no dsh CLI, no network, no
 * ~/.dsh) so it can run anywhere `npm test` can.
 *
 * A full scratch-profile boot against a real dsh host is on the roadmap; see
 * AGENTS.md.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply, Config, name } from '../lib/index.js'

// Keep the smoke away from the real ~/.dsh: pluginStillReferenced() and
// restoreAllCatalogs() both key off DSH_HOME.
process.env.DSH_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ai-sync-smoke-'))

assert.equal(name, 'dsh-pi-ai-sync', 'plugin name')
assert.equal(typeof apply, 'function', 'apply is exported')
assert.equal(typeof Config, 'function', 'Config schema is exported')

const defaults = Config({})
assert.equal(defaults.settingsMode, 'unset')
assert.equal(defaults.intervalMinutes, 240)
assert.deepEqual(defaults.managedRoutes, [])

const disposers = []
const registered = []
let registeredNamespace
const fakeCtx = {
  logger: { info() {}, warn() {}, debug() {} },
  settings: {
    register(ns, schema) {
      registeredNamespace = ns
      return { get: () => schema({}), watch() {} }
    },
  },
  get: () => undefined,
  effect(callback) {
    const disposer = callback()
    disposers.push(typeof disposer === 'function' ? disposer : () => {})
  },
  provide(serviceName) {
    assert.equal(serviceName, 'piAiSync')
  },
  inject(_deps, callback) {
    callback({
      commands: {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      },
      effect(effectCallback) {
        const disposer = effectCallback()
        disposers.push(typeof disposer === 'function' ? disposer : () => {})
      },
    })
  },
}

apply(fakeCtx)

assert.equal(registeredNamespace, 'pi-ai-sync', 'settings namespace')
assert.deepEqual(registered.map((def) => def.name), ['pi-ai-sync'], 'command registered')

for (const dispose of disposers.reverse()) {
  await dispose()
}

console.log('smoke-boot: ok')
