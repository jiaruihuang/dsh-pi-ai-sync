/**
 * The pi-ai catalog leg.
 *
 * dsh resolves a configured model's wire protocol as
 * `route.api ?? catalog[id].api ?? sharedCatalogApi(route)`. A route whose
 * installed catalog mixes protocols (opencode: anthropic-messages +
 * openai-completions + openai-responses + google-generative-ai) has no shared
 * api, and dsh 0.1.5's settings model schema has no per-model `api` field —
 * so a model missing from the installed catalog is rejected outright. This
 * module fixes the root cause: it copies pi.dev's records into
 * `@earendil-works/pi-ai/dist/providers/data/<route>.json`, turning them into
 * base-matching entries dsh can address.
 *
 * Writes are atomic (temp file + rename) and a first-modification backup is
 * kept beside the catalog so an uninstall can restore it.
 *
 * @module dsh-pi-ai-sync/catalog
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { CatalogDocument, PiDevEntry } from './types.ts'

/** Suffix for the pre-modification backup sibling file. */
export const BACKUP_SUFFIX = '.pi-ai-sync-backup.json'

/** The `~/.dsh` home (honours `DSH_HOME`). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/**
 * Locate the installed pi-ai catalog directory (`dist/providers/data`).
 * Resolution goes through the package's own export map, then falls back to
 * the profiles install. `realpath` avoids replacing a package symlink.
 */
export async function findCatalogDataDir(): Promise<string> {
  const candidates: string[] = []
  try {
    const require = createRequire(import.meta.url)
    const probe = require.resolve('@earendil-works/pi-ai/providers/all')
    candidates.push(path.join(path.dirname(probe), 'data'))
  } catch {
    // pi-ai not resolvable from here; fall through to the profiles install.
  }
  candidates.push(path.join(
    dshHome(), 'profiles', 'node_modules', '@earendil-works', 'pi-ai',
    'dist', 'providers', 'data',
  ))
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate)
      await fs.access(real)
      return real
    } catch {
      // try the next candidate
    }
  }
  throw new Error('找不到 pi-ai catalog 目录（dist/providers/data）')
}

/** A usable capacity is a positive integer. */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Turn a pi.dev record into a catalog record. Returns `undefined` when the
 * record cannot be addressed or carries an unusable capacity — writing it
 * would only move the failure downstream.
 */
export function toCatalogEntry(route: string, entry: PiDevEntry): PiDevEntry | undefined {
  if (typeof entry.id !== 'string' || entry.id.length === 0) return undefined
  if (typeof entry.api !== 'string' || entry.api.length === 0) return undefined
  if (!isPositiveInt(entry.contextWindow)) return undefined
  if (entry.maxTokens !== undefined && !isPositiveInt(entry.maxTokens)) return undefined
  return {
    ...entry,
    id: entry.id,
    name: entry.name ?? entry.id,
    api: entry.api,
    provider: entry.provider ?? route,
    contextWindow: entry.contextWindow,
    input: Array.isArray(entry.input) ? entry.input : ['text'],
    cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: entry.reasoning ?? false,
  }
}

/** Every model id in a catalog document, across api groups. */
export function catalogIds(doc: CatalogDocument): Set<string> {
  const ids = new Set<string>()
  for (const group of Object.values(doc)) {
    for (const id of Object.keys(group)) ids.add(id)
  }
  return ids
}

/**
 * Pure merge: return a new document with the pi.dev records that the current
 * document is missing, grouped under each record's own `api`. Never modifies
 * or removes existing records.
 */
export function mergeNewEntries(
  route: string,
  doc: CatalogDocument,
  entries: readonly PiDevEntry[],
): { next: CatalogDocument; added: string[] } {
  const next = JSON.parse(JSON.stringify(doc)) as CatalogDocument
  const have = catalogIds(next)
  const added: string[] = []
  for (const entry of entries) {
    const item = toCatalogEntry(route, entry)
    if (item === undefined) continue
    if (have.has(item.id)) continue
    const api = item.api as string
    next[api] ??= {}
    next[api][item.id] = item
    have.add(item.id)
    added.push(item.id)
  }
  return { next, added }
}

/** Read and validate one catalog file. */
export async function readCatalog(file: string): Promise<CatalogDocument> {
  const doc: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`catalog 格式异常: ${file}`)
  }
  return doc as CatalogDocument
}

/** Atomic write: a reader only ever sees the old or the new complete file. */
export async function writeCatalogAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o644 })
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** The first-modification backup: `original` before, `ours` after. */
export interface CatalogBackup {
  original: CatalogDocument
  ours: CatalogDocument
}

/** Path of a catalog file's backup sibling. */
export function backupPathFor(file: string): string {
  return `${file}${BACKUP_SUFFIX}`
}

/** Read a backup, or `undefined` when absent/corrupt. */
export async function readBackup(file: string): Promise<CatalogBackup | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(backupPathFor(file), 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    const backup = parsed as Partial<CatalogBackup>
    if (backup.original === undefined || backup.ours === undefined) return undefined
    return backup as CatalogBackup
  } catch {
    return undefined
  }
}

/** Write the backup only when none exists yet. */
export async function ensureBackup(
  file: string,
  original: CatalogDocument,
  ours: CatalogDocument,
): Promise<void> {
  if ((await readBackup(file)) !== undefined) return
  await writeCatalogAtomic(backupPathFor(file), { original, ours })
}

/** Remove a backup if present. */
export async function dropBackup(file: string): Promise<void> {
  await fs.rm(backupPathFor(file), { force: true }).catch(() => {})
}

/**
 * Restore one catalog file from its backup.
 *
 * Guard: if the current file no longer contains every id we wrote (e.g. it was
 * wholly replaced by a pi-ai upgrade), skip the restore and drop the backup so
 * we never roll back someone else's newer data.
 */
export async function restoreCatalogFile(
  file: string,
): Promise<{ restored: boolean; skipped: boolean }> {
  const backup = await readBackup(file)
  if (backup === undefined) return { restored: false, skipped: false }
  let current: CatalogDocument
  try {
    current = await readCatalog(file)
  } catch {
    return { restored: false, skipped: true }
  }
  const ours = catalogIds(backup.ours)
  const currentIds = catalogIds(current)
  if (ours.size === 0 || ![...ours].every((id) => currentIds.has(id))) {
    await dropBackup(file)
    return { restored: false, skipped: true }
  }
  await writeCatalogAtomic(file, backup.original)
  await dropBackup(file)
  return { restored: true, skipped: false }
}
