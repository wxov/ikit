// 由 routes.ts 拆分（P2-10，2026-11-28）
import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ChatMessage } from '@ikit/core'
import type { ApiRouteDeps } from './deps.js'

export function registerLlmRoutes(app: FastifyInstance, ctx: Context, deps: ApiRouteDeps): void {
  const { requireUser, requireAdmin } = deps

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
