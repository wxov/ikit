import test from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_PUBLISH_CUTOFF, resolveDraftCutoff } from './migrate.js'

test('DRAFT_PUBLISH_CUTOFF：可解析且不晚于当前时间（防止误设未来时间）', () => {
  const ts = Date.parse(DRAFT_PUBLISH_CUTOFF)
  assert.ok(Number.isFinite(ts), '常量必须是合法 ISO 时间')
  assert.ok(ts <= Date.now(), '截止时间不得晚于当前时间（否则会误伤新草稿）')
})

test('resolveDraftCutoff：未配置时使用默认常量', () => {
  const r = resolveDraftCutoff('')
  assert.equal(r.source, 'default')
  assert.equal(r.cutoff, DRAFT_PUBLISH_CUTOFF)
  assert.equal(resolveDraftCutoff(undefined).source, 'default')
})

test('resolveDraftCutoff：环境变量覆盖并规范化为 ISO', () => {
  const r = resolveDraftCutoff('2026-01-01T00:00:00Z')
  assert.equal(r.source, 'env')
  assert.equal(r.cutoff, '2026-01-01T00:00:00.000Z')
})

test('resolveDraftCutoff：非法值回退默认并标记 invalid-fallback', () => {
  const r = resolveDraftCutoff('not-a-date')
  assert.equal(r.source, 'invalid-fallback')
  assert.equal(r.cutoff, DRAFT_PUBLISH_CUTOFF)
})
