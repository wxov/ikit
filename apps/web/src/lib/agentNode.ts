// 桌面端本地 agent 节点客户端：
// - 注册/心跳到服务端，三端可见
// - 轮询派发到本节点的任务，在「本地」跑 agent 循环：LLM 走服务端、本地工具走 Tauri 原生命令
import { api } from './api'
import { apiUrl } from './config'
import { authHeaders, getToken } from './auth'
import { detectPlatform } from './update'

const NODE_ID_KEY = 'ikit-agent-node-id'

interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

interface TaskStep {
  toolName: string
  toolArgs: Record<string, unknown>
  toolResult: string
}

function isDesktop(): boolean {
  return detectPlatform() === 'tauri'
}

function nodeId(): string {
  let id = localStorage.getItem(NODE_ID_KEY)
  if (!id) {
    try {
      id = crypto.randomUUID()
    } catch {
      id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    }
    localStorage.setItem(NODE_ID_KEY, id)
  }
  return id
}

async function registerOnce(): Promise<void> {
  if (!getToken()) return
  try {
    await api('/api/agent/nodes/register', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: nodeId(), name: '桌面端' }),
    })
  } catch {
    /* 未登录或网络失败时静默，等待下次心跳再注册 */
  }
}

async function heartbeatOnce(): Promise<void> {
  if (!getToken()) return
  try {
    await api(`/api/agent/nodes/${nodeId()}/heartbeat`, { method: 'POST' })
  } catch {
    /* ignore */
  }
}

async function tauriInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const w = window as any
  if (!w.__TAURI_INTERNALS__?.invoke) throw new Error('Tauri 运行时不可用')
  return w.__TAURI_INTERNALS__.invoke(cmd, args)
}

// 本地工具（在桌面本机执行；文件读写已被原生层限制在 agent-workspace 目录内）
const LOCAL_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'exec_command',
      description:
        '在本机执行白名单命令（如 ipconfig、whoami、systeminfo、tasklist、ping 等），返回命令输出。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的命令' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_local_file',
      description: '读取桌面端 agent-workspace 目录内的文本文件，返回其内容。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对 agent-workspace 的文件路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_local_file',
      description: '在桌面端 agent-workspace 目录内写入文本文件（覆盖写，自动创建父目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 agent-workspace 的文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
]

function isLocalTool(name: string): boolean {
  return LOCAL_TOOLS.some((t) => t.function.name === name)
}

async function runLocalTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'exec_command') {
    return String(await tauriInvoke('exec_command', { command: String(args.command ?? '') }))
  }
  if (name === 'read_local_file') {
    return String(await tauriInvoke('read_local_file', { path: String(args.path ?? '') }))
  }
  if (name === 'write_local_file') {
    await tauriInvoke('write_local_file', {
      path: String(args.path ?? ''),
      content: String(args.content ?? ''),
    })
    return `已写入文件：${String(args.path)}`
  }
  throw new Error(`未知本地工具 ${name}`)
}

async function runServerTool(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await api<{ result: string }>(`/api/agent/tools/${name}/run`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ args }),
  })
  return r.result
}

async function fetchServerTools(): Promise<ToolDef[]> {
  const r = await api<{
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  }>('/api/agent/tools')
  return r.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

// 单次 LLM 流式调用，返回最终 assistant 消息（含 tool_calls）
async function llmChat(messages: LlmMessage[], tools: ToolDef[]): Promise<LlmMessage> {
  const res = await fetch(apiUrl('/api/llm/chat-stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ messages, tools }),
  })
  if (!res.ok || !res.body) throw new Error(`LLM HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: LlmMessage = { role: 'assistant', content: '' }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      let ev: any
      try {
        ev = JSON.parse(trimmed.slice(5).trim())
      } catch {
        continue
      }
      if (ev.type === 'done' && ev.message) final = ev.message
      else if (ev.type === 'error') throw new Error(ev.error ?? 'LLM error')
    }
  }
  return final
}

const SYSTEM_PROMPT =
  '你是一个在用户桌面端本地运行的智能助手。' +
  '你可以调用本机工具（exec_command / read_local_file / write_local_file）以及服务端工具（如 knowledge_search / web_fetch / current_time）来完成任务。' +
  '涉及本机信息（网络、进程、本机文件）时优先使用本地工具；涉及知识库或网页内容时使用服务端工具。'

async function runTaskLocally(message: string): Promise<{ answer: string; steps: TaskStep[] }> {
  const serverTools = await fetchServerTools()
  const tools = [...LOCAL_TOOLS, ...serverTools]
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: message },
  ]
  const steps: TaskStep[] = []
  const maxSteps = 10
  for (let i = 0; i < maxSteps; i++) {
    const msg = await llmChat(messages, tools)
    const toolCalls = msg.tool_calls ?? []
    if (!toolCalls.length) {
      return { answer: msg.content || '(无回答)', steps }
    }
    messages.push(msg)
    for (const call of toolCalls) {
      const args = parseArgs(call.function.arguments)
      const name = call.function.name
      let result: string
      try {
        result = isLocalTool(name)
          ? await runLocalTool(name, args)
          : await runServerTool(name, args)
      } catch (e) {
        result = `工具执行出错：${e instanceof Error ? e.message : String(e)}`
      }
      steps.push({ toolName: name, toolArgs: args, toolResult: result })
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }
  return { answer: '（达到最大步骤数仍未完成）', steps }
}

async function completeTaskLocally(id: string, message: string): Promise<void> {
  try {
    const { answer, steps } = await runTaskLocally(message)
    await api(`/api/agent/tasks/${id}/complete`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ result: answer, steps }),
    })
  } catch (e) {
    await api(`/api/agent/tasks/${id}/complete`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    })
  }
}

// 轮询并执行派发到本节点的远程任务（本地 agent 循环）；防重入，未登录不轮询
let polling = false
async function pollAndRunTasks(): Promise<void> {
  if (polling || !getToken()) return
  polling = true
  try {
    const r = await api<{ tasks: Array<{ id: string; message: string }> }>(
      `/api/agent/nodes/${nodeId()}/tasks`,
      { headers: authHeaders() },
    )
    for (const t of r.tasks ?? []) {
      await completeTaskLocally(t.id, t.message)
    }
  } catch {
    /* ignore */
  } finally {
    polling = false
  }
}

/** 启动桌面节点：立即注册 + 每 20s 心跳并轮询执行派发的任务；返回停止函数 */
export function startDesktopNode(): () => void {
  if (!isDesktop()) return () => {}
  let stopped = false
  const tick = async () => {
    if (stopped) return
    await registerOnce()
    await heartbeatOnce()
    await pollAndRunTasks()
  }
  void tick()
  const timer = window.setInterval(() => {
    void heartbeatOnce()
    void pollAndRunTasks()
  }, 20000)
  return () => {
    stopped = true
    window.clearInterval(timer)
  }
}

export { isDesktop }
