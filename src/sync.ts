/**
 * One sync round: the fusion.
 *
 * For each managed route:
 *  1. fetch the route's pi.dev listing;
 *  2. catalog layer — copy records the installed pi-ai catalog is missing into
 *     `data/<route>.json` (atomic + first-modification backup), and, when
 *     `updateExistingModels` is on, refresh the records it already has;
 *  3. settings layer — reconcile `llm-pi-ai.providers.<route>.models`.
 *
 * The catalog layer only takes effect after a dsh restart (the catalog is
 * imported into memory at boot), so a round that added models reports
 * `restartNeeded`.
 *
 * @module dsh-pi-ai-sync/sync
 */

import path from 'node:path'
import {
  catalogIds,
  ensureBackup,
  findCatalogDataDir,
  mergeNewEntries,
  readCatalog,
  updateExistingEntries,
  writeCatalogAtomic,
} from './catalog.ts'
import { fetchPiDevEntries, type PiDevFetchResult } from './pidev.ts'
import { unsetModels, writeModels } from './settings.ts'
import { translateEntry } from './translate.ts'
import type {
  Logger,
  PiDevEntry,
  PluginConfig,
  SettingsModelProfile,
  SettingsService,
} from './types.ts'

/** Routes synced when `managedRoutes` is empty. */
export const DEFAULT_ROUTES = ['opencode', 'opencode-go']

/** Injected dependencies (production wiring lives in index.ts). */
export interface RoundDeps {
  logger: Logger
  settings?: SettingsService
  /** Override the catalog directory (tests). */
  dataDir?: string
  /** Override the fetch (tests). */
  fetchEntries?: (route: string, timeoutMs: number) => Promise<PiDevFetchResult>
}

/** Per-route outcome of one round. */
export interface RouteOutcome {
  route: string
  catalogAdded: string[]
  /** Ids whose existing record was refreshed (only with `updateExistingModels`). */
  catalogUpdated: string[]
  settings: string
  error?: string
}

/** Whole-round report. */
export interface RoundReport {
  routes: RouteOutcome[]
  restartNeeded: boolean
  text: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Up to five ids, plus a count when there are more. */
function idList(ids: readonly string[]): string {
  const head = ids.slice(0, 5).join(', ')
  return ids.length > 5 ? `${head} 等 ${ids.length} 个` : head
}

/**
 * Build the `mirror` target.
 *
 * `models` replaces the served catalog wholesale, so an id left out of it
 * disappears from the picker. Two groups go in: pi.dev entries the installed
 * catalog can back, then — when `keepCatalogOnly` — the ids that exist *only*
 * in the catalog (promo/experimental models pi.dev has since dropped, and ids
 * the factory catalog shipped that pi.dev never listed). Those go in as bare
 * `{ id }`; dsh resolves their api/baseUrl/capacities from the catalog.
 */
function mirrorTarget(
  entries: readonly PiDevEntry[],
  addressableIds: Set<string>,
  keepCatalogOnly: boolean,
): SettingsModelProfile[] {
  const profiles: SettingsModelProfile[] = []
  const seen = new Set<string>()
  const piDevIds = new Set(entries.map((entry) => entry.id))
  for (const entry of entries) {
    if (!addressableIds.has(entry.id)) continue
    const profile = translateEntry(entry)
    if (profile === undefined) continue
    profiles.push(profile)
    seen.add(entry.id)
  }
  if (keepCatalogOnly) {
    for (const id of addressableIds) {
      if (piDevIds.has(id) || seen.has(id)) continue
      profiles.push({ id })
    }
  }
  profiles.sort((a, b) => a.id.localeCompare(b.id))
  return profiles
}

/**
 * Run one round.
 *
 * @param deps   injected services (settings / logger / test overrides)
 * @param config resolved plugin configuration
 */
export async function runRound(deps: RoundDeps, config: PluginConfig): Promise<RoundReport> {
  const routes = config.managedRoutes.length > 0 ? config.managedRoutes : DEFAULT_ROUTES
  const fetcher = deps.fetchEntries ?? fetchPiDevEntries
  const outcomes: RouteOutcome[] = []
  let restartNeeded = false

  let dataDir = deps.dataDir
  if (dataDir === undefined) {
    try {
      dataDir = await findCatalogDataDir()
    } catch (error) {
      deps.logger.debug('pi-ai catalog 不可用: %s', errorText(error))
    }
  }

  for (const route of routes) {
    const outcome: RouteOutcome = { route, catalogAdded: [], catalogUpdated: [], settings: 'kept' }
    try {
      let entries: PiDevEntry[] = []
      let absent = false
      if (config.catalogSync || config.settingsMode === 'mirror') {
        const fetched = await fetcher(route, config.refreshTimeoutMs)
        entries = fetched.entries
        absent = fetched.absent
      }

      let addressableIds: Set<string> | undefined
      if (dataDir !== undefined) {
        const file = path.join(dataDir, `${route}.json`)
        let doc: Record<string, Record<string, PiDevEntry>> | undefined
        try {
          doc = await readCatalog(file)
        } catch {
          // No catalog file for this route: it is not shipped by pi-ai.
        }
        if (doc !== undefined) {
          addressableIds = catalogIds(doc)
          if (config.catalogSync) {
            // Refresh what already exists first, so a record added in this same
            // round is never also reported as an update.
            let carried = doc
            let updated: string[] = []
            if (config.updateExistingModels) {
              const refreshed = updateExistingEntries(route, carried, entries)
              carried = refreshed.next
              updated = refreshed.updated
            }
            const { next, added } = mergeNewEntries(route, carried, entries)
            if (added.length > 0 || updated.length > 0) {
              await ensureBackup(file, doc, next)
              await writeCatalogAtomic(file, next)
              outcome.catalogAdded = added
              outcome.catalogUpdated = updated
              restartNeeded = true
            }
          }
        }
      }
      if (absent) outcome.error = 'pi.dev 无此路由'

      switch (config.settingsMode) {
        case 'keep':
          outcome.settings = 'kept'
          break
        case 'unset':
          outcome.settings = await unsetModels(deps.settings, route, deps.logger)
          break
        case 'mirror': {
          if (addressableIds === undefined) {
            outcome.settings = 'skipped'
            break
          }
          const target = mirrorTarget(entries, addressableIds, config.keepCatalogOnly)
          outcome.settings = await writeModels(deps.settings, route, target, deps.logger)
          break
        }
      }
    } catch (error) {
      outcome.error = errorText(error)
    }
    outcomes.push(outcome)
  }

  const lines = outcomes.map((outcome) => {
    const parts: string[] = []
    const changes: string[] = []
    if (outcome.catalogAdded.length > 0) {
      changes.push(`+${outcome.catalogAdded.length}（${idList(outcome.catalogAdded)}）`)
    }
    if (outcome.catalogUpdated.length > 0) {
      changes.push(`↻${outcome.catalogUpdated.length}（${idList(outcome.catalogUpdated)}）`)
    }
    if (changes.length > 0) parts.push(`catalog ${changes.join(' ')}`)
    else if (config.catalogSync) parts.push('catalog 无新增')
    parts.push(`settings: ${outcome.settings}`)
    if (outcome.error !== undefined) parts.push(`错误: ${outcome.error}`)
    return `${outcome.route}: ${parts.join('；')}`
  })
  if (restartNeeded) lines.push('⚠️ catalog 已变更，需重启 dsh 后才生效')

  return { routes: outcomes, restartNeeded, text: lines.join('\n') }
}
