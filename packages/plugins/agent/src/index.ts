import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Schema } from 'cordis'
import type { Context } from 'cordis'
import type { ChatMessage, LlmService, LlmToolDefinition } from '@ikit/plugin-llm'
import type { KnowledgeService } from '@ikit/plugin-knowledge'
import { JsonAgentStore, type AgentStore } from './store.js'
import type { AgentMessage, AgentMessageInput, AgentNode, AgentNodeInput, AgentService, AgentSession, AgentStreamEvent, AgentTask, AgentTaskInput, AgentTool } from './types.js'

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
  /** 是否启用写类工具（knowledge_add 等），默认关闭 */
  enableWriteTools?: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  filename: Schema.string().default('agent.json'),
  systemPrompt: Schema.string().default(
    '你是一个智能助手。当用户的问题涉及需要查询的事实、资料或文档时，优先调用 knowledge_search 工具检索知识库；如果知识库中没有相关内容，再基于自身知识回答。',
  ),
  maxSteps: Schema.number().default(10),
  knowledgeTopK: Schema.number().default(3),
  enableWriteTools: Schema.boolean().default(false),
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
    handler: async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) return '检索关键词为空'
      const results = await ctx.knowledge.search(query)
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

  // 内置工具：写入知识库（写类工具，需 enableWriteTools 开启）
  if (config.enableWriteTools) {
    registerTool({
      name: 'knowledge_add',
      description: '向知识库新增一条知识条目（标题 + Markdown 正文，可选分类）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '条目标题' },
          content: { type: 'string', description: '正文（Markdown）' },
          category: { type: 'string', description: '分类路径，可选' },
        },
        required: ['title', 'content'],
      },
      handler: async (args) => {
        const title = String(args.title ?? '').trim()
        const content = String(args.content ?? '').trim()
        if (!title || !content) return '标题与正文不能为空'
        const entry = await ctx.knowledge.create({
          title,
          content,
          category: args.category ? String(args.category) : undefined,
        })
        return `已新增知识条目：${entry.title}`
      },
    })
  }

  async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = tools.get(name)
    if (!tool) return `错误：未知工具 ${name}`
    try {
      return String(await tool.handler(args))
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
      for await (const ev of ctx.llm.chatStream(messages, { tools: toLlmTools() })) {
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

      for (const call of toolCalls) {
        const toolName = call.function.name
        const tool = tools.get(toolName)
        let toolArgs: Record<string, unknown> = {}
        try {
          toolArgs = JSON.parse(call.function.arguments || '{}')
        } catch {
          toolArgs = {}
        }

        yield { type: 'status', status: `正在调用工具 ${toolName}…` }
        let toolResult: string
        if (!tool) {
          toolResult = `错误：未知工具 ${toolName}`
        } else {
          try {
            toolResult = String(await tool.handler(toolArgs))
          } catch (e) {
            toolResult = `工具执行出错：${e instanceof Error ? e.message : String(e)}`
          }
        }

        yield { type: 'tool', toolName, toolArgs, toolResult }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
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
    runStream,
    listSessions,
    createSession,
    renameSession,
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
