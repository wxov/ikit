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
  </div>
</template>
