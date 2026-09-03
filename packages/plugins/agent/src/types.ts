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
  | { type: 'status'; status: string }
  | { type: 'done' }

/** 会话（持久化） */
export interface AgentSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** 会话内一条消息（持久化）；assistant 可携带工具调用步骤 */
export interface AgentMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }>
  createdAt: string
}

export interface AgentMessageInput {
  role: 'user' | 'assistant'
  content: string
  steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }>
}

export interface AgentDb {
  sessions: AgentSession[]
  messages: AgentMessage[]
  nodes?: AgentNode[]
  tasks?: AgentTask[]
}

/** Agent 节点（如桌面端本地 agent 运行时） */
export interface AgentNode {
  id: string
  type: 'desktop' | 'server'
  name: string
  ownerId?: string
  lastSeenAt: string
  createdAt: string
}

export interface AgentNodeInput {
  id: string
  type: 'desktop'
  name: string
  ownerId: string
}

/** 远程任务：移动/Web 派发给指定节点的任务 */
export interface AgentTask {
  id: string
  nodeId: string
  ownerId: string
  message: string
  status: 'pending' | 'running' | 'done' | 'error'
  result?: string
  steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }>
  createdAt: string
  updatedAt: string
}

export interface AgentTaskInput {
  nodeId: string
  ownerId: string
  message: string
}

export interface AgentService {
  registerTool(tool: AgentTool): () => void
  listTools(): AgentToolInfo[]
  runTool(name: string, args: Record<string, unknown>): Promise<string>
  runStream(userMessage: string, history?: ChatMessage[]): AsyncIterable<AgentStreamEvent>
  /** 会话管理 */
  listSessions(): Promise<AgentSession[]>
  createSession(title?: string): Promise<AgentSession>
  renameSession(id: string, title: string): Promise<AgentSession[]>
  deleteSession(id: string): Promise<AgentSession[]>
  listMessages(sessionId: string): Promise<AgentMessage[]>
  appendMessage(sessionId: string, input: AgentMessageInput): Promise<AgentMessage>
  /** 会话历史 → 供 LLM 的 ChatMessage 序列 */
  historyOf(sessionId: string): Promise<ChatMessage[]>
  /** 节点注册/发现/心跳 */
  listNodes(): Promise<AgentNode[]>
  registerNode(input: AgentNodeInput): Promise<AgentNode>
  heartbeat(nodeId: string): Promise<boolean>
  unregisterNode(nodeId: string): Promise<AgentNode[]>
  /** 远程任务队列 */
  createTask(input: AgentTaskInput): Promise<AgentTask>
  listPendingTasks(nodeId: string): Promise<AgentTask[]>
  getTask(id: string): Promise<AgentTask | undefined>
  completeTask(id: string, result: string, steps?: AgentTask['steps'], error?: string): Promise<AgentTask | undefined>
}
