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
