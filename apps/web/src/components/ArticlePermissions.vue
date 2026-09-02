<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, type KnowledgeEntry, type EntryVisibility } from '../lib/api'
import { authHeaders, listGroups, type Group } from '../lib/auth'

const entries = ref<KnowledgeEntry[]>([])
const groups = ref<Group[]>([])
const selected = ref<Set<string>>(new Set())
const visibility = ref<EntryVisibility>('public')
const selectedGroups = ref<string[]>([])
const busy = ref(false)
const notice = ref('')

const VIS_OPTIONS: { key: EntryVisibility; label: string }[] = [
  { key: 'public', label: '公开' },
  { key: 'login', label: '仅登录用户' },
  { key: 'groups', label: '指定组' },
  { key: 'private', label: '仅站主' },
]

function byOrder(a: KnowledgeEntry, b: KnowledgeEntry): number {
  return (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

function childrenOf(id: string): KnowledgeEntry[] {
  return entries.value.filter((e) => e.parentId === id)
}

function descendantsOf(id: string): string[] {
  const out: string[] = []
  const q = childrenOf(id)
  while (q.length) {
    const c = q.shift()!
    out.push(c.id)
    q.push(...childrenOf(c.id))
  }
  return out
}

// 树序 + 缩进深度
const ordered = computed<Array<{ entry: KnowledgeEntry; depth: number }>>(() => {
  const out: Array<{ entry: KnowledgeEntry; depth: number }> = []
  const walk = (e: KnowledgeEntry, depth: number) => {
    out.push({ entry: e, depth })
    childrenOf(e.id).sort(byOrder).forEach((c) => walk(c, depth + 1))
  }
  entries.value.filter((e) => !e.parentId).sort(byOrder).forEach((e) => walk(e, 0))
  return out
})

function toggleSelect(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
    // 父级连带子级
    for (const d of descendantsOf(id)) next.add(d)
  }
  selected.value = next
}

function toggleAll() {
  selected.value = selected.value.size === entries.value.length ? new Set() : new Set(entries.value.map((e) => e.id))
}

function visLabel(e: KnowledgeEntry): string {
  switch (e.visibility ?? 'public') {
    case 'public': return '公开'
    case 'login': return '仅登录'
    case 'groups': return '指定组'
    case 'private': return '仅站主'
    default: return '公开'
  }
}

async function load() {
  const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/entries', { headers: authHeaders() })
  entries.value = (r.entries || []).filter((e) => !e.deletedAt)
}

async function apply() {
  if (!selected.value.size) {
    notice.value = '请先勾选文章'
    return
  }
  if (visibility.value === 'groups' && !selectedGroups.value.length) {
    notice.value = '请至少选择一个用户组'
    return
  }
  busy.value = true
  notice.value = ''
  try {
    const r = await api<{ updated: number }>('/api/knowledge/batch-visibility', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        ids: [...selected.value],
        visibility: visibility.value,
        visibleGroups: visibility.value === 'groups' ? selectedGroups.value : undefined,
      }),
    })
    notice.value = `已更新 ${r.updated} 篇文章的权限`
    selected.value = new Set()
    await load()
  } catch (e: any) {
    notice.value = e.message
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  load()
  listGroups().then((r) => (groups.value = r.groups)).catch(() => {})
})
</script>

<template>
  <div class="ap">
    <div class="ap-toolbar">
      <button class="ap-btn ghost" @click="toggleAll">
        {{ selected.size === entries.length ? '取消全选' : '全选' }}
      </button>
      <span class="ap-count">已选 {{ selected.size }} / {{ entries.length }} 篇</span>
      <select v-model="visibility" class="ap-select">
        <option v-for="o in VIS_OPTIONS" :key="o.key" :value="o.key">{{ o.label }}</option>
      </select>
      <div v-if="visibility === 'groups'" class="ap-groups">
        <label v-for="g in groups" :key="g.id" class="ap-group" :class="{ on: selectedGroups.includes(g.id) }">
          <input type="checkbox" :value="g.id" v-model="selectedGroups" /> {{ g.name }}
        </label>
      </div>
      <button class="ap-btn" :disabled="busy" @click="apply">应用权限</button>
      <span v-if="notice" class="ap-notice">{{ notice }}</span>
    </div>

    <div v-if="!ordered.length" class="ap-empty">暂无文章</div>
    <div v-else class="ap-list">
      <div
        v-for="row in ordered"
        :key="row.entry.id"
        class="ap-row"
        :class="{ on: selected.has(row.entry.id) }"
        :style="{ paddingLeft: 12 + row.depth * 18 + 'px' }"
        @click="toggleSelect(row.entry.id)"
      >
        <span class="ap-check">{{ selected.has(row.entry.id) ? '✓' : '' }}</span>
        <span class="ap-title">{{ row.entry.title }}</span>
        <span class="ap-vis" :class="row.entry.visibility ?? 'public'">{{ visLabel(row.entry) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ap { padding: 4px 0; }
.ap-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.ap-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.ap-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.ap-btn:disabled { opacity: 0.5; cursor: default; }
.ap-count { font-size: 13px; color: var(--muted); font-weight: 600; }
.ap-select { border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; }
.ap-groups { display: flex; flex-wrap: wrap; gap: 6px; }
.ap-group {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px;
  font-size: 12px; cursor: pointer; color: var(--muted);
}
.ap-group.on { background: var(--primary-soft); border-color: var(--primary); color: var(--primary-dark); }
.ap-group input { accent-color: var(--primary); }
.ap-notice { font-size: 12px; color: var(--ok); }
.ap-empty { padding: 24px; text-align: center; color: var(--muted); }
.ap-list { display: flex; flex-direction: column; max-height: 480px; overflow-y: auto; border: 1px solid var(--border); border-radius: 10px; }
.ap-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px dashed var(--border); cursor: pointer;
}
.ap-row:last-child { border-bottom: none; }
.ap-row:hover { background: var(--primary-soft); }
.ap-row.on { background: var(--primary-soft); }
.ap-check {
  width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--border);
  display: inline-flex; align-items: center; justify-content: center; font-size: 11px;
  color: var(--primary-dark); flex-shrink: 0; background: var(--panel);
}
.ap-row.on .ap-check { background: var(--primary); color: #fff; border-color: var(--primary); }
.ap-title { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-vis { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.ap-vis.public { color: var(--ok); border-color: var(--ok); }
.ap-vis.private { color: var(--danger); border-color: var(--danger); }
</style>
