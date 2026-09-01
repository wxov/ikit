<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, type KnowledgeEntry, type KnowledgeComment, type CategoryNode } from '../lib/api'
import CategoryTree from './CategoryTree.vue'

const emit = defineEmits<{
  (e: 'open', entry: KnowledgeEntry): void
  (e: 'tag', tag: string): void
  (e: 'category', path: string): void
}>()

interface StatEntry {
  label: string
  value: number
}

const entries = ref<KnowledgeEntry[]>([])
const stats = ref<StatEntry[]>([])
const hot = ref<KnowledgeEntry[]>([])
const tags = ref<Array<{ name: string; count: number }>>([])
const recent = ref<Array<{ comment: KnowledgeComment; entry?: KnowledgeEntry }>>([])
const categories = ref<CategoryNode[]>([])

function score(e: KnowledgeEntry): number {
  return (e.likes ?? 0) * 3 + (e.rating ?? 0) * 2
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function load() {
  try {
    const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/entries')
    const list = (r.entries || []).filter((e) => !e.deletedAt)
    entries.value = list
    hot.value = [...list]
      .sort((a, b) => score(b) - score(a) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8)
    const map = new Map<string, number>()
    for (const e of list) for (const t of e.tags) map.set(t, (map.get(t) ?? 0) + 1)
    tags.value = [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 16)
  } catch {
    /* 静默：widget 失败不影响主界面 */
  }
  try {
    const r = await api<{ comments: KnowledgeComment[] }>('/api/knowledge/comments?limit=8')
    recent.value = (r.comments || []).map((c) => ({ comment: c, entry: entries.value.find((e) => e.id === c.entryId) }))
  } catch {
    recent.value = []
  }
  try {
    const r = await api<{ statistics: StatEntry[] }>('/api/plugins-data/statistics')
    stats.value = r.statistics || []
  } catch {
    stats.value = []
  }
  try {
    const r = await api<{ categories: CategoryNode[] }>('/api/knowledge/categories')
    categories.value = r.categories || []
  } catch {
    categories.value = []
  }
}

const sortedStats = computed(() => [...stats.value].sort((a, b) => a.value - b.value))
const maxStat = computed(() => Math.max(1, ...stats.value.map((s) => s.value)))

onMounted(load)
</script>

<template>
  <div class="portal-right">
    <section v-if="stats.length" class="widget">
      <h4 class="widget-title">数据概览</h4>
      <ul class="stat-list">
        <li v-for="s in sortedStats" :key="s.label" class="stat-item">
          <span class="stat-label">{{ s.label }}</span>
          <span class="stat-bar"><i :style="{ width: `${(s.value / maxStat) * 100}%` }" /></span>
          <span class="stat-value">{{ s.value }}</span>
        </li>
      </ul>
    </section>

    <section v-if="categories.length" class="widget">
      <h4 class="widget-title">分类</h4>
      <div class="pr-cat">
        <CategoryTree :nodes="categories" :active-path="''" @select="(p: string) => emit('category', p)" />
      </div>
    </section>

    <section v-if="tags.length" class="widget">
      <h4 class="widget-title">标签云</h4>
      <div class="tag-cloud">
        <span
          v-for="t in tags"
          :key="t.name"
          class="cloud-tag"
          :style="{ fontSize: `${Math.min(16, 11 + t.count * 1.5)}px` }"
          @click="emit('tag', t.name)"
        >{{ t.name }}<i v-if="t.count > 1">{{ t.count }}</i></span>
      </div>
    </section>

    <section v-if="hot.length" class="widget">
      <h4 class="widget-title">热门文章</h4>
      <ul class="hot-list">
        <li v-for="e in hot" :key="e.id" class="hot-item" @click="emit('open', e)">
          <span class="hot-title">{{ e.title }}</span>
          <span class="hot-meta">{{ e.likes ?? 0 }}👍 · {{ shortDate(e.updatedAt) }} · {{ e.category || '未分类' }}</span>
        </li>
      </ul>
    </section>

    <section v-if="recent.length" class="widget">
      <h4 class="widget-title">最新评论</h4>
      <ul class="hot-list">
        <li v-for="r in recent" :key="r.comment.id" class="hot-item" @click="r.entry && emit('open', r.entry)">
          <span class="hot-title">{{ r.comment.author }}：{{ r.comment.content }}</span>
          <span class="hot-meta">{{ r.entry?.title || '未知文章' }} · {{ shortDate(r.comment.createdAt) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.portal-right { display: flex; flex-direction: column; gap: 16px; }
.widget {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  padding: 14px;
}
.widget-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 700;
  position: relative;
  padding-left: 12px;
}
.widget-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 4px;
  border-radius: 2px;
  background: var(--primary);
}
.pr-cat :deep(.cat-row) { padding: 6px 8px; }
.pr-cat :deep(.cat-del) { display: none; }
.stat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.stat-item { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.stat-label { width: 64px; color: var(--muted); }
.stat-bar { flex: 1; height: 8px; background: var(--border); border-radius: 999px; overflow: hidden; }
.stat-bar i { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width 0.4s ease; }
.stat-value { width: 26px; text-align: right; font-weight: 600; }
.hot-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.hot-item { cursor: pointer; padding: 6px 8px; margin: 0 -8px; border-radius: 8px; transition: background 0.15s ease; }
.hot-item:hover { background: var(--primary-soft); }
.hot-item:hover .hot-title { color: var(--primary-dark); }
.hot-title { font-size: 13px; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.hot-meta { font-size: 11px; color: var(--muted); }
.tag-cloud { display: flex; flex-wrap: wrap; gap: 8px; }
.cloud-tag {
  font-size: 12px;
  color: var(--primary-dark);
  background: var(--primary-soft);
  border-radius: 999px;
  padding: 3px 10px;
  cursor: pointer;
}
.cloud-tag i { font-style: normal; font-size: 10px; color: var(--muted); margin-left: 3px; }
</style>
