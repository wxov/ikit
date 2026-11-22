import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Schema } from 'cordis'
import type { Context } from 'cordis'
import type { ChatMessage, LlmChatOptions, LlmService, LlmToolDefinition } from '@ikit/plugin-llm'
import type { KnowledgeService, Viewer } from '@ikit/plugin-knowledge'
import { JsonAgentStore, type AgentStore } from './store.js'
import type { AgentCallContext, AgentMessage, AgentMessageInput, AgentNode, AgentNodeInput, AgentService, AgentSession, AgentStreamEvent, AgentTask, AgentTaskInput, AgentTool } from './types.js'

export const name = 'agent'
// account 为可选依赖：仅用于存量会话迁移时解析 admin 首账号；不注入时按「无 admin」兜底清空
export const inject = {
  llm: { required: true },
  knowledge: { required: true },
  account: { required: false },
}

export interface Config {
  dataDir?: string
  filename?: string
  systemPrompt?: string
  maxSteps?: number
  knowledgeTopK?: number
  /** 是否启用写类工具（knowledge_add / knowledge_update），默认开启（仅站主可用 + 每次需确认） */
  enableWriteTools?: boolean
  /** 写操作等待用户确认的超时（毫秒），超时自动拒绝 */
  approvalTimeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  filename: Schema.string().default('agent.json'),
  systemPrompt: Schema.string().default(
    '你是「小知」（英文名 DocCurator），i-kit 知识库的文档管理员：负责整理、归类、检索与维护知识库文档。当用户的问题涉及需要查询的事实、资料或文档时，优先调用 knowledge_search 工具检索知识库；如果知识库中没有相关内容，再基于自身知识回答。若用户要求新增或修改文档，调用 knowledge_add / knowledge_update（执行前系统会请用户确认，确认后才会真正写入）。',
  ),
  maxSteps: Schema.number().default(10),
  knowledgeTopK: Schema.number().default(3),
  enableWriteTools: Schema.boolean().default(true),
  approvalTimeoutMs: Schema.number().default(120000),
})

/** account 可选依赖的最小结构面（避免硬依赖 @ikit/plugin-account 的完整类型） */
interface AccountLike {
  listUsers(): Promise<Array<{ id: string; role: 'user' | 'admin' }>>
}

interface AgentContext extends Context {
  llm: LlmService
  knowledge: KnowledgeService
}

export function apply(_ctx: Context, config: Config) {
  const ctx = _ctx as AgentContext
  const dataDir = config.dataDir ?? './data'
  mkdirSync(dataDir, { recursive: true })
  const store: AgentStore = new JsonAgentStore(path.join(dataDir, config.filename ?? 'agent.json'))
  const tools = new Map<string, AgentTool>()

  function registerTool(tool: AgentTool) {
    tools.set(tool.name, tool)
    return () => tools.delete(tool.name)
  }

  // 缺省可见性上下文：fail-closed —— 未传 call 时等价于「游客」，只能读到 public
  // （若确需全库检索，显式传 { viewer: { groups: [], isAdmin: true } }，显式即可审计）
  const GUEST_VIEWER: Viewer = { groups: ['guest'], isAdmin: false }
  const viewerOf = (call?: AgentCallContext): Viewer => call?.viewer ?? GUEST_VIEWER

  // 内置工具：知识库检索（RAG）
  registerTool({
    name: 'knowledge_search',
    description:
      '在本地知识库中检索相关内容，返回匹配的条目。当用户询问需要事实、资料或文档支撑的问题时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题' },
      },
      required: ['query'],
    },
    handler: async (args, call) => {
      const query = String(args.query ?? '').trim()
      if (!query) return '检索关键词为空'
      // 按调用者可见性过滤（与知识库 HTTP 接口同源：isVisible 单点实现，此处只传 viewer）
      const results = await ctx.knowledge.search(query, viewerOf(call))
      if (!results.length) return '知识库中没有找到相关内容'
      const top = results.slice(0, config.knowledgeTopK ?? 3)
      return top
        .map((r, i) => `[${i + 1}] ${r.entry.title}\n${r.entry.content}`)
        .join('\n\n')
    },
  })

  // 内置工具：当前时间（演示简单工具）
  registerTool({
    name: 'current_time',
    description: '获取当前日期和时间',
    parameters: { type: 'object', properties: {} },
    handler: async () =>
      new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  })

  // 内置工具：抓取网页（浏览器控制简化版，返回标题 + 纯文本摘要）
  registerTool({
    name: 'web_fetch',
    description: '抓取指定网页并返回标题与纯文本摘要。用于查询网页内容、文档或公开资料。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL（http/https）' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return '仅支持 http/https 链接'
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'i-kit-agent/1.0' },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return `请求失败 HTTP ${res.status}`
        const html = await res.text()
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim()
        return `标题：${title || '(无)'}\n正文摘要：${text.slice(0, 2000)}`
      } catch (e) {
        return `抓取失败：${e instanceof Error ? e.message : String(e)}`
      }
    },
  })

  // ---- 写类工具（2026-11-22）：新增 / 修改文档；仅站主可用，且每次执行前需用户确认 ----
  const approvals = new Map<string, (ok: boolean) => void>()

  /** 等待用户确认；超时自动拒绝 */
  function waitApproval(callId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        approvals.delete(callId)
        resolve(false)
      }, Math.max(1000, timeoutMs))
      approvals.set(callId, (ok) => {
        clearTimeout(timer)
        approvals.delete(callId)
        resolve(ok)
      })
    })
  }

  function resolveApproval(callId: string, approved: boolean): boolean {
    const fn = approvals.get(callId)
    if (!fn) return false
    fn(approved)
    return true
  }

  function approvalSummary(tool: string, args: Record<string, unknown>): string {
    const title = String(args.title ?? args.matchTitle ?? args.id ?? '').trim()
    if (tool === 'knowledge_add') return `新增文档《${title || '未命名'}》`
    if (tool === 'knowledge_update') return `修改文档「${title || '（未指定）'}」`
    return tool
  }

  if (config.enableWriteTools) {
    registerTool({
      name: 'knowledge_add',
      description:
        '向知识库新增一篇文档（标题 + Markdown 正文；可选分类/父文档/标签/可见性/发布状态）。属于写操作：仅站主可用，且执行前需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题' },
          content: { type: 'string', description: '正文（Markdown）' },
          category: { type: 'string', description: '分类路径，如 技术/前端（可选）' },
          parentId: { type: 'string', description: '父文档 id（可选，缺省为顶层）' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
          visibility: {
            type: 'string',
            enum: ['public', 'login', 'private'],
            description: '可见性（可选，缺省 public）',
          },
          status: {
            type: 'string',
            enum: ['draft', 'published'],
            description: '状态（可选，缺省 draft；published 表示发布后游客可见）',
          },
        },
        required: ['title', 'content'],
      },
      requiresApproval: true,
      handler: async (args, call) => {
        if (call?.role !== 'admin') return '错误：仅站主可使用写文档技能（新增/修改）。'
        const title = String(args.title ?? '').trim()
        const content = String(args.content ?? '').trim()
        if (!title || !content) return '标题与正文不能为空'
        const status = args.status === 'published' ? 'published' : 'draft'
        const visibility =
          args.visibility === 'login' || args.visibility === 'private' || args.visibility === 'public'
            ? (args.visibility as 'public' | 'login' | 'private')
            : undefined
        const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean) : undefined
        console.log(`[agent] knowledge_add by user ${call?.userId ?? '(unknown)'}`)
        const entry = await ctx.knowledge.create({
          title,
          content,
          category: args.category ? String(args.category) : undefined,
          parentId: args.parentId ? String(args.parentId) : undefined,
          tags,
          visibility,
          status,
        } as any)
        return `已新增文档「${entry.title}」（id=${entry.id}，状态=${entry.status ?? 'draft'}）`
      },
    })

    registerTool({
      name: 'knowledge_update',
      description:
        '修改知识库中的一篇文档：可按 id 或标题匹配目标，改标题/正文（替换或追加）/分类/标签/可见性/发布状态。属于写操作：仅站主可用，且执行前需用户确认；不支持移动、删除。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '目标文档 id（可选；与 matchTitle 二选一）' },
          matchTitle: { type: 'string', description: '目标文档标题（可选；按标题精确/包含匹配）' },
          title: { type: 'string', description: '新的标题（可选）' },
          content: { type: 'string', description: '正文内容（配合 mode 使用）' },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: '正文处理方式：replace=整篇替换（默认），append=在原文末尾追加',
          },
          category: { type: 'string', description: '新的分类路径（可选）' },
          tags: { type: 'array', items: { type: 'string' }, description: '新的标签（可选，整体替换）' },
          visibility: {
            type: 'string',
            enum: ['public', 'login', 'private'],
            description: '新的可见性（可选）',
          },
          status: {
            type: 'string',
            enum: ['draft', 'published'],
            description: '新的状态（可选；published 需标题与正文均非空）',
          },
        },
      },
      requiresApproval: true,
      handler: async (args, call) => {
        if (call?.role !== 'admin') return '错误：仅站主可使用写文档技能（新增/修改）。'
        const adminViewer: Viewer = { groups: ['admin'], isAdmin: true }
        // 定位目标
        let target: { id: string; title: string; content: string } | undefined
        const id = String(args.id ?? '').trim()
        const matchTitle = String(args.matchTitle ?? '').trim()
        if (id) {
          const e = await ctx.knowledge.view(id, adminViewer)
          if (e) target = { id: e.id, title: e.title, content: e.content ?? '' }
        } else if (matchTitle) {
          const all = await ctx.knowledge.list({ limit: 1000 }, adminViewer)
          const exact = all.find((e) => e.title === matchTitle)
          const fuzzy = exact ?? all.find((e) => e.title.includes(matchTitle))
          if (fuzzy) target = { id: fuzzy.id, title: fuzzy.title, content: fuzzy.content ?? '' }
        }
        if (!target) return '未找到要修改的文档：请提供准确的 id 或标题（可先用 knowledge_search 检索）。'

        const mode = args.mode === 'append' ? 'append' : 'replace'
        const patch: Record<string, unknown> = {}
        if (args.title !== undefined && String(args.title).trim()) patch.title = String(args.title).trim()
        if (args.content !== undefined && String(args.content).trim()) {
          patch.content =
            mode === 'append' ? `${target.content}\n\n${String(args.content).trim()}` : String(args.content).trim()
        }
        if (args.category !== undefined) patch.category = String(args.category).trim() || undefined
        if (Array.isArray(args.tags)) patch.tags = args.tags.map((t) => String(t).trim()).filter(Boolean)
        if (args.visibility === 'public' || args.visibility === 'login' || args.visibility === 'private') {
          patch.visibility = args.visibility
        }
        if (args.status === 'draft' || args.status === 'published') {
          const nextTitle = typeof patch.title === 'string' ? patch.title : target.title
          const nextContent = typeof patch.content === 'string' ? patch.content : target.content
          if (args.status === 'published' && (!nextTitle.trim() || !nextContent.trim())) {
            return '发布前需要标题与正文均非空（可先补全内容再发布）。'
          }
          patch.status = args.status
        }
        if (!Object.keys(patch).length) return '没有可修改的字段（请提供 title/content/category/tags/visibility/status 之一）。'
        console.log(`[agent] knowledge_update by user ${call?.userId ?? '(unknown)'} -> ${target.id}`)
        const updated = await ctx.knowledge.update(target.id, patch as any)
        if (!updated) return '修改失败：目标文档不存在或已删除。'
        const fields = Object.keys(patch).join('/')
        return `已修改文档「${updated.title}」（字段：${fields}）`
      },
    })
  }

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    call?: AgentCallContext,
  ): Promise<string> {
    const tool = tools.get(name)
    if (!tool) return `错误：未知工具 ${name}`
    try {
      // 旧单参 handler（第三方插件）同样可用：多传的 call 会被 JS 忽略
      return String(await tool.handler(args, call))
    } catch (e) {
      return `工具执行出错：${e instanceof Error ? e.message : String(e)}`
    }
  }

  function toLlmTools(): LlmToolDefinition[] {
    return [...tools.values()].map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  async function* runStream(
    userMessage: string,
    history: ChatMessage[] = [],
    call?: AgentCallContext,
    llmOptions: LlmChatOptions = {},
  ): AsyncIterable<AgentStreamEvent> {
    const messages: ChatMessage[] = [
      { role: 'system', content: config.systemPrompt ?? '' },
      ...history,
      { role: 'user', content: userMessage },
    ]
    const maxSteps = config.maxSteps ?? 10

    for (let i = 0; i < maxSteps; i++) {
      yield { type: 'status', status: i === 0 ? '思考中…' : `思考中…（第 ${i + 1} 轮）` }
      let msg: ChatMessage | undefined
      for await (const ev of ctx.llm.chatStream(messages, { tools: toLlmTools(), ...llmOptions })) {
        if (ev.type === 'delta') {
          yield { type: 'delta', content: ev.content }
        } else {
          msg = ev.message
        }
      }
      if (!msg) {
        yield { type: 'done' }
        return
      }
      messages.push(msg)

      const toolCalls = msg.tool_calls ?? []
      if (!toolCalls.length) {
        yield { type: 'done' }
        return
      }

      // 注意：循环变量不能叫 call，否则会遮蔽本函数的 call（调用上下文）形参
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name
        const tool = tools.get(toolName)
        let toolArgs: Record<string, unknown> = {}
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}')
        } catch {
          toolArgs = {}
        }

        yield { type: 'status', status: `正在调用工具 ${toolName}…` }
        let toolResult: string
        if (!tool) {
          toolResult = `错误：未知工具 ${toolName}`
        } else if (tool.requiresApproval) {
          // 写类工具：仅站主可用，且执行前挂起等待用户确认（SSE approval 事件 → 审批接口）
          if (call?.role !== 'admin') {
            toolResult = '错误：仅站主可使用写文档技能（新增/修改）。'
          } else {
            const callId = toolCall.id || `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const pending = waitApproval(callId, config.approvalTimeoutMs ?? 120000)
            yield {
              type: 'approval',
              callId,
              tool: toolName,
              args: toolArgs,
              summary: approvalSummary(toolName, toolArgs),
            }
            const approved = await pending
            if (!approved) {
              toolResult = '用户已拒绝该操作，未写入任何内容。'
            } else {
              try {
                toolResult = String(await tool.handler(toolArgs, call))
              } catch (e) {
                toolResult = `工具执行出错：${e instanceof Error ? e.message : String(e)}`
              }
            }
          }
        } else {
          try {
            toolResult = String(await tool.handler(toolArgs, call))
          } catch (e) {
            toolResult = `工具执行出错：${e instanceof Error ? e.message : String(e)}`
          }
        }

        yield { type: 'tool', toolName, toolArgs, toolResult }
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        })
      }
    }

    yield { type: 'done' }
  }

  // 存量会话迁移（懒触发、幂等）：仅处理缺 ownerId 的会话；有 admin 归属 admin 首账号，否则清空并告警
  let migrated = false
  async function migrateLegacySessions(): Promise<{ migrated: number; cleared: number }> {
    if (migrated) return { migrated: 0, cleared: 0 }
    migrated = true
    const db = await store.load()
    const legacy = db.sessions.filter((s) => !s.ownerId)
    if (!legacy.length) return { migrated: 0, cleared: 0 }

    // account 为可选注入：仅迁移时经代理按需解析，避免 AgentContext 与 core 的 Context 增强冲突
    const account = (ctx as AgentContext & { account?: AccountLike }).account
    const users = (await account?.listUsers()) ?? []
    const admin = users.find((u) => u.role === 'admin')
    if (admin) {
      for (const s of legacy) s.ownerId = admin.id
      await store.save(db)
      console.log(`[agent] 已将 ${legacy.length} 个遗留会话归属给 admin`)
      return { migrated: legacy.length, cleared: 0 }
    }

    db.sessions = db.sessions.filter((s) => s.ownerId)
    db.messages = db.messages.filter((m) => db.sessions.some((s) => s.id === m.sessionId))
    await store.save(db)
    console.warn(`[agent] 未找到 admin，清空 ${legacy.length} 个遗留会话`)
    return { migrated: 0, cleared: legacy.length }
  }

  const loadDb = async () => {
    await migrateLegacySessions()
    return store.load()
  }

  async function listSessions(ownerId: string): Promise<AgentSession[]> {
    const db = await loadDb()
    return db.sessions
      .filter((s) => s.ownerId === ownerId)
      .slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }

  async function getSession(ownerId: string, id: string): Promise<AgentSession | undefined> {
    const db = await loadDb()
    return db.sessions.find((s) => s.id === id && s.ownerId === ownerId)
  }

  async function createSession(ownerId: string, title?: string): Promise<AgentSession> {
    const db = await loadDb()
    const now = new Date().toISOString()
    const session: AgentSession = {
      id: randomUUID(),
      ownerId,
      title: (title || '').trim() || '新会话',
      createdAt: now,
      updatedAt: now,
    }
    db.sessions.push(session)
    await store.save(db)
    return session
  }

  async function renameSession(ownerId: string, id: string, title: string): Promise<AgentSession[]> {
    const db = await loadDb()
    const s = db.sessions.find((x) => x.id === id && x.ownerId === ownerId)
    if (s) {
      s.title = (title || '').trim() || s.title
      s.updatedAt = new Date().toISOString()
      await store.save(db)
    }
    return listSessions(ownerId)
  }

  /** 设置会话选用的模型（模型清单记录 id）；不传 = 清除，回到默认模型 */
  async function setSessionModel(
    ownerId: string,
    id: string,
    model?: string,
  ): Promise<AgentSession | undefined> {
    const db = await loadDb()
    const s = db.sessions.find((x) => x.id === id && x.ownerId === ownerId)
    if (!s) return undefined
    if (model) s.model = model
    else delete s.model
    s.updatedAt = new Date().toISOString()
    await store.save(db)
    return s
  }

  async function deleteSession(ownerId: string, id: string): Promise<AgentSession[]> {
    const db = await loadDb()
    const target = db.sessions.find((x) => x.id === id && x.ownerId === ownerId)
    if (target) {
      db.sessions = db.sessions.filter((x) => x !== target)
      db.messages = db.messages.filter((m) => m.sessionId !== id)
      await store.save(db)
    }
    return listSessions(ownerId)
  }

  async function listMessages(ownerId: string, sessionId: string): Promise<AgentMessage[]> {
    const db = await loadDb()
    const owned = db.sessions.some((s) => s.id === sessionId && s.ownerId === ownerId)
    if (!owned) return []
    return db.messages
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }

  async function appendMessage(
    ownerId: string,
    sessionId: string,
    input: AgentMessageInput,
  ): Promise<AgentMessage | undefined> {
    const db = await loadDb()
    const s = db.sessions.find((x) => x.id === sessionId && x.ownerId === ownerId)
    if (!s) return undefined
    const now = new Date().toISOString()
    const msg: AgentMessage = {
      id: randomUUID(),
      sessionId,
      role: input.role,
      content: input.content,
      steps: input.steps?.length ? input.steps : undefined,
      createdAt: now,
    }
    db.messages.push(msg)
    s.updatedAt = now
    if ((s.title === '新会话' || !s.title) && input.role === 'user' && input.content) {
      s.title = input.content.slice(0, 30)
    }
    await store.save(db)
    return msg
  }

  async function historyOf(ownerId: string, sessionId: string): Promise<ChatMessage[]> {
    const msgs = await listMessages(ownerId, sessionId)
    return msgs.map((m) => ({ role: m.role, content: m.content }))
  }

  async function listNodes(): Promise<AgentNode[]> {
    const db = await loadDb()
    return (db.nodes ?? [])
      .slice()
      .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
  }

  async function registerNode(input: AgentNodeInput): Promise<AgentNode> {
    const db = await loadDb()
    if (!Array.isArray(db.nodes)) db.nodes = []
    const now = new Date().toISOString()
    const existing = db.nodes.find((n) => n.id === input.id)
    if (existing) {
      existing.name = input.name || existing.name
      existing.ownerId = input.ownerId
      existing.lastSeenAt = now
      await store.save(db)
      return existing
    }
    const node: AgentNode = {
      id: input.id,
      type: input.type,
      name: input.name || '桌面端',
      ownerId: input.ownerId,
      lastSeenAt: now,
      createdAt: now,
    }
    db.nodes.push(node)
    await store.save(db)
    return node
  }

  async function heartbeat(nodeId: string): Promise<boolean> {
    const db = await loadDb()
    const node = (db.nodes ?? []).find((n) => n.id === nodeId)
    if (!node) return false
    node.lastSeenAt = new Date().toISOString()
    await store.save(db)
    return true
  }

  async function unregisterNode(nodeId: string): Promise<AgentNode[]> {
    const db = await loadDb()
    db.nodes = (db.nodes ?? []).filter((n) => n.id !== nodeId)
    await store.save(db)
    return listNodes()
  }

  async function createTask(input: AgentTaskInput): Promise<AgentTask> {
    const db = await loadDb()
    if (!Array.isArray(db.tasks)) db.tasks = []
    const now = new Date().toISOString()
    const task: AgentTask = {
      id: randomUUID(),
      nodeId: input.nodeId,
      ownerId: input.ownerId,
      message: input.message,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    db.tasks.push(task)
    await store.save(db)
    return task
  }

  async function listPendingTasks(nodeId: string): Promise<AgentTask[]> {
    const db = await loadDb()
    return (db.tasks ?? [])
      .filter((t) => t.nodeId === nodeId && t.status === 'pending')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }

  async function getTask(id: string): Promise<AgentTask | undefined> {
    const db = await loadDb()
    return (db.tasks ?? []).find((t) => t.id === id)
  }

  async function completeTask(
    id: string,
    result: string,
    steps?: AgentTask['steps'],
    error?: string,
  ): Promise<AgentTask | undefined> {
    const db = await loadDb()
    const task = (db.tasks ?? []).find((t) => t.id === id)
    if (!task) return undefined
    task.status = error ? 'error' : 'done'
    task.result = error ?? result
    if (steps?.length) task.steps = steps
    task.updatedAt = new Date().toISOString()
    await store.save(db)
    return task
  }

  const service: AgentService = {
    registerTool,
    listTools() {
      return [...tools.values()].map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }))
    },
    runTool,
    resolveApproval,
    runStream,
    listSessions,
    createSession,
    renameSession,
    setSessionModel,
    deleteSession,
    listMessages,
    appendMessage,
    getSession,
    historyOf,
    migrateLegacySessions,
    listNodes,
    registerNode,
    heartbeat,
    unregisterNode,
    createTask,
    listPendingTasks,
    getTask,
    completeTask,
  }

  ctx.set('agent', service)
  ctx.on('dispose', () => {
    console.log('[agent] plugin disposed')
  })

  console.log(`[agent] plugin started, ${tools.size} tools registered`)
}

export default { name, inject, apply, Config }
export * from './types.js'
