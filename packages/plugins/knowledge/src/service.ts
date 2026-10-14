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

/** 批量操作单次上限（与路由层 MAX_BATCH_IDS、批量导入上限一致） */
export const MAX_BATCH_IDS = 500

/**
 * 批量操作入参归一化：去重（保留首次出现顺序）+ 类型/空值/上限校验。
 * 校验在**任何写入之前**完成——非法入参直接抛错，不产生半成品数据。
 */
function normalizeBatchIds(ids: string[]): string[] {
  if (!Array.isArray(ids)) throw new Error('ids 必须是字符串数组')
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string') throw new Error('ids 必须是字符串数组')
    const v = id.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  if (!out.length) throw new Error('未选择任何条目')
  if (out.length > MAX_BATCH_IDS) throw new Error(`单次最多处理 ${MAX_BATCH_IDS} 条`)
  return out
}

/**
 * 折叠嵌套选择：若某选中项的**祖先也在选中集合中**，则该项随祖先级联处理，不再单独处理
 * （避免重复计数 / 重复写入）。返回值为「根级」条目，顺序与入参一致。
 */
function foldNestedSelection(
  db: KnowledgeDb,
  targets: KnowledgeEntry[],
  idSet: Set<string>,
): KnowledgeEntry[] {
  const byId = new Map(db.entries.map((e) => [e.id, e]))
  return targets.filter((e) => {
    const seen = new Set<string>([e.id])
    let cur = e.parentId ? byId.get(e.parentId) : undefined
    while (cur && !seen.has(cur.id)) {
      if (idSet.has(cur.id)) return false
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return true
  })
}

/** 环校验：`targetId` 是否为 `rootId` 自身或其子孙（自环 / 逆向挂载一律拒绝） */
function isSelfOrDescendant(db: KnowledgeDb, rootId: string, targetId: string): boolean {
  if (rootId === targetId) return true
  return collectDescendants(db, rootId).some((d) => d.id === targetId)
}

/** 归一化目标父级 id：非空字符串 → trim 后的 id；空串 / null / undefined → 顶层 */
function normalizeParentId(parentId: string | null | undefined): string | undefined {
  return typeof parentId === 'string' && parentId.trim() ? parentId.trim() : undefined
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

    /**
     * 批量软删除（站主）：**级联**软删除选中项及其全部子孙（进回收站，可逐条恢复）。
     *
     * 先整体校验、后写入——任一条目不存在 / 已在回收站 / 入参非法（类型、空、>500）都在写入前抛错，
     * 因此**全成功或全失败**，不会留下半成品数据。嵌套选择（父与子同时选中）折叠为按根处理：
     * 子项由根级联覆盖，不计入 `deleted`。写库只落盘一次，事件按受影响条目逐条广播。
     */
    async batchRemove(ids) {
      const unique = normalizeBatchIds(ids)
      const db = await store.load()
      const idSet = new Set(unique)
      const targets = db.entries.filter((e) => idSet.has(e.id) && !e.deletedAt)
      if (targets.length !== unique.length) {
        throw new Error('部分条目不存在或已在回收站，请刷新后重试')
      }
      const roots = foldNestedSelection(db, targets, idSet)
      // 受影响集合 = 各根 + 其全部子孙（根之间不会互相嵌套，用 seen 兜底去重）
      const affected: KnowledgeEntry[] = []
      const seen = new Set<string>()
      for (const root of roots) {
        if (!seen.has(root.id)) {
          seen.add(root.id)
          affected.push(root)
        }
        for (const d of collectDescendants(db, root.id)) {
          if (seen.has(d.id)) continue
          seen.add(d.id)
          affected.push(d)
        }
      }
      const now = new Date().toISOString()
      for (const e of affected) {
        e.deletedAt = now
        e.updatedAt = now
      }
      await store.save()
      await refreshFuse()
      for (const e of affected) emitChange('remove', e)
      return { deleted: roots.length, affectedIds: affected.map((e) => e.id) }
    },

    /**
     * 批量移动（站主）：把选中项整体挂到 `parentId` 下（`null`/空 = 顶层），**分类保持不变**。
     *
     * 先整体校验、后写入：目标必须存在且未删除；目标不得是选中项自身、也不得是任一选中项的子孙
     * （**服务端环校验**，杜绝把父挂到自己的子树下造成环）；任一条目不存在 / 已删除 → 抛错（全失败、零写入）。
     * 嵌套选择折叠为按根处理（子孙随祖先移动，不重复设置）。序号在**目标层追加到末尾**：目标层 `sortOrder`
     * 归一化（既有同层条目按原相对顺序重排为 0..k-1，被移动项接着排 k..k+m-1，连续且无并列）。
     */
    async batchMove(ids, parentId) {
      const unique = normalizeBatchIds(ids)
      const db = await store.load()
      const pid = normalizeParentId(parentId)
      const idSet = new Set(unique)
      const targets = db.entries.filter((e) => idSet.has(e.id) && !e.deletedAt)
      if (targets.length !== unique.length) {
        throw new Error('部分条目不存在或已在回收站，请刷新后重试')
      }
      if (pid) {
        const parent = db.entries.find((e) => e.id === pid && !e.deletedAt)
        if (!parent) throw new Error('目标父文档不存在或已在回收站')
        if (idSet.has(pid)) throw new Error('不能移动到自身或其子文档下')
        for (const t of targets) {
          if (isSelfOrDescendant(db, t.id, pid)) {
            throw new Error('不能移动到自身或其子文档下')
          }
        }
      }
      const roots = foldNestedSelection(db, targets, idSet)
      const moving = new Set(roots.map((r) => r.id))
      // 目标层归一化 + 追加到末尾：既有同层条目按原相对顺序（sortOrder → createdAt）重排为 0..k-1，
      // 被移动项接着排 k..k+m-1（连续、无并列）。同层既有条目的 sortOrder 属排序簿记（同上 `reorder`），
      // 不更新 updatedAt、不单独广播（受影响条目 = 被移动项，见 `affectedIds`）。
      const siblings = db.entries
        .filter((e) => !e.deletedAt && (e.parentId || undefined) === pid && !moving.has(e.id))
        .sort(
          (a, b) =>
            (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9) || a.createdAt.localeCompare(b.createdAt),
        )
      let next = 0
      for (const s of siblings) s.sortOrder = next++
      const now = new Date().toISOString()
      for (const r of roots) {
        r.parentId = pid
        r.sortOrder = next++
        r.updatedAt = now
      }
      await store.save()
      await refreshFuse()
      for (const r of roots) emitChange('update', r)
      return { moved: roots.length, affectedIds: roots.map((r) => r.id) }
    },

    // 单个移动：`parentId` 为空 = 顶层。**服务端环校验**（前端仅做提示，不构成约束）：
    // 不能移动到自身或其子孙下（否则子树成环、目录树将无限递归）；目标必须存在且未删除。
    // 校验不通过 → 抛错（路由层转 400），目标不变。
    async moveDoc(id, parentId) {
      const db = await store.load()
      const entry = db.entries.find((e) => e.id === id && !e.deletedAt)
      if (!entry) return undefined
      const pid = normalizeParentId(parentId)
      if (pid) {
        if (pid === id) throw new Error('不能移动到自身或其子文档下')
        const parent = db.entries.find((e) => e.id === pid && !e.deletedAt)
        if (!parent) throw new Error('目标父文档不存在或已在回收站')
        if (isSelfOrDescendant(db, id, pid)) throw new Error('不能移动到自身或其子文档下')
      }
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
