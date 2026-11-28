import test from 'node:test'
import assert from 'node:assert/strict'
import { SKILLS, findSkill, skillIndexText, skillList } from './skills.js'

test('技能：首批 4 个，描述与正文符合长度约束', () => {
  assert.equal(SKILLS.length, 4)
  for (const s of SKILLS) {
    assert.ok(s.name && s.title && s.description && s.body, `${s.name} 字段完整`)
    assert.ok(s.description.length <= 80, `${s.name} description ≤80 字（实际 ${s.description.length}）`)
    assert.ok(s.body.length <= 1500, `${s.name} body ≤1500 字（实际 ${s.body.length}）`)
    assert.match(s.version, /^v\d+$/)
  }
})

test('技能：索引只含名字/标题/触发，不含正文', () => {
  const idx = skillIndexText()
  for (const s of SKILLS) {
    assert.ok(idx.includes(s.name), `索引含 ${s.name}`)
    assert.ok(idx.includes(s.title), `索引含 ${s.title}`)
  }
  assert.match(idx, /use_skill/)
  assert.ok(!idx.includes('步骤：'), '索引不应包含技能正文')
})

test('技能：findSkill 命中与未命中', () => {
  assert.equal(findSkill('doc_writer')?.title, '文档写作')
  assert.equal(findSkill('  knowledge_curator ')?.title, '文档整理')
  assert.equal(findSkill('nope'), undefined)
})

test('技能：清单不含正文（供 API/UI）', () => {
  const list = skillList()
  assert.equal(list.length, 4)
  assert.ok(list.every((s) => !('body' in s)))
})
