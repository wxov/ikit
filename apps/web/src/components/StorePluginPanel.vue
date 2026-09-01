<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { api } from '../lib/api'
import { authHeaders } from '../lib/auth'

const props = defineProps<{ panel: string }>()

const TITLE: Record<string, string> = {
  stats: '数据统计',
  notes: '便签',
  calendar: '日历',
  todo: '待办清单',
  weather: '天气',
  rss: 'RSS 订阅',
  mdclip: 'Markdown 剪贴板',
  hello: 'Hello 插件',
}
const title = computed(() => TITLE[props.panel] ?? props.panel)

const hdrs = () => authHeaders()

// ---- 统计 ----
const statistics = ref<{ label: string; value: number }[]>([])
function barWidth(v: number): string {
  const max = Math.max(1, ...statistics.value.map((s) => s.value))
  return `${Math.round((v / max) * 100)}%`
}
async function loadStats() {
  try {
    const r = await api<{ statistics: { label: string; value: number }[] }>('/api/plugins-data/statistics')
    statistics.value = r.statistics
  } catch {
    statistics.value = []
  }
}

// ---- 便签 ----
const notes = ref<{ id: string; text: string }[]>([])
const noteText = ref('')
async function loadNotes() {
  const r = await api<{ notes: { id: string; text: string }[] }>('/api/plugins-data/notes')
  notes.value = r.notes
}
async function addNote() {
  if (!noteText.value.trim()) return
  const r = await api('/api/plugins-data/notes', { method: 'POST', headers: hdrs(), body: JSON.stringify({ text: noteText.value }) })
  notes.value = r.notes
  noteText.value = ''
}
async function delNote(id: string) {
  const r = await api(`/api/plugins-data/notes/${id}`, { method: 'DELETE', headers: hdrs() })
  notes.value = r.notes
}

// ---- 日程 ----
const events = ref<{ id: string; title: string; date: string; time: string; done: boolean }[]>([])
const evTitle = ref('')
const evDate = ref('')
const evTime = ref('')
async function loadEvents() {
  const r = await api<{ events: { id: string; title: string; date: string; time: string; done: boolean }[] }>('/api/plugins-data/events')
  events.value = r.events
}
async function addEvent() {
  if (!evTitle.value.trim()) return
  const r = await api('/api/plugins-data/events', { method: 'POST', headers: hdrs(), body: JSON.stringify({ title: evTitle.value, date: evDate.value, time: evTime.value }) })
  events.value = r.events
  evTitle.value = ''
}
async function toggleEvent(id: string) {
  const r = await api(`/api/plugins-data/events/${id}/toggle`, { method: 'POST', headers: hdrs(), body: JSON.stringify({}) })
  events.value = r.events
}
async function delEvent(id: string) {
  const r = await api(`/api/plugins-data/events/${id}`, { method: 'DELETE', headers: hdrs() })
  events.value = r.events
}

// ---- 待办 ----
const todos = ref<{ id: string; text: string; done: boolean }[]>([])
const todoText = ref('')
async function loadTodos() {
  const r = await api<{ todos: { id: string; text: string; done: boolean }[] }>('/api/plugins-data/todos')
  todos.value = r.todos
}
async function addTodo() {
  if (!todoText.value.trim()) return
  const r = await api('/api/plugins-data/todos', { method: 'POST', headers: hdrs(), body: JSON.stringify({ text: todoText.value }) })
  todos.value = r.todos
  todoText.value = ''
}
async function toggleTodo(id: string) {
  const r = await api(`/api/plugins-data/todos/${id}/toggle`, { method: 'POST', headers: hdrs(), body: JSON.stringify({}) })
  todos.value = r.todos
}
async function delTodo(id: string) {
  const r = await api(`/api/plugins-data/todos/${id}`, { method: 'DELETE', headers: hdrs() })
  todos.value = r.todos
}

// ---- 天气 ----
const city = ref('北京')
const weather = ref<{ city: string; temperature: number; condition: string; humidity: number; windSpeed: number } | null>(null)
const weatherLoading = ref(false)
async function loadWeather() {
  weatherLoading.value = true
  try {
    const r = await api<{ weather: typeof weather.value }>(`/api/plugins-data/weather?city=${encodeURIComponent(city.value)}`)
    weather.value = r.weather
  } catch {
    weather.value = null
  } finally {
    weatherLoading.value = false
  }
}

// ---- RSS ----
const rssUrl = ref('')
const rssItems = ref<{ title: string; link: string; pubDate?: string }[]>([])
const rssLoading = ref(false)
function shortDate(d: string): string {
  return d.slice(0, 16).replace(/GMT|UTC.*$/i, '').trim()
}
async function loadRss() {
  if (!rssUrl.value.trim()) return
  rssLoading.value = true
  try {
    const r = await api<{ items: typeof rssItems.value }>(`/api/plugins-data/rss?url=${encodeURIComponent(rssUrl.value)}`)
    rssItems.value = r.items
  } catch {
    rssItems.value = []
  } finally {
    rssLoading.value = false
  }
}

// ---- Markdown 剪贴板 ----
const mdText = ref('')
const drafts = ref<{ id: string; text: string }[]>([])
async function loadMd() {
  const r = await api<{ drafts: { id: string; text: string }[] }>('/api/plugins-data/md')
  drafts.value = r.drafts
}
async function saveMd() {
  if (!mdText.value.trim()) return
  const r = await api('/api/plugins-data/md', { method: 'POST', headers: hdrs(), body: JSON.stringify({ text: mdText.value }) })
  drafts.value = r.drafts
  mdText.value = ''
}
async function delMd(id: string) {
  const r = await api(`/api/plugins-data/md/${id}`, { method: 'DELETE', headers: hdrs() })
  drafts.value = r.drafts
}
async function copyMd(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    prompt('复制：', text)
  }
}

onMounted(() => {
  loadStats()
  loadNotes()
  loadEvents()
  loadTodos()
  loadWeather()
  loadMd()
})
</script>

<template>
  <div class="sp-panel">
    <!-- 统计 -->
    <template v-if="panel === 'stats'">
      <h3>数据统计</h3>
      <div class="sp-stats">
        <div v-for="s in statistics" :key="s.label" class="sp-stat">
          <span class="sp-num">{{ s.value }}</span>
          <span class="sp-label">{{ s.label }}</span>
        </div>
      </div>
      <div v-if="statistics.length" class="sp-chart">
        <div class="sp-chart-title">数据分布</div>
        <div class="sp-bar-row" v-for="s in statistics" :key="'bar-' + s.label">
          <span class="sp-bar-label">{{ s.label }}</span>
          <div class="sp-bar-track">
            <div class="sp-bar-fill" :style="{ width: barWidth(s.value) }"></div>
          </div>
          <span class="sp-bar-val">{{ s.value }}</span>
        </div>
      </div>
      <div v-if="!statistics.length" class="sp-hint">正在加载统计数据…</div>
    </template>

    <!-- 便签 -->
    <template v-else-if="panel === 'notes'">
      <h3>便签</h3>
      <div class="sp-input-row">
        <input v-model="noteText" placeholder="写点什么…" @keydown.enter="addNote" />
        <button class="sp-btn" @click="addNote">添加</button>
      </div>
      <div v-if="notes.length" class="sp-list">
        <div v-for="n in notes" :key="n.id" class="sp-item">
          <span>{{ n.text }}</span>
          <button class="sp-del" @click="delNote(n.id)">×</button>
        </div>
      </div>
      <div v-else class="sp-hint">暂无便签</div>
    </template>

    <!-- 日历 -->
    <template v-else-if="panel === 'calendar'">
      <h3>日历</h3>
      <div class="sp-input-row">
        <input v-model="evTitle" placeholder="日程标题" @keydown.enter="addEvent" />
        <input v-model="evDate" type="date" class="sp-date" />
        <input v-model="evTime" type="time" class="sp-date" />
        <button class="sp-btn" @click="addEvent">添加</button>
      </div>
      <div v-if="events.length" class="sp-list">
        <div v-for="e in events" :key="e.id" class="sp-item">
          <label class="sp-done">
            <input type="checkbox" :checked="e.done" @change="toggleEvent(e.id)" />
            <span :class="{ strike: e.done }">{{ e.title }}</span>
          </label>
          <span class="sp-date-text">{{ e.date }} {{ e.time }}</span>
          <button class="sp-del" @click="delEvent(e.id)">×</button>
        </div>
      </div>
      <div v-else class="sp-hint">暂无日程</div>
    </template>

    <!-- 待办 -->
    <template v-else-if="panel === 'todo'">
      <h3>待办清单</h3>
      <div class="sp-input-row">
        <input v-model="todoText" placeholder="添加待办…" @keydown.enter="addTodo" />
        <button class="sp-btn" @click="addTodo">添加</button>
      </div>
      <div v-if="todos.length" class="sp-list">
        <div v-for="t in todos" :key="t.id" class="sp-item">
          <label class="sp-done">
            <input type="checkbox" :checked="t.done" @change="toggleTodo(t.id)" />
            <span :class="{ strike: t.done }">{{ t.text }}</span>
          </label>
          <button class="sp-del" @click="delTodo(t.id)">×</button>
        </div>
      </div>
      <div v-else class="sp-hint">暂无待办</div>
    </template>

    <!-- 天气 -->
    <template v-else-if="panel === 'weather'">
      <h3>天气</h3>
      <div class="sp-input-row">
        <input v-model="city" placeholder="城市名（如 北京）" @keydown.enter="loadWeather" />
        <button class="sp-btn" :disabled="weatherLoading" @click="loadWeather">查询</button>
      </div>
      <div v-if="weather" class="sp-weather">
        <div class="sp-wx-city">{{ weather.city }}</div>
        <div class="sp-wx-temp">{{ weather.temperature }}°C</div>
        <div class="sp-wx-cond">{{ weather.condition }}</div>
        <div class="sp-wx-meta">湿度 {{ weather.humidity }}% · 风速 {{ weather.windSpeed }} km/h</div>
      </div>
      <div v-else class="sp-hint">{{ weatherLoading ? '查询中…' : '输入城市查询天气' }}</div>
    </template>

    <!-- RSS -->
    <template v-else-if="panel === 'rss'">
      <h3>RSS 订阅</h3>
      <div class="sp-input-row">
        <input v-model="rssUrl" placeholder="RSS 地址，如 https://example.com/feed.xml" @keydown.enter="loadRss" />
        <button class="sp-btn" :disabled="rssLoading" @click="loadRss">抓取</button>
      </div>
      <div v-if="rssItems.length" class="sp-list">
        <a v-for="(it, i) in rssItems" :key="i" :href="it.link" target="_blank" class="sp-rss-item">
          <span>{{ it.title }}</span>
          <span v-if="it.pubDate" class="sp-date-text">{{ shortDate(it.pubDate) }}</span>
        </a>
      </div>
      <div v-else class="sp-hint">{{ rssLoading ? '抓取中…' : '输入 RSS 地址抓取标题列表' }}</div>
    </template>

    <!-- Markdown 剪贴板 -->
    <template v-else-if="panel === 'mdclip'">
      <h3>Markdown 剪贴板</h3>
      <textarea v-model="mdText" class="sp-textarea" placeholder="粘贴 Markdown 内容…"></textarea>
      <div class="sp-input-row">
        <button class="sp-btn" @click="saveMd">保存草稿</button>
      </div>
      <div v-if="drafts.length" class="sp-list">
        <div v-for="d in drafts" :key="d.id" class="sp-item">
          <span class="sp-code">{{ d.text }}</span>
          <div class="sp-item-actions">
            <button class="sp-mini" @click="copyMd(d.text)">复制</button>
            <button class="sp-del" @click="delMd(d.id)">×</button>
          </div>
        </div>
      </div>
      <div v-else class="sp-hint">暂无草稿</div>
    </template>

    <!-- Hello 示例插件包 -->
    <template v-else>
      <h3>Hello 示例插件</h3>
      <div class="sp-hint">这是一个由后端插件包（plugins/hello）动态加载的真实插件。它的服务在服务端已注册，前端面板由 panel 字段驱动渲染。</div>
    </template>
  </div>
</template>

<style scoped>
.sp-panel { max-width: 760px; margin: 0 auto; padding: 20px; }
.sp-panel h3 { margin-bottom: 14px; }
.sp-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.sp-stat { flex: 1; border: 1px solid var(--border); border-radius: 10px; padding: 16px; text-align: center; }
.sp-num { display: block; font-size: 24px; font-weight: 700; color: var(--primary-dark); }
.sp-label { font-size: 12px; color: var(--muted); margin-top: 4px; }
.sp-hint { margin-top: 12px; color: var(--muted); font-size: 13px; }
.sp-input-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.sp-input-row input { flex: 1; min-width: 120px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: inherit; }
.sp-date { flex: 0 0 auto !important; }
.sp-btn { border: none; background: var(--primary); color: #fff; border-radius: 8px; padding: 9px 14px; cursor: pointer; font-size: 13px; }
.sp-list { display: flex; flex-direction: column; gap: 6px; }
.sp-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; }
.sp-done { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.sp-done input { width: 16px; height: 16px; accent-color: var(--primary); }
.sp-done span { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.strike { text-decoration: line-through; color: var(--muted); }
.sp-date-text { font-size: 12px; color: var(--muted); flex-shrink: 0; }
.sp-del { border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 16px; }
.sp-chart { margin-top: 20px; }
.sp-chart-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--muted); }
.sp-bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sp-bar-label { width: 90px; min-width: 90px; font-size: 12px; color: var(--text); }
.sp-bar-track { flex: 1; background: var(--border); border-radius: 6px; height: 12px; overflow: hidden; }
.sp-bar-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--primary-dark)); border-radius: 6px; transition: width 0.4s ease; }
.sp-bar-val { width: 40px; text-align: right; font-size: 12px; color: var(--muted); }
.sp-weather { border: 1px solid var(--border); border-radius: 12px; padding: 22px; text-align: center; }
.sp-wx-city { font-size: 15px; font-weight: 600; }
.sp-wx-temp { font-size: 44px; font-weight: 700; color: var(--primary-dark); margin: 6px 0; }
.sp-wx-cond { font-size: 15px; color: var(--text); }
.sp-wx-meta { font-size: 12px; color: var(--muted); margin-top: 8px; }
.sp-rss-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; text-decoration: none; color: var(--text); font-size: 13px; }
.sp-rss-item:hover { border-color: var(--primary); }
.sp-textarea { width: 100%; min-height: 140px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; font-family: monospace; margin-bottom: 8px; }
.sp-code { font-family: monospace; font-size: 12px; color: var(--muted); white-space: pre-wrap; max-height: 60px; overflow: hidden; flex: 1; }
.sp-item-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.sp-mini { border: 1px solid var(--border); background: var(--panel); border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-family: inherit; }
</style>
