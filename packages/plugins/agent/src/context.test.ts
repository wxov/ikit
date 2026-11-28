import test from 'node:test'
import assert from 'node:assert/strict'
import { SUMMARY_MAX_CHARS, buildSummaryMessages, summaryContextText, transcriptOf } from './context.js'

test('摘要：transcript 含角色且超长保留尾部', () => {
  const t = transcriptOf([
    { role: 'user', content: '帮我整理笔记' },
    { role: 'assistant', content: '好的，先列出方案' },
  ])
  assert.match(t, /用户：帮我整理笔记/)
  assert.match(t, /助手：好的，先列出方案/)

  const long = transcriptOf([{ role: 'user', content: 'a'.repeat(100) }], 10)
  assert.equal(long.length, 10)
  assert.equal(long, 'a'.repeat(10))
})

test('摘要：提示词包含字数上限与「不要编造」约束', () => {
  const msgs = buildSummaryMessages('用户：测试')
  assert.equal(msgs.length, 2)
  const system = msgs[0].content
  assert.match(system, new RegExp(`不超过 ${SUMMARY_MAX_CHARS} 字`))
  assert.match(system, /不要编造/)
  assert.match(msgs[1].content, /用户：测试/)
})

test('摘要：上下文包装明确标注为较早对话', () => {
  assert.match(summaryContextText('用户希望整理笔记'), /较早对话摘要/)
  assert.match(summaryContextText('  x  '), /x/)
})
