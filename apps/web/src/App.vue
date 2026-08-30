<script setup lang="ts">
import { ref, onMounted, onUnmounted, provide } from 'vue'
import { createSocket, type EventItem, type WsStatus } from './lib/api'
import {
  fetchUpdateManifest,
  hasUpdate as hasUpdateFn,
  applyUpdate,
  versionGt,
  detectPlatform,
  type UpdateInfo,
} from './lib/update'
import SystemPanel from './components/SystemPanel.vue'
import KnowledgePanel from './components/KnowledgePanel.vue'
import AgentPanel from './components/AgentPanel.vue'

type Tab = 'system' | 'agent' | 'knowledge'

const tab = ref<Tab>('system')
const wsStatus = ref<WsStatus>('connecting')
const events = ref<EventItem[]>([])
const lastEvent = ref<EventItem | null>(null)

// 热更新
const updateInfo = ref<UpdateInfo | null>(null)
const updateAvailable = ref(false)
const updating = ref(false)
const updatePlatform = ref(detectPlatform())

async function checkUpdate() {
  const info = await fetchUpdateManifest()
  updateInfo.value = info
  if (hasUpdateFn(info)) {
    updateAvailable.value = true
  }
}

async function doUpdate() {
  if (!updateInfo.value?.bundleUrl) return
  updating.value = true
  try {
    const res = await applyUpdate(updateInfo.value, updateInfo.value.bundleUrl)
    // Web 端已 reload；原生端若未接原生命令，则提供下载链接
    if (!res.applied && res.platform !== 'web') {
      window.open(res.url, '_blank')
    }
  } catch (e: any) {
    console.warn('[update] apply failed:', e)
  } finally {
    updating.value = false
  }
}

function dismissUpdate() {
  updateAvailable.value = false
}

// 暗色模式（默认跟随系统，可手动切换）
const theme = ref<'light' | 'dark'>(
  (localStorage.getItem('ikit-theme') as 'light' | 'dark') ??
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
)

function applyTheme() {
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('ikit-theme', theme.value)
}

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  applyTheme()
}

applyTheme()

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
  checkUpdate()
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
      <button class="theme-toggle" :title="theme === 'light' ? '切换暗色' : '切换亮色'" @click="toggleTheme">
        {{ theme === 'light' ? '🌙' : '☀️' }}
      </button>
    </header>

    <!-- 热更新提示 -->
    <div v-if="updateAvailable" class="update-banner">
      <span class="ub-icon">🔄</span>
      <span class="ub-text">
        发现新版本
        <b>v{{ updateInfo?.latest }}</b>
        (当前 v{{ updateInfo?.currentVersion }})
      </span>
      <button class="ub-btn" :disabled="updating" @click="doUpdate">
        {{ updating ? '更新中…' : updatePlatform === 'web' ? '刷新更新' : '立即更新' }}
      </button>
      <button class="ub-dismiss" title="稍后" @click="dismissUpdate">×</button>
    </div>

    <main :class="{ wide: tab === 'knowledge' }">
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
.update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 16px 0;
  padding: 10px 14px;
  background: var(--primary-soft);
  border: 1px solid var(--primary);
  border-radius: 10px;
  color: var(--primary-dark);
  font-size: 13px;
  animation: ub-in 0.3s ease;
}
@keyframes ub-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}
.ub-icon { font-size: 16px; }
.ub-text { flex: 1; }
.ub-btn {
  border: none;
  background: var(--primary);
  color: #fff;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.ub-btn:disabled { opacity: 0.6; cursor: default; }
.ub-dismiss {
  border: none;
  background: transparent;
  color: var(--primary-dark);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
[data-theme='dark'] .update-banner {
  color: var(--primary-dark);
}

.theme-toggle {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}

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
