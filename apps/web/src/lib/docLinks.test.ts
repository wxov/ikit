import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyLink, resolveDocLink, isDocVisible } from './docLinks.js'

test('classifyLink：data-doc-id 优先于 href', () => {
  assert.deepEqual(classifyLink('https://example.com', { docId: 'a1' }), { kind: 'doc', id: 'a1', href: 'https://example.com' })
  assert.deepEqual(classifyLink('#ikit-doc-x', { docTitle: '某标题' }), { kind: 'doc', title: '某标题', href: '#ikit-doc-x' })
})

test('classifyLink：内部链接（ikit:// 与安全 href）', () => {
  assert.equal(classifyLink('ikit://doc/abc')?.kind, 'doc')
  assert.equal(classifyLink('ikit://doc/abc')?.id, 'abc')
  assert.equal(classifyLink('#ikit-doc-abc')?.id, 'abc')
  assert.equal(classifyLink('#ikit-doc')?.kind, 'doc')
})

test('classifyLink：锚点 / 外链 / 相对 / 空', () => {
  assert.equal(classifyLink('#sec-1')?.kind, 'anchor')
  assert.equal(classifyLink('https://example.com/a')?.kind, 'external')
  assert.equal(classifyLink('//cdn.example.com/x')?.kind, 'external')
  assert.equal(classifyLink('mailto:a@b.c')?.kind, 'external')
  assert.equal(classifyLink('docs/a.md')?.kind, 'relative')
  assert.equal(classifyLink(''), null)
  assert.equal(classifyLink(null), null)
})

test('isDocVisible：草稿仅站主可见，缺省视为已发布', () => {
  assert.equal(isDocVisible({ id: '1', title: 't' }), true)
  assert.equal(isDocVisible({ id: '1', title: 't', status: 'draft' }), false)
  assert.equal(isDocVisible({ id: '1', title: 't', status: 'draft' }, { isAdmin: true }), true)
})

const index = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Beta', status: 'draft' as const },
  { id: 'c', title: 'Same' },
  { id: 'd', title: 'Same' },
]

test('resolveDocLink：按 id 命中', () => {
  const r = resolveDocLink({ kind: 'doc', id: 'a', href: '' }, index)
  assert.equal(r.kind, 'doc')
  assert.deepEqual(r.kind === 'doc' ? r.id : null, 'a')
})

test('resolveDocLink：id 不存在 / 草稿受限 / 站主可见', () => {
  assert.deepEqual(resolveDocLink({ kind: 'doc', id: 'zzz', href: '' }, index), { kind: 'missing', reason: 'id-not-found' })
  assert.deepEqual(resolveDocLink({ kind: 'doc', id: 'b', href: '' }, index), { kind: 'missing', reason: 'draft-restricted' })
  assert.equal(resolveDocLink({ kind: 'doc', id: 'b', href: '' }, index, { isAdmin: true }).kind, 'doc')
})

test('resolveDocLink：标题匹配（忽略大小写）与同名多篇', () => {
  const one = resolveDocLink({ kind: 'doc', title: 'alpha', href: '' }, index)
  assert.equal(one.kind, 'doc')
  const multi = resolveDocLink({ kind: 'doc', title: 'same', href: '' }, index)
  assert.equal(multi.kind, 'doc')
  assert.equal(multi.kind === 'doc' ? multi.matches.length : 0, 2)
})

test('resolveDocLink：标题不存在 / 索引未加载', () => {
  assert.deepEqual(resolveDocLink({ kind: 'doc', title: 'nope', href: '' }, index), { kind: 'missing', reason: 'title-not-found' })
  assert.deepEqual(resolveDocLink({ kind: 'doc', id: 'a', href: '' }, null), { kind: 'missing', reason: 'id-not-found' })
})

test('resolveDocLink：非 doc 链接原样透传', () => {
  assert.deepEqual(resolveDocLink({ kind: 'anchor', anchor: 'sec', href: '#sec' }, index), { kind: 'anchor', anchor: 'sec' })
  assert.deepEqual(resolveDocLink({ kind: 'external', href: 'https://x' }, index), { kind: 'external' })
  assert.deepEqual(resolveDocLink({ kind: 'relative', href: 'a.md' }, index), { kind: 'relative' })
  assert.deepEqual(resolveDocLink(null, index), { kind: 'missing', reason: 'no-target' })
})
