import test from 'node:test'
import assert from 'node:assert/strict'
import { splitBlocks, blockTypeOf, convertBlock, joinBlocks } from './editorBlocks.js'

test('splitBlocks：标题 / 段落 / 列表 分别成块', () => {
  const blocks = splitBlocks('# H1\n\npara\n\n- a\n- b')
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'paragraph', 'list'],
  )
  assert.equal(blocks.length, 3)
})

test('splitBlocks：围栏代码块内的空行不切块', () => {
  const blocks = splitBlocks('```ts\nline1\n\nline2\n```')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
})

test('splitBlocks：嵌套列表归入同一块', () => {
  const blocks = splitBlocks('- a\n  - a1\n  - a2\n- b')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'list')
})

test('blockTypeOf：常见块类型识别', () => {
  assert.equal(blockTypeOf('# 标题'), 'heading')
  assert.equal(blockTypeOf('普通段落'), 'paragraph')
  assert.equal(blockTypeOf('- 项'), 'list')
  assert.equal(blockTypeOf('1. 项'), 'ordered-list')
  assert.equal(blockTypeOf('- [ ] 待办'), 'task')
  assert.equal(blockTypeOf('> 引用'), 'quote')
  assert.equal(blockTypeOf('```\ncode\n```'), 'code')
  assert.equal(blockTypeOf('---'), 'hr')
  assert.equal(blockTypeOf('> [!NOTE] 提示'), 'callout')
})

test('convertBlock：互转结果符合 Markdown 语义', () => {
  assert.equal(convertBlock('段落文本', 'heading2'), '## 段落文本')
  assert.equal(convertBlock('# 标题', 'paragraph'), '标题')
  assert.equal(convertBlock('a', 'quote'), '> a')
  assert.equal(convertBlock('a', 'list'), '- a')
  assert.equal(convertBlock('a', 'ordered-list'), '1. a')
  assert.equal(convertBlock('a', 'task'), '- [ ] a')
  assert.equal(convertBlock('a', 'code'), '```\na\n```')
})

test('joinBlocks：分块后再合并，块边界不变（往返一致）', () => {
  const md = '# 标题\n\n第一段\n\n- a\n- b\n\n```\ncode\n```'
  const blocks = splitBlocks(md)
  const rejoined = joinBlocks(blocks.map((b) => b.md))
  assert.deepEqual(
    splitBlocks(rejoined).map((b) => b.md),
    blocks.map((b) => b.md),
  )
})
