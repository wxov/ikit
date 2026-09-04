import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ChatMessage, EntryVisibility, KnowledgeEntryInput, Viewer, VisibilitySyncMode } from '@ikit/core'
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
  // 客户端应传 ?client=<自身版本> 以便精确判断；未上报时视为旧版（提示更新），用于已发布旧包的热更新发现
  app.get('/api/update/manifest', async (req) => {
    const serverVersion = meta.version ?? '0.1.0'
    if (!meta.staticRoot) {
      return { currentVersion: serverVersion, latest: serverVersion, hasUpdate: false, updateKind: 'hot', bundleUrl: null, installerUrl: null }
    }
    try {
      const manifestPath = path.join(meta.staticRoot, 'web-manifest.json')
      const raw = readFileSync(manifestPath, 'utf-8')
      const m = JSON.parse(raw) as {
        version?: string
        buildTime?: string
        bundle?: string
        installerUrl?: string
      }
      const latest = m.version || serverVersion
      const client = String((req.query as { client?: string }).client ?? '').trim()
      const effectiveCurrent = client || '0.0.0' // 未上报：视为旧版
      const hasUpdate = latest !== effectiveCurrent
      // 按平台解析硬更新安装包地址（tauri→Windows 安装包 / capacitor→Android APK / web→无）
      const platform = String((req.query as { platform?: string }).platform ?? '').trim()
      const installerByPlatform: Record<string, string | undefined> = {
        tauri: process.env.UPDATE_INSTALLER_URL_TAURI,
        capacitor: process.env.UPDATE_INSTALLER_URL_ANDROID,
        web: process.env.UPDATE_INSTALLER_URL_WEB,
      }
      const installerUrl =
        installerByPlatform[platform] ?? m.installerUrl ?? process.env.UPDATE_INSTALLER_URL ?? null
      // 本次发布的更新类型：'hot'=仅需热更新（网页资源）；'hard'=需下载安装包重装（原生代码变更）。
      // web 无安装包概念一律按热更新；tauri/capacitor 由发布时环境变量 UPDATE_KIND 决定（默认 hot）
      const updateKind =
        platform === 'web' ? 'hot' : process.env.UPDATE_KIND === 'hard' ? 'hard' : 'hot'
      return {
        currentVersion: client ? effectiveCurrent : serverVersion,
        latest,
        hasUpdate,
        updateKind,
        // 分发包托管在 /update/<version>/<bundle>
        bundleUrl: hasUpdate && m.bundle ? `/update/${latest}/${m.bundle}` : null,
        installerUrl,
        buildTime: m.buildTime ?? null,
      }
    } catch {
      // 无 manifest（如开发模式）：视为已最新
      return { currentVersion: serverVersion, latest: serverVersion, hasUpdate: false, updateKind: 'hot', bundleUrl: null, installerUrl: null }
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

  // 由用户对象解析「可见性判定上下文」（组集合含包含关系展开 + 是否站主）
  async function viewerOf(user: any): Promise<Viewer> {
    const groups = await ctx.account.effectiveGroupsOf(user)
    return { groups, isAdmin: user?.role === 'admin' }
  }

  async function resolveViewer(req: any): Promise<Viewer> {
    return viewerOf(await ctx.account.me(tokenOf(req)))
  }

  function normalizeVisibility(v: string | undefined): EntryVisibility | null {
    return v === 'public' || v === 'login' || v === 'groups' || v === 'private' ? v : null
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
      const body = req.body as { username?: string; password?: string; role?: 'user' | 'admin'; groupIds?: string[] }
      try {
        const user = await ctx.account.createUser(
          body?.username ?? '',
          body?.password ?? '',
          body?.role === 'admin' ? 'admin' : 'user',
          body?.groupIds,
        )
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

  // 设置用户所属组（多组）
  app.post('/api/auth/users/:id/groups', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { groupIds?: string[] }
      try {
        return { users: await ctx.account.setUserGroups(id, body?.groupIds ?? []) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )

  // ---- 用户组管理（站主） ----
  app.get('/api/groups', (req, reply) =>
    requireAdmin(req, reply, async () => ({ groups: await ctx.account.listGroups() })),
  )
  app.post('/api/groups', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { name?: string; description?: string; parentId?: string }
      try {
        return { groups: await ctx.account.createGroup(body?.name ?? '', body?.description, body?.parentId) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.post('/api/groups/:id/parent', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { parentId?: string | null }
      try {
        return { groups: await ctx.account.setGroupParent(id, body?.parentId ?? undefined) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.patch('/api/groups/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      const body = req.body as { name?: string }
      try {
        return { groups: await ctx.account.renameGroup(id, body?.name ?? '') }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
    }),
  )
  app.delete('/api/groups/:id', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const id = (req.params as { id: string }).id
      try {
        return { groups: await ctx.account.deleteGroup(id) }
      } catch (e: any) {
        return reply.code(400).send({ error: e.message })
      }
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

  // 获取当前用户可见的插件（前台功能区数据源，按用户组判定）
  app.get('/api/plugins/visible', async (req) => {
    const user = await ctx.account.me(tokenOf(req))
    const viewer = await viewerOf(user)
    const role = !user ? 'guest' : user.role === 'admin' ? 'admin' : 'user'
    return { role, groups: viewer.groups, plugins: ctx.pluginRegistry.visibleFor(viewer.groups, viewer.isAdmin) }
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

  // 按用户组设置可见性
  app.post('/api/plugins/:name/visibility', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const name = (req.params as { name: string }).name
      const body = req.body as { groups?: string[] }
      const plugins = await ctx.pluginRegistry.setGroups(name, body?.groups ?? [])
      return { plugins }
    }),
  )

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
      // 支持 { name }（沿用商店条目，catalog 假安装 / remote 真下载）或 { name, packageUrl, sha256 }（直接远端安装）
      const body = req.body as { name?: string; packageUrl?: string; sha256?: string } | undefined
      try {
        const plugins = await ctx.pluginRegistry.install(body ?? {})
        return { plugins, store: ctx.pluginRegistry.store() }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message || '安装失败' })
      }
    }),
  )

  // 导出第三方目录包为 zip（内置 7 条目录源与 builtin 不可导出）
  app.get('/api/plugin-store/:name/export', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const name = (req.params as { name: string }).name
      try {
        const result = await ctx.pluginRegistry.exportPackage(name)
        reply.header('Content-Type', 'application/zip')
        reply.header('Content-Disposition', `attachment; filename="${result.filename}"`)
        return reply.send(result.buffer)
      } catch (e: any) {
        const msg = e?.message || '导出失败'
        const code = msg.includes('不可导出') ? 400 : 404
        return reply.code(code).send({ error: msg })
      }
    }),
  )

  // 导入插件包（zip base64 + 可选 sha256）；仅 admin，信任边界见文档
  app.post('/api/plugin-store/import', { bodyLimit: 5 * 1024 * 1024 }, (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { data?: string; sha256?: string }
      if (!body?.data) return reply.code(400).send({ error: 'data is required' })
      try {
        const plugins = await ctx.pluginRegistry.importPackage(body.data, body.sha256)
        return { plugins, store: ctx.pluginRegistry.store() }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message || '导入失败' })
      }
    }),
  )

  // 手动刷新远端静态目录源
  app.post('/api/plugin-store/refresh', (req, reply) =>
    requireAdmin(req, reply, async () => {
      await ctx.pluginRegistry.refreshRegistry()
      return { store: ctx.pluginRegistry.store() }
    }),
  )

  app.post('/api/plugin-store/:name/update', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const name = (req.params as { name: string }).name
      try {
        const plugins = await ctx.pluginRegistry.update(name)
        return { plugins, store: ctx.pluginRegistry.store() }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message || '更新失败' })
      }
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
    const viewer = await resolveViewer(req)
    return {
      entries: await ctx.knowledge.list(
        limit != null ? { limit, offset } : undefined,
        viewer,
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
        visibility: normalizeVisibility(body.visibility) ?? undefined,
        visibleGroups: body.visibleGroups,
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
  app.post('/api/knowledge/entries/:id/comments', (req, reply) =>
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
      return { ok: true }
    }),
  )

  app.delete('/api/knowledge/trash', (req, reply) =>
    requireAdmin(req, reply, async () => ({
      removed: await ctx.knowledge.emptyTrash(),
    })),
  )

  // ---- 知识库分类 ----
  app.get('/api/knowledge/categories', async (req) => ({
    categories: await ctx.knowledge.getCategories(await resolveViewer(req)),
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

  // ---- 文章可见性（站主） ----
  app.patch('/api/knowledge/entries/:id/visibility', (req, reply) =>
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

  // 执行一个服务端工具（节点本地 agent 循环复用服务端工具时调用；登录鉴权）
  app.post('/api/agent/tools/:name/run', (req, reply) =>
    requireUser(req, reply, async () => {
      const name = (req.params as { name: string }).name
      const body = req.body as { args?: Record<string, unknown> }
      return { result: await ctx.agent.runTool(name, body?.args ?? {}) }
    }),
  )

  // ---- Agent 会话管理（多会话 + 持久化 + 三端共享；登录 + 按 ownerId 隔离） ----
  app.get('/api/agent/sessions', (req, reply) =>
    requireUser(req, reply, async (user) => ({ sessions: await ctx.agent.listSessions(user.id) })),
  )
  app.post('/api/agent/sessions', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const body = req.body as { title?: string }
      const session = await ctx.agent.createSession(user.id, body?.title)
      return reply.code(201).send({ session, sessions: await ctx.agent.listSessions(user.id) })
    }),
  )
  app.patch('/api/agent/sessions/:id', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const body = req.body as { title?: string }
      const session = await ctx.agent.getSession(user.id, id)
      if (!session) return reply.code(404).send({ error: '会话不存在' })
      return { sessions: await ctx.agent.renameSession(user.id, id, body?.title ?? '') }
    }),
  )
  app.delete('/api/agent/sessions/:id', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const session = await ctx.agent.getSession(user.id, id)
      if (!session) return reply.code(404).send({ error: '会话不存在' })
      return { sessions: await ctx.agent.deleteSession(user.id, id) }
    }),
  )
  app.get('/api/agent/sessions/:id/messages', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const session = await ctx.agent.getSession(user.id, id)
      if (!session) return reply.code(404).send({ error: '会话不存在' })
      return { messages: await ctx.agent.listMessages(user.id, id) }
    }),
  )

  // ---- Agent 节点（桌面端本地 agent 运行时）注册/发现/心跳 ----
  app.get('/api/agent/nodes', async () => {
    const now = Date.now()
    const nodes = (await ctx.agent.listNodes()).map((n) => ({
      ...n,
      online: now - new Date(n.lastSeenAt).getTime() < 30000,
    }))
    return { nodes }
  })
  app.post('/api/agent/nodes/register', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const body = req.body as { id?: string; name?: string }
      if (!body?.id?.trim()) return reply.code(400).send({ error: 'id is required' })
      const node = await ctx.agent.registerNode({
        id: body.id.trim(),
        type: 'desktop',
        name: body.name?.trim() || '桌面端',
        ownerId: user.id,
      })
      return reply.code(201).send({ node })
    }),
  )
  app.post('/api/agent/nodes/:id/heartbeat', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const node = (await ctx.agent.listNodes()).find((n) => n.id === id)
      // server 节点无 ownerId 放开；desktop 节点仅本人可心跳（与派任务校验一致）
      if (!node || (node.ownerId && node.ownerId !== user.id)) {
        return reply.code(404).send({ error: '节点不存在' })
      }
      return { ok: await ctx.agent.heartbeat(id) }
    }),
  )
  app.delete('/api/agent/nodes/:id', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const node = (await ctx.agent.listNodes()).find((n) => n.id === id)
      if (!node || (node.ownerId && node.ownerId !== user.id)) {
        return reply.code(404).send({ error: '节点不存在' })
      }
      return { nodes: await ctx.agent.unregisterNode(id) }
    }),
  )

  // ---- Agent 远程任务：移动/Web 派发给指定节点，节点轮询执行并回传 ----
  app.post('/api/agent/tasks', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const body = req.body as { nodeId?: string; message?: string }
      if (!body?.nodeId?.trim() || !body?.message?.trim()) {
        return reply.code(400).send({ error: 'nodeId and message are required' })
      }
      const nodeId = body.nodeId.trim()
      const node = (await ctx.agent.listNodes()).find((n) => n.id === nodeId)
      if (!node) return reply.code(404).send({ error: 'node not found' })
      // 只能向自己名下的节点派任务（server 节点无 ownerId，放开）
      if (node.ownerId && node.ownerId !== user.id) {
        return reply.code(403).send({ error: '不能向他人名下的节点派任务' })
      }
      const task = await ctx.agent.createTask({
        nodeId,
        ownerId: user.id,
        message: body.message.trim(),
      })
      return reply.code(201).send({ task })
    }),
  )
  app.get('/api/agent/nodes/:id/tasks', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const node = (await ctx.agent.listNodes()).find((n) => n.id === id)
      if (!node || (node.ownerId && node.ownerId !== user.id)) {
        return reply.code(404).send({ error: '节点不存在' })
      }
      return { tasks: await ctx.agent.listPendingTasks(id) }
    }),
  )
  app.get('/api/agent/tasks/:id', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const task = await ctx.agent.getTask(id)
      if (!task || task.ownerId !== user.id) return { task: null }
      return { task }
    }),
  )
  app.post('/api/agent/tasks/:id/run', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const task = await ctx.agent.getTask(id)
      if (!task || task.ownerId !== user.id) return reply.code(404).send({ error: 'task not found' })
      if (task.status === 'done' || task.status === 'error') return { task }
      let answer = ''
      const steps: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }> = []
      try {
        for await (const ev of ctx.agent.runStream(task.message, [])) {
          if (ev.type === 'delta') answer += ev.content
          else if (ev.type === 'tool') {
            steps.push({ toolName: ev.toolName, toolArgs: ev.toolArgs, toolResult: ev.toolResult })
          }
        }
        return { task: await ctx.agent.completeTask(id, answer, steps) }
      } catch (e) {
        return {
          task: await ctx.agent.completeTask(
            id,
            '',
            undefined,
            e instanceof Error ? e.message : String(e),
          ),
        }
      }
    }),
  )
  app.post('/api/agent/tasks/:id/complete', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const body = req.body as { result?: string; error?: string; steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }> }
      const task = await ctx.agent.getTask(id)
      if (!task || task.ownerId !== user.id) return reply.code(404).send({ error: 'task not found' })
      const completed = await ctx.agent.completeTask(id, body?.result ?? '', body?.steps, body?.error)
      if (!completed) return reply.code(404).send({ error: 'task not found' })
      return { task: completed }
    }),
  )

  // Agent 会话流式输出（SSE）：在指定会话内对话并持久化（登录 + 归属校验，须在 writeHead 前完成）
  app.post('/api/agent/sessions/:id/chat-stream', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const id = (req.params as { id: string }).id
      const body = req.body as { message?: string }
      if (!body?.message?.trim()) {
        return reply.code(400).send({ error: 'message is required' })
      }
      // 归属校验必须在 writeHead 之前完成（否则无法返回 404）
      const session = await ctx.agent.getSession(user.id, id)
      if (!session) return reply.code(404).send({ error: '会话不存在' })

      // 持久化用户消息，并用之前的消息作为历史
      await ctx.agent.appendMessage(user.id, id, { role: 'user', content: body.message })
      const fullHistory = await ctx.agent.historyOf(user.id, id)
      const priorHistory = fullHistory.slice(0, -1)

      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      let assistantContent = ''
      const steps: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }> = []
      try {
        for await (const ev of ctx.agent.runStream(body.message, priorHistory)) {
          if (ev.type === 'delta') assistantContent += ev.content
          else if (ev.type === 'tool') {
            steps.push({ toolName: ev.toolName, toolArgs: ev.toolArgs, toolResult: ev.toolResult })
          }
          raw.write(`data: ${JSON.stringify(ev)}\n\n`)
        }
        await ctx.agent.appendMessage(user.id, id, { role: 'assistant', content: assistantContent, steps })
      } catch (e) {
        raw.write(
          `data: ${JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : String(e) })}\n\n`,
        )
      }
      raw.end()
    }),
  )

  // Agent 流式输出（SSE）（通用，无会话；登录鉴权，与 /api/llm/chat-stream 一致）
  app.post('/api/agent/chat-stream', (req, reply) =>
    requireUser(req, reply, async () => {
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
    }),
  )

  // ---- LLM 原始流式（登录鉴权）：桌面节点本地 agent 循环用它自行驱动 function-calling ----
  app.post('/api/llm/chat-stream', (req, reply) =>
    requireUser(req, reply, async () => {
      const body = req.body as {
        messages?: ChatMessage[]
        tools?: Array<{
          type: 'function'
          function: { name: string; description: string; parameters: Record<string, unknown> }
        }>
        temperature?: number
        maxTokens?: number
      }
      if (!Array.isArray(body?.messages) || !body.messages.length) {
        return reply.code(400).send({ error: 'messages is required' })
      }
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      try {
        for await (const ev of ctx.llm.chatStream(body.messages, {
          tools: body.tools,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
        })) {
          raw.write(`data: ${JSON.stringify(ev)}\n\n`)
        }
      } catch (e) {
        raw.write(
          `data: ${JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : String(e) })}\n\n`,
        )
      }
      raw.end()
    }),
  )
}
