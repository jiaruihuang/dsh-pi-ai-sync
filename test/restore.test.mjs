import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureBackup, readCatalog, writeCatalogAtomic } from '../lib/catalog.js'
import { pluginStillReferenced, restoreAllCatalogs } from '../lib/restore.js'

test('restoreAllCatalogs restores every backed-up catalog', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ai-sync-restore-'))
  const file = path.join(dir, 'opencode.json')
  await writeCatalogAtomic(file, { g: { a: { id: 'a' } } })
  await ensureBackup(file, { g: { a: { id: 'a' } } }, { g: { a: { id: 'a' }, b: { id: 'b' } } })
  await writeCatalogAtomic(file, { g: { a: { id: 'a' }, b: { id: 'b' } } })

  const restored = await restoreAllCatalogs(dir)
  assert.deepEqual(restored, [file])
  const doc = await readCatalog(file)
  assert.deepEqual(Object.keys(doc.g), ['a'])
})

test('pluginStillReferenced scans profiles under DSH_HOME', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ai-sync-home-'))
  await fs.mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
  await fs.writeFile(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(await pluginStillReferenced(), false)
    await fs.writeFile(
      path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
      "- insert:\n    - id: pi-ai-sync\n      name: 'dsh-pi-ai-sync'\n",
    )
    assert.equal(await pluginStillReferenced(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
