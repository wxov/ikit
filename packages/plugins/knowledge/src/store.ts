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
        parent_id TEXT,
        sort_order INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        embedding TEXT,
        cover TEXT,
        views INTEGER NOT NULL DEFAULT 0,
        rating INTEGER,
        likes INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        summary TEXT,
        history TEXT,
        share_token TEXT
      );
      CREATE TABLE IF NOT EXISTS categories (
        path TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        parent_id TEXT,
        likes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `)
    // 迁移：为旧库补充缺失的列
    const cols = (this.db.prepare('PRAGMA table_info(entries)').all() as any[]).map(
      (c) => c.name,
    )
    const addCol = (name: string, def: string) => {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${def}`)
    }
    addCol('parent_id', 'TEXT')
    addCol('sort_order', 'INTEGER')
    addCol('cover', 'TEXT')
    addCol('views', 'INTEGER NOT NULL DEFAULT 0')
    addCol('rating', 'INTEGER')
    addCol('likes', 'INTEGER NOT NULL DEFAULT 0')
    addCol('status', 'TEXT')
    addCol('summary', 'TEXT')
    addCol('history', 'TEXT')
    addCol('share_token', 'TEXT')
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
      parentId: r.parent_id ?? undefined,
      sortOrder: r.sort_order ?? undefined,
      pinned: !!r.pinned,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at ?? undefined,
      embedding: r.embedding ? JSON.parse(r.embedding) : undefined,
      cover: r.cover ?? undefined,
      views: r.views ?? undefined,
      rating: r.rating ?? undefined,
      likes: r.likes ?? undefined,
      status: (r.status as KnowledgeEntry['status']) || undefined,
      summary: r.summary ?? undefined,
      history: r.history ? JSON.parse(r.history) : undefined,
      shareToken: r.share_token ?? undefined,
    }))
    const cats = this.db.prepare('SELECT path FROM categories').all() as any[]
    const cmts = this.db.prepare('SELECT * FROM comments').all() as any[]
    this.cache = {
      entries,
      categories: cats.map((c) => c.path),
      comments: cmts.map((c) => ({
        id: c.id,
        entryId: c.entry_id,
        author: c.author,
        content: c.content,
        parentId: c.parent_id ?? undefined,
        likes: c.likes ?? undefined,
        createdAt: c.created_at,
      })),
    }
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
      this.db.exec('DELETE FROM comments')
      const ins = this.db.prepare(`
        INSERT INTO entries (id, title, content, tags, category, parent_id, sort_order, pinned, created_at, updated_at, deleted_at, embedding, cover, views, rating, likes, status, summary, history, share_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const e of data.entries) {
        ins.run(
          e.id,
          e.title,
          e.content,
          JSON.stringify(e.tags),
          e.category ?? null,
          e.parentId ?? null,
          e.sortOrder ?? null,
          e.pinned ? 1 : 0,
          e.createdAt,
          e.updatedAt,
          e.deletedAt ?? null,
          e.embedding ? JSON.stringify(e.embedding) : null,
          e.cover ?? null,
          e.views ?? 0,
          e.rating ?? null,
          e.likes ?? 0,
          e.status ?? null,
          e.summary ?? null,
          e.history ? JSON.stringify(e.history) : null,
          e.shareToken ?? null,
        )
      }
      const insCat = this.db.prepare('INSERT INTO categories (path) VALUES (?)')
      for (const c of data.categories) {
        insCat.run(c)
      }
      const insCmt = this.db.prepare(`
        INSERT INTO comments (id, entry_id, author, content, parent_id, likes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const c of data.comments ?? []) {
        insCmt.run(c.id, c.entryId, c.author, c.content, c.parentId ?? null, c.likes ?? 0, c.createdAt)
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
