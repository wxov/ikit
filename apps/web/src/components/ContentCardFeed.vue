<script setup lang="ts">
import { ref, computed, onMounted, watch, onUnmounted, inject, type Ref } from 'vue'
import { api, type KnowledgeEntry } from '../lib/api'
import { authHeaders } from '../lib/auth'

const props = defineProps<{ query?: string; category?: string; tag?: string; categories?: string[] }>()
const emit = defineEmits<{
  (e: 'open', entry: KnowledgeEntry): void
  (e: 'categories'): void
  (e: 'clear'): void
}>()

const userRole = inject<Ref<string>>('userRole', ref('guest'))
const isAdmin = computed(() => userRole.value === 'admin')

const entries = ref<KnowledgeEntry[]>([])
const loading = ref(false)
const error = ref('')
const page = ref(1)
const pageSize = 5

// ---- 批量管理（仅站主） ----
const batchMode = ref(false)
const selected = ref<Set<string>>(new Set())
const batchCat = ref('')
const newCat = ref('')
const batchBusy = ref(false)
const batchNotice = ref('')

function toggleBatch() {
  batchMode.value = !batchMode.value
  selected.value = new Set()
  batchNotice.value = ''
}
function toggleSelect(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
async function applyBulk() {
  if (!selected.value.size) return
  batchBusy.value = true
  batchNotice.value = ''
  try {
    const r = await api<{ updated: number }>('/api/knowledge/batch-category', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ids: [...selected.value], category: batchCat.value || undefined }),
    })
    batchNotice.value = `已更新 ${r.updated} 篇文章的分类`
    selected.value = new Set()
    await load()
  } catch (e: any) {
    batchNotice.value = e.message
  } finally {
    batchBusy.value = false
  }
}
async function addCategory() {
  if (!newCat.value.trim()) return
  batchBusy.value = true
  batchNotice.value = ''
  try {
    await api('/api/knowledge/categories', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path: newCat.value.trim() }),
    })
    batchNotice.value = `已添加分类「${newCat.value.trim()}」`
    newCat.value = ''
    emit('categories')
    await load()
  } catch (e: any) {
    batchNotice.value = e.message
  } finally {
    batchBusy.value = false
  }
}

const GRADIENTS = [
  'linear-gradient(135deg, #667eea, #764ba2)',
  'linear-gradient(135deg, #f093fb, #f5576c)',
  'linear-gradient(135deg, #4facfe, #00f2fe)',
  'linear-gradient(135deg, #43e97b, #38f9d7)',
  'linear-gradient(135deg, #fa709a, #fee140)',
  'linear-gradient(135deg, #30cfd0, #330867)',
  'linear-gradient(135deg, #a8edea, #fed6e3)',
  'linear-gradient(135deg, #f6d365, #fda085)',
]

function coverFor(cat: string | undefined, title: string): string {
  const seed = (cat || '') + title
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return GRADIENTS[h % GRADIENTS.length]
}

function coverStyle(e: KnowledgeEntry): string {
  if (e.cover) return `url(${e.cover}) center/cover no-repeat`
  const img = firstImageUrl(e.content)
  if (img) return `url(${img}) center/cover no-repeat`
  return coverFor(e.category, e.title)
}

function firstImageUrl(c: string): string | null {
  const m = c.match(/!\[[^\]]*\]\(([^)]+)\)/)
  if (!m) return null
  const url = m[1].replace(/[<>\s]/g, '')
  if (/^(https?:)?\/\//.test(url) || url.startsWith('/') || url.startsWith('data:')) return url
  return null
}

async function onOpen(e: KnowledgeEntry) {
  try {
    await api(`/api/knowledge/entries/${e.id}/view`, { method: 'POST' })
  } catch {
    /* 忽略计数失败 */
  }
  emit('open', e)
}

function excerpt(c: string): string {
  const plain = c
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/#{1,6}\s+/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 120 ? plain.slice(0, 120) + '…' : plain
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/entries')
    entries.value = (r.entries || []).filter((e) => !e.deletedAt)
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  let list = entries.value
  if (props.category) list = list.filter((e) => (e.category || '') === props.category)
  if (props.tag) list = list.filter((e) => e.tags.includes(props.tag!))
  const q = (props.query || '').trim().toLowerCase()
  if (q) {
    list = list.filter(
      (e) => e.title.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }
  return [...list].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
})

const filterLabel = computed(() => {
  const parts: string[] = []
  if (props.category) parts.push(`分类：${props.category}`)
  if (props.tag) parts.push(`标签：${props.tag}`)
  return parts.join(' · ')
})

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

watch([() => props.query, () => props.category, () => props.tag], () => {
  page.value = 1
})

onMounted(() => {
  load()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}

function prev() {
  if (page.value > 1) page.value--
}
function next() {
  if (page.value < totalPages.value) page.value++
}

function star(n: number | undefined): string {
  const s = Math.round(n ?? 0)
  return '★'.repeat(s) + '☆'.repeat(5 - s)
}
</script>

<template>
  <div class="feed">
    <!-- 当前筛选 -->
    <div v-if="filterLabel" class="filter-chip" @click="emit('clear')">
      🔍 {{ filterLabel }} <span class="fc-x">✕ 清除</span>
    </div>

    <!-- 批量管理工具栏（仅站主） -->
    <div v-if="isAdmin" class="batch-bar">
      <template v-if="!batchMode">
        <button class="batch-toggle" @click="toggleBatch">☑ 批量管理</button>
      </template>
      <template v-else>
        <span class="bb-count">已选 {{ selected.size }} 篇</span>
        <select v-model="batchCat" class="bb-select">
          <option value="">未分类</option>
          <option v-for="c in props.categories" :key="c" :value="c">{{ c }}</option>
        </select>
        <button class="batch-btn" :disabled="batchBusy || !selected.size" @click="applyBulk">
          应用分类
        </button>
        <input v-model="newCat" class="bb-input" placeholder="新增分类，如：技术/前端" @keydown.enter="addCategory" />
        <button class="batch-btn ghost" :disabled="batchBusy || !newCat.trim()" @click="addCategory">
          添加分类
        </button>
        <button class="batch-btn ghost" @click="toggleBatch">退出</button>
      </template>
      <span v-if="batchNotice" class="bb-notice">{{ batchNotice }}</span>
    </div>

    <div v-if="loading" class="feed-loading">加载中…</div>
    <div v-else-if="error" class="feed-error">{{ error }}</div>
    <template v-else>
      <div v-if="!paged.length" class="feed-empty">暂无内容，去知识库创建第一篇吧～</div>
      <div class="feed-list">
        <article
          v-for="e in paged"
          :key="e.id"
          class="card"
          :class="{ 'batch-select': batchMode && selected.has(e.id) }"
          @click="batchMode ? toggleSelect(e.id) : onOpen(e)"
        >
          <span v-if="batchMode" class="card-check">
            <i>{{ selected.has(e.id) ? '✓' : '' }}</i>
          </span>
          <div class="card-cover" :style="{ background: coverStyle(e) }">
            <span v-if="e.pinned" class="card-pin">置顶</span>
          </div>
          <div class="card-body">
            <div class="card-title">{{ e.title }}</div>
            <p class="card-excerpt">{{ excerpt(e.content) }}</p>
          </div>
          <div class="card-footer">
            <span class="cf-item">📂 {{ e.category || '未分类' }}</span>
            <span class="cf-item">🕑 {{ shortDate(e.updatedAt) }}</span>
            <span v-if="e.views" class="cf-item">👁 {{ e.views }}</span>
            <span v-if="e.likes" class="cf-item">👍 {{ e.likes }}</span>
            <span v-if="e.rating" class="cf-item stars">{{ star(e.rating) }}</span>
          </div>
        </article>
      </div>
      <div v-if="totalPages > 1" class="feed-pager">
        <button class="pager-btn" :disabled="page <= 1" @click.stop="prev">‹ 上一页</button>
        <span class="pager-info">{{ page }} / {{ totalPages }}</span>
        <button class="pager-btn" :disabled="page >= totalPages" @click.stop="next">下一页 ›</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.feed { min-height: 60vh; }
.filter-chip {
  display: inline-flex; align-items: center; gap: 8px;
  margin-bottom: 12px; padding: 6px 12px;
  background: var(--primary-soft); border: 1px solid var(--primary);
  border-radius: 999px; font-size: 13px; color: var(--primary-dark); cursor: pointer;
}
.fc-x { font-size: 12px; color: var(--primary-dark); }
.filter-chip:hover { filter: brightness(0.97); }
.batch-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 14px; }
.batch-toggle { border: 1px dashed var(--primary); background: transparent; color: var(--primary-dark); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; font-family: inherit; }
.bb-count { font-size: 13px; color: var(--muted); font-weight: 600; }
.bb-select, .bb-input { border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; }
.bb-input { width: 180px; }
.batch-btn { border: 1px solid var(--primary); background: var(--primary); color: #fff; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; font-family: inherit; }
.batch-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.batch-btn:disabled { opacity: 0.5; cursor: default; }
.bb-notice { font-size: 12px; color: var(--ok); }
.card-check {
  position: absolute; top: 12px; left: 12px; z-index: 3;
  width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.25);
  display: inline-flex; align-items: center; justify-content: center;
}
.card-check i { font-style: normal; color: #fff; font-size: 13px; font-weight: 700; }
.card.batch-select { outline: 3px solid var(--primary); outline-offset: -3px; }
.card.batch-select .card-check { background: var(--primary); border-color: var(--primary); }
.feed-loading, .feed-empty, .feed-error { padding: 60px; text-align: center; color: var(--muted); }
.feed-error { color: var(--danger); }
/* 参考站：单列大卡片流，每条卡为通栏 banner 封面 + 标题/摘要 + 底部信息条 */
.feed-list {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.card {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  display: flex;
  flex-direction: column;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);
  padding: 0;
  margin: 0;
}
.card:hover {
  transform: translateY(-3px);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.12);
}
.card-cover {
  position: relative;
  height: 220px;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.card-pin {
  position: absolute;
  top: 14px;
  right: 16px;
  z-index: 2;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
}
.card-body { padding: 18px 20px 14px; }
.card-title { font-size: 17px; font-weight: 700; margin: 0 0 8px; line-height: 1.4; }
.card-excerpt {
  font-size: 14px;
  color: var(--muted);
  line-height: 1.75;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 10px 20px;
  background: var(--bg);
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
}
.cf-item { white-space: nowrap; }
.cf-item.stars { color: #f59e0b; }
.feed-pager { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 22px; }
.pager-btn {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  color: var(--text);
}
.pager-btn:disabled { opacity: 0.5; cursor: default; }
.pager-info { font-size: 13px; color: var(--muted); }
</style>
