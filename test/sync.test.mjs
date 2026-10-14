import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runRound } from '../lib/sync.js'
import { readBackup, readCatalog } from '../lib/catalog.js'

const logger = { info() {}, warn() {}, debug() {} }

function baseConfig(overrides = {}) {
  return {
    managedRoutes: ['opencode'],
    settingsMode: 'unset',
    catalogSync: true,
    intervalMinutes: 240,
    startupDelaySeconds: 5,
    refreshTimeoutMs: 1000,
    syncNotify: true,
    keepBuiltinOnly: true,
    ...overrides,
  }
}

function fakeSettings(routes = {}) {
  const providerMap = JSON.parse(JSON.stringify(routes))
  let revision = 1
  return {
    routes: providerMap,
    describe: () => [{ ns: 'llm-pi-ai', revision, user: { providers: providerMap } }],
    mutate: async (ns, ops, expected) => {
      if (expected !== revision) {
        const error = new Error('conflict')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      for (const op of ops) {
        const route = op.path[1]
        const field = op.path[2]
        providerMap[route] ??= {}
        if (op.op === 'set') providerMap[route][field] = op.value
        else delete providerMap[route][field]
      }
      revision += 1
    },
  }
}

async function tempDataDir(doc) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ai-sync-round-'))
  if (doc !== undefined) await fs.writeFile(path.join(dir, 'opencode.json'), JSON.stringify(doc))
  return dir
}

test('a round adds catalog entries, backs up, and unsets the settings override', async () => {
  const dataDir = await tempDataDir({ 'openai-completions': { old: { id: 'old', api: 'openai-completions' } } })
  const settings = fakeSettings({ opencode: { models: [{ id: 'old' }] } })
  const report = await runRound({
    logger,
    settings,
    dataDir,
    fetchEntries: async () => ({
      absent: false,
      entries: [
        { id: 'old', api: 'openai-completions', contextWindow: 1000 },
        { id: 'new', api: 'anthropic-messages', contextWindow: 2000 },
      ],
    }),
  }, baseConfig())

  assert.equal(report.restartNeeded, true)
  assert.deepEqual(report.routes[0].catalogAdded, ['new'])
  assert.equal(report.routes[0].settings, 'unset')
  assert.match(report.text, /catalog \+1/)
  assert.match(report.text, /需重启/)

  const doc = await readCatalog(path.join(dataDir, 'opencode.json'))
  assert.deepEqual(Object.keys(doc['anthropic-messages']), ['new'])
  assert.ok((await readBackup(path.join(dataDir, 'opencode.json'))) !== undefined)
  assert.equal('models' in settings.routes.opencode, false)
})

test('mirror mode writes only addressable ids plus catalog-only ids', async () => {
  const dataDir = await tempDataDir({
    'openai-completions': {
      known: { id: 'known', api: 'openai-completions' },
      'catalog-only': { id: 'catalog-only', api: 'openai-completions' },
    },
  })
  const settings = fakeSettings({ opencode: {} })
  const report = await runRound({
    logger,
    settings,
    dataDir,
    fetchEntries: async () => ({
      absent: false,
      entries: [
        { id: 'known', api: 'openai-completions', contextWindow: 1000, name: 'Known' },
        { id: 'brand-new', api: 'openai-responses', contextWindow: 1000, name: 'Brand New' },
      ],
    }),
  }, baseConfig({ settingsMode: 'mirror' }))

  assert.equal(report.routes[0].settings, 'wrote')
  const ids = settings.routes.opencode.models.map((m) => m.id)
  // brand-new was catalog-added this round, so it is not addressable yet
  assert.deepEqual(ids, ['catalog-only', 'known'])
  assert.equal(report.restartNeeded, true)
})

test('a route without a catalog file degrades cleanly', async () => {
  const dataDir = await tempDataDir() // no opencode.json
  const settings = fakeSettings({ opencode: { models: [{ id: 'x' }] } })
  const report = await runRound({
    logger,
    settings,
    dataDir,
    fetchEntries: async () => ({ absent: false, entries: [] }),
  }, baseConfig({ settingsMode: 'mirror' }))

  assert.equal(report.routes[0].settings, 'skipped')
  assert.equal(report.restartNeeded, false)
})
