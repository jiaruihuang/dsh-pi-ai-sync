/**
 * Uninstall restore.
 *
 * A disposed plugin may just be reloading (HMR, profile switch, restart), so
 * restoration only runs when no profile still references this package — the
 * same fail-safe contract `dsh-opencode-go-models` uses.
 *
 * @module dsh-pi-ai-sync/restore
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { BACKUP_SUFFIX, dshHome, findCatalogDataDir, restoreCatalogFile } from './catalog.ts'

/** Restore every catalog file that still carries a backup. */
export async function restoreAllCatalogs(dataDir?: string): Promise<string[]> {
  const dir = dataDir ?? (await findCatalogDataDir())
  const names = await fs.readdir(dir)
  const restored: string[] = []
  for (const name of names) {
    if (!name.endsWith(BACKUP_SUFFIX)) continue
    const file = path.join(dir, name.slice(0, -BACKUP_SUFFIX.length))
    try {
      const result = await restoreCatalogFile(file)
      if (result.restored) restored.push(file)
    } catch {
      // One bad file must not block the others.
    }
  }
  return restored
}

/**
 * True when any profile's `cordis.patch.yml` or `package.json` still
 * references this package. Unreadable profiles are treated as "still
 * referenced" (fail-safe: never destroy data on uncertainty).
 */
export async function pluginStillReferenced(): Promise<boolean> {
  const base = path.join(dshHome(), 'profiles')
  let profiles: string[]
  try {
    profiles = await fs.readdir(base)
  } catch {
    return true
  }
  for (const profile of profiles) {
    for (const file of ['cordis.patch.yml', 'package.json']) {
      try {
        const content = await fs.readFile(path.join(base, profile, file), 'utf8')
        if (content.includes('dsh-pi-ai-sync') || content.includes('pi-ai-sync')) return true
      } catch {
        // File absent in this profile.
      }
    }
  }
  return false
}
