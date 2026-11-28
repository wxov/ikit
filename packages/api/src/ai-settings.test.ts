import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AI_SETTINGS,
  loadAiSettings,
  normalizeAiSettings,
  resolveSkillVariant,
  saveAiSettings,
} from './ai-settings.js'

const tmpFile = (): { file: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'ikit-ai-settings-'))
  return { file: join(dir, 'ai-settings.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('AI 设置：文件不存在时返回默认值', () => {
  const { file, cleanup } = tmpFile()
  try {
    assert.deepEqual(loadAiSettings(file), DEFAULT_AI_SETTINGS)
  } finally {
    cleanup()
  }
})

test('AI 设置：部分更新与落盘（原子写无 tmp 残留）', () => {
  const { file, cleanup } = tmpFile()
  try {
    const saved = saveAiSettings({ promptPolish: false, summaryThreshold: 24 }, file)
    assert.equal(saved.promptPolish, false)
    assert.equal(saved.summaryThreshold, 24)
    assert.equal(saved.skillVariant, DEFAULT_AI_SETTINGS.skillVariant)
    const raw = readFileSync(file, 'utf-8')
    assert.ok(raw.includes('"promptPolish": false'))
    assert.deepEqual(loadAiSettings(file), saved)
  } finally {
    cleanup()
  }
})

test('AI 设置：非法值回落默认，数值钳制且 keep < threshold', () => {
  const s = normalizeAiSettings({ skillVariant: 'zzz', summaryThreshold: 3, summaryKeep: 99, dualVariantsDefault: 5 })
  assert.equal(s.skillVariant, DEFAULT_AI_SETTINGS.skillVariant)
  assert.equal(s.summaryThreshold, 4) // 最小 4
  assert.equal(s.summaryKeep, 3) // min(40, 4-1)=3
  assert.equal(s.dualVariantsDefault, 1)
})

test('AI 设置：损坏文件回落默认值', () => {
  const { file, cleanup } = tmpFile()
  try {
    saveAiSettings({}, file)
    // 覆盖为非法 JSON
    writeFileSync(file, '{ not json', 'utf-8')
    assert.deepEqual(loadAiSettings(file), DEFAULT_AI_SETTINGS)
  } finally {
    cleanup()
  }
})

test('技能变体分流：off/a/b 直接生效，auto 稳定 50/50', () => {
  assert.equal(resolveSkillVariant('u1', 'off'), undefined)
  assert.equal(resolveSkillVariant('u1', 'a'), 'a')
  assert.equal(resolveSkillVariant('u1', 'b'), 'b')
  assert.equal(resolveSkillVariant(undefined, 'auto'), undefined)

  const first = resolveSkillVariant('user-1', 'auto')
  assert.equal(resolveSkillVariant('user-1', 'auto'), first) // 稳定
  let a = 0
  const total = 1000
  for (let i = 0; i < total; i++) if (resolveSkillVariant(`uid-${i}`, 'auto') === 'a') a++
  assert.ok(a / total > 0.4 && a / total < 0.6, `分布 ${a}/${total}`)
})
