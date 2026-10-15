/**
 * The pi.dev data source.
 *
 * `https://pi.dev/api/models/providers/<route>` returns the route's model
 * listing already in pi-ai catalog shape (every record carries its own `api`
 * protocol, `baseUrl`, capacities, `thinkingLevelMap` and `compat`). That is
 * why the catalog layer can copy records verbatim instead of maintaining a
 * hand-written protocol/family table the way `dsh-opencode-go-models` does.
 *
 * @module dsh-pi-ai-sync/pidev
 */

import type { PiDevEntry } from './types.ts'

/** The pi.dev gateway's per-route model listing. */
export const PI_DEV_BASE = 'https://pi.dev/api/models/providers/'

/** Outcome of one route's fetch. `absent` marks a 404/501: pi.dev does not know the route. */
export interface PiDevFetchResult {
  entries: PiDevEntry[]
  absent: boolean
}

/**
 * Normalize a pi.dev listing body (an id-keyed object, or an array) into
 * entries. Records without a non-empty string `id` are dropped.
 */
export function normalizePiDevEntries(data: unknown): PiDevEntry[] {
  const list = Array.isArray(data)
    ? data
    : data !== null && typeof data === 'object'
      ? Object.values(data as Record<string, unknown>)
      : []
  const out: PiDevEntry[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as PiDevEntry
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    out.push(entry)
  }
  return out
}

/** True when the response body is a usable listing (non-empty after normalization). */
function looksLikeListing(data: unknown): boolean {
  return data !== null && typeof data === 'object'
}

/**
 * Fetch one route's pi.dev listing.
 *
 * @param route     provider route id (e.g. `opencode`)
 * @param timeoutMs abort budget for the request
 * @param fetchImpl injectable fetch, for tests
 */
export async function fetchPiDevEntries(
  route: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PiDevFetchResult> {
  const response = await fetchImpl(PI_DEV_BASE + encodeURIComponent(route), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status === 404 || response.status === 501) {
    return { entries: [], absent: true }
  }
  if (!response.ok) {
    throw new Error(`pi.dev ${response.status} ${response.statusText}`)
  }
  const data: unknown = await response.json()
  if (!looksLikeListing(data)) {
    throw new Error('pi.dev 返回了非对象响应')
  }
  return { entries: normalizePiDevEntries(data), absent: false }
}
