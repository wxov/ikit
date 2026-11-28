<script setup lang="ts">
import { ref, computed, inject, nextTick, onMounted } from 'vue'
import type { Ref } from 'vue'
import { api } from '../lib/api'
import { apiUrl } from '../lib/config'
import { authHeaders } from '../lib/auth'
import type { PublicUser } from '../lib/auth'
import { renderMarkdown } from '../lib/markdown'
import { useAgentModels, compositeOf, type AgentSession } from '../composables/useAgentModels'

interface AgentMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }>
  createdAt: string
}
interface ApprovalInfo {
  callId: string
  tool: string
  summary: string
  args: Record<string, unknown>
  state: 'pending' | 'approved' | 'denied' | 'error'
  message?: string
}
interface ChatItem {
  role: 'user' | 'assistant'
  content: string
  steps?: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolResult: string }>
  /** 写类工具待确认卡片（新增/修改文档） */
  approval?: ApprovalInfo
}

const currentUser = inject<Ref<PublicUser | null>>('currentUser', ref(null))
const loggedIn = computed(() => !!currentUser.value)

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

// ---- 模型选择 / 模型配置（P2-10）：逻辑抽到 composables/useAgentModels.ts ----
const isAdmin = computed(() => currentUser.value?.role === 'admin')
const {
  models,
  defaultModelId,
  selectedModel,
  modelsError,
  loadModels,
  syncModelFromSession,
  configOpen,
  configProviders,
  configDefaultId,
  configLoading,
  configSaving,
  configNotice,
  fetchOpen,
  fetchProviderIdx,
  fetchLoading,
  fetchError,
  fetchManual,
  fetchList,
  openModelConfig,
  addProvider,
  removeProvider,
  addModel,
  removeModel,
  openFetch,
  doFetch,
  toggleAllFetch,
  applyFetch,
  saveModelConfig,
} = useAgentModels({ loggedIn, isAdmin, sessions, currentId })

function stop() {
  abortController?.abort()
  loading.value = false
}

async function loadTools() {
  try {
    const r = await api<{ tools: Array<{ name: string; description: string }> }>('/api/agent/tools', {
      headers: authHeaders(),
    })
    tools.value = r.tools
  } catch {
    /* ignore */
  }
}

async function loadNodes() {
  try {
    const r = await api<{ nodes: Array<{ id: string; type: string; name: string; online: boolean }> }>(
      '/api/agent/nodes',
      { headers: authHeaders() },
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
    const r = await api<{ task: { status: string; result?: string } | null }>(`/api/agent/tasks/${id}`, {
      headers: authHeaders(),
    })
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
  if (!loggedIn.value) return
  try {
    const r = await api<{ sessions: AgentSession[] }>('/api/agent/sessions', { headers: authHeaders() })
    sessions.value = r.sessions
    if (!currentId.value && sessions.value.length) currentId.value = sessions.value[0].id
    syncModelFromSession()
  } catch (e: any) {
    error.value = e.message
  }
}

async function loadMessages() {
  messages.value = []
  if (!currentId.value) return
  try {
    const r = await api<{ messages: AgentMessage[] }>(`/api/agent/sessions/${currentId.value}/messages`, {
      headers: authHeaders(),
    })
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
  syncModelFromSession()
  await loadMessages()
}

async function newSession() {
  if (!loggedIn.value) return
  stop()
  try {
    const r = await api<{ session: AgentSession; sessions: AgentSession[] }>('/api/agent/sessions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title: '' }),
    })
    sessions.value = r.sessions
    currentId.value = r.session.id
    selectedModel.value = defaultModelId.value
    messages.value = []
    error.value = ''
  } catch (e: any) {
    error.value = e.message
  }
}

// 删除会话：用应用内确认弹窗替代 window.confirm（桌面/移动 webview 会屏蔽原生 confirm → 点击无反应）
const confirmDeleteId = ref('')

function askDeleteSession(id: string) {
  error.value = ''
  confirmDeleteId.value = id
}

async function doDeleteSession() {
  const id = confirmDeleteId.value
  if (!id || loading.value) return
  try {
    const r = await api<{ sessions: AgentSession[] }>(`/api/agent/sessions/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    sessions.value = r.sessions
    confirmDeleteId.value = ''
    if (currentId.value === id) {
      currentId.value = sessions.value[0]?.id ?? ''
      syncModelFromSession()
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
      headers: authHeaders(),
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
  if (!loggedIn.value || !text || loading.value || !currentId.value) return
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
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: text, model: selectedModel.value || undefined }),
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
        } else if (ev.type === 'approval') {
          // 写操作需用户确认：插到当前流式回答之前，展示确认卡片
          const item: ChatItem = {
            role: 'assistant',
            content: '',
            approval: {
              callId: String(ev.callId ?? ''),
              tool: String(ev.tool ?? ''),
              summary: String(ev.summary ?? ev.tool ?? '写操作'),
              args: (ev.args ?? {}) as Record<string, unknown>,
              state: 'pending',
            },
          }
          const idx = messages.value.indexOf(assistant)
          messages.value.splice(idx >= 0 ? idx : messages.value.length, 0, item)
          statusText.value = '等待你确认写操作…'
          scrollToBottom()
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

// ---- 输入提示词润色（「✨优化」，2026-11-28）：**手动触发**，不自动改写 ----
const polishBusy = ref(false)
const polishError = ref('')
const polishCard = ref<{ prompt: string; added: string[]; degraded: boolean } | null>(null)
const polishDraft = ref('')

async function doPromptPolish() {
  const text = input.value.trim()
  if (!loggedIn.value || !text || polishBusy.value) return
  polishBusy.value = true
  polishError.value = ''
  polishCard.value = null
  try {
    const sessionTitle = sessions.value.find((s) => s.id === currentId.value)?.title ?? ''
    const r = await api<{ prompt: string; added: string[]; intent: string; degraded: boolean }>('/api/agent/prompt-polish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ text, context: sessionTitle }),
    })
    polishDraft.value = r.prompt || text
    polishCard.value = { prompt: r.prompt || text, added: r.added ?? [], degraded: !!r.degraded }
  } catch (e: any) {
    polishError.value = e?.message ?? String(e)
  } finally {
    polishBusy.value = false
  }
}

/** 采用优化后的提示词并直接发送 */
function usePolishedPrompt() {
  if (!polishCard.value) return
  input.value = polishDraft.value
  polishCard.value = null
  polishError.value = ''
  void send()
}

function closePolishCard() {
  polishCard.value = null
  polishError.value = ''
}

/** 写操作确认卡片：参数预览（超长截断） */
function approvalArgsText(args: Record<string, unknown>): string {
  let s = ''
  try {
    s = JSON.stringify(args, null, 2)
  } catch {
    s = String(args)
  }
  return s.length > 1200 ? `${s.slice(0, 1200)}\n…（已截断）` : s
}

/** 允许 / 拒绝一次写操作（服务端据此继续或取消该工具调用） */
async function respondApproval(item: ChatItem, approved: boolean) {
  const a = item.approval
  if (!a || a.state !== 'pending' || !currentId.value) return
  a.state = approved ? 'approved' : 'denied'
  try {
    await api(`/api/agent/sessions/${currentId.value}/approvals/${a.callId}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ approved }),
    })
  } catch (e: any) {
    a.state = 'error'
    a.message = e?.message ?? String(e)
  }
}

onMounted(async () => {
  loadTools()
  loadNodes()
  if (loggedIn.value) {
    await loadModels()
    await loadSessions()
    if (currentId.value) await loadMessages()
    syncModelFromSession()
  }
})
</script>

<template>
  <div class="agent card">
    <div class="row" style="justify-content: space-between">
      <h2 style="margin: 0">小知 · DocCurator</h2>
      <!-- 模型选择：按会话记忆（服务端随消息持久化）；非站主只看到「对普通用户可见」的模型 -->
      <div v-if="loggedIn" class="model-pick" :title="modelsError || '选择本会话使用的模型'">
        <label>模型</label>
        <select v-model="selectedModel" :disabled="!models.length">
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.providerName }} · {{ m.name }}</option>
        </select>
        <span v-if="!models.length" class="model-hint">未配置模型</span>
        <button v-if="isAdmin" class="model-cfg-btn" title="模型配置（增删改模型 / 默认 / 可见性）" @click="openModelConfig">
          ⚙ 配置
        </button>
      </div>
      <div>
        <span v-for="t in tools" :key="t.name" class="badge" :title="t.description">
          {{ t.name }}
        </span>
      </div>
    </div>

    <!-- 未登录提示（保留小知入口，面板内提示登录） -->
    <div v-if="!loggedIn" class="agent-login-hint">
      ⚠ 请先登录后使用小知（DocCurator）——会话、消息与对话均需登录。
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
    <div v-if="loggedIn" class="sessions">
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
          <button class="sess-btn danger" title="删除" @click.stop="askDeleteSession(s.id)">×</button>
        </div>
        <div v-if="renamingId" class="sess-rename">
          <input v-model="renameInput" class="sess-input" placeholder="会话名称" @keydown.enter="renameSession(renamingId)" />
          <button class="sess-btn" @click="renameSession(renamingId)">确定</button>
        </div>
      </div>
    </div>

    <div v-if="error" class="error" style="margin-top: 12px">{{ error }}</div>
    <div v-if="statusText" class="agent-status">{{ statusText }}</div>

    <div v-if="loggedIn" ref="chatEl" class="chat">
      <div v-if="!messages.length" class="empty">
        我是小知，i-kit 知识库的文档管家。<br />
        可以帮你检索资料、整理归类，也能新增或修改文档——写入前会先请你确认。<br />
        直接说需求就行，比如「把上周的会议纪要整理成一篇文档」。
      </div>

      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg"
        :class="[m.role, { streaming: m.role === 'assistant' && loading && i === messages.length - 1 }]"
      >
        <div class="msg-head">{{ m.role === 'user' ? '你' : '小知' }}</div>

        <!-- 写操作确认卡片（新增/修改文档需用户允许后才执行） -->
        <div v-if="m.approval" class="approval-card" :class="m.approval.state">
          <div class="ap-head">🔐 需要确认：{{ m.approval.summary }}</div>
          <div class="ap-tool">工具：<code>{{ m.approval.tool }}</code></div>
          <pre class="ap-args">{{ approvalArgsText(m.approval.args) }}</pre>
          <div v-if="m.approval.state === 'pending'" class="ap-actions">
            <button class="btn" @click="respondApproval(m, true)">允许并执行</button>
            <button class="btn danger" @click="respondApproval(m, false)">拒绝</button>
          </div>
          <div v-else class="ap-state">
            {{ m.approval.state === 'approved' ? '✅ 已允许，执行中…' : m.approval.state === 'denied' ? '🚫 已拒绝，未写入' : '⚠️ ' + (m.approval.message || '提交失败') }}
          </div>
        </div>

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

    <div v-if="loggedIn" class="row">
      <textarea
        v-model="input"
        placeholder="输入问题，例如：Cordis 是什么？"
        style="flex: 1; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; resize: vertical; min-height: 44px; font-family: inherit"
        @keydown.enter.exact.prevent="send"
      />
      <button
        v-if="!loading"
        class="btn secondary"
        :disabled="polishBusy || !input.trim()"
        title="把这句话补全成更清晰的指令（仅在你点击时执行）"
        @click="doPromptPolish"
      >
        {{ polishBusy ? '优化中…' : '✨ 优化' }}
      </button>
      <button v-if="!loading" class="btn" @click="send">发送</button>
      <button v-else class="btn danger" @click="stop">停止</button>
    </div>

    <!-- 提示词优化结果卡片：可编辑后「用这个发送」 -->
    <div v-if="polishCard || polishError" class="polish-card">
      <div class="polish-head">
        ✨ 优化后的提示词
        <span v-if="polishCard?.degraded" class="polish-warn">（未能优化，可直接发送原文）</span>
      </div>
      <div v-if="polishError" class="polish-err">{{ polishError }}</div>
      <template v-else>
        <textarea v-model="polishDraft" class="polish-draft" rows="3" />
        <div v-if="polishCard?.added?.length" class="polish-added">补充：{{ polishCard.added.join('；') }}</div>
        <div class="polish-actions">
          <button class="btn secondary sm" @click="closePolishCard">取消</button>
          <button class="btn sm" @click="usePolishedPrompt">用这个发送</button>
        </div>
      </template>
    </div>

    <!-- 模型配置（站主，小知面板内）：按供应商分组（参考 CC Switch）；Teleport 到 body 避免被面板裁剪 -->
    <Teleport to="body">
      <div v-if="configOpen" class="mc-overlay" @click.self="configSaving ? undefined : (configOpen = false)">
        <div class="mc-modal">
          <h3>⚙ 模型配置</h3>
          <p class="mc-hint">
            按<b>供应商</b>分组：第一行填连接信息（名称 / apiBase / API Key），第二行管理该供应商下的模型；
            「⇩ 获取模型列表」会请求 <code>{apiBase}/models</code>，勾选后加入。密钥只保存在服务端，这里只显示掩码；
            <b>留空表示不修改</b>。
          </p>
          <div v-if="configLoading" class="mc-hint">加载中…</div>
          <div v-else class="mc-providers">
            <div v-for="(p, pi) in configProviders" :key="pi" class="mc-provider">
              <div class="mc-provider-top">
                <input v-model="p.name" class="mc-input mc-pname" placeholder="供应商名（如 DeepSeek）" />
                <input v-model="p.apiBase" class="mc-input" placeholder="apiBase（如 https://api.deepseek.com）" />
                <input
                  v-model="p.apiKey"
                  class="mc-input"
                  type="password"
                  :placeholder="p.hasKey ? '已保存 ' + p.keyMask + '，留空不修改' : 'API Key'"
                />
                <button class="mc-btn" :disabled="fetchLoading" @click="openFetch(pi)">⇩ 获取模型列表</button>
                <button class="mc-del" @click="removeProvider(pi)">删除供应商</button>
              </div>
              <div class="mc-models">
                <div v-for="(m, mi) in p.models" :key="mi" class="mc-model">
                  <label class="mc-def">
                    <input
                      type="radio"
                      :checked="configDefaultId === compositeOf(p, m)"
                      @change="configDefaultId = compositeOf(p, m)"
                    />
                    默认
                  </label>
                  <input v-model="m.name" class="mc-input" placeholder="显示名（如 DeepSeek Chat）" />
                  <input v-model="m.model" class="mc-input" placeholder="模型 id（如 deepseek-chat）" />
                  <label class="mc-chk"><input type="checkbox" v-model="m.visibleToUsers" /> 对普通用户可见</label>
                  <button class="mc-del" @click="removeModel(pi, mi)">删除</button>
                </div>
                <div class="mc-actions">
                  <button class="mc-btn" @click="addModel(pi)">＋ 手动添加模型</button>
                </div>
              </div>
            </div>
            <div class="mc-actions mc-footer">
              <button class="mc-btn" @click="addProvider">＋ 添加供应商</button>
              <button class="mc-btn primary" :disabled="configSaving" @click="saveModelConfig">
                {{ configSaving ? '保存中…' : '保存' }}
              </button>
              <button class="mc-btn" :disabled="configSaving" @click="configOpen = false">关闭</button>
            </div>
            <div v-if="modelsError" class="mc-error">❌ {{ modelsError }}</div>
            <div v-if="configNotice" class="mc-ok">✅ {{ configNotice }}</div>
          </div>
        </div>
      </div>

      <!-- 一键获取模型列表（拉回后勾选加入；也可手动输入 id 兜底） -->
      <div v-if="fetchOpen" class="mc-overlay" @click.self="fetchOpen = false">
        <div class="mc-fetch">
          <h3>⇩ 获取模型列表</h3>
          <p class="mc-hint">
            {{ configProviders[fetchProviderIdx]?.name || '供应商' }} · {{ configProviders[fetchProviderIdx]?.apiBase }}
          </p>
          <div class="mc-actions" style="margin-bottom: 8px">
            <button class="mc-btn" :disabled="fetchLoading" @click="doFetch">
              {{ fetchLoading ? '获取中…' : '开始获取' }}
            </button>
            <button class="mc-btn" @click="toggleAllFetch(true)">全选</button>
            <button class="mc-btn" @click="toggleAllFetch(false)">全不选</button>
          </div>
          <div v-if="fetchError" class="mc-error">❌ {{ fetchError }}</div>
          <div v-if="fetchList.length" class="mc-fetch-list">
            <label v-for="f in fetchList" :key="f.id" class="mc-fetch-item" :class="{ exists: f.exists }">
              <input type="checkbox" v-model="f.checked" :disabled="f.exists" />
              <span class="mc-fetch-id">{{ f.id }}</span>
              <span v-if="f.exists" class="mc-fetch-tag">已存在</span>
            </label>
          </div>
          <div class="mc-actions" style="margin-top: 8px">
            <input
              v-model="fetchManual"
              class="mc-input"
              style="flex: 1"
              placeholder="可手动输入模型 id（逗号 / 空格分隔）"
            />
          </div>
          <div class="mc-actions">
            <button class="mc-btn primary" @click="applyFetch">加入所选</button>
            <button class="mc-btn" @click="fetchOpen = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除会话确认：应用内弹窗（替代 window.confirm） -->
    <Teleport to="body">
      <div v-if="confirmDeleteId" class="sess-modal-mask" @click.self="confirmDeleteId = ''">
        <div class="sess-modal" role="dialog" aria-label="确认删除会话">
          <div class="sess-modal-title">删除该会话？</div>
          <div class="sess-modal-body">会话及其历史记录将被永久删除，不可恢复。</div>
          <div v-if="error" class="sess-modal-error">{{ error }}</div>
          <div class="sess-modal-actions">
            <button class="sess-modal-btn" :disabled="loading" @click="confirmDeleteId = ''">取消</button>
            <button class="sess-modal-btn danger" :disabled="loading" @click="doDeleteSession">
              {{ loading ? '删除中…' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.agent {
  display: flex;
  flex-direction: column;
  /* 高度由外层中栏固定（App.vue .portal-main--fit）决定，这里只填满；不再写死 100vh-140（会超出视口导致整栏滚动） */
  height: 100%;
  min-height: 0;
}

.agent-login-hint {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px dashed var(--warn, #d97706);
  border-radius: 10px;
  background: #fffbeb;
  color: var(--text);
  font-size: 13px;
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
  /* 关键：flex 子项默认 min-height:auto 不允许收缩 → 内容会把整栏撑高；显式 min-height:0 才能让对话区自身滚动 */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  margin: 16px 0;
  padding-right: 4px;
  overscroll-behavior: contain;
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

/* 模型选择器（小知头部） */
.model-pick {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--muted); flex: 0 0 auto;
}
.model-pick label { white-space: nowrap; }
.model-pick select {
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel); color: var(--text);
  padding: 5px 8px; font-size: 12px; font-family: inherit;
  max-width: 200px;
}
.model-pick select:disabled { opacity: 0.6; }
.model-hint { font-size: 12px; color: var(--muted); }
@media (max-width: 768px) {
  .model-pick select { max-width: 140px; }
}

/* 模型配置入口 + 弹窗（站主，小知面板内） */
.model-cfg-btn {
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
  white-space: nowrap;
}
.model-cfg-btn:hover { background: var(--primary-soft); color: var(--primary-dark); }
.mc-overlay {
  position: fixed; inset: 0; z-index: 1100;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.mc-modal {
  width: min(860px, 96vw); max-height: 86vh; overflow: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 20px;
}
.mc-modal h3 { margin: 0 0 8px; font-size: 16px; }
.mc-hint { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0 0 10px; }
.mc-hint code { background: var(--primary-soft); padding: 0 4px; border-radius: 4px; }
.mc-list { display: flex; flex-direction: column; gap: 8px; }
.mc-row {
  display: grid;
  grid-template-columns: 62px minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1.2fr) auto auto;
  gap: 6px; align-items: center;
  border: 1px solid var(--border); border-radius: 10px; padding: 8px;
}
.mc-input {
  width: 100%; min-width: 0; box-sizing: border-box;
  border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px;
  font-size: 12px; font-family: inherit; background: var(--panel); color: var(--text);
}
.mc-def, .mc-chk { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.mc-del {
  border: 1px solid var(--danger, #dc2626); color: var(--danger, #dc2626);
  background: transparent; border-radius: 6px; padding: 4px 8px; font-size: 12px;
  cursor: pointer; font-family: inherit;
}
.mc-actions { display: flex; gap: 8px; margin-top: 4px; }
.mc-btn {
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.mc-btn.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
.mc-btn:disabled { opacity: 0.6; cursor: default; }
.mc-error { font-size: 12px; color: var(--danger, #dc2626); }
.mc-ok { font-size: 12px; color: var(--primary-dark); }
@media (max-width: 900px) { .mc-row { grid-template-columns: 1fr 1fr; } }

/* 供应商卡片（模型配置 v2） */
.mc-providers { display: flex; flex-direction: column; gap: 10px; }
.mc-provider { border: 1px solid var(--border); border-radius: 12px; padding: 10px; background: var(--panel); }
.mc-provider-top {
  display: grid;
  grid-template-columns: 150px minmax(0, 1.4fr) minmax(0, 1.2fr) auto auto;
  gap: 6px; align-items: center;
}
.mc-pname { font-weight: 600; }
.mc-models { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.mc-model {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr) auto auto;
  gap: 6px; align-items: center;
  padding: 6px 0 0;
  border-top: 1px dashed var(--border);
}
.mc-model:first-child { border-top: none; padding-top: 0; }
.mc-footer { margin-top: 4px; }
.mc-fetch {
  width: min(560px, 94vw); max-height: 84vh; overflow: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 20px;
}
.mc-fetch h3 { margin: 0 0 6px; font-size: 16px; }
.mc-fetch-list {
  max-height: 46vh; overflow: auto;
  display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--border); border-radius: 10px; padding: 6px;
}
.mc-fetch-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.mc-fetch-item:hover { background: var(--primary-soft); }
.mc-fetch-item.exists { opacity: 0.55; cursor: default; }
.mc-fetch-id { overflow-wrap: anywhere; }
.mc-fetch-tag { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; }
@media (max-width: 900px) {
  .mc-provider-top { grid-template-columns: 1fr 1fr; }
  .mc-model { grid-template-columns: 1fr 1fr; }
}

/* 写操作确认卡片（新增/修改文档） */
.approval-card {
  border: 1px solid var(--primary);
  background: var(--primary-soft);
  border-radius: 10px;
  padding: 10px 12px;
  margin: 6px 0 10px;
  max-width: 100%;
}
.approval-card.denied { border-color: var(--border); background: var(--panel); opacity: 0.9; }
.approval-card.approved { border-color: var(--border); background: var(--panel); }
.approval-card.error { border-color: var(--danger, #dc2626); }
.ap-head { font-size: 13px; font-weight: 600; color: var(--text); }
.ap-tool { font-size: 12px; color: var(--muted); margin: 2px 0 6px; }
.ap-args {
  margin: 0 0 8px; padding: 8px 10px; max-height: 200px; overflow: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
}
.ap-actions { display: flex; gap: 8px; }
.ap-state { font-size: 12px; color: var(--muted); }
/* ---- 删除会话确认弹窗（应用内，2026-11-28） ---- */
.sess-modal-mask {
  position: fixed; inset: 0; z-index: 1200;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.sess-modal {
  width: min(400px, 100%);
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 18px 18px 14px; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
}
.sess-modal-title { font-size: 15px; font-weight: 700; color: var(--text); }
.sess-modal-body { margin-top: 8px; font-size: 13px; line-height: 1.7; color: var(--muted); }
.sess-modal-error { margin-top: 8px; font-size: 12px; color: var(--danger); }
.sess-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.sess-modal-btn {
  padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel); color: var(--text); font-size: 13px; font-family: inherit; cursor: pointer;
}
.sess-modal-btn.danger { border-color: var(--danger); background: var(--danger); color: #fff; }
.sess-modal-btn:disabled { opacity: 0.6; cursor: default; }
/* ---- 输入提示词润色卡片（✨优化，2026-11-28）---- */
.polish-card {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.02));
}
.polish-head { font-size: 12px; font-weight: 600; color: var(--primary-dark, var(--primary)); margin-bottom: 6px; }
.polish-warn { font-weight: 400; color: var(--warning, #b45309); }
.polish-err { font-size: 12px; color: var(--danger, #dc2626); }
.polish-draft {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.polish-added { margin-top: 6px; font-size: 12px; color: var(--text-muted, #6b7280); }
.polish-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
