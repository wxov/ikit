import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonShiguangStore } from './store.js'
import { createShiguangService } from './service.js'
import { ShiguangError } from './types.js'
import type { ShiguangService } from './types.js'

function makeService(): { svc: ShiguangService; dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ikit-sg-'))
  const file = join(dir, 'shiguang.json')
  const svc = createShiguangService(new JsonShiguangStore(file), { tokenTtlMs: 60_000 })
  return { svc, dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const expectCode = async (fn: () => Promise<unknown>, code: string) => {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ShiguangError)
    assert.equal(e.code, code)
    return true
  })
}

test('拾光：初始未设密码，解锁返回 E_NO_PASSCODE', async () => {
  const { svc, cleanup } = makeService()
  try {
    const st = await svc.status()
    assert.equal(st.hasPasscode, false)
    assert.equal(st.locked, true)
    await expectCode(() => svc.unlock('1234'), 'E_NO_PASSCODE')
  } finally {
    cleanup()
  }
})

test('拾光：密码长度校验', async () => {
  const { svc, cleanup } = makeService()
  try {
    await expectCode(() => svc.setPasscode({ newPasscode: '123' }), 'E_PASSCODE_LENGTH')
    await expectCode(() => svc.setPasscode({ newPasscode: 'x'.repeat(33) }), 'E_PASSCODE_LENGTH')
  } finally {
    cleanup()
  }
})

test('拾光：设置密码 → 解锁 → 锁上', async () => {
  const { svc, cleanup } = makeService()
  try {
    await svc.setPasscode({ newPasscode: '1234' })
    assert.equal((await svc.status()).hasPasscode, true)
    const { token } = await svc.unlock('1234')
    assert.equal(svc.verify(token), true)
    svc.lock(token)
    assert.equal(svc.verify(token), false)
  } finally {
    cleanup()
  }
})

test('拾光：错误密码计数，第 5 次锁定', async () => {
  const { svc, cleanup } = makeService()
  try {
    await svc.setPasscode({ newPasscode: '1234' })
    for (let i = 0; i < 4; i++) await expectCode(() => svc.unlock('wrong'), 'E_BAD_PASSCODE')
    await expectCode(() => svc.unlock('wrong'), 'E_LOCKED_OUT')
    // 锁定期内即使密码正确也拒绝
    await expectCode(() => svc.unlock('1234'), 'E_LOCKED_OUT')
  } finally {
    cleanup()
  }
})

test('拾光：改密需验证旧密码，改后旧密码失效', async () => {
  const { svc, cleanup } = makeService()
  try {
    await svc.setPasscode({ newPasscode: '1234' })
    await expectCode(() => svc.setPasscode({ newPasscode: '5678' }), 'E_OLD_REQUIRED')
    await expectCode(() => svc.setPasscode({ oldPasscode: '0000', newPasscode: '5678' }), 'E_BAD_OLD_PASSCODE')
    await svc.setPasscode({ oldPasscode: '1234', newPasscode: '5678' })
    await expectCode(() => svc.unlock('1234'), 'E_BAD_PASSCODE')
    const { token } = await svc.unlock('5678')
    assert.equal(svc.verify(token), true)
  } finally {
    cleanup()
  }
})

test('拾光：条目增删改查与类型过滤', async () => {
  const { svc, cleanup } = makeService()
  try {
    await svc.setPasscode({ newPasscode: '1234' })
    const diary = await svc.add({ type: 'diary', content: '今天写了拾光', date: '2026-11-28', title: '日记一' })
    const quote = await svc.add({ type: 'quote', content: '千里之行，始于足下。', author: '老子' })
    assert.equal((await svc.list()).length, 2)
    assert.equal((await svc.list('diary')).length, 1)
    assert.equal((await svc.list('quote'))[0].author, '老子')

    const updated = await svc.update(diary.id, { content: '改过的日记' })
    assert.equal(updated.content, '改过的日记')
    await svc.remove(quote.id)
    assert.equal((await svc.list()).length, 1)

    await expectCode(() => svc.add({ type: 'insight', content: '   ' }), 'E_EMPTY_CONTENT')
    await expectCode(() => svc.update('not-exist', { content: 'x' }), 'E_NOT_FOUND')
    await expectCode(() => svc.remove('not-exist'), 'E_NOT_FOUND')
  } finally {
    cleanup()
  }
})

test('拾光：数据文件不含明文密码', async () => {
  const { svc, file, cleanup } = makeService()
  try {
    await svc.setPasscode({ newPasscode: 'MySecret42' })
    const raw = readFileSync(file, 'utf-8')
    assert.ok(raw.includes('passcodeHash'))
    assert.ok(!raw.includes('MySecret42'))
  } finally {
    cleanup()
  }
})
