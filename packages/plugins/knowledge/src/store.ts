import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KnowledgeDb, KnowledgeEntry } from './types.js'

/** 知识库存储抽象：JSON 文件 / SQLite 共用同一接口 */
export interface KnowledgeStore {
  load(): Promise<KnowledgeDb>
  save(): Promise<void>
}

/** JSON 文件存储（默认，适合中小数据量） */
export class JsonStore implements KnowledgeStore {
  private cache: KnowledgeDb | null = null

  constructor(
    private readonly file: string,
    private readonly fallback: KnowledgeDb,
  ) {}

  async load(): Promise<KnowledgeDb> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      this.cache = JSON.parse(raw) as KnowledgeDb
    } catch {
      this.cache = structuredClone(this.fallback)
      await this.save()
    }
    return this.cache
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf-8')
  }

  get data(): KnowledgeDb {
    if (!this.cache) throw new Error('store not loaded')
    return this.cache
  }
}

/** SQLite 存储（数据量大时使用，基于 Node 内置 node:sqlite，零原生依赖） */
export class SqliteStore implements KnowledgeStore {
  private cache: KnowledgeDb | null = null
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        category TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        embedding TEXT
      );
      CREATE TABLE IF NOT EXISTS categories (
        path TEXT PRIMARY KEY
      );
    `)
  }

  async load(): Promise<KnowledgeDb> {
    if (this.cache) return this.cache
    const rows = this.db.prepare('SELECT * FROM entries').all() as any[]
    const entries: KnowledgeEntry[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      tags: JSON.parse(r.tags),
      category: r.category ?? undefined,
      pinned: !!r.pinned,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at ?? undefined,
      embedding: r.embedding ? JSON.parse(r.embedding) : undefined,
    }))
    const cats = this.db.prepare('SELECT path FROM categories').all() as any[]
    this.cache = { entries, categories: cats.map((c) => c.path) }
    return this.cache
  }

  async save(): Promise<void> {
    this.persist()
  }

  private persist(): void {
    if (!this.cache) return
    const data = this.cache
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM entries')
      this.db.exec('DELETE FROM categories')
      const ins = this.db.prepare(`
        INSERT INTO entries (id, title, content, tags, category, pinned, created_at, updated_at, deleted_at, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const e of data.entries) {
        ins.run(
          e.id,
          e.title,
          e.content,
          JSON.stringify(e.tags),
          e.category ?? null,
          e.pinned ? 1 : 0,
          e.createdAt,
          e.updatedAt,
          e.deletedAt ?? null,
          e.embedding ? JSON.stringify(e.embedding) : null,
        )
      }
      const insCat = this.db.prepare('INSERT INTO categories (path) VALUES (?)')
      for (const c of data.categories) {
        insCat.run(c)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** 同步导入数据（用于从 JSON 迁移） */
  importData(data: KnowledgeDb): void {
    this.cache = data
    this.persist()
  }

  /** 是否为空（用于判断是否需要从 JSON 迁移） */
  isEmpty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as any
    return row.n === 0
  }

  close(): void {
    this.db.close()
  }
}
