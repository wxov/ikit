import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ChatMessage, EntryVisibility, KnowledgeEntryInput, Viewer, VisibilitySyncMode } from '@ikit/core'
import type { AuditEvent, AuditLog } from '@ikit/shared'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ApiRouteDeps } from './routes/deps.js'
import { registerPluginStoreRoutes } from './routes/plugin-store.js'
import { registerShiguangRoutes } from './routes/shiguang.js'
import { registerKnowledgeRoutes } from './routes/knowledge.js'

// 批量导入文档单次上限（超出直接 400，避免一次请求写入过多条目）
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
  /** 写操作审计（P2-8）；未提供时审计调用为空操作 */
  audit?: AuditLog
}

export function registerRoutes(app: FastifyInstance, ctx: Context, meta: ApiMeta = {}) {
  /** 审计写入（无 audit 时为空操作；永不抛错影响请求） */
  const audit = (event: AuditEvent): void => meta.audit?.write(event)
  const ipOf = (req: any): string => String(req?.ip ?? '')
  /** 解析操作者用户名（仅 admin 路由需要；按需查询，失败不影响主流程） */
  const actorOf = async (req: any): Promise<string | undefined> => {
    try {
      return (await ctx.account.me(tokenOf(req)))?.username
    } catch {
      return undefined
    }
  }
  app.get('/api/health', async () => ({
    ok: true,
    uptime: Math.round(process.uptime()),
    ts: Date.now(),
  }))

  // 下载中心（公开，2026-11-23）：当前版本 + 各平台安装包/热更新包地址
  // 地址优先取 env（UPDATE_INSTALLER_URL_TAURI/_ANDROID/_WEB），缺省按站点约定路径推导
  app.get('/api/update/downloads', async (req) => {
    const version = meta.version ?? '0.1.0'
    const host = String((req.headers as any).host ?? '')
    const origin = host ? `http://${host}` : ''
    const derive = (name: string) => (origin ? `${origin}/update/${version}/${name}` : '')
    const tauri = (process.env.UPDATE_INSTALLER_URL_TAURI ?? '').trim()
    const android = (process.env.UPDATE_INSTALLER_URL_ANDROID ?? '').trim()
    const web = (process.env.UPDATE_INSTALLER_URL_WEB ?? '').trim()
    return {
      version,
      items: [
        {
          id: 'windows',
          label: 'Windows 桌面安装包',
          hint: '覆盖安装即可完成更新（.exe）',
          url: tauri || derive(`i-kit_${version}_x64-setup.exe`),
          configured: !!tauri,
        },
        {
          id: 'android',
          label: 'Android 安装包',
          hint: '覆盖安装即可（.apk，系统需允许安装未知应用）',
          url: android || derive(`i-kit_${version}.apk`),
          configured: !!android,
        },
        {
          id: 'web',
          label: 'Web 热更新包',
          hint: '分发包（.zip），用于已安装 Web 客户端的热更新',
          url: web || derive(`web-update-${version}.zip`),
          configured: !!web,
        },
      ],
    }
  })

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
    return {
      viewer: await viewerOf(user),
      userId: user?.id as string | undefined,
      // 写类工具（knowledge_add/knowledge_update）据此鉴权：仅站主可用
      role: (user?.role === 'admin' ? 'admin' : 'user') as 'user' | 'admin',
    }
  }

  /**
   * 解析「小知」本次请求使用的模型（2026-11-22 模型配置与选择）：
   * - 未指定 → 默认模型；
   * - 指定 → 必须在「该角色可见的模型清单」内（非 admin 只能用 visibleToUsers 的），否则 400；
   * - 返回可直接透传给 llm 的 { model, apiBase?, apiKey? }。
   */
  function resolveAgentModel(
    user: any,
    requested?: string,
  ):
    | { ok: true; rec: { id: string; model: string; apiBase?: string; apiKey?: string } }
    | { ok: false; error: string } {
    const rid = (requested ?? '').trim()
    const view = ctx.llmModels.listPublic(user?.role)
    if (rid && !view.models.some((m) => m.id === rid)) {
      return { ok: false, error: '无权使用该模型或模型不存在' }
    }
    try {
      return { ok: true, rec: ctx.llmModels.resolve(rid || undefined) }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '模型配置不可用' }
    }
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
  // 登录：账号维度限流在 account 服务内（5 次失败锁 5 分钟）；此处再按 IP 维度限流（20 次失败锁 10 分钟）
  const loginIpFails = new Map<string, { fails: number; lockedUntil: number }>()
  const LOGIN_IP_MAX = 20
  const LOGIN_IP_LOCK_MS = 10 * 60_000
  app.post(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
    const ip = String((req as any).ip ?? 'unknown')
    const now = Date.now()
    const rec = loginIpFails.get(ip)
    if (rec && rec.lockedUntil > now) {
      const min = Math.max(1, Math.ceil((rec.lockedUntil - now) / 60_000))
      return reply.code(429).send({ error: `登录尝试过于频繁，请 ${min} 分钟后再试`, code: 'E_LOGIN_LOCKED' })
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    try {
      const r = await ctx.account.login(username ?? '', password ?? '')
      loginIpFails.delete(ip)
      audit({ action: 'auth.login', ok: true, user: r.user.username, ip })
      return { token: r.token, user: r.user }
    } catch (e: any) {
      const next = loginIpFails.get(ip) ?? { fails: 0, lockedUntil: 0 }
      next.fails += 1
      if (next.fails >= LOGIN_IP_MAX) {
        next.fails = 0
        next.lockedUntil = Date.now() + LOGIN_IP_LOCK_MS
      }
      loginIpFails.set(ip, next)
      audit({ action: 'auth.login', ok: false, user: username, ip, detail: { code: e?.code } })
      const status = e?.code === 'E_LOGIN_LOCKED' ? 429 : 401
      return reply.code(status).send({ error: e?.message ?? '登录失败', code: e?.code })
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
        audit({ action: 'user.create', ok: true, user: await actorOf(req), ip: ipOf(req), target: user.username })
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
      const users = await ctx.account.deleteUser(id)
      audit({ action: 'user.delete', ok: true, user: await actorOf(req), ip: ipOf(req), target: id })
      return { users }
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

  // 拆分模块共享依赖（P2-10）：统一注入，避免每个模块各传一套
  const routeDeps: ApiRouteDeps = {
    requireUser,
    requireAdmin,
    tokenOf,
    audit,
    ipOf,
    actorOf,
    viewerOf,
    resolveViewer,
    parseBatchIds,
    normalizeVisibility,
  }
  // ---- 插件商店 + 商店插件数据（已拆分到 routes/plugin-store.ts）----
  registerPluginStoreRoutes(app, ctx, routeDeps)

  // ---- 拾光（日记 / 感悟 / 名言，已拆分到 routes/shiguang.ts）----
  registerShiguangRoutes(app, ctx, routeDeps)

  // ---- demo 插件服务 ----
  app.get('/api/demo/hello', async (req) => {
    const name = (req.query as { name?: string }).name
    return { message: ctx.demo.hello(name) }
  })

  app.get('/api/demo/status', async () => ({
    greetCount: ctx.demo.greetCount,
  }))

  // ---- knowledge 插件服务 / 评论 / 批量 / 回收站 / 分类 / 可见性（已拆分到 routes/knowledge.ts）----
  registerKnowledgeRoutes(app, ctx, routeDeps)

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
  app.post(
    '/api/agent/tools/:name/run',
    {
      schema: {
        body: {
          type: 'object',
          properties: { args: { type: 'object' } },
        },
      },
    },
    (req, reply) =>
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
      const body = req.body as { message?: string; model?: string }
      if (!body?.message?.trim()) {
        return reply.code(400).send({ error: 'message is required' })
      }
      // 归属校验必须在 writeHead 之前完成（否则无法返回 404）
      const session = await ctx.agent.getSession(user.id, id)
      if (!session) return reply.code(404).send({ error: '会话不存在' })

      // 模型选择（按会话记忆）：校验可见性 → 解析调用参数（含 baseUrl/key），并持久化到会话
      const picked = resolveAgentModel(user, body.model)
      if (!picked.ok) return reply.code(400).send({ error: picked.error })
      await ctx.agent.setSessionModel(user.id, id, picked.rec.id)

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
        for await (const ev of ctx.agent.runStream(body.message, priorHistory, call, {
          model: picked.rec.model,
          apiBase: picked.rec.apiBase,
          apiKey: picked.rec.apiKey,
        })) {
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

  // Agent 写操作审批（2026-11-22）：SSE 收到 approval 事件后，前端 POST 此接口决定允许/拒绝
  app.post('/api/agent/sessions/:id/approvals/:callId', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const { id, callId } = req.params as { id: string; callId: string }
      const session = await ctx.agent.getSession(user.id, id)
      if (!session) return reply.code(404).send({ error: '会话不存在' })
      const body = req.body as { approved?: boolean }
      const ok = ctx.agent.resolveApproval(callId, !!body?.approved)
      if (!ok) return reply.code(404).send({ error: '该确认请求已过期或不存在' })
      return { ok: true, approved: !!body?.approved }
    }),
  )

  // Agent 流式输出（SSE）（通用，无会话；登录鉴权，与 /api/llm/chat-stream 一致）
  app.post('/api/agent/chat-stream', (req, reply) =>
    requireUser(req, reply, async (user) => {
      const body = req.body as { message?: string; history?: ChatMessage[]; model?: string }
      if (!body?.message?.trim()) {
        return reply.code(400).send({ error: 'message is required' })
      }
      const pickedGeneric = resolveAgentModel(user, body.model)
      if (!pickedGeneric.ok) return reply.code(400).send({ error: pickedGeneric.error })
      const call = await callOf(user)
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      try {
        for await (const ev of ctx.agent.runStream(body.message, body.history ?? [], call, {
          model: pickedGeneric.rec.model,
          apiBase: pickedGeneric.rec.apiBase,
          apiKey: pickedGeneric.rec.apiKey,
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

  // ---- LLM 模型清单（2026-11-22：小知的模型配置与选择）----
  // 站主：全部模型；其他登录用户：仅 visibleToUsers 的模型。响应永不含明文 apiKey（只给掩码）。
  app.get('/api/llm/models', (req, reply) =>
    requireUser(req, reply, async (user) => ctx.llmModels.listPublic(user.role)),
  )
  // 站主保存整份清单（供应商分组 + 默认模型）；校验失败 → 400 { error }
  app.put('/api/llm/models', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { providers?: unknown; defaultKey?: string }
      try {
        return ctx.llmModels.save({
          providers: Array.isArray(body?.providers) ? (body.providers as any[]) : [],
          defaultKey: body?.defaultKey ?? '',
        })
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? '模型配置保存失败' })
      }
    }),
  )
  // 一键获取模型列表（站主）：服务端代理请求该供应商的 GET {apiBase}/models
  // body: { apiBase, apiKey?, providerId? }；apiKey 留空时用 providerId 已保存的密钥
  app.post('/api/llm/models/fetch', (req, reply) =>
    requireAdmin(req, reply, async () => {
      const body = req.body as { apiBase?: string; apiKey?: string; providerId?: string }
      const stored = body?.providerId ? ctx.llmModels.keyOf(String(body.providerId)) : undefined
      const apiBase = String(body?.apiBase || stored?.apiBase || '').trim().replace(/\/+$/, '')
      const apiKey = String(body?.apiKey || '').trim() || stored?.apiKey || ''
      if (!apiBase) return reply.code(400).send({ error: '请先填写 apiBase' })
      try {
        const u = new URL(apiBase)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol')
      } catch {
        return reply.code(400).send({ error: 'apiBase 不是合法的 http(s) 地址' })
      }
      try {
        const res = await fetch(`${apiBase}/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return reply.code(400).send({ error: `获取模型列表失败（HTTP ${res.status}）：${text.slice(0, 200)}` })
        }
        const data = (await res.json()) as any
        // OpenAI 兼容：{ data: [{ id }] }；也兼容 { models: [...] } / 纯数组
        const rawList: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : []
        const models = rawList
          .map((m) => ({
            id: String(typeof m === 'string' ? m : (m?.id ?? m?.name ?? '')).trim(),
            ownedBy: typeof m === 'object' ? (m?.owned_by ?? m?.ownedBy ?? '') : '',
          }))
          .filter((m) => m.id)
          .map((m) => ({ id: m.id, name: m.id, ownedBy: m.ownedBy || undefined }))
        return { models }
      } catch (e: any) {
        return reply.code(400).send({ error: `获取模型列表失败：${e?.message ?? e}` })
      }
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
