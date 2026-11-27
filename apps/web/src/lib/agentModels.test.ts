import test from 'node:test'
import assert from 'node:assert/strict'
import { compositeOf, providersFrom } from './agentModels.js'
import type { LlmProviderPublic } from './llm.js'

test('compositeOf：providerId + modelKey', () => {
  assert.equal(compositeOf({ id: 'p1', name: '', apiBase: '', apiKey: '', keyMask: '', hasKey: true, models: [] }, { key: 'k1', name: '', model: 'm', visibleToUsers: true }), 'p1/k1')
})

test('compositeOf：空 id/key 回退', () => {
  assert.equal(compositeOf({ id: '', name: '', apiBase: '', apiKey: '', keyMask: '', hasKey: false, models: [] }, { key: '', name: '', model: 'deepseek-chat', visibleToUsers: true }), 'new/deepseek-chat')
})

test('providersFrom：去 provider 前缀、密钥不回显、保留可见性', () => {
  const list = [
    {
      id: 'p1',
      name: '供应商 1',
      apiBase: 'https://api.example.com',
      keyMask: 'sk-***',
      hasKey: true,
      models: [
        { id: 'p1/deepseek-chat', name: 'Chat', model: 'deepseek-chat', visibleToUsers: true },
        { id: 'other-model', name: 'Other', model: 'other-model', visibleToUsers: false },
      ],
    },
  ] as unknown as LlmProviderPublic[]
  const rows = providersFrom(list)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].apiKey, '')
  assert.equal(rows[0].keyMask, 'sk-***')
  assert.equal(rows[0].hasKey, true)
  assert.deepEqual(
    rows[0].models.map((m) => [m.key, m.model, m.visibleToUsers]),
    [
      ['deepseek-chat', 'deepseek-chat', true],
      ['other-model', 'other-model', false],
    ],
  )
  assert.equal(compositeOf(rows[0], rows[0].models[0]), 'p1/deepseek-chat')
})

test('providersFrom：空清单', () => {
  assert.deepEqual(providersFrom([]), [])
})
