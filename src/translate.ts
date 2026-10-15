/**
 * pi.dev record → settings-writable model profile.
 *
 * Used only by `settingsMode: 'mirror'`. `settingsMode: 'unset'` (the
 * default) skips translation entirely: once the catalog layer has made every
 * model base-matching, the installed catalog is the richer, authoritative
 * source and the settings `models` override is removed instead.
 *
 * @module dsh-pi-ai-sync/translate
 */

import { isPositiveInt } from './catalog.ts'
import type { PiDevEntry, SettingsModelProfile } from './types.ts'

/** The thinking levels dsh's schema accepts as `reasoningEfforts` keys. */
export const THINKING_LEVELS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS)

/**
 * Derive the `reasoningEfforts` dict from a pi.dev `thinkingLevelMap`.
 * Returns `undefined` when the entry states no usable map, so the field is
 * omitted and the installed catalog's own capability applies.
 */
export function deriveReasoningEfforts(
  entry: PiDevEntry,
): Record<string, string | null> | undefined {
  const map = entry.thinkingLevelMap
  if (map === undefined || map === null || typeof map !== 'object') return undefined
  const out: Record<string, string | null> = {}
  for (const [level, wire] of Object.entries(map)) {
    if (!THINKING_LEVEL_SET.has(level)) continue
    if (wire === null) out[level] = null
    else if (typeof wire === 'string' && wire.length > 0) out[level] = wire
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Translate one addressable pi.dev record into a settings model profile.
 * Capacity values are sanity-gated (positive integers, and `maxTokens`
 * strictly below the context window) because a written value overrides the
 * installed catalog and a bogus `maxTokens` becomes the request default.
 */
export function translateEntry(entry: PiDevEntry): SettingsModelProfile | undefined {
  if (typeof entry.id !== 'string' || entry.id.length === 0) return undefined
  const profile: SettingsModelProfile = { id: entry.id }
  if (typeof entry.name === 'string' && entry.name.length > 0) profile.name = entry.name
  if (isPositiveInt(entry.contextWindow)) profile.contextWindow = entry.contextWindow
  if (Array.isArray(entry.input) && entry.input.length > 0) profile.input = [...entry.input]
  if (isPositiveInt(entry.maxTokens)) {
    const ctx = profile.contextWindow
    if (ctx === undefined || entry.maxTokens < ctx) profile.maxTokens = entry.maxTokens
  }
  const efforts = deriveReasoningEfforts(entry)
  if (efforts !== undefined) profile.reasoningEfforts = efforts
  // compat only means something to the openai-completions protocol.
  if (entry.api === 'openai-completions' && entry.compat !== undefined) {
    const compat: NonNullable<SettingsModelProfile['compat']> = {}
    if (typeof entry.compat.thinkingFormat === 'string') {
      compat.thinkingFormat = entry.compat.thinkingFormat
    }
    if (typeof entry.compat.supportsReasoningEffort === 'boolean') {
      compat.supportsReasoningEffort = entry.compat.supportsReasoningEffort
    }
    if (Object.keys(compat).length > 0) profile.compat = compat
  }
  return profile
}
