import { randomUUID } from 'node:crypto'
import Fuse from 'fuse.js'
import type { Context } from 'cordis'
import type {
  CategoryNode,
  EntryVisibility,
  KnowledgeComment,
  KnowledgeDb,
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeSearchResult,
  KnowledgeService,
  Viewer,
  VisibilitySyncMode,
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

/**
 * 草稿可见性开关（方案 X）：
 * - `admin-only`（默认）：非 admin 的读路径过滤掉未发布条目（草稿仅站主可见）；
 * - `everyone`：完全等价历史行为（零过滤），用于一句话回滚。
 */
export type DraftVisibility = 'admin-only' | 'everyone'

/** 发布态判定：`undefined` / `NULL` 视为 `published`（存量数据兼容，见方案 F1） */
export function isPublished(entry: KnowledgeEntry): boolean {
  return (entry.status ?? 'published') === 'published'
}

// 可见性判定工厂：admin 恒可见；非 admin 先过「发布态」再按 visibility 级别判断
function makeIsVisible(draftVisibility: DraftVisibility) {
  return function isVisible(entry: KnowledgeEntry, viewer: Viewer): boolean {
    if (viewer.isAdmin) return true
    // 方案 X：草稿仅站主可见（fail-closed，'archived' 同样视为未发布）
    if (draftVisibility !== 'everyone' && !isPublished(entry)) return false
    const v = entry.visibility ?? 'public'
    if (v === 'public') return true
    if (v === 'private') return false
    if (v === 'login') return !viewer.groups.includes('guest')
    if (v === 'groups') return (entry.visibleGroups ?? []).some((g) => viewer.groups.includes(g))
    return false
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

// 收集某文档的全部后代（不含自身，递归、广度优先）
function collectDescendants(db: KnowledgeDb, rootId: string): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = []
  const queue = db.entries.filter((e) => e.parentId === rootId && !e.deletedAt)
  while (queue.length) {
    const cur = queue.shift()!
    out.push(cur)
    const children = db.entries.filter((e) => e.parentId === cur.id && !e.deletedAt)
    queue.push(...children)
  }
  return out
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
  options?: { draftVisibility?: DraftVisibility },
): KnowledgeService {
  const isVisible = makeIsVisible(options?.draftVisibility ?? 'admin-only')
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

  /**
   * 构造条目实体：`create` 与 `importMany` 共用，保证两条写入路径的分类补全、
   * sortOrder、可见性继承等规范化逻辑完全一致（不会各自漂移）。
   *
   * `defaultStatus` 由**调用方**决定（完善⑦）：`create()` = `'draft'`（交互式新建走草稿流），
   * `importMany()` = `'published'`（导入即可见）；`input.status` 显式传入时优先。
   */
  const buildEntry = (
    db: KnowledgeDb,
    input: KnowledgeEntryInput,
    defaultStatus: 'draft' | 'published' = 'draft',
  ): KnowledgeEntry => {
    const now = new Date().toISOString()
    const category = input.category?.trim() ? normalizePath(input.category) : undefined
    if (category) ensureCategory(db, category)
    // 可见性：显式指定优先；否则继承父文档（默认公开）
    let visibility: EntryVisibility | undefined = input.visibility
    let visibleGroups = input.visibleGroups
    if (!visibility && input.parentId) {
      const parent = db.entries.find((e) => e.id === input.parentId && !e.deletedAt)
      if (parent) {
        visibility = parent.visibility
        visibleGroups = parent.visibleGroups
      }
    }
    return {
      id: randomUUID(),
      title: input.title.trim(),
      content: input.content ?? '',
      tags: input.tags ?? [],
      category,
      parentId: input.parentId || undefined,
      sortOrder: db.entries.filter(
        (e) => !e.deletedAt && (e.parentId || undefined) === (input.parentId || undefined),
      ).length,
      status: input.status ?? defaultStatus,
      cover: input.cover || undefined,
      visibility: visibility && visibility !== 'public' ? visibility : undefined,
      visibleGroups: visibility === 'groups' ? visibleGroups : undefined,
      views: 0,
      createdAt: now,
      updatedAt: now,
    }
  }

  return {
    async create(input) {
      const db = await store.load()
      ensureCategories(db)
      const entry = buildEntry(db, input)
      await vectorize(entry)
      db.entries.push(entry)
      await store.save()
      await refreshFuse()
      emitChange('create', entry)
      return entry
    },

    // 批量导入（站主）：逐条走与 create 相同的构造逻辑（分类补全 / sortOrder / 可见性继承 /
    // 向量化 / 逐条 knowledge:changed 广播），但只在末尾保存一次 + 重建一次检索索引——
    // 上限 500 条时避免 JSON/SQLite 反复全量落盘；跳过标题为空的条目（不计入 created）。
    // **默认发布态为 published**（完善⑦：导入即可见，无需逐条手动发布）。
    async importMany(items) {
      const created: KnowledgeEntry[] = []
      for (const input of items) {
        if (typeof input?.title !== 'string' || !input.title.trim()) continue
        const db = await store.load()
        ensureCategories(db)
        const entry = buildEntry(db, input, 'published')
        await vectorize(entry)
        db.entries.push(entry)
        created.push(entry)
      }
      if (created.length) {
        await store.save()
        await refreshFuse()
        for (const entry of created) emitChange('create', entry)
      }
      return { created: created.length, entries: created }
    },

    async list(options, viewer) {
      const db = await store.load()
      let active = db.entries.filter((e) => !e.deletedAt)
      if (viewer) active = active.filter((e) => isVisible(e, viewer))
      if (options?.limit != null) {
        const offset = options.offset ?? 0
        return active.slice(offset, offset + options.limit)
      }
      return active
    },

    async update(id, patch, opts) {
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

      // 空标题回落原值（自动保存时标题可能尚未填写，不能把已有标题清空）
      const newTitle = patch.title?.trim() || prev.title
      const newContent = patch.content ?? prev.content

      // 发布态（完善⑦）：显式传入才变更；'archived' 不在白名单（由路由 400 拒绝）
      const newStatus: KnowledgeEntry['status'] =
        patch.status === 'draft' || patch.status === 'published' ? patch.status : prev.status

      // 发布前置校验（服务端权威）：合并后 title/content 均需非空
      if (newStatus === 'published' && (!newTitle.trim() || !newContent.trim())) {
        throw new Error('发布前需填写标题与正文')
      }

      // 可见性：显式传入才变更；'public' 归一化为未设置
      let visibility = prev.visibility
      let visibleGroups = prev.visibleGroups
      if (patch.visibility !== undefined) {
        visibility = patch.visibility && patch.visibility !== 'public' ? patch.visibility : undefined
        visibleGroups = patch.visibility === 'groups' ? patch.visibleGroups : undefined
      }

      const entry: KnowledgeEntry = {
        ...prev,
        title: newTitle,
        content: newContent,
        tags: patch.tags ?? prev.tags,
        category,
        cover: patch.cover !== undefined ? patch.cover || undefined : prev.cover,
        status: newStatus,
        visibility,
        visibleGroups,
        updatedAt: new Date().toISOString(),
      }
      // 自动保存路径（opts.skipEmbedding）跳过向量化：避免每 2s 一次外部 embedding 调用；
      // 发布/撤回与手动保存不跳过 → 检索质量不受影响。
      if (embed && !opts?.skipEmbedding && (patch.title || patch.content)) {
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

    async moveDoc(id, parentId) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return undefined
      const pid = parentId || undefined
      entry.parentId = pid
      // 移动到目标末尾
      entry.sortOrder = db.entries.filter(
        (e) => !e.deletedAt && (e.parentId || undefined) === pid && e.id !== id,
      ).length
      entry.updatedAt = new Date().toISOString()
      await store.save()
      await refreshFuse()
      emitChange('update', entry)
      return entry
    },

    async reorder(parentId, orderedIds) {
      const db = await store.load()
      const pid = parentId || undefined
      let updated = 0
      for (let i = 0; i < orderedIds.length; i++) {
        const entry = db.entries.find(
          (e) => e.id === orderedIds[i] && !e.deletedAt && (e.parentId || undefined) === pid,
        )
        if (entry) {
          entry.sortOrder = i
          updated++
        }
      }
      if (updated) await store.save()
      return { updated }
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

    async view(id, viewer) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return undefined
      if (viewer && !isVisible(entry, viewer)) return undefined
      entry.views = (entry.views ?? 0) + 1
      await store.save()
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

    async search(query, viewer) {
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

      const out = [...results.values()]
      const visible = viewer ? out.filter((r) => isVisible(r.entry, viewer)) : out
      return visible.sort((a, b) => b.score - a.score)
    },

    async count() {
      const db = await store.load()
      return db.entries.filter((e) => !e.deletedAt).length
    },

    async getCategories(viewer) {
      const db = await store.load()
      ensureCategories(db)
      const entries = viewer
        ? db.entries.filter((e) => !e.deletedAt && isVisible(e, viewer))
        : db.entries
      return buildCategoryTree(db.categories, entries)
    },

    async addCategory(path) {
      const db = await store.load()
      ensureCategories(db)
      const normalized = normalizePath(path)
      if (normalized) ensureCategory(db, normalized)
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

    async setVisibility(id, visibility, visibleGroups, syncMode = 'self') {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return { updated: 0 }
      const origVis = entry.visibility ?? 'public'
      const origGroups = entry.visibleGroups ?? []
      const apply = (e: KnowledgeEntry) => {
        e.visibility = visibility && visibility !== 'public' ? visibility : undefined
        e.visibleGroups = visibility === 'groups' ? (visibleGroups ?? []) : undefined
        e.updatedAt = new Date().toISOString()
      }
      apply(entry)
      let updated = 1
      if (syncMode === 'all' || syncMode === 'same') {
        const descendants = collectDescendants(db, id)
        for (const d of descendants) {
          if (syncMode === 'all') {
            apply(d)
            updated++
          } else {
            const dv = d.visibility ?? 'public'
            const dg = d.visibleGroups ?? []
            if (dv === origVis && arraysEqual(dg, origGroups)) {
              apply(d)
              updated++
            }
          }
        }
      }
      await store.save()
      await refreshFuse()
      emitChange('update', entry)
      return { updated }
    },

    async bulkSetVisibility(ids, visibility, visibleGroups) {
      const db = await store.load()
      let updated = 0
      for (const entry of db.entries) {
        if (ids.includes(entry.id)) {
          entry.visibility = visibility && visibility !== 'public' ? visibility : undefined
          entry.visibleGroups = visibility === 'groups' ? (visibleGroups ?? []) : undefined
          entry.updatedAt = new Date().toISOString()
          updated++
        }
      }
      if (updated) await store.save()
      return { updated }
    },

    async listComments(entryId, viewer) {
      const db = await store.load()
      if (viewer) {
        const entry = db.entries.find((e) => e.id === entryId && !e.deletedAt)
        if (!entry || !isVisible(entry, viewer)) return []
      }
      const comments = db.comments ?? []
      return comments
        .filter((c) => c.entryId === entryId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    },

    async addComment(entryId, input, author, viewer) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === entryId && !e.deletedAt)
      if (!entry) throw new Error('条目不存在')
      if (viewer && !isVisible(entry, viewer)) throw new Error('无权访问该文章')
      const content = (input.content || '').trim()
      if (!content) throw new Error('评论内容不能为空')
      if (!db.comments) db.comments = []
      const comment: KnowledgeComment = {
        id: randomUUID(),
        entryId,
        author,
        content,
        parentId: input.parentId || undefined,
        likes: 0,
        createdAt: new Date().toISOString(),
      }
      db.comments.push(comment)
      await store.save()
      ctx.emit('knowledge:changed', { action: 'comment', entryId, comment })
      return comment
    },

    async listAllComments(viewer) {
      const db = await store.load()
      const comments = db.comments ?? []
      if (!viewer) return comments.slice()
      const visibleIds = new Set(
        db.entries.filter((e) => !e.deletedAt && isVisible(e, viewer)).map((e) => e.id),
      )
      return comments.filter((c) => visibleIds.has(c.entryId))
    },

    async removeComment(id, isAdmin, author) {
      const db = await store.load()
      const comments = db.comments ?? []
      const idx = comments.findIndex((c) => c.id === id)
      if (idx < 0) return false
      const c = comments[idx]
      if (!isAdmin && c.author !== author) throw new Error('无权删除该评论')
      comments.splice(idx, 1)
      db.comments = comments
      await store.save()
      ctx.emit('knowledge:changed', { action: 'comment-removed', id })
      return true
    },
  }
}
