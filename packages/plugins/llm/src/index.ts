import { Schema } from 'cordis'
import type { Context } from 'cordis'
import type {
  ChatMessage,
  ChatStreamEvent,
  LlmChatOptions,
  LlmResponse,
  LlmService,
} from './types.js'

export const name = 'llm'

export interface Config {
  apiBase?: string
  apiKey?: string
  model?: string
  temperature?: number
  maxTokens?: number
  timeout?: number
  embeddingApiBase?: string
  embeddingApiKey?: string
  embeddingModel?: string
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().default('https://api.deepseek.com'),
  apiKey: Schema.string().default(''),
  model: Schema.string().default('deepseek-chat'),
  temperature: Schema.number().default(0.7),
  maxTokens: Schema.number().default(2048),
  timeout: Schema.number().default(60000),
  embeddingApiBase: Schema.string().default('https://api.siliconflow.cn/v1'),
  embeddingApiKey: Schema.string().default(''),
  embeddingModel: Schema.string().default('BAAI/bge-m3'),
})

export function apply(ctx: Context, config: Config) {
  const apiBase = (config.apiBase ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const apiKey = config.apiKey?.trim() || process.env.LLM_API_KEY || ''
  const model = config.model ?? 'deepseek-chat'
  const temperature = config.temperature ?? 0.7
  const maxTokens = config.maxTokens ?? 2048
  const timeout = config.timeout ?? 60000

  const embeddingApiBase = (config.embeddingApiBase ?? 'https://api.siliconflow.cn/v1').replace(
    /\/+$/,
    '',
  )
  const embeddingApiKey =
    config.embeddingApiKey?.trim() || process.env.EMBEDDING_API_KEY || ''
  const embeddingModel = config.embeddingModel ?? 'BAAI/bge-m3'
  const embeddingEnabled = !!embeddingApiKey

  async function chat(messages: ChatMessage[], options: LlmChatOptions = {}): Promise<LlmResponse> {
    if (!apiKey) {
      throw new Error('LLM 未配置 API Key（请设置环境变量 LLM_API_KEY 或配置 apiKey）')
    }

    const res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? temperature,
        max_tokens: options.maxTokens ?? maxTokens,
        tools: options.tools?.length ? options.tools : undefined,
      }),
      signal: AbortSignal.timeout(timeout),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM API 错误 ${res.status}: ${text.slice(0, 500)}`)
    }

    const data = (await res.json()) as any
    const message: ChatMessage = data?.choices?.[0]?.message ?? {
      role: 'assistant',
      content: '',
    }
    return {
      message,
      usage: data?.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    }
  }

  async function* chatStream(
    messages: ChatMessage[],
    options: LlmChatOptions = {},
  ): AsyncIterable<ChatStreamEvent> {
    if (!apiKey) {
      throw new Error('LLM 未配置 API Key（请设置环境变量 LLM_API_KEY 或配置 apiKey）')
    }

    const res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: options.temperature ?? temperature,
        max_tokens: options.maxTokens ?? maxTokens,
        tools: options.tools?.length ? options.tools : undefined,
      }),
      signal: AbortSignal.timeout(timeout),
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM API 错误 ${res.status}: ${text.slice(0, 500)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const message: ChatMessage = { role: 'assistant', content: '' }
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        let json: any
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        const delta = json?.choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) {
          message.content += delta.content
          yield { type: 'delta', content: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            const cur = toolCallMap.get(idx) ?? { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name = tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            toolCallMap.set(idx, cur)
          }
        }
      }
    }

    if (toolCallMap.size) {
      message.tool_calls = [...toolCallMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, t]) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.args },
        }))
    }
    yield { type: 'done', message }
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (!embeddingApiKey) {
      throw new Error('Embedding 未配置 API Key（请设置环境变量 EMBEDDING_API_KEY 或配置 embeddingApiKey）')
    }

    const res = await fetch(`${embeddingApiBase}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${embeddingApiKey}`,
      },
      body: JSON.stringify({ model: embeddingModel, input: texts }),
      signal: AbortSignal.timeout(timeout),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Embedding API 错误 ${res.status}: ${text.slice(0, 500)}`)
    }

    const data = (await res.json()) as any
    const list: any[] = data?.data ?? []
    list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return list.map((d) => d.embedding)
  }

  const service: LlmService = {
    configured: !!apiKey,
    model,
    embeddingEnabled,
    embeddingModel,
    chat,
    chatStream,
    embed,
  }

  ctx.set('llm', service)
  ctx.on('dispose', () => {
    console.log('[llm] plugin disposed')
  })

  console.log(`[llm] plugin started, model = "${model}", configured = ${!!apiKey}`)
  console.log(`[llm] embedding: model = "${embeddingModel}", enabled = ${embeddingEnabled}`)
}

export default { name, apply, Config }
export * from './types.js'
