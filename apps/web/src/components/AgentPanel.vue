<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { api } from '../lib/api'
import { apiUrl } from '../lib/config'
import { authHeaders } from '../lib/auth'
import { renderMarkdown } from '../lib/markdown'

interface AgentSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}
interface AgentMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }>
  createdAt: string
}
interface ChatItem {
  role: 'user' | 'assistant'
  content: string
  steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }>
}

const sessions = ref<AgentSession[]>([])
const currentId = ref('')
const messages = ref<ChatItem[]>([])
const input = ref('')
const loading = ref(false)
const error = ref('')
const statusText = ref('')
const tools = ref<Array<{ name: string; description: string }>>([])
const nodes = ref<Array<{ id: string; type: string; name: string; online: boolean }>>([])
// 远程任务
const remoteNodeId = ref('')
const remoteMsg = ref('')
const taskBusy = ref(false)
const remoteTasks = ref<Array<{ id: string; message: string; status: string; result?: string }>>([])
const onlineDesktopNodes = computed(() => nodes.value.filter((n) => n.online && n.type === 'desktop'))
const renamingId = ref('')
const renameInput = ref('')
const chatEl = ref<HTMLElement | null>(null)
let abortController: AbortController | null = null

function stop() {
  abortController?.abort()
  loading.value = false
}

async function loadTools() {
  try {
    const r = await api<{ tools: Array<{ name: string; description: string }> }>('/api/agent/tools')
    tools.value = r.tools
  } catch {
    /* ignore */
  }
}

async function loadNodes() {
  try {
    const r = await api<{ nodes: Array<{ id: string; type: string; name: string; online: boolean }> }>(
      '/api/agent/nodes',
    )
    nodes.value = r.nodes
  } catch {
    /* ignore */
  }
}

async function sendTask() {
  if (!remoteNodeId.value || !remoteMsg.value.trim()) return
  taskBusy.value = true
  const msg = remoteMsg.value.trim()
  try {
    const r = await api<{ task: { id: string } }>('/api/agent/tasks', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ nodeId: remoteNodeId.value, message: msg }),
    })
    remoteTasks.value.unshift({ id: r.task.id, message: msg, status: 'pending' })
    remoteMsg.value = ''
    pollTaskResult(r.task.id)
  } catch (e: any) {
    error.value = e.message
  } finally {
    taskBusy.value = false
  }
}

async function pollTaskResult(id: string) {
  const item = remoteTasks.value.find((t) => t.id === id)
  if (!item) return
  try {
    const r = await api<{ task: { status: string; result?: string } | null }>(`/api/agent/tasks/${id}`)
    if (r.task) {
      item.status = r.task.status
      item.result = r.task.result
      if (r.task.status === 'pending' || r.task.status === 'running') {
        setTimeout(() => pollTaskResult(id), 3000)
      }
    }
  } catch {
    /* ignore */
  }
}

async function loadSessions() {
  try {
    const r = await api<{ sessions: AgentSession[] }>('/api/agent/sessions')
    sessions.value = r.sessions
    if (!currentId.value && sessions.value.length) currentId.value = sessions.value[0].id
  } catch (e: any) {
    error.value = e.message
  }
}

async function loadMessages() {
  messages.value = []
  if (!currentId.value) return
  try {
    const r = await api<{ messages: AgentMessage[] }>(`/api/agent/sessions/${currentId.value}/messages`)
    messages.value = r.messages.map((m) => ({
      role: m.role,
      content: m.content,
      steps: m.steps,
    }))
    scrollToBottom()
  } catch (e: any) {
    error.value = e.message
  }
}

async function selectSession(id: string) {
  currentId.value = id
  await loadMessages()
}

async function newSession() {
  stop()
  try {
    const r = await api<{ session: AgentSession; sessions: AgentSession[] }>('/api/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: '' }),
    })
    sessions.value = r.sessions
    currentId.value = r.session.id
    messages.value = []
    error.value = ''
  } catch (e: any) {
    error.value = e.message
  }
}

async function deleteSession(id: string) {
  if (!confirm('删除该会话及其历史记录？')) return
  try {
    const r = await api<{ sessions: AgentSession[] }>(`/api/agent/sessions/${id}`, { method: 'DELETE' })
    sessions.value = r.sessions
    if (currentId.value === id) {
      currentId.value = sessions.value[0]?.id ?? ''
      await loadMessages()
    }
  } catch (e: any) {
    error.value = e.message
  }
}

async function renameSession(id: string) {
  const title = renameInput.value.trim()
  if (!title) return
  try {
    const r = await api<{ sessions: AgentSession[] }>(`/api/agent/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
    sessions.value = r.sessions
    renamingId.value = ''
  } catch (e: any) {
    error.value = e.message
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || loading.value || !currentId.value) return
  messages.value.push({ role: 'user', content: text })
  input.value = ''
  loading.value = true
  error.value = ''
  scrollToBottom()

  const assistant: ChatItem = { role: 'assistant', content: '', steps: [] }
  messages.value.push(assistant)

  try {
    abortController = new AbortController()
    const res = await fetch(apiUrl(`/api/agent/sessions/${currentId.value}/chat-stream`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
      signal: abortController.signal,
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
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
        if (ev.type === 'delta') {
          assistant.content += ev.content
          scrollToBottom()
        } else if (ev.type === 'tool') {
          assistant.steps!.push({ toolName: ev.toolName, toolArgs: ev.toolArgs, toolResult: ev.toolResult })
          scrollToBottom()
        } else if (ev.type === 'status') {
          statusText.value = ev.status
        } else if (ev.type === 'error') {
          error.value = ev.error
        }
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') error.value = e.message
  } finally {
    abortController = null
    loading.value = false
    statusText.value = ''
    scrollToBottom()
  }
}

function scrollToBottom() {
  nextTick(() => {
    chatEl.value?.scrollTo({ top: chatEl.value.scrollHeight, behavior: 'smooth' })
  })
}

onMounted(async () => {
  loadTools()
  loadNodes()
  await loadSessions()
  if (currentId.value) await loadMessages()
})
</script>

<template>
  <div class="agent card">
    <div class="row" style="justify-content: space-between">
      <h2 style="margin: 0">AI Agent</h2>
      <div>
        <span v-for="t in tools" :key="t.name" class="badge" :title="t.description">
          {{ t.name }}
        </span>
      </div>
    </div>

    <!-- 可用节点 -->
    <div v-if="nodes.length" class="nodes-line">
      <span class="nodes-label">节点</span>
      <span v-for="n in nodes" :key="n.id" class="node-chip" :class="{ on: n.online }">
        <i class="node-dot" />{{ n.name }}
      </span>
      <button class="nodes-refresh" title="刷新" @click="loadNodes">↻</button>
    </div>

    <!-- 远程派任务 -->
    <div v-if="onlineDesktopNodes.length" class="task-line">
      <select v-model="remoteNodeId" class="task-select">
        <option value="" disabled>选择节点</option>
        <option v-for="n in onlineDesktopNodes" :key="n.id" :value="n.id">{{ n.name }}</option>
      </select>
      <input
        v-model="remoteMsg"
        class="task-input"
        placeholder="派发给该节点的任务，例如：查一下今天新闻"
        @keydown.enter="sendTask"
      />
      <button class="task-btn" :disabled="!remoteNodeId || !remoteMsg.trim() || taskBusy" @click="sendTask">
        派发
      </button>
    </div>
    <div v-if="remoteTasks.length" class="task-results">
      <div v-for="t in remoteTasks" :key="t.id" class="task-item">
        <div class="task-head">
          <span class="task-status" :class="t.status">
            {{ t.status === 'done' ? '✓ 完成' : t.status === 'error' ? '✗ 失败' : '… 处理中' }}
          </span>
          <span class="task-msg">{{ t.message }}</span>
        </div>
        <div v-if="t.result" class="task-result markdown-body" v-html="renderMarkdown(t.result).html"></div>
      </div>
    </div>

    <!-- 会话列表 -->
    <div class="sessions">
      <button class="sess-new" @click="newSession">＋ 新会话</button>
      <div class="sess-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="sess-item"
          :class="{ on: s.id === currentId }"
        >
          <span class="sess-title" @click="selectSession(s.id)">{{ s.title }}</span>
          <button class="sess-btn" title="重命名" @click.stop="renamingId = s.id; renameInput = s.title">✎</button>
          <button class="sess-btn danger" title="删除" @click.stop="deleteSession(s.id)">×</button>
        </div>
        <div v-if="renamingId" class="sess-rename">
          <input v-model="renameInput" class="sess-input" placeholder="会话名称" @keydown.enter="renameSession(renamingId)" />
          <button class="sess-btn" @click="renameSession(renamingId)">确定</button>
        </div>
      </div>
    </div>

    <div v-if="error" class="error" style="margin-top: 12px">{{ error }}</div>
    <div v-if="statusText" class="agent-status">{{ statusText }}</div>

    <div ref="chatEl" class="chat">
      <div v-if="!messages.length" class="empty">
        新建会话后向 Agent 提问，它会按需调用工具（如检索知识库）来回答。<br />
        示例：先到「知识库」添加条目，再回来问「Cordis 是什么？」
      </div>

      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg"
        :class="[m.role, { streaming: m.role === 'assistant' && loading && i === messages.length - 1 }]"
      >
        <div class="msg-head">{{ m.role === 'user' ? '你' : 'Agent' }}</div>

        <div v-if="m.steps && m.steps.length" class="steps">
          <div v-for="(s, j) in m.steps" :key="j" class="step">
            <div class="step-head">🔧 调用工具 <code>{{ s.toolName }}</code></div>
            <div class="muted step-args">参数：{{ JSON.stringify(s.toolArgs) }}</div>
            <div class="step-result">{{ s.toolResult }}</div>
          </div>
        </div>

        <div
          v-if="m.role === 'assistant'"
          class="msg-content markdown-body"
          v-html="renderMarkdown(m.content).html"
        ></div>
        <div v-else class="msg-content">{{ m.content }}</div>
      </div>
    </div>

    <div class="row">
      <textarea
        v-model="input"
        placeholder="输入问题，例如：Cordis 是什么？"
        style="flex: 1; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; resize: vertical; min-height: 44px; font-family: inherit"
        @keydown.enter.exact.prevent="send"
      />
      <button v-if="!loading" class="btn" @click="send">发送</button>
      <button v-else class="btn danger" @click="stop">停止</button>
    </div>
  </div>
</template>

<style scoped>
.agent {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 140px);
}

.sessions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.sess-new {
  flex: 0 0 auto;
  border: 1px dashed var(--primary);
  background: transparent;
  color: var(--primary-dark);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.sess-list {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  flex: 1;
}
.sess-item {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 13px;
}
.sess-item.on {
  background: var(--primary-soft);
  border-color: var(--primary);
}
.sess-title {
  cursor: pointer;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sess-btn {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.sess-btn.danger {
  color: var(--danger);
}
.sess-rename {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.sess-input {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 13px;
  font-family: inherit;
  background: var(--panel);
  color: var(--text);
  width: 160px;
}

.agent-status {
  font-size: 12px;
  color: var(--muted);
  margin-top: 8px;
  font-style: italic;
}

.nodes-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
}
.nodes-label {
  color: var(--muted);
  flex: 0 0 auto;
}
.node-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
  color: var(--muted);
}
.node-chip.on {
  color: var(--ok);
  border-color: var(--ok);
}
.node-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.node-chip.on .node-dot {
  background: var(--ok);
}
.nodes-refresh {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
}

.task-line {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.task-select {
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
  background: var(--panel);
  color: var(--text);
}
.task-input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  background: var(--panel);
  color: var(--text);
}
.task-btn {
  flex: 0 0 auto;
  border: 1px solid var(--primary);
  background: var(--primary);
  color: #fff;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.task-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.task-results {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
  background: var(--bg);
}
.task-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.task-status {
  font-size: 12px;
  color: var(--muted);
  flex: 0 0 auto;
}
.task-status.done {
  color: var(--ok);
}
.task-status.error {
  color: var(--danger);
}
.task-msg {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-result {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  white-space: normal;
}

.chat {
  flex: 1;
  overflow: auto;
  margin: 16px 0;
  padding-right: 4px;
}

.msg {
  max-width: 85%;
  margin-bottom: 14px;
}

.msg.user {
  margin-left: auto;
}

.msg-head {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}

.msg.user .msg-head {
  text-align: right;
}

.msg-content {
  background: #f1f3f7;
  border-radius: 10px;
  padding: 10px 14px;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user .msg-content {
  background: var(--primary);
  color: #fff;
}

.steps {
  margin-bottom: 8px;
}

.step {
  border: 1px solid var(--border);
  border-left: 3px solid var(--warn);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 6px;
  background: #fffbeb;
}

.step-head {
  font-size: 13px;
  font-weight: 600;
}

.step-args {
  font-size: 12px;
  word-break: break-all;
}

.step-result {
  font-size: 13px;
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
}

.msg.streaming .msg-content::after {
  content: '▍';
  display: inline-block;
  margin-left: 2px;
  animation: blink 1s step-end infinite;
  color: var(--primary);
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

.msg-content.markdown-body {
  white-space: normal;
  font-size: 14px;
  line-height: 1.7;
  max-width: 100%;
}
</style>
