import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Schema } from 'cordis'
import { findSkill, skillIndexText, skillList, SKILLS } from './skills.js'
import { createLogger, safeFetchText } from '@ikit/shared'
import type { Context } from 'cordis'
import type { ChatMessage, LlmChatOptions, LlmService, LlmToolDefinition } from '@ikit/plugin-llm'
import type { KnowledgeService, Viewer } from '@ikit/plugin-knowledge'
import { JsonAgentStore, type AgentStore } from './store.js'
import type { AgentCallContext, AgentMessage, AgentMessageInput, AgentNode, AgentNodeInput, AgentService, AgentSession, AgentStreamEvent, AgentTask, AgentTaskInput, AgentTool } from './types.js'

const log = createLogger('agent')

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
  systemPrompt: Schema.string().default(`<role>
你是「小知」（DocCurator），i-kit 知识库的文档管理员与写作搭档。你熟悉站主的文档习惯：中文、简洁、重结构、少套话。
</role>

<responsibilities>
1) 检索与答疑：先查库再回答；库里有就引用，没有就明说。
2) 整理与归类：合并重复、拆分长文、补标签与上级文档。
3) 写作与改写：新建/续写/修改在库文档（执行前系统会请站主确认）。
4) 站务协助：解释功能与操作路径，不臆测系统行为。
</responsibilities>

<tool_discipline>
- knowledge_search：问题涉及「站内资料 / 我之前写过 / 文档里有没有」时必须先检索；闲聊、常识、计算不必检索。
- 检索一次不够时，换更具体的关键词最多再试 1 次；仍无结果就回答「知识库中没有相关内容」，并说明可以怎么补录。
- web_fetch：仅当用户明确要求「查网上 / 最新 / 对比外部资料」时使用；一次对话最多抓 2 个链接。
- knowledge_add / knowledge_update：执行前先用一句话说明将改什么；不确定目标文档时先 knowledge_search 确认，不要凭标题猜。
- 工具报错：翻译成用户能理解的一句话并给出下一步（换关键词 / 补标题 / 稍后重试），不要原样抛出错误栈。
</tool_discipline>

<answer_style>
- 默认中文；先给结论，再给依据或步骤；能用 3 句说清就不写 10 句。
- 引用知识库时标注来源，如「参考《Cordis 插件框架》」。
- 列表不超过 7 条；代码或命令用代码块；不主动使用 emoji。
- 不确定就说不确定，并说明还缺什么信息。
</answer_style>

<boundaries>
- 不编造文档内容、不虚构引用、不替用户做未经确认的发布或删除。
- 涉及权限（草稿 / 私密 / 用户组）时按调用者可见性说话，不暗示他人文档存在。
- 不输出与任务无关的长篇背景。
</boundaries>

<examples>
<example>
用户：知识库里有没有讲 Cordis 插件依赖注入的？
小知：先调用 knowledge_search 检索「Cordis 依赖注入」；有结果则给 2–3 句结论并标注《标题》，没有则回答「知识库中没有相关内容」并建议补录。
</example>
<example>
用户：帮我把重复的笔记合并一下。
小知：先检索候选并列出「保留 / 合并 / 拆分」方案，等用户确认后再逐条调用 knowledge_update；不要一次性大改。
</example>
<example>
用户：写一篇《Vite 构建优化》放进技术/前端。
小知：先给 3–6 节提纲（含代码块位置），确认后用 knowledge_add 写入草稿，再询问是否发布。
</example>
<example>
用户：把别人的私密文档删掉。
小知：说明没有权限、也看不到该文档，并给出替代路径（联系站主 / 让站主操作），不调用任何写工具。
</example>
</examples>`),
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
      '在站主的知识库中做语义/关键词混合检索，返回最相关的若干条目（标题 + 正文）。' +
      '何时用：用户问「文档里有没有…」「我之前写过…」，或需要引用站内资料支撑回答时。' +
      '何时不用：纯常识、计算、闲聊；用户明确要求联网时改用 web_fetch。' +
      '失败处理：返回「知识库中没有找到相关内容」时，换更具体的关键词再试一次；仍失败就直说没有，并建议补录。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题，尽量具体（如「Cordis 依赖注入」而不是「那个框架」）' },
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
    description:
      '返回服务器当前日期时间（Asia/Shanghai）。' +
      '何时用：用户问「现在几点 / 今天几号」，或需要以当前时间做推算（如倒计时）时。' +
      '何时不用：与时间无关的普通问题，不要为了「确认时间」额外调用。',
    parameters: { type: 'object', properties: {} },
    handler: async () =>
      new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  })

  // 内置工具：抓取网页（浏览器控制简化版，返回标题 + 纯文本摘要）
  registerTool({
    name: 'web_fetch',
    description:
      '抓取指定网页并返回标题与纯文本摘要（服务端安全抓取，拒绝内网/本机地址，单页上限 1MB）。' +
      '何时用：用户明确要求「查网上资料 / 最新动态 / 对比外部文档」，且知识库没有相关内容时。' +
      '何时不用：站内问题优先 knowledge_search；一次对话最多抓 2 个链接，不要抓取搜索结果页或需要登录的页面。' +
      '失败处理：返回「抓取失败 / 请求失败 HTTP xxx」时，直接说明该链接不可用并给出替代建议，不要重复重试。',
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
        // 安全抓取：仅 http/https、拒绝内网/本机/链路本地（含云元数据）、逐跳校验重定向、响应体上限 1MB
        const safe = await safeFetchText(url, { userAgent: 'i-kit-agent/1.0', timeoutMs: 15000, maxBytes: 1024 * 1024 })
        if (!safe.ok) return `请求失败 HTTP ${safe.status}`
        const html = safe.text
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

  // 内置工具：加载技能正文（渐进披露，2026-11-28 M2）
  registerTool({
    name: 'use_skill',
    description:
      '加载某个技能的完整操作流程（正文）。' +
      '何时用：判断需要按固定流程处理时（文档整理、写作、联网调研、站务问答），先调用本工具加载对应技能，再按其中步骤执行。' +
      '何时不用：普通问答不需要；一次对话最多加载 2 个技能，不要重复加载同一个。' +
      '参数：name 必须是技能索引里的名字；返回正文后按步骤继续，不要偏离流程。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: SKILLS.map((s) => s.name),
          description: '技能名（见 system prompt 的技能索引）',
        },
      },
      required: ['name'],
    },
    handler: async (args, call) => {
      const skill = findSkill(String(args.name ?? ''))
      if (!skill) {
        return `未找到技能「${String(args.name)}」。可用技能：${SKILLS.map((s) => s.name).join('、')}`
      }
      if (skill.requiresAdmin && call?.role !== 'admin') {
        return '错误：该技能仅站主可用。'
      }
      log.info(`[agent] use_skill ${skill.name} by user ${call?.userId ?? '(unknown)'}`)
      return `【技能：${skill.title}（${skill.name} ${skill.version}）】\n${skill.body}`
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
        '向知识库新增一篇文档（标题 + Markdown 正文；可选分类/父文档/标签/可见性/发布状态）。' +
        '何时用：用户明确要求「新建 / 写一篇 / 存到知识库」，且已有足够内容或提纲时。' +
        '何时不用：只想讨论思路时先给提纲；修改已有文档用 knowledge_update。' +
        '注意：属于写操作，仅站主可用，执行前系统会请用户确认；status 缺省为草稿，发布需用户明确同意。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题（必填，非空）' },
          content: { type: 'string', description: '正文（Markdown，可含代码块；发布时不可为空）' },
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
        log.info(`[agent] knowledge_add by user ${call?.userId ?? '(unknown)'}`)
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
        '修改知识库中的一篇文档：可按 id 或标题匹配目标，改标题/正文（替换或追加）/分类/标签/可见性/发布状态。' +
        '何时用：用户要求「改 / 补充 / 续写 / 调整分类或标签」已有文档时；先用 knowledge_search 或 id 确认目标。' +
        '何时不用：创建新文档用 knowledge_add；删除/移动不支持，请让用户在界面操作。' +
        '硬约束：用户没有给出完整新正文时，优先 append 或只改字段，**禁止整篇 replace**；执行前系统会请用户确认。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '目标文档 id（可选；与 matchTitle 二选一）' },
          matchTitle: { type: 'string', description: '目标文档标题（可选；按标题精确/包含匹配）' },
          title: { type: 'string', description: '新的标题（可选）' },
          content: { type: 'string', description: '正文内容（配合 mode 使用；replace 会整篇覆盖，慎用）' },
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
        log.info(`[agent] knowledge_update by user ${call?.userId ?? '(unknown)'} -> ${target.id}`)
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
      { role: 'system', content: [config.systemPrompt ?? '', skillIndexText()].filter(Boolean).join('\n\n') },
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
      log.info(`[agent] 已将 ${legacy.length} 个遗留会话归属给 admin`)
      return { migrated: legacy.length, cleared: 0 }
    }

    db.sessions = db.sessions.filter((s) => s.ownerId)
    db.messages = db.messages.filter((m) => db.sessions.some((s) => s.id === m.sessionId))
    await store.save(db)
    log.warn(`[agent] 未找到 admin，清空 ${legacy.length} 个遗留会话`)
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
    listSkills: () => skillList(),
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
    log.info('[agent] plugin disposed')
  })

  log.info(`[agent] plugin started, ${tools.size} tools registered`)
}

export default { name, inject, apply, Config }
export * from './types.js'
