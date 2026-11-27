import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLog } from './audit.js'

const tmp = (): { dir: string; file: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'ikit-audit-'))
  return { dir, file: join(dir, 'audit.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('audit：按队列写入 JSONL 且字段完整', async () => {
  const { file, cleanup } = tmp()
  try {
    const audit = createAuditLog({ file, enabled: true })
    audit.write({ action: 'auth.login', ok: true, user: 'admin', ip: '1.2.3.4', target: 'admin' })
    audit.write({ action: 'knowledge.delete', ok: false, user: 'admin', target: 'e1', detail: { soft: true } })
    await audit.flush()

    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.action, 'auth.login')
    assert.equal(first.ok, true)
    assert.equal(first.user, 'admin')
    assert.equal(first.ip, '1.2.3.4')
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/)
    const second = JSON.parse(lines[1])
    assert.equal(second.ok, false)
    assert.deepEqual(second.detail, { soft: true })
  } finally {
    cleanup()
  }
})

test('audit：关闭时不落盘', async () => {
  const { file, cleanup } = tmp()
  try {
    const audit = createAuditLog({ file, enabled: false })
    audit.write({ action: 'x', ok: true })
    await audit.flush()
    assert.equal(existsSync(file), false)
  } finally {
    cleanup()
  }
})

test('audit：超长字段被裁剪', async () => {
  const { file, cleanup } = tmp()
  try {
    const audit = createAuditLog({ file, enabled: true })
    audit.write({ action: 'a'.repeat(500), ok: true, user: 'u'.repeat(500), target: 't'.repeat(500) })
    await audit.flush()
    const rec = JSON.parse(readFileSync(file, 'utf-8').trim())
    assert.equal(rec.action.length, 80)
    assert.equal(rec.user.length, 64)
    assert.equal(rec.target.length, 128)
  } finally {
    cleanup()
  }
})
