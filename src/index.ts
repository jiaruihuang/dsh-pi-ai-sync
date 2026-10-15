/**
 * dsh-pi-ai-sync — cordis plugin entry.
 *
 * Fuses the two model-sync styles on the dsh 0.1.x line:
 *  - `dsh-opencode-go-models`' catalog layer (writes the installed pi-ai
 *    `dist/providers/data/<route>.json`), and
 *  - `dsh-model-sync`' settings layer (reconciles `llm-pi-ai.providers.<route>.models`).
 *
 * The settings namespace is `pi-ai-sync` (the spelling this dsh line uses for
 * plugin-owned config). See AGENTS.md for the architecture and the host facts
 * the implementation relies on.
 *
 * @module dsh-pi-ai-sync
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { pluginStillReferenced, restoreAllCatalogs } from './restore.ts'
import { DEFAULT_ROUTES, runRound } from './sync.ts'
import type { Logger, PluginConfig } from './types.ts'

export const name = 'dsh-pi-ai-sync'

/** The settings seam this plugin consumes (its own config namespace). */
export const inject = ['settings']

/** The settings namespace users edit in `settings.yaml`. */
const OWN_NS = 'pi-ai-sync'

/** The `pi-ai-sync` settings schema. Every key has a safe default. */
export const Config = z.object({
  /** Routes to sync; empty = opencode / opencode-go. */
  managedRoutes: z.array(z.string()).default([]),
  /** `unset` removes the route's models override; `mirror` rewrites it; `keep` leaves settings alone. */
  settingsMode: z.union(['unset', 'mirror', 'keep']).default('unset'),
  /** Maintain the installed pi-ai catalog files (the fusion's core layer). */
  catalogSync: z.boolean().default(true),
  /** Minutes between auto rounds; 0 = startup only. */
  intervalMinutes: z.number().step(1).min(0).default(240),
  /** Delay before the first auto round, so the adapter is ready. */
  startupDelaySeconds: z.number().step(1).min(0).default(5),
  /** Abort budget for one round's network request. */
  refreshTimeoutMs: z.number().step(1).min(1000).default(120000),
  /** Log the report when there was something to report. */
  syncNotify: z.boolean().default(true),
  /**
   * In `mirror` mode, also write the ids that exist only in the catalog.
   * Without this a catalog-only model drops out of the picker, because the
   * written `models` list replaces the catalog wholesale.
   */
  keepCatalogOnly: z.boolean().default(true),
})

/** The settings scope dsh hands back from `settings.register`. */
interface SettingsScope {
  get(): PluginConfig
  watch(callback: (next: PluginConfig) => void): void
}

/** The slice of `Context` this plugin uses, typed structurally. */
interface PluginRuntime {
  logger: Logger
  settings: {
    register(ns: string, schema: unknown): SettingsScope
  }
  get(name: string): unknown
  effect(callback: () => void | (() => void | Promise<void>)): void
  provide?(name: string, value: unknown): void
  inject?(deps: string[], callback: (ctx: PluginRuntime) => void): void
}

/** The `pi-ai-sync` service other plugins/UI can call. */
export interface PiAiSyncService {
  syncNow(): Promise<string>
}

export function apply(ctx: Context): void {
  const runtime = ctx as unknown as PluginRuntime
  const scope = runtime.settings.register(OWN_NS, Config)
  const logger = runtime.logger

  const syncNow = async (): Promise<string> => {
    const settings = runtime.get('settings')
    const report = await runRound(
      { logger, settings: settings as Parameters<typeof runRound>[0]['settings'] },
      scope.get(),
    )
    return report.text
  }

  const runAuto = (): void => {
    void syncNow().then(
      (text) => {
        if (scope.get().syncNotify) logger.info('pi-ai-sync:\n%s', text)
      },
      (error: unknown) => logger.warn('pi-ai-sync 自动同步失败: %o', error),
    )
  }

  let interval: ReturnType<typeof setInterval> | undefined
  let startup: ReturnType<typeof setTimeout> | undefined
  const armInterval = (minutes: number): void => {
    if (interval !== undefined) clearInterval(interval)
    interval = undefined
    if (minutes > 0) interval = setInterval(runAuto, minutes * 60_000)
  }

  ctx.effect(() => () => {
    if (interval !== undefined) clearInterval(interval)
    if (startup !== undefined) clearTimeout(startup)
  })

  const initial = scope.get()
  startup = setTimeout(runAuto, Math.max(0, initial.startupDelaySeconds ?? 5) * 1000)
  armInterval(initial.intervalMinutes ?? 240)
  scope.watch((next) => {
    armInterval(next?.intervalMinutes ?? 0)
    if (startup !== undefined) clearTimeout(startup)
    startup = setTimeout(runAuto, 1000)
  })

  if (typeof runtime.provide === 'function') {
    runtime.provide('piAiSync', { syncNow } satisfies PiAiSyncService)
  }

  // `/pi-ai-sync` — command registry is an optional peer; degrade when absent.
  if (typeof runtime.inject === 'function') {
    runtime.inject(['commands'], (cmdCtx) => {
      const commands = (cmdCtx as { commands?: { register(def: unknown): () => void } }).commands
      if (commands?.register === undefined) return
      cmdCtx.effect(() => commands.register({
        name: 'pi-ai-sync',
        description: 'Force one catalog + settings sync round from the pi.dev gateway (dsh-pi-ai-sync)',
        handler: async () => {
          try {
            return { kind: 'success', text: await syncNow() }
          } catch (error) {
            return { kind: 'error', text: `pi-ai-sync 失败: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      }))
    })
  }

  // Restore original catalogs on a real uninstall (never on HMR/restart).
  ctx.effect(() => async () => {
    try {
      if (!(await pluginStillReferenced())) await restoreAllCatalogs()
    } catch (error) {
      logger.warn('dsh-pi-ai-sync 卸载还原失败: %o', error)
    }
  })
}

export { DEFAULT_ROUTES }
