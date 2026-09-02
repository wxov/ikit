import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ChatMessage, KnowledgeEntryInput } from '@ikit/core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface ApiMeta {
  name?: string
  version?: string
  plugins?: Array<{ name: string; version?: string }>
  /** 前端静态目录（生产模式托管 dist） */
  staticRoot?: string
  /** 热更新分发包根目录（含 <version>/web-update.zip） */
  updateRoot?: string
  /** 上传文件目录（图片等，通过 /uploads/<file> 访问） */
  uploadsDir?: string
}

export function registerRoutes(app: FastifyInstance, ctx: Context, meta: ApiMeta = {}) {
  app.get('/api/health', async () => ({
    ok: true,
    uptime: Math.round(process.uptime()),
    ts: Date.now(),
  }))

  // 热更新：返回可用的 web 版本清单（来源：dist/web-manifest.json）
  app.get('/api/update/manifest', async () => {
    const currentVersion = meta.version ?? '0.1.0'
    if (!meta.staticRoot) {
      return { currentVersion, latest: currentVersion, hasUpdate: false, bundleUrl: null }
    }
    try {
      const manifestPath = path.join(meta.staticRoot, 'web-manifest.json')
      const raw = readFileSync(manifestPath, 'utf-8')
      const m = JSON.parse(raw) as {
        version?: string
        buildTime?: string
        bundle?: string
      }
      const latest = m.version || currentVersion
      const hasUpdate = latest !== currentVersion
      return {
        currentVersion,
        latest,
        hasUpdate,
        // 分发包托管在 /update/<version>/<bundle>
        bundleUrl: hasUpdate && m.bundle ? `/update/${latest}/${m.bundle}` : null,
        buildTime: m.buildTime ?? null,
      }
    } catch {
      // 无 manifest（如开发模式）：视为已最新
      return { currentVersion, latest: currentVersion, hasUpdate: false, bundleUrl: null }
    }
  })

  app.get('/api/system/info', async () => ({
    name: meta.name ?? 'i-kit',
    version: meta.version ?? '0.1.0',
    plugins: meta.plugins ?? [],
  }))

  // ---- 账号体系 ----
  const tokenOf = (req: any) =>
    (req.headers['authorization'] as string || '').replace(/^Bearer\s+/i, '').trim()

  function requireAdmin<T>(req: any, reply: any, fn: () => Promise<T>) {
    return (async () => {
      const token = tokenOf(req)
      const user = await ctx.account.me(token)
      if (!user || user.role !== 'admin') {
        return reply.code(403).send({ error: '需要站主权限' })
      }
      return await fn()
    })()
  }

  // 要求已登录（游客只读，写操作需登录）
  function requireUser<T>(req: any, reply: any, fn: (user: any) => Promise<T>) {
    return (async () => {
      const user = await ctx.account.me(tokenOf(req))
      if (!user) {
        return reply.code(401).send({ error: '请先登录' })
      }
      return await fn(user)
    })()
  }

  // 注册已屏蔽（站主在用户管理手动建号）；保留登录/找回
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    try {
      const r = await ctx.account.login(username ?? '', password ?? '')
      return { token: r.token, user: r.user }
    } catch (e: any) {
      return reply.code(401).send({ error: e.message })
    }
  })

  app.post('/api/auth/request-reset', async (req) => {
    const { username } = (req.body ?? {}) as { username?: string }
    const r = await ctx.account.requestReset(username ?? '')
    // 已配置邮件：sent=true（不发纯文本令牌）；未配置则返回 resetToken 供演示/前端
    return { sent: r?.sent ?? false, resetToken: r?.resetToken ?? null }
  })

  app.post('/api/auth/reset-password', async (req, reply) => {
    const { resetToken, password } = (req.body ?? {}) as { resetToken?: string; password?: string }
    const ok = await ctx.account.resetPassword(resetToken ?? '', password ?? '')
    if (!ok) return reply.code(400).send({ error: '重置码无效或已过期' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (req) => {
    const user = await ctx.account.me(tokenOf(req))
    return { user }
  })

  app.post('/api/auth/logout', async (req) => {
    await ctx.account.logout(tokenOf(req))
    return { ok: true }
  })

  // ---- 用户自助修改资料（改用户名 / 改密码）----
  app.post('/api/auth/profile', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const body = req.body as { username?: string; oldPassword?: string; newPassword?: string }
      try {
        const updated = await ctx.account.updateProfile(user.id, {
          username: body?.username,
          oldPassword: body?.oldPassword,
          newPassword: body?.newPassword,
        })
        return { user: updated }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )

  // ---- 站主管理用户 ----
  app.get('/api/auth/users', (req, reply) => requireAdmin(req, reply, async () => ({ users: await ctx.account.listUsers() })))
  app.post('/api/auth/users', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { username?: string; password?: string; role?: 'user' | 'admin' }
      try {
        const user = await ctx.account.createUser(body?.username ?? '', body?.password ?? '', body?.role === 'admin' ? 'admin' : 'user')
        return reply.code(201).send({ user, users: await ctx.account.listUsers() })
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.post('/api/auth/users/:id/disable', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { disabled?: boolean }
      return { users: await ctx.account.disableUser(id, !!body?.disabled) }
    }),
  )
  app.delete('/api/auth/users/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      return { users: await ctx.account.deleteUser(id) }
    }),
  )
  app.post('/api/auth/users/:id/role', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { role?: 'user' | 'admin' }
      return { users: await ctx.account.setRole(id, body?.role === 'admin' ? 'admin' : 'user') }
    }),
  )

  // ---- 插件注册表（权限核心闭环） ----
  // 解析当前角色：仅从 Authorization Bearer token 解析真实用户角色；无有效会话一律 guest
  async function resolveRole(req: any): Promise<'guest' | 'user' | 'admin'> {
    const token = tokenOf(req)
    if (!token) return 'guest'
    const role = await ctx.account.roleOf(token)
    return role
  }

  // 获取当前角色可见的插件（前台功能区数据源）
  app.get('/api/plugins/visible', async (req) => {
    const role = await resolveRole(req)
    return { role, plugins: ctx.pluginRegistry.visibleFor(role) }
  })

  // 获取全部插件（站主管理用）
  app.get('/api/plugins', async (req, reply) => {
    const role = await resolveRole(req)
    if (role !== 'admin') return reply.code(403).send({ error: '需要站主权限' })
    return { plugins: ctx.pluginRegistry.list() }
  })

  // 启用/禁用插件
  app.post('/api/plugins/:name/enable', async (req, reply) => {
    const role = await resolveRole(req)
    if (role !== 'admin') return reply.code(403).send({ error: '需要站主权限' })
    const name = (req.params as { name: string }).name
    const body = req.body as { enabled?: boolean }
    const plugins = await ctx.pluginRegistry.enable(name, !!body?.enabled)
    return { plugins }
  })

  // 排序
  app.post('/api/plugins/order', async (req, reply) => {
    const role = await resolveRole(req)
    if (role !== 'admin') return reply.code(403).send({ error: '需要站主权限' })
    const body = req.body as { ordered?: string[] }
    const plugins = await ctx.pluginRegistry.setOrder(body?.ordered ?? [])
    return { plugins }
  })

  // 按角色可见性
  app.post('/api/plugins/:name/visibility', async (req, reply) => {
    const name = (req.params as { name: string }).name
    const body = req.body as { role?: string; visible?: boolean }
    const role = (['guest', 'user', 'admin'].includes(body?.role ?? '')
      ? body!.role
      : 'guest') as 'guest' | 'user' | 'admin'
    const plugins = await ctx.pluginRegistry.setVisibility(name, role, !!body?.visible)
    return { plugins }
  })

  // ---- 插件商店 ----
  app.get('/api/plugin-store', async () => ({
    store: ctx.pluginRegistry.store(),
  }))

  app.get('/api/plugin-store/categories', async () => ({
    categories: ctx.pluginRegistry.categories(),
  }))

  app.post('/api/plugin-store/rate', async (req) => {
    const body = req.body as { name?: string; score?: number; comment?: string }
    const author = (await ctx.account.me(tokenOf(req)))?.username ?? '匿名'
    const store = await ctx.pluginRegistry.rate(body?.name ?? '', author, body?.score ?? 5, body?.comment ?? '')
    return { store }
  })

  app.post('/api/plugin-store/install', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { name?: string }
      const plugins = await ctx.pluginRegistry.install(body?.name ?? '')
      return { plugins, store: ctx.pluginRegistry.store() }
    }),
  )

  app.post('/api/plugin-store/:name/update', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const name = (req.params as { name: string }).name
      const plugins = await ctx.pluginRegistry.update(name)
      return { plugins, store: ctx.pluginRegistry.store() }
    }),
  )

  app.delete('/api/plugin-store/:name', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const name = (req.params as { name: string }).name
      const plugins = await ctx.pluginRegistry.uninstall(name)
      return { plugins, store: ctx.pluginRegistry.store() }
    }),
  )

  // ---- 商店插件真实数据服务（统计/便签/日程/待办） ----
  app.get('/api/plugins-data/statistics', async () => ({
    statistics: await ctx.storeData.statistics(),
  }))

  app.get('/api/plugins-data/notes', async () => ({ notes: await ctx.storeData.listNotes() }))
  app.post('/api/plugins-data/notes', (req, reply) =>
    requireUser(req, reply, async () => {
      const { text } = (req.body ?? {}) as { text?: string }
      return { notes: await ctx.storeData.addNote(text ?? '') }
    }),
  )
  app.delete('/api/plugins-data/notes/:id', (req, reply) =>
    requireUser(req, reply, async () => {
      const id = (req.params as { id: string }).id
      return { notes: await ctx.storeData.deleteNote(id) }
    }),
  )

  app.get('/api/plugins-data/events', async () => ({ events: await ctx.storeData.listEvents() }))
  app.post('/api/plugins-data/events', (req, reply) =>
    requireUser(req, reply, async () => {
      const body = (req.body ?? {}) as { title?: string; date?: string; time?: string }
      return { events: await ctx.storeData.addEvent({ title: body.title ?? '', date: body.date ?? '', time: body.time ?? '' }) }
    }),
  )
  app.delete('/api/plugins-data/events/:id', (req, reply) =>
    requireUser(req, reply, async () => {
      const id = (req.params as { id: string }).id
      return { events: await ctx.storeData.deleteEvent(id) }
    }),
  )
  app.post('/api/plugins-data/events/:id/toggle', (req, reply) =>
    requireUser(req, reply, async () => {
      const id = (req.params as { id: string }).id
      return { events: await ctx.storeData.toggleEvent(id) }
    }),
  )

  app.get('/api/plugins-data/todos', async () => ({ todos: await ctx.storeData.listTodos() }))
  app.post('/api/plugins-data/todos', (req, reply) =>
    requireUser(req, reply, async () => {
      const { text } = (req.body ?? {}) as { text?: string }
      return { todos: await ctx.storeData.addTodo(text ?? '') }
    }),
  )
  app.post('/api/plugins-data/todos/:id/toggle', (req, reply) =>
    requireUser(req, reply, async () => {
      const id = (req.params as { id: string }).id
      return { todos: await ctx.storeData.toggleTodo(id) }
    }),
  )
  app.delete('/api/plugins-data/todos/:id', (req, reply) =>
    requireUser(req, reply, async () => {
      const id = (req.params as { id: string }).id
      return { todos: await ctx.storeData.deleteTodo(id) }
    }),
  )

  // 天气
  app.get('/api/plugins-data/weather', async (req) => {
    const q = (req.query as { city?: string }).city ?? '北京'
    return { weather: await ctx.storeData.weather(q) }
  })
  // RSS
  app.get('/api/plugins-data/rss', async (req) => {
    const q = (req.query as { url?: string }).url ?? ''
    return { items: await ctx.storeData.rss(q) }
  })
  // Markdown 剪贴板
  app.get('/api/plugins-data/md', async () => ({ drafts: await ctx.storeData.listMd() }))
  app.post('/api/plugins-data/md', (req, reply) =>
    requireUser(req, reply, async () => {
      const { text } = (req.body ?? {}) as { text?: string }
      return { drafts: await ctx.storeData.saveMd(text ?? '') }
    }),
  )
  app.delete('/api/plugins-data/md/:id', (req, reply) =>
    requireUser(req, reply, async () => {
      const id = (req.params as { id: string }).id
      return { drafts: await ctx.storeData.deleteMd(id) }
    }),
  )

  // ---- demo 插件服务 ----
  app.get('/api/demo/hello', async (req) => {
    const name = (req.query as { name?: string }).name
    return { message: ctx.demo.hello(name) }
  })

  app.get('/api/demo/status', async () => ({
    greetCount: ctx.demo.greetCount,
  }))

  // ---- knowledge 插件服务 ----
  app.get('/api/knowledge/entries', async (req) => {
    const q = req.query as { limit?: string; offset?: string }
    const limit = q.limit ? Number(q.limit) : undefined
    const offset = q.offset ? Number(q.offset) : undefined
    return {
      entries: await ctx.knowledge.list(
        limit != null ? { limit, offset } : undefined,
      ),
    }
  })

  app.post('/api/knowledge/entries', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as KnowledgeEntryInput
      if (!body?.title?.trim() || !body?.content) {
        return reply.code(400).send({ error: 'title and content are required' })
      }
      const entry = await ctx.knowledge.create({
        title: body.title,
        content: body.content,
        tags: body.tags,
        category: body.category,
        parentId: body.parentId,
        cover: body.cover,
      })
      return reply.code(201).send({ entry })
    }),
  )

  app.patch('/api/knowledge/entries/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const entry = await ctx.knowledge.update(id, req.body as Partial<KnowledgeEntryInput>)
      if (!entry) return reply.code(404).send({ error: 'entry not found' })
      return { entry }
    }),
  )

  // 访问计数（公开，无需登录；打开/浏览条目时调用）
  app.post('/api/knowledge/entries/:id/view', async (req) => {
    const id = (req.params as { id: string }).id
    const entry = await ctx.knowledge.view(id)
    return { entry }
  })

  // ---- 评论 ----
  app.get('/api/knowledge/entries/:id/comments', async (req) => {
    const id = (req.params as { id: string }).id
    return { comments: await ctx.knowledge.listComments(id) }
  })
  app.post('/api/knowledge/entries/:id/comments', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const body = req.body as { content?: string; parentId?: string }
      try {
        const comment = await ctx.knowledge.addComment(id, { content: body?.content ?? '', parentId: body?.parentId }, user.username)
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
    const all = await ctx.knowledge.listAllComments()
    const comments = (all ?? []).sort(
      (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    return { comments: comments.slice(0, limit) }
  })

  // 移动文档到新的父文档（parentId 为空 = 移动到顶层）
  app.post('/api/knowledge/entries/:id/move', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { parentId?: string | null }
      const entry = await ctx.knowledge.moveDoc(id, body?.parentId ?? undefined)
      if (!entry) return reply.code(404).send({ error: 'entry not found' })
      return { entry }
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
      return { ok: true }
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
  app.get('/api/knowledge/trash', async () => ({
    entries: await ctx.knowledge.listTrash(),
  }))

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
      return { ok: true }
    }),
  )

  app.delete('/api/knowledge/trash', (req, reply) =>
    requireAdmin(req, reply, async () => ({
      removed: await ctx.knowledge.emptyTrash(),
    })),
  )

  // ---- 知识库分类 ----
  app.get('/api/knowledge/categories', async () => ({
    categories: await ctx.knowledge.getCategories(),
  }))

  app.post('/api/knowledge/categories', (req, reply) =>
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

  // ---- 图片上传（站主）----
  app.post('/api/upload', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { name?: string; data?: string }
      if (!body?.data) return reply.code(400).send({ error: 'data is required' })
      const m = /^data:(image\/[\w+.-]+);base64,/.exec(body.data)
      const base64 = m ? body.data.slice(m[0].length) : body.data
      const buf = Buffer.from(base64, 'base64')
      if (!buf.length || buf.length > 5 * 1024 * 1024) {
        return reply.code(400).send({ error: 'invalid or too large (max 5MB)' })
      }
      if (!meta.uploadsDir) return reply.code(400).send({ error: 'uploads not configured' })
      mkdirSync(meta.uploadsDir, { recursive: true })
      const ext = m
        ? m[1].split('/')[1].replace(/[^a-z0-9]/gi, '')
        : ((body.name?.split('.').pop() || 'png').replace(/[^a-z0-9]/gi, '') || 'png')
      const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
      writeFileSync(path.join(meta.uploadsDir, file), buf)
      return { url: `/uploads/${file}` }
    }),
  )

  // ---- agent 插件服务 ----
  app.get('/api/agent/tools', async () => ({
    tools: ctx.agent.listTools(),
  }))

  // Agent 流式输出（SSE）
  app.post('/api/agent/chat-stream', async (req, reply) => {
    const body = req.body as { message?: string; history?: ChatMessage[] }
    if (!body?.message?.trim()) {
      return reply.code(400).send({ error: 'message is required' })
    }
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    try {
      for await (const ev of ctx.agent.runStream(body.message, body.history ?? [])) {
        raw.write(`data: ${JSON.stringify(ev)}\n\n`)
      }
    } catch (e) {
      raw.write(
        `data: ${JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : String(e) })}\n\n`,
      )
    }
    raw.end()
  })
}
