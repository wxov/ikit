import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStoreData } from './store.js'

function tempFile(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ikit-store-data-'))
  return { dir, file: join(dir, 'plugins-data.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('store-data：保存后可按原样读回', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new JsonStoreData(file)
    await store.save({ notes: [{ id: 'n1', text: '便签' }], events: [], todos: [], md: [] } as never)
    const loaded = await store.load()
    assert.equal(loaded.notes.length, 1)
    assert.equal(loaded.notes[0].text, '便签')
  } finally {
    cleanup()
  }
})

test('store-data：原子写（不残留 .tmp，且目标文件存在）', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new JsonStoreData(file)
    await store.save({ notes: [], events: [], todos: [], md: [] } as never)
    assert.equal(existsSync(file), true)
    assert.equal(existsSync(`${file}.tmp`), false)
  } finally {
    cleanup()
  }
})

test('store-data：文件损坏时回退为空数据（不抛错）', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new JsonStoreData(file)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ not json', 'utf-8')
    const loaded = await store.load()
    assert.deepEqual(loaded.notes, [])
    assert.deepEqual(loaded.events, [])
  } finally {
    cleanup()
  }
})
