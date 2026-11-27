// 由 routes.ts 拆分（P2-10，2026-11-28）
import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { KnowledgeEntryInput, VisibilitySyncMode } from '@ikit/core'
import type { ApiRouteDeps } from './deps.js'

/** 批量导入文档单次上限（超出直接 400，避免一次请求写入过多条目） */
const MAX_IMPORT_ENTRIES = 500

export function registerKnowledgeRoutes(app: FastifyInstance, ctx: Context, deps: ApiRouteDeps): void {
  const { requireAdmin, requireUser, audit, ipOf, actorOf, viewerOf, resolveViewer, parseBatchIds, normalizeVisibility } = deps

  // ---- knowledge 插件服务 ----
  app.get('/api/knowledge/entries', async (req) => {
    const q = req.query as { limit?: string; offset?: string }
    const limit = q.limit ? Number(q.limit) : undefined
    const offset = q.offset ? Number(q.offset) : undefined
    const viewer = await resolveViewer(req)
    return {
      entries: await ctx.knowledge.list(
        limit != null ? { limit, offset } : undefined,
        viewer,
      ),
    }
  })

  // 创建条目（站主）：草稿流放宽为「标题与正文不可同时为空」——
  // 新建文章在详情页编辑态首次自动保存即创建，此时用户常先粘正文后补标题。
  // 空标题回落「未命名草稿」（目录树/卡片有可读标签）。
  // 发布不变式与 PATCH 对称：`status:'published'` 时必须填写标题与正文，否则 400（避免游客立刻看到空壳条目）。
  app.post(
    '/api/knowledge/entries',
    { schema: { body: { type: 'object', properties: { title: { type: 'string', maxLength: 500 }, content: { type: 'string', maxLength: 2000000 }, status: { type: 'string', enum: ['draft', 'published'] }, visibility: { type: 'string', enum: ['public', 'login', 'groups', 'private'] }, visibleGroups: { type: 'array', items: { type: 'string' } }, category: { type: 'string', maxLength: 200 }, parentId: { type: 'string', maxLength: 64 }, tags: { type: 'array', items: { type: 'string', maxLength: 50 } } } } } },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as KnowledgeEntryInput
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      const content = typeof body?.content === 'string' ? body.content : ''
      if (!title && !content.trim()) {
        return reply.code(400).send({ error: 'title and content cannot both be empty' })
      }
      if (body?.status !== undefined && body.status !== 'draft' && body.status !== 'published') {
        return reply.code(400).send({ error: "status must be 'draft' or 'published'" })
      }
      // 发布不变式（与 PATCH 对称，服务端权威）：直接以 status:'published' 创建时，
      // 标题与正文均需非空，否则游客会立刻看到空壳/无标题条目。
      // 注意：交互式新建走 status:'draft'（默认），不受此处影响。
      if (body?.status === 'published' && (!title || !content.trim())) {
        return reply.code(400).send({ error: '发布前需填写标题与正文' })
      }
      const entry = await ctx.knowledge.create({
        title: title || '未命名草稿',
        content,
        tags: body.tags,
        category: body.category,
        parentId: body.parentId,
        cover: body.cover,
        status: body.status,
        visibility: normalizeVisibility(body.visibility) ?? undefined,
        visibleGroups: body.visibleGroups,
      })
      return reply.code(201).send({ entry })
    }),
  )

  // 批量导入文档（站主）；单次上限 MAX_IMPORT_ENTRIES 条
  // bodyLimit：批量 md 正文（含代码块/长文）可能远超 Fastify 默认 1MB，放宽到 20MB
  // body.parentId：统一挂载目标父文档（可选）；条目自带 parentId 时以条目为准（保留逐条覆盖）
  app.post(
    '/api/knowledge/import',
    {
      bodyLimit: 20 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['entries'],
          properties: {
            entries: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object' } },
            parentId: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { entries?: KnowledgeEntryInput[]; parentId?: string }
      if (!Array.isArray(body?.entries) || !body.entries.length) {
        return reply.code(400).send({ error: 'entries array is required' })
      }
      if (body.entries.length > MAX_IMPORT_ENTRIES) {
        return reply
          .code(400)
          .send({ error: `too many entries (max ${MAX_IMPORT_ENTRIES})` })
      }

      const unifiedParentId =
        typeof body.parentId === 'string' && body.parentId.trim() ? body.parentId.trim() : undefined
      // 父文档查证与分类继承都在**写入之前**完成（校验失败 → 400 零写入）。
      // list() 只返回未软删除条目：父文档不存在 / 已在回收站都会查不到 → parent not found。
      if (unifiedParentId || body.entries.some((e) => !!e?.parentId)) {
        const parents = new Map((await ctx.knowledge.list()).map((e) => [e.id, e]))
        if (unifiedParentId && !parents.has(unifiedParentId)) {
          return reply.code(400).send({ error: 'parent not found' })
        }
        // 统一父级下发到每条（条目自带 parentId 优先）；导入专用分类继承——条目未显式给分类时
        // 继承父文档分类（不改 buildEntry/create 的通用语义，以免影响"新建文章"路径）。
        body.entries = body.entries.map((it) => {
          const pid = it?.parentId || unifiedParentId
          if (!pid) return it
          const parent = parents.get(pid)
          const next: KnowledgeEntryInput = { ...it, parentId: pid }
          if (parent?.category && !it.category?.trim()) next.category = parent.category
          return next
        })
      }

      return await ctx.knowledge.importMany(body.entries)
    }),
  )

  // 更新条目（站主）：
  //  - `status`（可选）走白名单 draft|published；'archived' 或其它值 → 400（归档无写入入口）
  //  - `status:'published'` 时校验合并后 title/content 非空（服务层权威校验）→ 400
  //  - `autosave:true`（自动保存路径）→ 跳过 embedding 向量化（避免每 2s 一次外部调用）
  app.patch(
    '/api/knowledge/entries/:id',
    { schema: { body: { ...{ type: 'object', properties: { title: { type: 'string', maxLength: 500 }, content: { type: 'string', maxLength: 2000000 }, status: { type: 'string', enum: ['draft', 'published'] }, visibility: { type: 'string', enum: ['public', 'login', 'groups', 'private'] }, visibleGroups: { type: 'array', items: { type: 'string' } }, category: { type: 'string', maxLength: 200 }, parentId: { type: 'string', maxLength: 64 }, tags: { type: 'array', items: { type: 'string', maxLength: 50 } } } }, properties: { ...{ type: 'object', properties: { title: { type: 'string', maxLength: 500 }, content: { type: 'string', maxLength: 2000000 }, status: { type: 'string', enum: ['draft', 'published'] }, visibility: { type: 'string', enum: ['public', 'login', 'groups', 'private'] }, visibleGroups: { type: 'array', items: { type: 'string' } }, category: { type: 'string', maxLength: 200 }, parentId: { type: 'string', maxLength: 64 }, tags: { type: 'array', items: { type: 'string', maxLength: 50 } } } }.properties, autosave: { type: 'boolean' } } } } },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as Partial<KnowledgeEntryInput> & { autosave?: boolean }
      if (body?.status !== undefined && body.status !== 'draft' && body.status !== 'published') {
        return reply.code(400).send({ error: "status must be 'draft' or 'published'" })
      }
      const patch: Partial<KnowledgeEntryInput> = { ...body }
      delete (patch as { autosave?: boolean }).autosave
      try {
        const entry = await ctx.knowledge.update(id, patch, {
          skipEmbedding: body?.autosave === true,
        })
        if (!entry) return reply.code(404).send({ error: 'entry not found' })
        return { entry }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'update failed' })
      }
    }),
  )

  // 访问计数（公开，无需登录；不可见文章不计数）
  app.post('/api/knowledge/entries/:id/view', async (req) => {
    const id = (req.params as { id: string }).id
    const entry = await ctx.knowledge.view(id, await resolveViewer(req))
    return { entry }
  })

  // ---- 评论 ----
  app.get('/api/knowledge/entries/:id/comments', async (req) => {
    const id = (req.params as { id: string }).id
    return { comments: await ctx.knowledge.listComments(id, await resolveViewer(req)) }
  })
  app.post(
    '/api/knowledge/entries/:id/comments',
    {
      schema: {
        body: {
          type: 'object',
          required: ['content'],
          properties: { content: { type: 'string', minLength: 1, maxLength: 2000 }, parentId: { type: 'string', maxLength: 64 } },
        },
      },
    },
    (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const body = req.body as { content?: string; parentId?: string }
      try {
        const comment = await ctx.knowledge.addComment(
          id,
          { content: body?.content ?? '', parentId: body?.parentId },
          user.username,
          await viewerOf(user),
        )
        return reply.code(201).send({ comment })
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.delete('/api/knowledge/comments/:id', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      try {
        const ok = await ctx.knowledge.removeComment(id, user.role === 'admin', user.username)
        if (!ok) return reply.code(404).send({ error: '评论不存在' })
        return { ok: true }
      } catch (e: any) {
        return reply.code(403).send({ error: e.message })
      }
    }),
  )
  // 全站最新评论（供右侧「最新评论」widget 使用）
  app.get('/api/knowledge/comments', async (req) => {
    const q = req.query as { limit?: string }
    const limit = Math.max(1, Math.min(20, parseInt(q?.limit ?? '10', 10) || 10))
    const all = await ctx.knowledge.listAllComments(await resolveViewer(req))
    const comments = (all ?? []).sort(
      (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    return { comments: comments.slice(0, limit) }
  })

  // 移动文档到新的父文档（parentId 为空 = 移动到顶层）
  // 服务端环校验在 service.moveDoc 内（自身 / 子孙 / 目标不存在或已删除 → 400，目标不变）
  app.post(
    '/api/knowledge/entries/:id/move',
    { schema: { body: { type: 'object', properties: { parentId: { type: ['string', 'null'], maxLength: 64 } } } } },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { parentId?: string | null }
      try {
        const entry = await ctx.knowledge.moveDoc(id, body?.parentId ?? undefined)
        if (!entry) return reply.code(404).send({ error: 'entry not found' })
        return { entry }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'move failed' })
      }
    }),
  )

  // 同级排序（站主）
  app.post('/api/knowledge/reorder', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { parentId?: string | null; ids?: string[] }
      if (!Array.isArray(body?.ids)) {
        return reply.code(400).send({ error: 'ids array is required' })
      }
      return await ctx.knowledge.reorder(body?.parentId ?? undefined, body.ids)
    }),
  )

  app.delete('/api/knowledge/entries/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const ok = await ctx.knowledge.remove(id)
      if (!ok) return reply.code(404).send({ error: 'entry not found' })
      audit({ action: 'knowledge.delete', ok: true, user: await actorOf(req), ip: ipOf(req), target: id, detail: { soft: true } })
      return { ok: true }
    }),
  )

  // ---- 目录树批量操作（站主）----
  // 批量软删除（级联）：连带选中项的全部子孙一起进回收站（可恢复）；不提供彻底删除。
  // 服务层**先整体校验、后写入**（不存在 / 已删除 / 类型 / 空 / 上限 → 400 且零写入）。
  app.post(
    '/api/knowledge/batch-delete',
    {
      schema: {
        body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1 } } } },
      },
    },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { ids?: string[] }
      const ids = parseBatchIds(reply, body?.ids)
      if (!ids) return
      try {
        const r = await ctx.knowledge.batchRemove(ids)
        audit({ action: 'knowledge.batch_delete', ok: true, user: await actorOf(req), ip: ipOf(req), detail: { count: ids.length } })
        return r
      } catch (e: any) {
        audit({ action: 'knowledge.batch_delete', ok: false, user: await actorOf(req), ip: ipOf(req), detail: { code: e?.code } })
        return reply.code(400).send({ error: e?.message ?? 'batch delete failed' })
      }
    }),
  )

  // 批量移动（站主）：`parentId: null` / 省略 = 顶层；目标须存在且未删除；服务端环校验；
  // 嵌套选择折叠为按根处理；目标层 sortOrder 追加末尾；分类不变。
  app.post(
    '/api/knowledge/batch-move',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1 } },
            parentId: { type: ['string', 'null'], maxLength: 64 },
          },
        },
      },
    },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { ids?: string[]; parentId?: string | null }
      if (
        body?.parentId !== undefined &&
        body?.parentId !== null &&
        typeof body?.parentId !== 'string'
      ) {
        return reply.code(400).send({ error: 'parentId must be a string or null' })
      }
      const ids = parseBatchIds(reply, body?.ids)
      if (!ids) return
      try {
        const r = await ctx.knowledge.batchMove(ids, body?.parentId ?? null)
        audit({ action: 'knowledge.batch_move', ok: true, user: await actorOf(req), ip: ipOf(req), detail: { count: ids.length, parentId: body?.parentId ?? null } })
        return r
      } catch (e: any) {
        audit({ action: 'knowledge.batch_move', ok: false, user: await actorOf(req), ip: ipOf(req), detail: { code: e?.code } })
        return reply.code(400).send({ error: e?.message ?? 'batch move failed' })
      }
    }),
  )

  app.post('/api/knowledge/entries/:id/toggle-pin', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const entry = await ctx.knowledge.togglePin(id)
      if (!entry) return reply.code(404).send({ error: 'entry not found' })
      return { entry }
    }),
  )

  // ---- 回收站 ----
  app.get('/api/knowledge/trash', (req, reply) =>
    requireAdmin(req, reply, async () => ({
      entries: await ctx.knowledge.listTrash(),
    })),
  )

  app.post('/api/knowledge/trash/:id/restore', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const ok = await ctx.knowledge.restore(id)
      if (!ok) return reply.code(404).send({ error: 'entry not found' })
      return { ok: true }
    }),
  )

  app.delete('/api/knowledge/trash/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const ok = await ctx.knowledge.purge(id)
      if (!ok) return reply.code(404).send({ error: 'entry not found' })
      audit({ action: 'knowledge.trash_purge', ok: true, user: await actorOf(req), ip: ipOf(req), target: id })
      return { ok: true }
    }),
  )

  app.delete('/api/knowledge/trash', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const removed = await ctx.knowledge.emptyTrash()
      audit({ action: 'knowledge.trash_empty', ok: true, user: await actorOf(req), ip: ipOf(req), detail: { removed } })
      return { removed }
    }),
  )

  // ---- 知识库分类 ----
  app.get('/api/knowledge/categories', async (req) => ({
    categories: await ctx.knowledge.getCategories(await resolveViewer(req)),
  }))

  app.post(
    '/api/knowledge/categories',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { path?: string }
      if (!body?.path?.trim()) {
        return reply.code(400).send({ error: 'path is required' })
      }
      return { categories: await ctx.knowledge.addCategory(body.path) }
    }),
  )

  app.post('/api/knowledge/batch-category', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { ids?: string[]; category?: string }
      if (!Array.isArray(body?.ids) || !body.ids.length) {
        return reply.code(400).send({ error: 'ids array is required' })
      }
      return await ctx.knowledge.bulkSetCategory(body.ids, body.category)
    }),
  )

  // ---- 文章可见性（站主） ----
  app.patch(
    '/api/knowledge/entries/:id/visibility',
    {
      schema: {
        body: {
          type: 'object',
          required: ['visibility'],
          properties: {
            visibility: { type: 'string', enum: ['public', 'login', 'groups', 'private'] },
            visibleGroups: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['self', 'same', 'all'] },
          },
        },
      },
    },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { visibility?: string; visibleGroups?: string[]; mode?: string }
      const visibility = normalizeVisibility(body?.visibility)
      if (!visibility) return reply.code(400).send({ error: 'invalid visibility' })
      const mode: VisibilitySyncMode =
        body?.mode === 'same' || body?.mode === 'all' ? body.mode : 'self'
      return await ctx.knowledge.setVisibility(id, visibility, body?.visibleGroups, mode)
    }),
  )

  app.post('/api/knowledge/batch-visibility', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { ids?: string[]; visibility?: string; visibleGroups?: string[] }
      if (!Array.isArray(body?.ids) || !body.ids.length) {
        return reply.code(400).send({ error: 'ids array is required' })
      }
      const visibility = normalizeVisibility(body?.visibility)
      if (!visibility) return reply.code(400).send({ error: 'invalid visibility' })
      return await ctx.knowledge.bulkSetVisibility(body.ids, visibility, body?.visibleGroups)
    }),
  )
}
