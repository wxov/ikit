<script setup lang="ts">
import { ref, onMounted, onUnmounted, provide } from 'vue'
import { createSocket, type EventItem, type WsStatus } from './lib/api'
import SystemPanel from './components/SystemPanel.vue'
import KnowledgePanel from './components/KnowledgePanel.vue'
import AgentPanel from './components/AgentPanel.vue'

type Tab = 'system' | 'agent' | 'knowledge'

const tab = ref<Tab>('system')
const wsStatus = ref<WsStatus>('connecting')
const events = ref<EventItem[]>([])
const lastEvent = ref<EventItem | null>(null)

provide('events', events)
provide('lastEvent', lastEvent)

let socket: ReturnType<typeof createSocket> | null = null

onMounted(() => {
  socket = createSocket(
    (msg) => {
      if (msg.type === 'connected' || msg.type === 'pong') return
      lastEvent.value = msg
      events.value.unshift(msg)
      if (events.value.length > 100) events.value.length = 100
    },
    (status) => {
      wsStatus.value = status
    },
  )
})

onUnmounted(() => socket?.close())
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1>i-kit 控制台</h1>
      <nav>
        <button :class="{ active: tab === 'system' }" @click="tab = 'system'">系统</button>
        <button :class="{ active: tab === 'agent' }" @click="tab = 'agent'">Agent</button>
        <button :class="{ active: tab === 'knowledge' }" @click="tab = 'knowledge'">知识库</button>
      </nav>
      <span class="ws" :class="wsStatus">
        <i class="dot" />
        {{
          wsStatus === 'open' ? '已连接' : wsStatus === 'connecting' ? '连接中' : '已断开'
        }}
      </span>
    </header>
    <main>
      <SystemPanel v-if="tab === 'system'" />
      <AgentPanel v-else-if="tab === 'agent'" />
      <KnowledgePanel v-else />
    </main>

    <!-- 移动端底部 Tab Bar -->
    <nav class="bottom-tabbar">
      <button :class="{ active: tab === 'system' }" @click="tab = 'system'">
        <span class="tab-icon">⚙️</span>
        <span class="tab-label">系统</span>
      </button>
      <button :class="{ active: tab === 'agent' }" @click="tab = 'agent'">
        <span class="tab-icon">🤖</span>
        <span class="tab-label">Agent</span>
      </button>
      <button :class="{ active: tab === 'knowledge' }" @click="tab = 'knowledge'">
        <span class="tab-icon">📚</span>
        <span class="tab-label">知识库</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.bottom-tabbar {
  display: none;
}

@media (max-width: 768px) {
  .topbar nav {
    display: none;
  }
  .bottom-tabbar {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    z-index: 400;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .bottom-tabbar button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
  }
  .bottom-tabbar button.active {
    color: var(--primary-dark);
    font-weight: 600;
  }
  .tab-icon {
    font-size: 18px;
    line-height: 1;
  }
  main {
    padding-bottom: 72px;
  }
}
</style>
