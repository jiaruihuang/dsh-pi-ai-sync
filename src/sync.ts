/**
 * One sync round: the fusion.
 *
 * For each managed route:
 *  1. fetch the route's pi.dev listing;
 *  2. catalog leg — copy records the installed pi-ai catalog is missing into
 *     `data/<route>.json` (atomic + first-modification backup);
 *  3. settings leg — reconcile `llm-pi-ai.providers.<route>.models`.
 *
 * The catalog leg only takes effect after a dsh restart (the catalog is
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

/** Build the `mirror` target: addressable pi.dev entries + catalog-only ids. */
function mirrorTarget(
  entries: readonly PiDevEntry[],
  addressableIds: Set<string>,
  keepBuiltinOnly: boolean,
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
  if (keepBuiltinOnly) {
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
    const outcome: RouteOutcome = { route, catalogAdded: [], settings: 'kept' }
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
            const { next, added } = mergeNewEntries(route, doc, entries)
            if (added.length > 0) {
              await ensureBackup(file, doc, next)
              await writeCatalogAtomic(file, next)
              outcome.catalogAdded = added
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
          const target = mirrorTarget(entries, addressableIds, config.keepBuiltinOnly)
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
    if (outcome.catalogAdded.length > 0) {
      const head = outcome.catalogAdded.slice(0, 5).join(', ')
      const more = outcome.catalogAdded.length > 5 ? ` 等 ${outcome.catalogAdded.length} 个` : ''
      parts.push(`catalog +${outcome.catalogAdded.length}（${head}${more}）`)
    } else if (config.catalogSync) {
      parts.push('catalog 无新增')
    }
    parts.push(`settings: ${outcome.settings}`)
    if (outcome.error !== undefined) parts.push(`错误: ${outcome.error}`)
    return `${outcome.route}: ${parts.join('；')}`
  })
  if (restartNeeded) lines.push('⚠️ catalog 已更新，需重启 dsh 后新模型才可选')

  return { routes: outcomes, restartNeeded, text: lines.join('\n') }
}
