<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, apiErrorMessage, type KnowledgeEntry } from '../lib/api'
import { authHeaders } from '../lib/auth'

// 批量删除确认（站主，目录树批量模式）：**级联软删除**——选中项连同其全部子孙一起进回收站。
// - 文案明确「将删除 N 篇（含 M 篇子文档）」；不提供彻底删除（回收站已有清空入口）；
// - 前端统计仅供确认预览（与 service.batchRemove 的折叠嵌套 / 级联口径一致）；服务端为权威。
const props = defineProps<{ ids: string[]; entries: KnowledgeEntry[] }>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'deleted', payload: { deleted: number; affectedIds: string[] }): void
}>()

const busy = ref(false)
const error = ref('')

/** 预览统计：折叠嵌套选择（祖先已选则子项不再单独计根）+ 级联收集子孙 */
const stats = computed(() => {
  const byId = new Map(props.entries.filter((e) => !e.deletedAt).map((e) => [e.id, e]))
  const idSet = new Set(props.ids)
  const targets = props.ids
    .map((id) => byId.get(id))
    .filter((e): e is KnowledgeEntry => !!e)
  const roots = targets.filter((e) => {
    const seen = new Set<string>([e.id])
    let cur = e.parentId ? byId.get(e.parentId) : undefined
    while (cur && !seen.has(cur.id)) {
      if (idSet.has(cur.id)) return false
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return true
  })
  const affected = new Set<string>()
  for (const r of roots) {
    affected.add(r.id)
    const queue = props.entries.filter((e) => e.parentId === r.id && !e.deletedAt)
    while (queue.length) {
      const cur = queue.shift()!
      if (affected.has(cur.id)) continue
      affected.add(cur.id)
      queue.push(...props.entries.filter((e) => e.parentId === cur.id && !e.deletedAt))
    }
  }
  return { roots, total: affected.size, children: affected.size - roots.length }
})

async function confirm() {
  if (busy.value || !props.ids.length) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ deleted: number; affectedIds: string[] }>('/api/knowledge/batch-delete', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ids: props.ids }),
    })
    emit('deleted', { deleted: r.deleted, affectedIds: r.affectedIds ?? [] })
  } catch (e) {
    error.value = apiErrorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="bd-overlay" @click.self="!busy && emit('close')">
    <div class="bd-modal">
      <h3>🗑 确认批量删除</h3>
      <p class="bd-main">
        将删除 <b>{{ stats.total }}</b> 篇<template v-if="stats.children > 0">（含 {{ stats.children }} 篇子文档）</template>，移入回收站后可恢复。
      </p>
      <p class="bd-hint">
        删除为「级联软删除」：选中项的子孙会一并进回收站；如需彻底清空请使用「回收站 → 清空」。
      </p>
      <div v-if="stats.roots.length" class="bd-list">
        <div class="bd-list-title">删除范围（按根目录 {{ stats.roots.length }} 项）</div>
        <div v-for="r in stats.roots.slice(0, 8)" :key="r.id" class="bd-row">
          · {{ r.title }}<span v-if="stats.children > 0" class="bd-sub">（含子文档）</span>
        </div>
        <div v-if="stats.roots.length > 8" class="bd-row">… 等共 {{ stats.roots.length }} 项</div>
      </div>
      <div v-if="error" class="bd-error">❌ {{ error }}</div>
      <div class="bd-foot">
        <button class="bd-btn ghost" :disabled="busy" @click="emit('close')">取消</button>
        <button class="bd-btn danger" :disabled="busy || !stats.total" @click="confirm">
          {{ busy ? '删除中…' : '确认删除' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bd-overlay {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.bd-modal {
  width: min(460px, 96vw); max-height: 88vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 20px;
}
.bd-modal h3 { margin: 0 0 8px; font-size: 16px; }
.bd-main { margin: 0 0 8px; font-size: 14px; color: var(--text); line-height: 1.7; }
.bd-hint { margin: 0 0 10px; font-size: 12px; color: var(--muted); line-height: 1.7; }
.bd-list {
  border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 10px; margin-bottom: 10px; max-height: 180px; overflow-y: auto;
}
.bd-list-title { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.bd-row {
  font-size: 13px; color: var(--text); padding: 2px 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bd-sub { font-size: 11px; color: var(--muted); }
.bd-error { font-size: 13px; color: var(--danger, #dc2626); margin-bottom: 8px; word-break: break-word; }
.bd-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.bd-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 8px 18px; font-size: 14px; cursor: pointer; font-family: inherit;
}
.bd-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.bd-btn.danger { border-color: #dc2626; background: #dc2626; }
.bd-btn:disabled { opacity: 0.6; cursor: default; }
</style>
