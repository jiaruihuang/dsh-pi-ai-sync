import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BACKUP_SUFFIX,
  catalogIds,
  ensureBackup,
  mergeNewEntries,
  readBackup,
  readCatalog,
  restoreCatalogFile,
  toCatalogEntry,
  updateExistingEntries,
  writeCatalogAtomic,
} from '../lib/catalog.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-ai-sync-'))
}

test('toCatalogEntry gates unusable records', () => {
  assert.equal(toCatalogEntry('opencode', { id: 'x' }), undefined) // no api
  assert.equal(toCatalogEntry('opencode', { id: '', api: 'openai-completions' }), undefined)
  assert.equal(toCatalogEntry('opencode', { id: 'x', api: 'openai-completions' }), undefined) // no ctx
  assert.equal(
    toCatalogEntry('opencode', { id: 'x', api: 'openai-completions', contextWindow: 0 }),
    undefined,
  )
})

test('toCatalogEntry fills defaults', () => {
  const entry = toCatalogEntry('opencode', {
    id: 'x', api: 'openai-completions', contextWindow: 1000, maxTokens: 100,
  })
  assert.equal(entry.provider, 'opencode')
  assert.equal(entry.name, 'x')
  assert.deepEqual(entry.input, ['text'])
  assert.equal(entry.reasoning, false)
  assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('mergeNewEntries is add-only and groups by api', () => {
  const doc = { 'openai-completions': { old: { id: 'old', api: 'openai-completions' } } }
  const { next, added } = mergeNewEntries('opencode', doc, [
    { id: 'old', api: 'openai-completions', contextWindow: 1 }, // already present
    { id: 'new-a', api: 'openai-completions', contextWindow: 1000 },
    { id: 'new-b', api: 'anthropic-messages', contextWindow: 2000 },
    { id: 'bad', api: 'openai-responses' }, // no capacity -> skipped
  ])
  assert.deepEqual(added, ['new-a', 'new-b'])
  assert.deepEqual(Object.keys(next['openai-completions']), ['old', 'new-a'])
  assert.deepEqual(Object.keys(next['anthropic-messages']), ['new-b'])
  // original untouched
  assert.deepEqual(Object.keys(doc['openai-completions']), ['old'])
})

test('catalog file round-trip, backup and restore', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'opencode.json')
  const original = { 'openai-completions': { a: { id: 'a' } } }
  await writeCatalogAtomic(file, original)
  assert.deepEqual(catalogIds(await readCatalog(file)), new Set(['a']))

  const ours = { 'openai-completions': { a: { id: 'a' }, b: { id: 'b' } } }
  await ensureBackup(file, original, ours)
  await writeCatalogAtomic(file, ours)
  assert.ok((await readBackup(file)) !== undefined)
  assert.deepEqual([...catalogIds(await readCatalog(file))].sort(), ['a', 'b'])

  const result = await restoreCatalogFile(file)
  assert.deepEqual(result, { restored: true, skipped: false })
  assert.deepEqual([...catalogIds(await readCatalog(file))], ['a'])
  assert.equal(await readBackup(file), undefined)
})

test('restore is skipped when the file was externally replaced', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'opencode.json')
  const original = { g: { a: { id: 'a' } } }
  await ensureBackup(file, original, { g: { a: { id: 'a' }, b: { id: 'b' } } })
  await writeCatalogAtomic(file, { g: { somethingElse: { id: 'somethingElse' } } })
  const result = await restoreCatalogFile(file)
  assert.deepEqual(result, { restored: false, skipped: true })
  assert.equal(await readBackup(file), undefined)
})

test('ensureBackup never overwrites an existing backup', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'opencode.json')
  await ensureBackup(file, { g: { first: { id: 'first' } } }, { g: { first: { id: 'first' } } })
  await ensureBackup(file, { g: { second: { id: 'second' } } }, { g: { second: { id: 'second' } } })
  const backup = await readBackup(file)
  assert.deepEqual(Object.keys(backup.original.g), ['first'])
  assert.ok(file.endsWith('opencode.json'))
  assert.ok(BACKUP_SUFFIX.length > 0)
})

test('updateExistingEntries applies only the fields pi.dev states', () => {
  const doc = {
    'openai-completions': {
      stale: {
        id: 'stale',
        name: 'stale',
        api: 'openai-completions',
        contextWindow: 8192,
        maxTokens: 4096,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        'local-only': 'keep me',
      },
    },
  }
  const { next, updated, moved } = updateExistingEntries('opencode-go', doc, [
    // what pi.dev states today; it says nothing about `cost` or `local-only`
    { id: 'stale', api: 'openai-completions', name: 'Step 5 Preview Free', contextWindow: 1000000, maxTokens: 65536 },
    { id: 'brand-new', api: 'openai-completions', contextWindow: 1000 }, // not ours to add
  ])

  assert.deepEqual(updated, ['stale'])
  assert.deepEqual(moved, [])
  const record = next['openai-completions'].stale
  assert.equal(record.name, 'Step 5 Preview Free')
  assert.equal(record.contextWindow, 1000000)
  assert.equal(record.maxTokens, 65536)
  // pi.dev stayed silent, so these survive untouched
  assert.deepEqual(record.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
  assert.equal(record['local-only'], 'keep me')
  // and no entry was invented
  assert.equal(next['openai-completions']['brand-new'], undefined)
  // the input document is not mutated
  assert.equal(doc['openai-completions'].stale.contextWindow, 8192)
})

test('updateExistingEntries does not call a re-ordered object a change', () => {
  const doc = {
    g: {
      m: {
        id: 'm',
        api: 'g',
        contextWindow: 1000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 1, output: 2 },
        input: ['text', 'image'],
      },
    },
  }
  // same values, different key order inside `cost` (the file's order is not ours)
  const { updated } = updateExistingEntries('r', doc, [{
    id: 'm',
    api: 'g',
    contextWindow: 1000,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    input: ['text', 'image'],
  }])
  assert.deepEqual(updated, [])
})

test('updateExistingEntries follows pi.dev across an api group', () => {
  const doc = {
    'openai-completions': { m: { id: 'm', api: 'openai-completions', contextWindow: 1000 } },
    'anthropic-messages': {},
  }
  const { next, updated, moved } = updateExistingEntries('r', doc, [
    { id: 'm', api: 'openai-responses', contextWindow: 2000 },
  ])
  assert.deepEqual(updated, ['m'])
  assert.deepEqual(moved, ['m'])
  assert.deepEqual(Object.keys(next['openai-completions']), [])
  assert.deepEqual(Object.keys(next['openai-responses']), ['m'])
  assert.equal(next['openai-responses'].m.api, 'openai-responses')
  assert.equal(next['openai-responses'].m.contextWindow, 2000)
})
