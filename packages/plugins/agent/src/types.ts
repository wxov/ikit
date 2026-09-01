import type { ChatMessage } from '@ikit/plugin-llm'

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<string> | string
}

export interface AgentToolInfo {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentStep {
  type: 'tool' | 'final'
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  answer?: string
}

export interface AgentRunResult {
  answer: string
  steps: AgentStep[]
}

export type AgentStreamEvent =
  | { type: 'tool'; toolName: string; toolArgs: Record<string, unknown>; toolResult: string }
  | { type: 'delta'; content: string }
  | { type: 'done' }

export interface AgentService {
  registerTool(tool: AgentTool): () => void
  listTools(): AgentToolInfo[]
  runStream(userMessage: string, history?: ChatMessage[]): AsyncIterable<AgentStreamEvent>
}
