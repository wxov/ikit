import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ChatMessage, EntryVisibility, KnowledgeEntryInput, Viewer, VisibilitySyncMode } from '@ikit/core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// 批量导入文档单次上限（超出直接 400，避免一次请求写入过多条目）
const MAX_IMPORT_ENTRIES = 500
// 批量删除 / 批量移动单次上限（与 knowledge 服务层 MAX_BATCH_IDS 一致）
const MAX_BATCH_IDS = 500

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

  // user → Agent 调用上下文（完善④）：viewer 由「调用者」解析，与 HTTP 知识库接口同源
  async function callOf(user: any) {
    return { viewer: await viewerOf(user), userId: user?.id as string | undefined }
  }

  function normalizeVisibility(v: string | undefined): EntryVisibility | null {
    return v === 'public' || v === 'login' || v === 'groups' || v === 'private' ? v : null
  }

  /**
   * 批量接口 `ids` 入参校验（站主）：必须为非空字符串数组、元素非空、数量 ≤ MAX_BATCH_IDS。
   * 校验不通过时已发送 400 并返回 null，调用方直接 return（不进入服务层写入）。
   */
  function parseBatchIds(reply: any, ids: unknown): string[] | null {
    if (!Array.isArray(ids) || !ids.length) {
      reply.code(400).send({ error: 'ids array is required' })
      return null
    }
    if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
      reply.code(400).send({ error: 'ids must be non-empty strings' })
      return null
    }
    if (ids.length > MAX_BATCH_IDS) {
      reply.code(400).send({ error: `too many ids (max ${MAX_BATCH_IDS})` })
      return null
    }
    return ids as string[]
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
  // 顶层附带签名策略与信任表 keyId 列表（完善⑥），供前端渲染徽标与门控
  app.get('/api/plugin-store', async () => {
    const info = ctx.pluginRegistry.signatureInfo()
    return { store: ctx.pluginRegistry.store(), signatureMode: info.mode, trustedKeyIds: info.trustedKeyIds }
  })

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
      // 可选签名字段（signature/keyId/signedHash/signedAt）优先于包内 zip comment
      const body = req.body as
        | { name?: string; packageUrl?: string; sha256?: string; signature?: string; keyId?: string; signedHash?: string; signedAt?: string }
        | undefined
      try {
        const { plugins, scan, signature } = await ctx.pluginRegistry.install(body ?? {})
        return { plugins, store: ctx.pluginRegistry.store(), scan, signature }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message || '安装失败', code: e?.code })
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

  // 导入插件包（zip base64 + 可选 sha256 + 可选签名平铺字段）；仅 admin，信任边界见文档
  app.post('/api/plugin-store/import', { bodyLimit: 5 * 1024 * 1024 }, (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as {
        data?: string
        sha256?: string
        signature?: string
        keyId?: string
        signedHash?: string
        signedAt?: string
      }
      if (!body?.data) return reply.code(400).send({ error: 'data is required' })
      try {
        const { plugins, scan, signature } = await ctx.pluginRegistry.importPackage(
          body.data,
          body.sha256,
          // 请求体签名字段可选覆盖 zip comment（缺省时由服务端读包内 comment）
          { signature: body.signature, keyId: body.keyId, signedHash: body.signedHash, signedAt: body.signedAt },
        )
        return { plugins, store: ctx.pluginRegistry.store(), scan, signature }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message || '导入失败', code: e?.code })
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
        const { plugins, scan, signature } = await ctx.pluginRegistry.update(name)
        return { plugins, store: ctx.pluginRegistry.store(), scan, signature }
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message || '更新失败', code: e?.code })
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

  // 创建条目（站主）：草稿流放宽为「标题与正文不可同时为空」——
  // 新建文章在详情页编辑态首次自动保存即创建，此时用户常先粘正文后补标题。
  // 空标题回落「未命名草稿」（目录树/卡片有可读标签）。
  // 发布不变式与 PATCH 对称：`status:'published'` 时必须填写标题与正文，否则 400（避免游客立刻看到空壳条目）。
  app.post('/api/knowledge/entries', (req, reply) =>
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
  app.post('/api/knowledge/import', { bodyLimit: 20 * 1024 * 1024 }, (req, reply) =>
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
  app.patch('/api/knowledge/entries/:id', (req, reply) =>
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
  // 服务端环校验在 service.moveDoc 内（自身 / 子孙 / 目标不存在或已删除 → 400，目标不变）
  app.post('/api/knowledge/entries/:id/move', (req, reply) =>
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
      return { ok: true }
    }),
  )

  // ---- 目录树批量操作（站主）----
  // 批量软删除（级联）：连带选中项的全部子孙一起进回收站（可恢复）；不提供彻底删除。
  // 服务层**先整体校验、后写入**（不存在 / 已删除 / 类型 / 空 / 上限 → 400 且零写入）。
  app.post('/api/knowledge/batch-delete', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { ids?: string[] }
      const ids = parseBatchIds(reply, body?.ids)
      if (!ids) return
      try {
        return await ctx.knowledge.batchRemove(ids)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'batch delete failed' })
      }
    }),
  )

  // 批量移动（站主）：`parentId: null` / 省略 = 顶层；目标须存在且未删除；服务端环校验；
  // 嵌套选择折叠为按根处理；目标层 sortOrder 追加末尾；分类不变。
  app.post('/api/knowledge/batch-move', (req, reply) =>
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
        return await ctx.knowledge.batchMove(ids, body?.parentId ?? null)
      } catch (e: any) {
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
  // 登录鉴权：工具清单暴露内部能力与参数结构，按登录态收敛（完善④ Q1）
  app.get('/api/agent/tools', (req, reply) =>
    requireUser(req, reply, async () => ({
      tools: ctx.agent.listTools(),
    })),
  )

  // 执行一个服务端工具（节点本地 agent 循环复用服务端工具时调用；登录鉴权）
  app.post('/api/agent/tools/:name/run', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const name = (req.params as { name: string }).name
      const body = req.body as { args?: Record<string, unknown> }
      return { result: await ctx.agent.runTool(name, body?.args ?? {}, await callOf(user)) }
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
  // 登录鉴权：节点列表含 ownerId/name/lastSeenAt，按登录态收敛（完善④ Q2）
  app.get('/api/agent/nodes', (req, reply) =>
    requireUser(req, reply, async () => {
      const now = Date.now()
      const nodes = (await ctx.agent.listNodes()).map((n) => ({
        ...n,
        online: now - new Date(n.lastSeenAt).getTime() < 30000,
      }))
      return { nodes }
    }),
  )
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
      // 在流开始前解析可见性上下文（避免 SSE 头写出后才发现问题）；viewer 取调用者
      const call = await callOf(user)
      let answer = ''
      const steps: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }> = []
      try {
        for await (const ev of ctx.agent.runStream(task.message, [], call)) {
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
      const call = await callOf(user)
      try {
        for await (const ev of ctx.agent.runStream(body.message, priorHistory, call)) {
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
    requireUser(req, reply, async (user) => {
      const body = req.body as { message?: string; history?: ChatMessage[] }
      if (!body?.message?.trim()) {
        return reply.code(400).send({ error: 'message is required' })
      }
      const call = await callOf(user)
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      try {
        for await (const ev of ctx.agent.runStream(body.message, body.history ?? [], call)) {
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
