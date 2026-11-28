import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptPolishMessages, parsePromptPolishOutput } from './prompt-polish.js'

test('提示词润色：消息结构包含原文与 JSON 指令', () => {
  const msgs = buildPromptPolishMessages('整理一下', '小知会话')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.match(msgs[0].content, /严格 JSON/)
  assert.match(msgs[1].content, /整理一下/)
  assert.match(msgs[1].content, /小知会话/)
})

test('提示词润色：解析正常 JSON', () => {
  const r = parsePromptPolishOutput(
    '{"prompt":"帮我整理知识库里重复的笔记，先列出合并方案","added":["明确了操作对象","要求先给方案"],"intent":"organize"}',
    '整理一下',
  )
  assert.equal(r.degraded, false)
  assert.equal(r.intent, 'organize')
  assert.deepEqual(r.added, ['明确了操作对象', '要求先给方案'])
  assert.match(r.prompt, /合并方案/)
})

test('提示词润色：兼容代码块包裹与多余文字', () => {
  const r = parsePromptPolishOutput('```json\n{"prompt":"查一下知识库里的 Cordis 文档","added":[],"intent":"search"}\n```', '查cordis')
  assert.equal(r.degraded, false)
  assert.equal(r.intent, 'search')
  assert.equal(r.prompt, '查一下知识库里的 Cordis 文档')
})

test('提示词润色：added 超过 3 条时截断，非法 intent 归一为 other', () => {
  const r = parsePromptPolishOutput(
    '{"prompt":"p","added":["a","b","c","d"],"intent":"unknown"}',
    'p',
  )
  assert.equal(r.added.length, 3)
  assert.equal(r.intent, 'other')
})

test('提示词润色：无法解析时降级为原文', () => {
  const r = parsePromptPolishOutput('抱歉，我无法处理', '原始输入')
  assert.equal(r.degraded, true)
  assert.equal(r.prompt, '原始输入')
  assert.deepEqual(r.added, [])
})

test('提示词润色：缺 prompt 字段时降级', () => {
  const r = parsePromptPolishOutput('{"added":[],"intent":"ask"}', '原始输入')
  assert.equal(r.degraded, true)
  assert.equal(r.prompt, '原始输入')
})
