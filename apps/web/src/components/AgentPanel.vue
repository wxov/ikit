<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { api } from '../lib/api'
import { apiUrl } from '../lib/config'
import { renderMarkdown } from '../lib/markdown'

interface AgentStep {
  type: 'tool' | 'final'
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  answer?: string
}

interface AgentRunResult {
  answer: string
  steps: AgentStep[]
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

interface ChatItem {
  role: 'user' | 'assistant'
  content: string
  steps?: AgentStep[]
}

const messages = ref<ChatItem[]>([])
const input = ref('')
const loading = ref(false)
const error = ref('')
const tools = ref<Array<{ name: string; description: string }>>([])
const chatEl = ref<HTMLElement | null>(null)
let abortController: AbortController | null = null

function stop() {
  abortController?.abort()
  loading.value = false
}

async function loadTools() {
  try {
    const r = await api<{ tools: Array<{ name: string; description: string }> }>(
      '/api/agent/tools',
    )
    tools.value = r.tools
  } catch {
    /* ignore */
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || loading.value) return
  messages.value.push({ role: 'user', content: text })
  input.value = ''
  loading.value = true
  error.value = ''
  scrollToBottom()

  // 流式助手消息（实时累积）
  const assistant: ChatItem = { role: 'assistant', content: '', steps: [] }
  messages.value.push(assistant)

  try {
    const history: ChatMessage[] = messages.value
      .slice(0, -2)
      .map((m) => ({ role: m.role, content: m.content }))

    abortController = new AbortController()
    const res = await fetch(apiUrl('/api/agent/chat-stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history }),
      signal: abortController.signal,
    })

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

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
        let ev: any
        try {
          ev = JSON.parse(data)
        } catch {
          continue
        }

        if (ev.type === 'delta') {
          assistant.content += ev.content
          scrollToBottom()
        } else if (ev.type === 'tool') {
          assistant.steps!.push({
            type: 'tool',
            toolName: ev.toolName,
            toolArgs: ev.toolArgs,
            toolResult: ev.toolResult,
          })
          scrollToBottom()
        } else if (ev.type === 'error') {
          error.value = ev.error
        }
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      error.value = e.message
    }
  } finally {
    abortController = null
    loading.value = false
    scrollToBottom()
  }
}

function scrollToBottom() {
  nextTick(() => {
    chatEl.value?.scrollTo({ top: chatEl.value.scrollHeight, behavior: 'smooth' })
  })
}

loadTools()
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

    <div v-if="error" class="error" style="margin-top: 12px">{{ error }}</div>

    <div ref="chatEl" class="chat">
      <div v-if="!messages.length" class="empty">
        向 Agent 提问，它会按需调用工具（如检索知识库）来回答。<br />
        示例：先到「知识库」添加条目，再回来问「Cordis 是什么？」
      </div>

      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg"
        :class="[
          m.role,
          { streaming: m.role === 'assistant' && loading && i === messages.length - 1 },
        ]"
      >
        <div class="msg-head">{{ m.role === 'user' ? '你' : 'Agent' }}</div>

        <div v-if="m.steps && m.steps.length" class="steps">
          <div v-for="(s, j) in m.steps" :key="j">
            <div v-if="s.type === 'tool'" class="step">
              <div class="step-head">🔧 调用工具 <code>{{ s.toolName }}</code></div>
              <div class="muted step-args">参数：{{ JSON.stringify(s.toolArgs) }}</div>
              <div class="step-result">{{ s.toolResult }}</div>
            </div>
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

/* 流式打字光标 */
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

/* assistant 消息内嵌 Markdown 排版 */
.msg-content.markdown-body {
  white-space: normal;
  font-size: 14px;
  line-height: 1.7;
  max-width: 100%;
}
</style>
