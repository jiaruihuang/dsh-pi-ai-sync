/**
 * Shared types for dsh-pi-ai-sync.
 *
 * The plugin deliberately depends on no dsh internals at the type level: it
 * consumes the `settings` service and a logger through the structural
 * interfaces below, so it keeps compiling (and loading) against hosts whose
 * `@deepseek-ai/dsh-*` closure is not installed in this repo.
 *
 * @module dsh-pi-ai-sync/types
 */

/** A model record as served by the pi.dev gateway and stored in the pi-ai catalog. */
export interface PiDevEntry {
  id: string
  name?: string
  api?: string
  provider?: string
  baseUrl?: string
  reasoning?: boolean
  input?: string[]
  cost?: Cost
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, unknown>
  [key: string]: unknown
}

/** Per-million-token pricing, the shape pi-ai's catalog uses. */
export interface Cost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One pi-ai catalog file: api protocol → model id → record. */
export type CatalogDocument = Record<string, Record<string, PiDevEntry>>

/** The subset of a settings model profile this plugin writes (see dsh-llm-pi-ai's catalog). */
export interface SettingsModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  reasoningEfforts?: Record<string, string | null> | false
  compat?: {
    thinkingFormat?: string
    supportsReasoningEffort?: boolean
  }
  [key: string]: unknown
}

/** One `settings.mutate` operation. */
export interface SettingsMutationOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** The descriptor `settings.describe()` returns for one namespace. */
export interface SettingsDescriptor {
  ns: string
  revision: number
  user?: Record<string, unknown>
  value?: Record<string, unknown>
}

/** The settings seam this plugin consumes (injected structurally, never imported). */
export interface SettingsService {
  describe(): SettingsDescriptor[]
  mutate(ns: string, ops: SettingsMutationOp[], expectedRevision?: number): Promise<void>
}

/** A cordis-style logger. */
export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  debug(format: string, ...args: unknown[]): void
}

/** User-facing plugin configuration (the `pi-ai-sync` settings namespace). */
export interface PluginConfig {
  /** Routes to sync; empty = DEFAULT_ROUTES. */
  managedRoutes: string[]
  /** `unset` removes the route's settings `models` override; `mirror` rewrites it; `keep` leaves settings alone. */
  settingsMode: 'unset' | 'mirror' | 'keep'
  /** Maintain the pi-ai catalog files (the fusion's core layer). */
  catalogSync: boolean
  /**
   * Refresh the records that already exist with the fields pi.dev states today.
   * Off by default: add-only is what keeps a partial pi.dev listing from
   * rewriting models you already have.
   */
  updateExistingModels: boolean
  /** Minutes between auto rounds; 0 = startup only. */
  intervalMinutes: number
  /** Delay before the first auto round. */
  startupDelaySeconds: number
  /** Abort budget for one round's network request. */
  refreshTimeoutMs: number
  /** Log the report when there was something to report. */
  syncNotify: boolean
  /** In `mirror` mode, also write the ids that exist only in the catalog. */
  keepCatalogOnly: boolean
}
