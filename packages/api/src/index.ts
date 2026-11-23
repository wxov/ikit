import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { WebSocket } from 'ws'
import type { Context } from 'cordis'
import { createBus } from './bus.js'
import { registerRoutes, type ApiMeta } from './routes.js'

export type { ApiMeta }

export async function createApi(ctx: Context, meta: ApiMeta = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const bus = createBus(ctx)

  // ---- 域名访问白名单（2026-11-23）----
  // 站点与 API 只允许指定域名访问；`/update/*`（安装包/热更新包）额外允许下载子域。
  // 环境变量：WEB_ALLOWED_HOSTS（站点+API，逗号分隔）、WEB_DOWNLOAD_HOSTS（仅 /update，逗号分隔）、
  //           WEB_ALLOW_LOCALHOST=0 关闭本地放行、WEB_HOST_GUARD=0 关闭整个校验（排障用）。
  const normHost = (h: string) => (h || '').toLowerCase().replace(/:\d+$/, '')
  const listOf = (v: string | undefined, def: string) =>
    (v ?? def)
      .split(',')
      .map((s) => normHost(s.trim()))
      .filter(Boolean)
  const siteHosts = listOf(process.env.WEB_ALLOWED_HOSTS, 'ayioiya.com,ikit.ayioiya.com,www.ayioiya.com')
  const downloadHosts = listOf(process.env.WEB_DOWNLOAD_HOSTS, 'download.ayioiya.com')
  const allowLocal = process.env.WEB_ALLOW_LOCALHOST !== '0'
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (process.env.WEB_HOST_GUARD !== '0') {
    app.addHook('onRequest', async (req, reply) => {
      const host = normHost(req.headers.host ?? '')
      if (allowLocal && LOCAL_HOSTS.has(host)) return
      const path = (req.raw.url ?? '').split('?')[0]
      const isUpdate = path === '/update' || path.startsWith('/update/')
      const allowed = isUpdate
        ? siteHosts.includes(host) || downloadHosts.includes(host)
        : siteHosts.includes(host)
      if (allowed) return
      const allowedText = isUpdate
        ? [...siteHosts, ...downloadHosts].join(' / ')
        : siteHosts.join(' / ')
      reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send(`403 Forbidden：域名 "${host || '(空)'}" 不在允许列表（允许：${allowedText}）`)
    })
  }

  await app.register(cors, { origin: true })
  await app.register(websocket)

  // WebSocket 端点：前端通过它实时订阅核心事件
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    bus.clients.add(socket)
    socket.send(JSON.stringify({ type: 'connected', ts: Date.now() }))
    socket.on('close', () => bus.clients.delete(socket))
    socket.on('error', () => bus.clients.delete(socket))
    socket.on('message', (raw) => {
      const text = raw.toString()
      if (text === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      }
    })
  })

  registerRoutes(app, ctx, meta)

  // 热更新分发包静态托管（/update/<version>/<bundle>）
  if (meta.updateRoot) {
    await app.register(fastifyStatic, {
      root: meta.updateRoot,
      prefix: '/update/',
      decorateReply: false,
    })
  }

  // 上传文件静态托管（/uploads/<file>）
  if (meta.uploadsDir) {
    await app.register(fastifyStatic, {
      root: meta.uploadsDir,
      prefix: '/uploads/',
      decorateReply: false,
    })
  }

  // 静态托管（生产模式）：托管前端构建产物 dist，实现前后端同源
  if (meta.staticRoot) {
    await app.register(fastifyStatic, {
      root: meta.staticRoot,
      prefix: '/',
    })
    // SPA 回退：非 API / WS 路径回退到 index.html
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? ''
      if (url.startsWith('/api') || url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  app.addHook('onClose', () => {
    bus.dispose()
  })

  return app
}
