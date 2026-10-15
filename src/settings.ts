/**
 * The settings layer.
 *
 * `settingsMode: 'unset'` (default) removes the route's `models` override so
 * the installed catalog — now enriched by the catalog layer — serves the route
 * directly. `settingsMode: 'mirror'` rewrites it from the pi.dev list
 * (dsh-model-sync's behavior); routes carrying non-empty `modelOverrides` are
 * skipped because folding and persisting those values is dsh-model-sync's
 * models-store job, not this plugin's.
 *
 * All writes go through the official `settings.mutate` seam with the
 * `SETTINGS_CONFLICT` retry-once contract.
 *
 * @module dsh-pi-ai-sync/settings
 */

import type {
  Logger,
  SettingsDescriptor,
  SettingsModelProfile,
  SettingsMutationOp,
  SettingsService,
} from './types.ts'

/** The llm-pi-ai namespace dsh's adapter registers. */
export const LLM_NS = 'llm-pi-ai'

/** Error code for a revision mismatch in `settings.mutate`. */
const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'

function findLlmDescriptor(settings: SettingsService): SettingsDescriptor | undefined {
  return settings.describe().find((descriptor) => descriptor.ns === LLM_NS)
}

/** The raw user-segment profile for one route, if present. */
export function getRouteUser(
  descriptor: SettingsDescriptor | undefined,
  route: string,
): Record<string, unknown> | undefined {
  const providers = descriptor?.user?.providers as Record<string, unknown> | undefined
  if (providers === undefined) return undefined
  const routeData = providers[route] as Record<string, unknown> | undefined
  return routeData
}

/** True when the raw user segment carries a `models` key. */
export function hasModels(
  descriptor: SettingsDescriptor | undefined,
  route: string,
): boolean {
  const routeData = getRouteUser(descriptor, route)
  return routeData !== undefined && Object.prototype.hasOwnProperty.call(routeData, 'models')
}

/** True when the raw user segment carries a non-empty `modelOverrides` dict. */
export function hasOverrides(
  descriptor: SettingsDescriptor | undefined,
  route: string,
): boolean {
  const overrides = getRouteUser(descriptor, route)?.modelOverrides
  return overrides !== null && typeof overrides === 'object' && Object.keys(overrides).length > 0
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA).sort()
  const keysB = Object.keys(objB).sort()
  if (keysA.length !== keysB.length) return false
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false
    if (!deepEqual(objA[keysA[i]], objB[keysB[i]])) return false
  }
  return true
}

/** Deep equality for two settings model arrays (both sorted by id). */
export function profilesEqual(current: unknown[], target: unknown[]): boolean {
  if (current.length !== target.length) return false
  for (let i = 0; i < current.length; i += 1) {
    if (!deepEqual(current[i], target[i])) return false
  }
  return true
}

/**
 * Run a mutate, retrying once on a revision conflict.
 * @returns true when the mutation landed
 */
async function mutateWithRetry(
  settings: SettingsService,
  ops: SettingsMutationOp[],
  logger: Logger,
): Promise<boolean> {
  const first = findLlmDescriptor(settings)
  if (first === undefined) return false
  try {
    await settings.mutate(LLM_NS, ops, first.revision)
    return true
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code !== SETTINGS_CONFLICT) {
      logger.warn('settings.mutate 被拒绝: %s', error instanceof Error ? error.message : String(error))
      return false
    }
    logger.info('settings 版本冲突，重试一次')
    const fresh = findLlmDescriptor(settings)
    if (fresh === undefined) return false
    try {
      await settings.mutate(LLM_NS, ops, fresh.revision)
      return true
    } catch (retryError) {
      logger.warn('settings.mutate 重试失败: %s', retryError instanceof Error ? retryError.message : String(retryError))
      return false
    }
  }
}

/** The result of one route's settings-layer action. */
export type SettingsOutcome =
  | 'unset'
  | 'no-models'
  | 'wrote'
  | 'no-change'
  | 'kept'
  | 'skipped-overrides'
  | 'skipped'

/**
 * Remove a route's `models` override. `modelOverrides` is deliberately left
 * alone: with no `models` list beside it, dsh happily serves the catalog and
 * applies the overrides on top.
 */
export async function unsetModels(
  settings: SettingsService | undefined,
  route: string,
  logger: Logger,
): Promise<SettingsOutcome> {
  if (settings === undefined) return 'skipped'
  const descriptor = findLlmDescriptor(settings)
  if (descriptor === undefined) return 'skipped'
  if (!hasModels(descriptor, route)) return 'no-models'
  const landed = await mutateWithRetry(
    settings,
    [{ op: 'unset', path: ['providers', route, 'models'] }],
    logger,
  )
  return landed ? 'unset' : 'skipped'
}

/**
 * Mirror the pi.dev target into the route's `models` list (dsh-model-sync
 * shape). Refuses routes with non-empty `modelOverrides`.
 */
export async function writeModels(
  settings: SettingsService | undefined,
  route: string,
  target: SettingsModelProfile[],
  logger: Logger,
): Promise<SettingsOutcome> {
  if (settings === undefined) return 'skipped'
  const descriptor = findLlmDescriptor(settings)
  if (descriptor === undefined) return 'skipped'
  if (hasOverrides(descriptor, route)) return 'skipped-overrides'

  const current = getRouteUser(descriptor, route)?.models
  if (Array.isArray(current) && profilesEqual(current, target)) return 'no-change'

  const landed = await mutateWithRetry(
    settings,
    [{ op: 'set', path: ['providers', route, 'models'], value: target }],
    logger,
  )
  return landed ? 'wrote' : 'skipped'
}
