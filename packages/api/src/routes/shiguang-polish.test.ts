import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPolishPrompt,
  normalizePolishIntensity,
  normalizePolishStyle,
  nextIntensity,
  normalizePolishType,
} from './shiguang-polish.js'

test('拾光润色：日记提示词包含生活化编辑清单', () => {
  const p = buildPolishPrompt('diary', 'standard', 'plain')
  assert.match(p.system, /场景落地/)
  assert.match(p.system, /感官细节/)
  assert.match(p.system, /口语与短句/)
  assert.match(p.system, /去作文腔/)
  assert.match(p.system, /±25%/)
  assert.match(p.system, /朴素优先/)
})

test('拾光润色：感悟提示词包含哲思与文笔清单', () => {
  const p = buildPolishPrompt('insight', 'standard', 'literary')
  assert.match(p.system, /概念提炼/)
  assert.match(p.system, /因果\/张力/)
  assert.match(p.system, /隐喻克制/)
  assert.match(p.system, /留白/)
  assert.match(p.system, /文笔优先/)
})

test('拾光润色：强度影响篇幅容差与采样参数', () => {
  const light = buildPolishPrompt('diary', 'light', 'plain')
  const deep = buildPolishPrompt('diary', 'deep', 'plain')
  assert.match(light.system, /±15%/)
  assert.match(deep.system, /±35%/)
  assert.ok(deep.maxTokens >= light.maxTokens)
  const insightDeep = buildPolishPrompt('insight', 'deep', 'plain')
  assert.equal(insightDeep.maxTokens, 1800)
})

test('拾光润色：入参归一化', () => {
  assert.equal(normalizePolishType('diary'), 'diary')
  assert.equal(normalizePolishType('insight'), 'insight')
  assert.equal(normalizePolishType('quote'), null)
  assert.equal(normalizePolishType(undefined), null)
  assert.equal(normalizePolishIntensity('deep'), 'deep')
  assert.equal(normalizePolishIntensity('nonsense'), 'standard')
  assert.equal(normalizePolishStyle('literary'), 'literary')
  assert.equal(normalizePolishStyle(''), 'plain')
})

test('拾光润色：段落级模式只润色选中段', () => {
  const p = buildPolishPrompt('diary', 'standard', 'plain', 'section')
  assert.match(p.system, /只润色【选中段】/)
  assert.match(p.system, /不要改写上下文/)
  const full = buildPolishPrompt('diary', 'standard', 'plain', 'full')
  assert.match(full.system, /整篇润色/)
})

test('拾光润色：双候选的第二版强度递进', () => {
  assert.equal(nextIntensity('light'), 'standard')
  assert.equal(nextIntensity('standard'), 'deep')
  assert.equal(nextIntensity('deep'), 'deep')
})