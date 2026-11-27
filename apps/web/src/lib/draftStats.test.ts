import test from 'node:test'
import assert from 'node:assert/strict'
import { countOf, errText } from './draftStats.js'

test('countOf：空文本', () => {
  assert.deepEqual(countOf(''), { chars: 0, words: 0 })
  assert.deepEqual(countOf('   \n\t '), { chars: 0, words: 0 })
})

test('countOf：中英混排（字符去空白，词数 = 汉字数 + 拉丁词数）', () => {
  assert.deepEqual(countOf('你好 world'), { chars: 7, words: 3 })
  assert.deepEqual(countOf('拾光 2026-11-28'), { chars: 12, words: 3 })
})

test('errText：JSON {error} 取 error 字段', () => {
  assert.equal(errText(new Error('{"error":"需要站主权限","code":"E_FORBIDDEN"}')), '需要站主权限')
})

test('errText：非 JSON 原样返回；非 Error 也转字符串', () => {
  assert.equal(errText(new Error('网络错误')), '网络错误')
  assert.equal(errText('纯字符串错误'), '纯字符串错误')
  assert.equal(errText({ error: '对象' }), '[object Object]')
})
