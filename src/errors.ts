/**
 * Failure reporting and the round's retry policy.
 *
 * Two things a real host taught this plugin: a bare `fetch failed` hides the
 * socket/TLS reason that says *which* layer broke, and one transient failure
 * should not cost a route its whole round. Both are cheap to fix and neither
 * may change the safe behaviour — a route whose listing could not be verified
 * still keeps its settings untouched (see `sync.ts`).
 *
 * @module dsh-pi-ai-sync/errors
 */

/**
 * Render an error with its `cause` chain on one line:
 * `fetch failed ← connect ETIMEDOUT 172.67.221.13:443`.
 *
 * Node hides the useful part of a network failure in `cause` — often an
 * `AggregateError` holding one entry per resolved address — so a
 * message-only rendering loses exactly the detail that identifies the layer
 * that broke.
 */
export function errorText(error: unknown): string {
  return render(error, 0)
}

/** Max `cause` links followed, and max members shown of an AggregateError. */
const MAX_DEPTH = 4
const MAX_MEMBERS = 3

function render(error: unknown, depth: number): string {
  if (error === null || error === undefined) return String(error)
  if (error instanceof AggregateError && error.errors.length > 0) {
    const members = error.errors.slice(0, MAX_MEMBERS).map((item) => render(item, depth + 1))
    const rest = error.errors.length > MAX_MEMBERS ? ` (+${error.errors.length - MAX_MEMBERS})` : ''
    const head = error.message.length > 0 ? `${error.message} ← ` : ''
    return `${head}${members.join(' | ')}${rest}`
  }
  if (error instanceof Error) {
    const name = error.name === '' || error.name === 'Error' ? '' : `${error.name}: `
    const own = `${name}${error.message}`
    if (depth >= MAX_DEPTH || error.cause === undefined) return own
    return `${own} ← ${render(error.cause, depth + 1)}`
  }
  return String(error)
}

/** Options for {@link retry}. */
export interface RetryOptions {
  /** Total attempts including the first; `1` disables retrying. */
  attempts: number
  /** Backoff base: attempt *n* waits `baseDelayMs * 2 ** (n - 1)`. */
  baseDelayMs?: number
  /** Ceiling for one wait. */
  maxDelayMs?: number
  /** Whether this failure is worth another attempt. Default: always. */
  shouldRetry?: (error: unknown) => boolean
  /** Called before each wait; `attempt` is the 1-based attempt that just failed. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
  /** Injectable sleep, so tests do not spend the backoff. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Run `operation`, retrying a retryable failure a bounded number of times with
 * exponential backoff.
 *
 * The last failure is rethrown **unchanged**, so the caller still sees the real
 * error and its cause rather than a wrapper.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  // A NaN/undefined attempt count must still run the operation once: never call
  // it zero times and report someone else's error.
  const requested = Math.trunc(options.attempts)
  const attempts = Number.isFinite(requested) ? Math.max(1, requested) : 1
  const base = options.baseDelayMs ?? 500
  const ceiling = options.maxDelayMs ?? 8000
  const shouldRetry = options.shouldRetry ?? (() => true)
  const sleep = options.sleep ?? defaultSleep
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !shouldRetry(error)) throw error
      const delayMs = Math.min(ceiling, base * 2 ** (attempt - 1))
      options.onRetry?.(error, attempt, delayMs)
      await sleep(delayMs)
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError
}
