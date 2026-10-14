import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveReasoningEfforts, translateEntry } from '../lib/translate.js'

test('deriveReasoningEfforts keeps only whitelisted levels', () => {
  const efforts = deriveReasoningEfforts({
    id: 'm',
    thinkingLevelMap: { off: null, low: 'low', bogus: 'x', max: 'max' },
  })
  assert.deepEqual(efforts, { off: null, low: 'low', max: 'max' })
})

test('deriveReasoningEfforts returns undefined without a map', () => {
  assert.equal(deriveReasoningEfforts({ id: 'm' }), undefined)
  assert.equal(deriveReasoningEfforts({ id: 'm', thinkingLevelMap: {} }), undefined)
})

test('translateEntry emits id/name/context/input/efforts', () => {
  const profile = translateEntry({
    id: 'm',
    name: 'Model M',
    api: 'anthropic-messages',
    contextWindow: 1000,
    maxTokens: 100,
    input: ['text', 'image'],
    thinkingLevelMap: { low: 'low', high: 'high' },
  })
  assert.deepEqual(profile, {
    id: 'm',
    name: 'Model M',
    contextWindow: 1000,
    maxTokens: 100,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high' },
  })
})

test('translateEntry drops a maxTokens that echoes the context window', () => {
  const profile = translateEntry({ id: 'm', contextWindow: 1000, maxTokens: 1000 })
  assert.equal(profile.maxTokens, undefined)
})

test('translateEntry only copies compat for openai-completions', () => {
  const withCompat = translateEntry({
    id: 'm',
    api: 'openai-completions',
    contextWindow: 1000,
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false, other: 1 },
  })
  assert.deepEqual(withCompat.compat, { thinkingFormat: 'deepseek', supportsReasoningEffort: false })

  const anthropic = translateEntry({
    id: 'm',
    api: 'anthropic-messages',
    contextWindow: 1000,
    compat: { thinkingFormat: 'deepseek' },
  })
  assert.equal(anthropic.compat, undefined)
})
