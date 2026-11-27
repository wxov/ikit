import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger, currentLogLevel, isLevelEnabled } from './logger.js'

const withLevel = <T>(level: string, fn: () => T): T => {
  const prev = process.env.LOG_LEVEL
  process.env.LOG_LEVEL = level
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = prev
  }
}

test('logger：阈值过滤（warn 下 info 关闭、warn/error 开启）', () => {
  withLevel('warn', () => {
    assert.equal(isLevelEnabled('debug'), false)
    assert.equal(isLevelEnabled('info'), false)
    assert.equal(isLevelEnabled('warn'), true)
    assert.equal(isLevelEnabled('error'), true)
  })
})

test('logger：silent 全部关闭', () => {
  withLevel('silent', () => {
    assert.equal(isLevelEnabled('error'), false)
  })
})

test('logger：非法 LOG_LEVEL 回退 info', () => {
  withLevel('nonsense', () => {
    assert.equal(currentLogLevel(), 'info')
    assert.equal(isLevelEnabled('info'), true)
    assert.equal(isLevelEnabled('debug'), false)
  })
})

test('logger：输出格式含时间/级别/模块，且按阈值过滤', () => {
  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
  try {
    process.env.LOG_LEVEL = 'info'
    const log = createLogger('unit')
    log.info('hello', { a: 1 })
    log.debug('hidden')
    log.error(new Error('boom'))
  } finally {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
    delete process.env.LOG_LEVEL
  }
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[info\] \[unit\] hello \{"a":1\}$/)
  assert.match(lines[1], /\[error\] \[unit\] Error: boom/)
})
