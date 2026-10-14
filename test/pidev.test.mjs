import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePiDevEntries, fetchPiDevEntries, PI_DEV_BASE, } from '../lib/pidev.js'

test('normalizePiDevEntries accepts an id-keyed object', () => {
  const entries = normalizePiDevEntries({
    'a-model': { id: 'a-model', api: 'openai-completions' },
    'b-model': { id: 'b-model' },
  })
  assert.deepEqual(entries.map((e) => e.id), ['a-model', 'b-model'])
})

test('normalizePiDevEntries accepts an array and drops id-less records', () => {
  const entries = normalizePiDevEntries([
    { id: 'ok' },
    { id: '' },
    { name: 'no-id' },
    null,
    'nope',
  ])
  assert.deepEqual(entries.map((e) => e.id), ['ok'])
})

test('normalizePiDevEntries tolerates non-listings', () => {
  assert.deepEqual(normalizePiDevEntries(null), [])
  assert.deepEqual(normalizePiDevEntries(42), [])
})

test('fetchPiDevEntries reports 404 as absent', async () => {
  const fakeFetch = async () => new Response('not found', { status: 404 })
  const result = await fetchPiDevEntries('nope', 1000, fakeFetch)
  assert.deepEqual(result, { entries: [], absent: true })
})

test('fetchPiDevEntries parses a 200 listing', async () => {
  const fakeFetch = async (url) => {
    assert.equal(url, `${PI_DEV_BASE}opencode-go`)
    return new Response(JSON.stringify({ 'm-1': { id: 'm-1', api: 'openai-completions' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const result = await fetchPiDevEntries('opencode-go', 1000, fakeFetch)
  assert.equal(result.absent, false)
  assert.deepEqual(result.entries.map((e) => e.id), ['m-1'])
})

test('fetchPiDevEntries throws on a server error', async () => {
  const fakeFetch = async () => new Response('boom', { status: 500, statusText: 'Server Error' })
  await assert.rejects(() => fetchPiDevEntries('opencode', 1000, fakeFetch), /500/)
})
