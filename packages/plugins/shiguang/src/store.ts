// 拾光数据存储（JSON 文件，原子写）
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ShiguangEntry } from './types.js'

export interface ShiguangData {
  version: number
  /** 开门密码：scrypt 哈希 + 随机盐（不存明文） */
  passcodeHash?: string
  passcodeSalt?: string
  entries: ShiguangEntry[]
}

export interface ShiguangPersist {
  load(): Promise<ShiguangData>
  save(data: ShiguangData): Promise<void>
}

const EMPTY: ShiguangData = { version: 1, entries: [] }

export class JsonShiguangStore implements ShiguangPersist {
  private cache: ShiguangData | null = null
  constructor(private readonly file: string) {}

  async load(): Promise<ShiguangData> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const p = JSON.parse(raw) as Partial<ShiguangData>
      this.cache = {
        version: 1,
        passcodeHash: typeof p.passcodeHash === 'string' ? p.passcodeHash : undefined,
        passcodeSalt: typeof p.passcodeSalt === 'string' ? p.passcodeSalt : undefined,
        entries: Array.isArray(p.entries) ? p.entries : [],
      }
    } catch {
      this.cache = { ...EMPTY, entries: [] }
    }
    return this.cache
  }

  async save(data: ShiguangData): Promise<void> {
    this.cache = data
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tmp, this.file)
  }
}
