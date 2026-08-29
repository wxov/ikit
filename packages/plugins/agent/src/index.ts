import { Schema } from 'cordis'
import type { Context } from 'cordis'
import type { ChatMessage, LlmService, LlmToolDefinition } from '@ikit/plugin-llm'
import type { KnowledgeService } from '@ikit/plugin-knowledge'
import type { AgentRunResult, AgentService, AgentStep, AgentStreamEvent, AgentTool } from './types.js'

export const name = 'agent'
export const inject = ['llm', 'knowledge']

export interface Config {
  systemPrompt?: string
  maxSteps?: number
  knowledgeTopK?: number
}

export const Config: Schema<Config> = Schema.object({
  systemPrompt: Schema.string().default(
    '你是一个智能助手。当用户的问题涉及需要查询的事实、资料或文档时，优先调用 knowledge_search 工具检索知识库；如果知识库中没有相关内容，再基于自身知识回答。',
  ),
  maxSteps: Schema.number().default(10),
  knowledgeTopK: Schema.number().default(3),
})

interface AgentContext extends Context {
  llm: LlmService
  knowledge: KnowledgeService
}

export function apply(_ctx: Context, config: Config) {
  const ctx = _ctx as AgentContext
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

  async function run(userMessage: string, history: ChatMessage[] = []): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: config.systemPrompt ?? '' },
      ...history,
      { role: 'user', content: userMessage },
    ]
    const steps: AgentStep[] = []
    const maxSteps = config.maxSteps ?? 10

    for (let i = 0; i < maxSteps; i++) {
      const resp = await ctx.llm.chat(messages, { tools: toLlmTools() })
      const msg = resp.message
      messages.push(msg)

      const toolCalls = msg.tool_calls ?? []
      if (!toolCalls.length) {
        const answer = msg.content ?? ''
        steps.push({ type: 'final', answer })
        return { answer, steps }
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

        steps.push({ type: 'tool', toolName, toolArgs, toolResult })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult,
        })
      }
    }

    const answer = '已达到最大工具调用步数，未能完成回答。'
    steps.push({ type: 'final', answer })
    return { answer, steps }
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

  const service: AgentService = {
    registerTool,
    unregisterTool(name) {
      tools.delete(name)
    },
    listTools() {
      return [...tools.values()].map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }))
    },
    run,
    runStream,
  }

  ctx.set('agent', service)
  ctx.on('dispose', () => {
    console.log('[agent] plugin disposed')
  })

  console.log(`[agent] plugin started, ${tools.size} tools registered`)
}

export default { name, inject, apply, Config }
export * from './types.js'
