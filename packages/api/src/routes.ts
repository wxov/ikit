import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'

import type { AuditEvent, AuditLog } from '@ikit/shared'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ApiRouteDeps } from './routes/deps.js'
import { registerPluginStoreRoutes } from './routes/plugin-store.js'
import { registerShiguangRoutes } from './routes/shiguang.js'
import { registerKnowledgeRoutes } from './routes/knowledge.js'
import { createAuthHelpers } from './routes/auth-helpers.js'
import { registerAccountRoutes } from './routes/account.js'
import { registerAgentRoutes } from './routes/agent.js'
import { registerLlmRoutes } from './routes/llm.js'

// 批量导入文档单次上限（超出直接 400，避免一次请求写入过多条目）

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
  // 鉴权 / 可见性 / Agent 调用上下文统一由工厂提供（P2-10：抽到 routes/auth-helpers.ts）
  const auth = createAuthHelpers(ctx)
  const { tokenOf, requireAdmin, requireUser, viewerOf, resolveViewer, callOf, resolveAgentModel, normalizeVisibility, parseBatchIds } =
    auth

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
    callOf,
    resolveAgentModel,
  }


  // ---- 账号体系（已拆分到 routes/account.ts）----
  registerAccountRoutes(app, ctx, routeDeps)
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

  // ---- agent / LLM（已拆分到 routes/agent.ts、routes/llm.ts）----
  registerAgentRoutes(app, ctx, routeDeps)
  registerLlmRoutes(app, ctx, routeDeps)
}