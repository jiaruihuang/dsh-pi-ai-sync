import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasModels,
  hasOverrides,
  profilesEqual,
  unsetModels,
  writeModels,
} from '../lib/settings.js'

const logger = { info() {}, warn() {}, debug() {} }

function fakeSettings(routes = {}) {
  const providerMap = { ...routes }
  const calls = []
  let revision = 1
  return {
    calls,
    routes: providerMap,
    describe: () => [{ ns: 'llm-pi-ai', revision, user: { providers: providerMap } }],
    mutate: async (ns, ops, expected) => {
      calls.push({ ns, ops, expected })
      if (expected !== revision) {
        const error = new Error('conflict')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      for (const op of ops) {
        if (op.path[0] !== 'providers') continue
        const route = op.path[1]
        const field = op.path[2]
        providerMap[route] ??= {}
        if (op.op === 'set') providerMap[route][field] = op.value
        else delete providerMap[route][field]
      }
      revision += 1
    },
    setRevision: (n) => { revision = n },
  }
}

test('hasModels / hasOverrides read the raw user segment', () => {
  const desc = {
    ns: 'llm-pi-ai',
    revision: 1,
    user: { providers: { opencode: { models: [], modelOverrides: { 'm-1': { contextWindow: 1 } } } } },
  }
  assert.equal(hasModels(desc, 'opencode'), true)
  assert.equal(hasModels(desc, 'other'), false)
  assert.equal(hasOverrides(desc, 'opencode'), true)
  assert.equal(hasOverrides(desc, 'other'), false)
})

test('profilesEqual compares deeply', () => {
  assert.equal(profilesEqual([{ id: 'a' }], [{ id: 'a' }]), true)
  assert.equal(profilesEqual([{ id: 'a' }], [{ id: 'a', name: 'x' }]), false)
})

test('unsetModels removes the models override and leaves modelOverrides alone', async () => {
  const settings = fakeSettings({ opencode: { models: [{ id: 'a' }], modelOverrides: { a: {} } } })
  assert.equal(await unsetModels(settings, 'opencode', logger), 'unset')
  assert.equal(settings.calls.length, 1)
  assert.deepEqual(settings.calls[0].ops, [{ op: 'unset', path: ['providers', 'opencode', 'models'] }])
  assert.equal('models' in settings.routes.opencode, false)
  assert.deepEqual(settings.routes.opencode.modelOverrides, { a: {} })
})

test('unsetModels is a no-op without a models key', async () => {
  const settings = fakeSettings({ opencode: {} })
  assert.equal(await unsetModels(settings, 'opencode', logger), 'no-models')
  assert.equal(settings.calls.length, 0)
})

test('writeModels refuses a route with non-empty modelOverrides', async () => {
  const settings = fakeSettings({ opencode: { modelOverrides: { a: { contextWindow: 1 } } } })
  assert.equal(await writeModels(settings, 'opencode', [{ id: 'a' }], logger), 'skipped-overrides')
  assert.equal(settings.calls.length, 0)
})

test('writeModels detects no-change and writes otherwise', async () => {
  const settings = fakeSettings({ opencode: { models: [{ id: 'a' }] } })
  assert.equal(await writeModels(settings, 'opencode', [{ id: 'a' }], logger), 'no-change')
  assert.equal(settings.calls.length, 0)

  assert.equal(await writeModels(settings, 'opencode', [{ id: 'a' }, { id: 'b' }], logger), 'wrote')
  assert.deepEqual(settings.routes.opencode.models, [{ id: 'a' }, { id: 'b' }])
})

test('a revision conflict is retried once', async () => {
  const settings = fakeSettings({ opencode: { models: [{ id: 'old' }] } })
  const originalMutate = settings.mutate
  let first = true
  settings.mutate = async (...args) => {
    if (first) {
      first = false
      settings.setRevision(99) // make the expected revision stale
      const error = new Error('conflict')
      error.code = 'SETTINGS_CONFLICT'
      const { calls } = settings
      calls.push({ ns: args[0], ops: args[1], expected: args[2] })
      throw error
    }
    return originalMutate(...args)
  }
  assert.equal(await writeModels(settings, 'opencode', [{ id: 'new' }], logger), 'wrote')
  assert.deepEqual(settings.routes.opencode.models, [{ id: 'new' }])
})
