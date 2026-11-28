// 由 routes.ts 拆分（P2-10，2026-11-28）
import type { FastifyInstance } from 'fastify'
import type { Context } from 'cordis'
import type { ChatMessage } from '@ikit/core'
import type { ApiRouteDeps } from './deps.js'
import { buildPromptPolishMessages, parsePromptPolishOutput } from './prompt-polish.js'

export function registerAgentRoutes(app: FastifyInstance, ctx: Context, deps: ApiRouteDeps): void {
  const { requireUser, callOf, resolveAgentModel } = deps

  // ---- agent 插件服务 ----
  // 登录鉴权：工具清单暴露内部能力与参数结构，按登录态收敛（完善④ Q1）
  app.get('/api/agent/tools', (req, reply) =>
    requireUser(req, reply, async () => ({
      tools: ctx.agent.listTools(),
    })),
  )

  // 技能索引（2026-11-28 M2）：只返回名字/标题/触发条件，正文由 use_skill 按需加载
  app.get('/api/agent/skills', (req, reply) =>
    requireUser(req, reply, async () => ({
      skills: ctx.agent.listSkills(),
    })),
  )

  // ---- 输入提示词润色（小知「✨优化」，2026-11-28）：把口语输入改写为结构化指令（手动触发）----
  app.post(
    '/api/agent/prompt-polish',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 2000 },
            context: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    (req, reply) =>
      requireUser(req, reply, async () => {
        const body = req.body as { text: string; context?: string }
        const text = String(body.text ?? '').trim()
        if (!text) return { prompt: '', added: [], intent: 'other' as const, degraded: true }
        try {
          const res = await ctx.llm.chat(buildPromptPolishMessages(text, body.context), {
            temperature: 0.2,
            maxTokens: 400,
          })
          return parsePromptPolishOutput(String(res.message?.content ?? ''), text)
        } catch (e: any) {
          reply.code(502)
          return { error: e?.message ?? '优化失败', code: 'E_POLISH_FAILED' }
        }
      }),
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
}
