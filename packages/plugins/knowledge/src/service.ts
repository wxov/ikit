import { randomUUID } from 'node:crypto'
import Fuse from 'fuse.js'
import type { Context } from 'cordis'
import type {
  CategoryNode,
  KnowledgeDb,
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeSearchResult,
  KnowledgeService,
} from './types.js'
import type { KnowledgeStore } from './store.js'

const STOP_WORDS = new Set([
  '的', '了', '是', '吗', '呢', '啊', '吧', '请', '请问', '什么', '怎么', '如何',
  '为什么', '哪些', '哪个', '一下', '关于', '有关', '多少', '几个', '谁', '哪个',
  'what', 'how', 'why', 'where', 'is', 'are', 'the', 'a', 'an', 'please', 'to',
])

export type EmbedFn = (texts: string[]) => Promise<number[][]>

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function normalizePath(path: string): string {
  return path.trim().split('/').filter(Boolean).join('/')
}

// 把分类路径（含父级）加入分类列表
function ensureCategory(db: KnowledgeDb, path: string) {
  if (!path) return
  const parts = path.split('/')
  let cur = ''
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p
    if (!db.categories.includes(cur)) db.categories.push(cur)
  }
}

// 从分类路径列表 + 条目构建树
function buildCategoryTree(categories: string[], entries: KnowledgeEntry[]): CategoryNode[] {
  const countMap = new Map<string, number>()
  for (const e of entries) {
    if (!e.category || e.deletedAt) continue
    const parts = e.category.split('/')
    let cur = ''
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p
      countMap.set(cur, (countMap.get(cur) ?? 0) + 1)
    }
  }

  const root: CategoryNode[] = []
  const nodeMap = new Map<string, CategoryNode>()
  for (const cat of categories) {
    const parts = cat.split('/').filter(Boolean)
    let parentPath = ''
    let level = root
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const path = parentPath ? `${parentPath}/${name}` : name
      parentPath = path
      let node = nodeMap.get(path)
      if (!node) {
        node = { name, path, count: countMap.get(path) ?? 0, children: [] }
        nodeMap.set(path, node)
        level.push(node)
      }
      level = node.children
    }
  }
  return root
}

export function createKnowledgeService(
  ctx: Context,
  store: KnowledgeStore,
  embed?: EmbedFn,
): KnowledgeService {
  const fuse = new Fuse<KnowledgeEntry>([], {
    keys: ['title', 'content', 'tags'],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
  })

  const refreshFuse = async () => {
    const db = await store.load()
    fuse.setCollection(db.entries.filter((e) => !e.deletedAt))
  }

  const emitChange = (action: 'create' | 'update' | 'remove', entry: KnowledgeEntry) => {
    ctx.emit('knowledge:changed', { action, entry })
  }

  const tokenize = (query: string) =>
    query
      .toLowerCase()
      .split(/[\s,，。、;；:：!！?？()（）'"“”‘’]+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))

  const vectorize = async (entry: KnowledgeEntry) => {
    if (!embed) return
    try {
      const [vec] = await embed([`${entry.title}\n${entry.content}`])
      if (vec?.length) entry.embedding = vec
    } catch (e) {
      console.warn('[knowledge] embedding generation failed:', e instanceof Error ? e.message : e)
    }
  }

  const ensureCategories = (db: KnowledgeDb) => {
    if (!Array.isArray(db.categories)) db.categories = []
    return db.categories
  }

  return {
    async importMany(items) {
      const db = await store.load()
      ensureCategories(db)
      const now = new Date().toISOString()
      const entries: KnowledgeEntry[] = []
      for (const input of items) {
        if (!input.title?.trim()) continue
        const category = input.category?.trim() ? normalizePath(input.category) : undefined
        if (category) ensureCategory(db, category)
        const entry: KnowledgeEntry = {
          id: randomUUID(),
          title: input.title.trim(),
          content: input.content,
          tags: input.tags ?? [],
          category,
          status: 'published',
          createdAt: now,
          updatedAt: now,
        }
        await vectorize(entry)
        db.entries.push(entry)
        entries.push(entry)
      }
      await store.save()
      await refreshFuse()
      for (const entry of entries) emitChange('create', entry)
      return { created: entries.length, entries }
    },

    async create(input) {
      const db = await store.load()
      ensureCategories(db)
      const now = new Date().toISOString()
      const category = input.category?.trim() ? normalizePath(input.category) : undefined
      if (category) ensureCategory(db, category)
      const entry: KnowledgeEntry = {
        id: randomUUID(),
        title: input.title.trim(),
        content: input.content,
        tags: input.tags ?? [],
        category,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      }
      await vectorize(entry)
      db.entries.push(entry)
      await store.save()
      await refreshFuse()
      emitChange('create', entry)
      return entry
    },

    async list(options) {
      const db = await store.load()
      const active = db.entries.filter((e) => !e.deletedAt)
      if (options?.limit != null) {
        const offset = options.offset ?? 0
        return active.slice(offset, offset + options.limit)
      }
      return active
    },

    async get(id) {
      const db = await store.load()
      return db.entries.find((e) => e.id === id)
    },

    async update(id, patch) {
      const db = await store.load()
      ensureCategories(db)
      const idx = db.entries.findIndex((e) => e.id === id)
      if (idx < 0) return undefined
      const prev = db.entries[idx]
      const category =
        patch.category !== undefined
          ? patch.category.trim()
            ? normalizePath(patch.category)
            : undefined
          : prev.category
      if (category) ensureCategory(db, category)

      const newTitle = patch.title?.trim() ?? prev.title
      const newContent = patch.content ?? prev.content

      // 版本历史：标题或内容变化时保存旧版本
      if (newTitle !== prev.title || newContent !== prev.content) {
        const history = prev.history ?? []
        history.unshift({
          version: (history[0]?.version ?? 0) + 1,
          title: prev.title,
          content: prev.content,
          updatedAt: prev.updatedAt,
        })
        if (history.length > 20) history.length = 20
        prev.history = history
      }

      const entry: KnowledgeEntry = {
        ...prev,
        title: newTitle,
        content: newContent,
        tags: patch.tags ?? prev.tags,
        category,
        updatedAt: new Date().toISOString(),
      }
      if (embed && (patch.title || patch.content)) {
        await vectorize(entry)
      }
      db.entries[idx] = entry
      await store.save()
      await refreshFuse()
      emitChange('update', entry)
      return entry
    },

    async remove(id) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return false
      entry.deletedAt = new Date().toISOString()
      entry.updatedAt = new Date().toISOString()
      await store.save()
      await refreshFuse()
      ctx.emit('knowledge:changed', { action: 'remove', entry })
      return true
    },

    async togglePin(id) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return undefined
      entry.pinned = !entry.pinned
      entry.updatedAt = new Date().toISOString()
      await store.save()
      await refreshFuse()
      emitChange('update', entry)
      return entry
    },

    async setStatus(id, status) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return undefined
      entry.status = status
      entry.updatedAt = new Date().toISOString()
      await store.save()
      await refreshFuse()
      emitChange('update', entry)
      return entry
    },

    async restoreVersion(id, version) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return undefined
      const target = entry.history?.find((h) => h.version === version)
      if (!target) return undefined
      // 当前版本也存入历史
      const history = entry.history ?? []
      history.unshift({
        version: (history[0]?.version ?? 0) + 1,
        title: entry.title,
        content: entry.content,
        updatedAt: entry.updatedAt,
      })
      if (history.length > 20) history.length = 20
      entry.history = history
      // 恢复目标版本
      entry.title = target.title
      entry.content = target.content
      entry.updatedAt = new Date().toISOString()
      if (embed) await vectorize(entry)
      await store.save()
      await refreshFuse()
      emitChange('update', entry)
      return entry
    },

    async listTrash() {
      const db = await store.load()
      return db.entries.filter((e) => e.deletedAt)
    },

    async restore(id) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && e.deletedAt)
      if (!entry) return false
      delete entry.deletedAt
      entry.updatedAt = new Date().toISOString()
      await store.save()
      await refreshFuse()
      return true
    },

    async purge(id) {
      const db = await store.load()
      const idx = db.entries.findIndex((e) => e.id === id && e.deletedAt)
      if (idx < 0) return false
      db.entries.splice(idx, 1)
      await store.save()
      await refreshFuse()
      return true
    },

    async emptyTrash() {
      const db = await store.load()
      const before = db.entries.length
      db.entries = db.entries.filter((e) => !e.deletedAt)
      const removed = before - db.entries.length
      await store.save()
      await refreshFuse()
      return removed
    },

    async search(query) {
      const q = query.trim()
      if (!q) return []
      const db = await store.load()
      await refreshFuse()

      const results = new Map<string, KnowledgeSearchResult>()

      for (const r of fuse.search(q)) {
        results.set(r.item.id, { entry: r.item, score: 1 - (r.score ?? 1) })
      }

      const tokens = tokenize(q)
      if (tokens.length) {
        for (const entry of db.entries) {
          if (entry.deletedAt || results.has(entry.id)) continue
          const haystack = `${entry.title} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase()
          let matched = 0
          for (const t of tokens) {
            if (haystack.includes(t)) matched++
          }
          if (matched > 0) {
            results.set(entry.id, { entry, score: matched / tokens.length })
          }
        }
      }

      if (embed) {
        try {
          const [qVec] = await embed([q])
          if (qVec?.length) {
            for (const entry of db.entries) {
              if (entry.deletedAt || !entry.embedding?.length) continue
              const sim = cosineSimilarity(qVec, entry.embedding)
              const existing = results.get(entry.id)
              if (!existing || sim > existing.score) {
                results.set(entry.id, { entry, score: Math.max(0, sim) })
              }
            }
          }
        } catch (e) {
          console.warn('[knowledge] vector search failed:', e instanceof Error ? e.message : e)
        }
      }

      return [...results.values()].sort((a, b) => b.score - a.score)
    },

    async count() {
      const db = await store.load()
      return db.entries.filter((e) => !e.deletedAt).length
    },

    async getCategories() {
      const db = await store.load()
      ensureCategories(db)
      return buildCategoryTree(db.categories, db.entries)
    },

    async addCategory(path) {
      const db = await store.load()
      ensureCategories(db)
      const normalized = normalizePath(path)
      if (normalized) ensureCategory(db, normalized)
      await store.save()
      return buildCategoryTree(db.categories, db.entries)
    },

    async removeCategory(path) {
      const db = await store.load()
      ensureCategories(db)
      const normalized = normalizePath(path)
      db.categories = db.categories.filter(
        (c) => c !== normalized && !c.startsWith(`${normalized}/`),
      )
      await store.save()
      return buildCategoryTree(db.categories, db.entries)
    },

    async renameCategory(oldPath, newPath) {
      const db = await store.load()
      ensureCategories(db)
      const old = normalizePath(oldPath)
      const next = normalizePath(newPath)
      if (!old || !next || old === next) {
        return buildCategoryTree(db.categories, db.entries)
      }
      // 更新分类（含子分类前缀替换）并去重
      db.categories = [...new Set(
        db.categories.map((c) => {
          if (c === old) return next
          if (c.startsWith(`${old}/`)) return next + c.slice(old.length)
          return c
        }),
      )]
      // 更新条目的分类
      for (const e of db.entries) {
        if (e.category === old) e.category = next
        else if (e.category?.startsWith(`${old}/`)) {
          e.category = next + e.category.slice(old.length)
        }
      }
      await store.save()
      return buildCategoryTree(db.categories, db.entries)
    },

    async bulkSetCategory(ids, category) {
      const db = await store.load()
      ensureCategories(db)
      const normalized = category?.trim() ? normalizePath(category) : undefined
      if (normalized) ensureCategory(db, normalized)
      let updated = 0
      for (const entry of db.entries) {
        if (ids.includes(entry.id)) {
          entry.category = normalized
          entry.updatedAt = new Date().toISOString()
          updated++
        }
      }
      if (updated) await store.save()
      return { updated }
    },
  }
}
