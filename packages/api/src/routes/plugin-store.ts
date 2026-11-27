// 由 routes.ts 拆分（P2-10，2026-11-28）
import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ApiRouteDeps } from './deps.js'

export function registerPluginStoreRoutes(app: FastifyInstance, ctx: Context, deps: ApiRouteDeps): void {
  const { requireAdmin, requireUser, tokenOf, audit, ipOf, actorOf } = deps

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

  app.post(
    '/api/plugin-store/install',
    {
      schema: {
        body: {
          anyOf: [
            { type: 'string', minLength: 1, maxLength: 100 },
            {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: 100 },
                packageUrl: { type: 'string', maxLength: 2048 },
                sha256: { type: 'string', maxLength: 64 },
              },
            },
          ],
        },
      },
    },
    (req, reply) =>
    requireAdmin(req, reply, async () => {
      // 支持 { name }（沿用商店条目，catalog 假安装 / remote 真下载）或 { name, packageUrl, sha256 }（直接远端安装）
      // 可选签名字段（signature/keyId/signedHash/signedAt）优先于包内 zip comment
      const body = req.body as
        | { name?: string; packageUrl?: string; sha256?: string; signature?: string; keyId?: string; signedHash?: string; signedAt?: string }
        | undefined
      try {
        const { plugins, scan, signature } = await ctx.pluginRegistry.install(body ?? {})
        audit({
          action: 'plugin.install',
          ok: true,
          user: await actorOf(req),
          ip: ipOf(req),
          target: body?.name ?? body?.packageUrl,
          detail: { packageUrl: body?.packageUrl, warnings: scan?.warnings?.length ?? 0 },
        })
        return { plugins, store: ctx.pluginRegistry.store(), scan, signature }
      } catch (e: any) {
        audit({ action: 'plugin.install', ok: false, user: await actorOf(req), ip: ipOf(req), target: body?.name, detail: { code: e?.code } })
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
  app.post(
    '/api/plugin-store/import',
    {
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['data'],
          properties: {
            data: { type: 'string', minLength: 1 },
            sha256: { type: 'string', maxLength: 64 },
            signature: { type: 'string', maxLength: 4096 },
            keyId: { type: 'string', maxLength: 128 },
            signedHash: { type: 'string', maxLength: 64 },
            signedAt: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    (req, reply) =>
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
        audit({ action: 'plugin.import', ok: true, user: await actorOf(req), ip: ipOf(req), target: body.sha256 ? body.sha256.slice(0, 16) : 'zip' })
        return { plugins, store: ctx.pluginRegistry.store(), scan, signature }
      } catch (e: any) {
        audit({ action: 'plugin.import', ok: false, user: await actorOf(req), ip: ipOf(req), detail: { code: e?.code } })
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
        audit({ action: 'plugin.update', ok: true, user: await actorOf(req), ip: ipOf(req), target: name })
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
      audit({ action: 'plugin.uninstall', ok: true, user: await actorOf(req), ip: ipOf(req), target: name })
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
}
