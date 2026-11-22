export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface LlmToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmChatOptions {
  tools?: LlmToolDefinition[]
  temperature?: number
  maxTokens?: number
  /** 按调用覆盖模型 id（不传则用 Config 默认） */
  model?: string
  /** 按调用覆盖 API 地址（OpenAI 兼容，不带 /chat/completions；不传则用 Config 默认） */
  apiBase?: string
  /** 按调用覆盖密钥（不传则用 Config 默认） */
  apiKey?: string
}

export interface LlmResponse {
  message: ChatMessage
  usage?: {
    promptTokens?: number
    completionTokens?: number
  }
}

export type ChatStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; message: ChatMessage }

export interface LlmService {
  readonly configured: boolean
  readonly model: string
  readonly embeddingEnabled: boolean
  readonly embeddingModel: string
  chat(messages: ChatMessage[], options?: LlmChatOptions): Promise<LlmResponse>
  chatStream(messages: ChatMessage[], options?: LlmChatOptions): AsyncIterable<ChatStreamEvent>
  embed(texts: string[]): Promise<number[][]>
}
