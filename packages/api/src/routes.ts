import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ChatMessage, KnowledgeEntryInput } from '@ikit/core'

export interface ApiMeta {
  name?: string
  version?: string
  plugins?: Array<{ name: string; version?: string }>
  /** 前端静态目录（生产模式托管 dist） */
  staticRoot?: string
}

export function registerRoutes(app: FastifyInstance, ctx: Context, meta: ApiMeta = {}) {
  app.get('/api/health', async () => ({
    ok: true,
    uptime: Math.round(process.uptime()),
    ts: Date.now(),
  }))

  app.get('/api/system/info', async () => ({
    name: meta.name ?? 'i-kit',
    version: meta.version ?? '0.1.0',
    plugins: meta.plugins ?? [],
  }))

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

  app.get('/api/knowledge/entries/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const entry = await ctx.knowledge.get(id)
    if (!entry) return reply.code(404).send({ error: 'entry not found' })
    return { entry }
  })

  app.post('/api/knowledge/entries', async (req, reply) => {
    const body = req.body as KnowledgeEntryInput
    if (!body?.title?.trim() || !body?.content) {
      return reply.code(400).send({ error: 'title and content are required' })
    }
    const entry = await ctx.knowledge.create({
      title: body.title,
      content: body.content,
      tags: body.tags,
      category: body.category,
    })
    return reply.code(201).send({ entry })
  })

  app.post('/api/knowledge/import', async (req, reply) => {
    const body = req.body as { entries?: KnowledgeEntryInput[] }
    if (!Array.isArray(body?.entries) || !body.entries.length) {
      return reply.code(400).send({ error: 'entries array is required' })
    }
    return await ctx.knowledge.importMany(body.entries)
  })

  app.patch('/api/knowledge/entries/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const entry = await ctx.knowledge.update(id, req.body as Partial<KnowledgeEntryInput>)
    if (!entry) return reply.code(404).send({ error: 'entry not found' })
    return { entry }
  })

  app.delete('/api/knowledge/entries/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const ok = await ctx.knowledge.remove(id)
    if (!ok) return reply.code(404).send({ error: 'entry not found' })
    return { ok: true }
  })

  app.post('/api/knowledge/entries/:id/toggle-pin', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const entry = await ctx.knowledge.togglePin(id)
    if (!entry) return reply.code(404).send({ error: 'entry not found' })
    return { entry }
  })

  // ---- 回收站 ----
  app.get('/api/knowledge/trash', async () => ({
    entries: await ctx.knowledge.listTrash(),
  }))

  app.post('/api/knowledge/trash/:id/restore', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const ok = await ctx.knowledge.restore(id)
    if (!ok) return reply.code(404).send({ error: 'entry not found' })
    return { ok: true }
  })

  app.delete('/api/knowledge/trash/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const ok = await ctx.knowledge.purge(id)
    if (!ok) return reply.code(404).send({ error: 'entry not found' })
    return { ok: true }
  })

  app.delete('/api/knowledge/trash', async () => ({
    removed: await ctx.knowledge.emptyTrash(),
  }))

  app.get('/api/knowledge/search', async (req) => {
    const q = (req.query as { q?: string }).q ?? ''
    return { results: await ctx.knowledge.search(q) }
  })

  // ---- 知识库分类 ----
  app.get('/api/knowledge/categories', async () => ({
    categories: await ctx.knowledge.getCategories(),
  }))

  app.post('/api/knowledge/categories', async (req, reply) => {
    const body = req.body as { path?: string }
    if (!body?.path?.trim()) {
      return reply.code(400).send({ error: 'path is required' })
    }
    return { categories: await ctx.knowledge.addCategory(body.path) }
  })

  app.post('/api/knowledge/category-rename', async (req, reply) => {
    const body = req.body as { oldPath?: string; newPath?: string }
    if (!body?.oldPath?.trim() || !body?.newPath?.trim()) {
      return reply.code(400).send({ error: 'oldPath and newPath are required' })
    }
    return { categories: await ctx.knowledge.renameCategory(body.oldPath, body.newPath) }
  })

  app.delete('/api/knowledge/categories', async (req) => {
    const path = (req.query as { path?: string }).path ?? ''
    return { categories: await ctx.knowledge.removeCategory(path) }
  })

  app.post('/api/knowledge/batch-category', async (req, reply) => {
    const body = req.body as { ids?: string[]; category?: string }
    if (!Array.isArray(body?.ids) || !body.ids.length) {
      return reply.code(400).send({ error: 'ids array is required' })
    }
    return await ctx.knowledge.bulkSetCategory(body.ids, body.category)
  })

  // ---- agent 插件服务 ----
  app.get('/api/agent/tools', async () => ({
    tools: ctx.agent.listTools(),
  }))

  app.post('/api/agent/chat', async (req, reply) => {
    const body = req.body as { message?: string; history?: ChatMessage[] }
    if (!body?.message?.trim()) {
      return reply.code(400).send({ error: 'message is required' })
    }
    try {
      return await ctx.agent.run(body.message, body.history ?? [])
    } catch (e) {
      return reply.code(500).send({
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })

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
