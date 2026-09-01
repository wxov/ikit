<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, type KnowledgeEntry } from '../lib/api'

const emit = defineEmits<{ (e: 'open', entry: KnowledgeEntry): void }>()

const entries = ref<KnowledgeEntry[]>([])
const loading = ref(false)
const error = ref('')

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

interface MonthGroup {
  month: string
  list: KnowledgeEntry[]
}

const groups = computed<MonthGroup[]>(() => {
  const map = new Map<string, KnowledgeEntry[]>()
  for (const e of [...entries.value].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())) {
    const d = new Date(e.updatedAt)
    const m = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
    if (!map.has(m)) map.set(m, [])
    map.get(m)!.push(e)
  }
  return [...map.entries()].map(([month, list]) => ({ month, list }))
})

onMounted(load)
</script>

<template>
  <div class="archive">
    <div class="ar-head">
      <h3>归档</h3>
      <span class="ar-sub">按更新时间分组 · 共 {{ entries.length }} 篇</span>
    </div>
    <div v-if="loading" class="ar-empty">加载中…</div>
    <div v-else-if="error" class="ar-empty bad">{{ error }}</div>
    <template v-else>
      <div v-if="!groups.length" class="ar-empty">暂无文章</div>
      <section v-for="g in groups" :key="g.month" class="ar-group">
        <h4 class="ar-month">{{ g.month }} <i class="ar-count">{{ g.list.length }}</i></h4>
        <ul class="ar-list">
          <li v-for="e in g.list" :key="e.id" class="ar-item" @click="emit('open', e)">
            <span class="ar-title">{{ e.title }}</span>
            <span class="ar-date">{{ e.updatedAt.slice(0, 10) }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.archive { max-width: 860px; margin: 0 auto; padding: 16px; }
.ar-head h3 { margin: 0 0 4px; }
.ar-sub { font-size: 13px; color: var(--muted); }
.ar-empty { padding: 40px; text-align: center; color: var(--muted); }
.ar-empty.bad { color: var(--danger); }
.ar-group { margin-top: 18px; }
.ar-month { margin: 0 0 8px; font-size: 14px; }
.ar-count { font-style: normal; font-size: 11px; color: var(--muted); margin-left: 6px; }
.ar-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.ar-item {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 10px; border-bottom: 1px dashed var(--border); cursor: pointer; border-radius: 6px;
}
.ar-item:hover { background: var(--primary-soft); }
.ar-title { flex: 1; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-date { font-size: 12px; color: var(--muted); }
</style>
