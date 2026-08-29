<script setup lang="ts">
import { ref, onMounted, inject, type Ref } from 'vue'
import { api, type EventItem } from '../lib/api'

interface PluginMeta {
  name: string
  version?: string
}

interface SystemInfo {
  name: string
  version: string
  plugins: PluginMeta[]
}

const events = inject<Ref<EventItem[]>>('events', ref([]))

const info = ref<SystemInfo | null>(null)
const greetName = ref('')
const greetResult = ref('')
const greetCount = ref(0)
const health = ref<{ ok: boolean; uptime: number } | null>(null)

onMounted(async () => {
  try {
    info.value = await api<SystemInfo>('/api/system/info')
    health.value = await api<{ ok: boolean; uptime: number }>('/api/health')
  } catch (e) {
    console.error(e)
  }
  refreshCount()
})

async function refreshCount() {
  const r = await api<{ greetCount: number }>('/api/demo/status')
  greetCount.value = r.greetCount
}

async function sayHello() {
  const name = greetName.value.trim() || 'world'
  const r = await api<{ message: string }>(`/api/demo/hello?name=${encodeURIComponent(name)}`)
  greetResult.value = r.message
  refreshCount()
}
</script>

<template>
  <div>
    <div class="card">
      <h2>系统信息</h2>
      <div class="grid">
        <div>
          <div class="muted">应用</div>
          <strong>{{ info?.name ?? '...' }}</strong>
          <span class="muted"> v{{ info?.version ?? '...' }}</span>
        </div>
        <div>
          <div class="muted">运行时长</div>
          <strong>{{ health?.uptime ?? 0 }}s</strong>
        </div>
        <div>
          <div class="muted">已加载插件</div>
          <div>
            <span v-for="p in info?.plugins ?? []" :key="p.name" class="badge">
              {{ p.name }}@{{ p.version ?? '?' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Demo 插件测试</h2>
      <p class="muted">
        调用 demo 插件的 <code>hello()</code> 服务，验证 Cordis 服务注入与事件总线。
      </p>
      <div class="row">
        <input
          v-model="greetName"
          placeholder="输入名字（默认 world）"
          style="max-width: 240px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px"
        />
        <button class="btn" @click="sayHello">打招呼</button>
        <span class="muted">累计调用：{{ greetCount }} 次</span>
      </div>
      <p v-if="greetResult" style="margin-top: 12px">
        返回结果：<strong>{{ greetResult }}</strong>
      </p>
    </div>

    <div class="card">
      <h2>实时事件流（WebSocket）</h2>
      <p class="muted">核心服务内部事件通过 WebSocket 实时推送到这里。</p>
      <div v-if="events.length" class="log">
        <div v-for="(e, i) in events" :key="i" class="line">
          <span class="time">{{ new Date(e.ts ?? 0).toLocaleTimeString() }}</span>
          <span class="type">{{ e.type }}</span>
          {{ JSON.stringify(e.payload) }}
        </div>
      </div>
      <div v-else class="empty">暂无事件，试试上面的「打招呼」或在知识库里新增条目。</div>
    </div>
  </div>
</template>
