import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorText, retry } from '../lib/errors.js'

/** An error with a `cause`, the shape Node uses for network failures. */
function chained(...messages) {
  let error
  for (const message of messages) {
    const next = new Error(message)
    if (error !== undefined) next.cause = error
    error = next
  }
  return error
}

test('errorText renders the whole cause chain', () => {
  // the real shape: fetch failed <- AggregateError <- connect ETIMEDOUT, per address
  const timeout = new Error('connect ETIMEDOUT 172.67.221.13:443')
  const aggregate = new AggregateError([timeout], '')
  const failure = new TypeError('fetch failed')
  failure.cause = aggregate
  assert.equal(
    errorText(failure),
    'TypeError: fetch failed ← connect ETIMEDOUT 172.67.221.13:443',
  )
})

test('errorText keeps the error name and caps aggregate members', () => {
  assert.equal(errorText(new TypeError('fetch failed')), 'TypeError: fetch failed')
  assert.equal(errorText(new Error('plain')), 'plain')
  const dom = new Error('The operation was aborted due to timeout')
  dom.name = 'TimeoutError'
  assert.equal(errorText(dom), 'TimeoutError: The operation was aborted due to timeout')

  const many = new AggregateError([1, 2, 3, 4, 5].map((n) => new Error(`e${n}`)), 'all failed')
  assert.equal(errorText(many), 'all failed ← e1 | e2 | e3 (+2)')
})

test('errorText survives non-errors and deep chains', () => {
  assert.equal(errorText(undefined), 'undefined')
  assert.equal(errorText('boom'), 'boom')
  assert.equal(errorText(42), '42')
  // 6 links, only 4 followed, and it must not recurse forever
  assert.equal(errorText(chained('a', 'b', 'c', 'd', 'e', 'f')), 'f ← e ← d ← c ← b')
})

test('retry returns the first success without waiting', async () => {
  let calls = 0
  const slept = []
  const result = await retry(async () => {
    calls += 1
    return 'ok'
  }, { attempts: 3, sleep: async (ms) => { slept.push(ms) } })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
  assert.deepEqual(slept, [])
})

test('retry backs off exponentially and stops at the first success', async () => {
  let calls = 0
  const slept = []
  const seen = []
  const result = await retry(async () => {
    calls += 1
    if (calls < 3) throw new Error(`boom ${calls}`)
    return 'ok'
  }, {
    attempts: 5,
    baseDelayMs: 100,
    sleep: async (ms) => { slept.push(ms) },
    onRetry: (error, attempt, delayMs) => seen.push([error.message, attempt, delayMs]),
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(slept, [100, 200])
  assert.deepEqual(seen, [['boom 1', 1, 100], ['boom 2', 2, 200]])
})

test('retry rethrows the original error after the last attempt', async () => {
  const original = chained('fetch failed', 'connect ETIMEDOUT 1.2.3.4:443')
  let calls = 0
  let caught
  try {
    await retry(async () => {
      calls += 1
      throw original
    }, { attempts: 3, baseDelayMs: 0, sleep: async () => {} })
  } catch (error) {
    caught = error
  }
  assert.equal(calls, 3)
  assert.equal(caught, original) // not wrapped: the caller keeps the cause chain
  assert.match(errorText(caught), /connect ETIMEDOUT/)
})

test('retry stops immediately when the failure is not retryable', async () => {
  let calls = 0
  const slept = []
  await assert.rejects(
    () => retry(async () => {
      calls += 1
      throw new Error('pi.dev 403 Forbidden')
    }, {
      attempts: 4,
      shouldRetry: () => false,
      sleep: async (ms) => { slept.push(ms) },
    }),
    /403/,
  )
  assert.equal(calls, 1)
  assert.deepEqual(slept, [])
})

test('retry honours the backoff ceiling and runs at least once', async () => {
  const slept = []
  await assert.rejects(() => retry(async () => { throw new Error('x') }, {
    attempts: 4, baseDelayMs: 1000, maxDelayMs: 1500, sleep: async (ms) => { slept.push(ms) },
  }), /x/)
  assert.deepEqual(slept, [1000, 1500, 1500])

  // a missing or nonsensical attempt count still runs the operation exactly once
  for (const attempts of [undefined, NaN, 0, -3]) {
    let calls = 0
    await assert.rejects(() => retry(async () => { calls += 1; throw new Error('once') }, { attempts }), /once/)
    assert.equal(calls, 1)
  }
})
