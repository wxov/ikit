<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, apiErrorMessage, type KnowledgeEntry } from '../lib/api'
import { authHeaders } from '../lib/auth'
import DocParentPicker from './DocParentPicker.vue'

// 批量移动（站主，目录树批量模式）：把选中项整体挂到目标父文档下（含「顶层」）。
// - 目标用公共「可搜索层级下拉」（`DocParentPicker.vue`，与批量导入同一组件）；
// - 前端只做**提示性**过滤（隐藏选中项自身及其子孙，避免误选）；**服务端才是权威校验**
//   （环校验 / 目标已删 / 整体校验 → 400 且零写入），失败时展示服务端错误原文；
// - 语义：同级 `sortOrder` 追加到末尾、分类保持不变、子孙随父级自然跟随。
const props = defineProps<{ ids: string[] }>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'moved', payload: { moved: number; parentId: string; label: string }): void
}>()

type DocEntry = KnowledgeEntry & { deletedAt?: string }

const allDocs = ref<DocEntry[]>([])
const loading = ref(false)
const parentId = ref('')
const busy = ref(false)
const error = ref('')

const docById = computed(() => new Map(allDocs.value.map((e) => [e.id, e])))

/** 由 parentId 关系回溯出完整路径标签，如 `技术笔记 / Vue / 组件` */
function pathOf(id: string): string {
  const parts: string[] = []
  const seen = new Set<string>()
  let cur = docById.value.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    parts.unshift(cur.title)
    cur = cur.parentId ? docById.value.get(cur.parentId) : undefined
  }
  return parts.join(' / ')
}

/** 非法目标：选中项自身 + 其全部子孙（移入会让子树成环；服务端同样拒绝） */
const blockedIds = computed(() => {
  const out = new Set<string>(props.ids)
  const queue = [...props.ids]
  while (queue.length) {
    const cur = queue.shift()!
    for (const c of allDocs.value) {
      if (c.parentId !== cur || out.has(c.id)) continue
      out.add(c.id)
      queue.push(c.id)
    }
  }
  return out
})

const docOptions = computed(() =>
  allDocs.value
    .filter((e) => !blockedIds.value.has(e.id))
    .map((e) => ({ id: e.id, path: pathOf(e.id) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh')),
)

const targetLabel = computed(() => {
  if (!parentId.value) return '顶层（无父文档）'
  return docOptions.value.find((d) => d.id === parentId.value)?.path || '已选目标'
})

async function loadDocs() {
  loading.value = true
  try {
    // 带站主 token：可见性按站主视角（否则选不到 private / 草稿父档）
    const r = await api<{ entries: DocEntry[] }>('/api/knowledge/entries?limit=1000', {
      headers: authHeaders(),
    })
    allDocs.value = (r.entries ?? []).filter((e) => !e.deletedAt)
  } catch (e) {
    error.value = apiErrorMessage(e)
    allDocs.value = []
  } finally {
    loading.value = false
  }
}

async function confirm() {
  if (busy.value || !props.ids.length) return
  busy.value = true
  error.value = ''
  const label = targetLabel.value
  try {
    const r = await api<{ moved: number; affectedIds: string[] }>('/api/knowledge/batch-move', {
      method: 'POST',
      headers: authHeaders(),
      // parentId: null = 顶层
      body: JSON.stringify({ ids: props.ids, parentId: parentId.value || null }),
    })
    emit('moved', { moved: r.moved, parentId: parentId.value, label })
  } catch (e) {
    error.value = apiErrorMessage(e)
  } finally {
    busy.value = false
  }
}

onMounted(loadDocs)
</script>

<template>
  <div class="bm-overlay" @click.self="!busy && emit('close')">
    <div class="bm-modal">
      <h3>⇅ 批量移动 {{ ids.length }} 项</h3>
      <p class="bm-hint">
        选择目标父文档后，选中项整体挂到其下（同级追加到末尾，分类保持不变，子孙随之跟随）。
        不能移动到自身或其子文档下——非法目标已自动隐藏，服务端仍会二次校验。
      </p>

      <DocParentPicker
        v-model="parentId"
        :docs="docOptions"
        label="移动到"
        :disabled="busy || loading"
        placeholder="搜索父文档标题 / 路径…"
      />

      <div class="bm-target">目标：<b>{{ targetLabel }}</b></div>
      <div v-if="loading" class="bm-note">正在加载文档列表…</div>
      <div v-if="error" class="bm-error">❌ {{ error }}</div>

      <div class="bm-foot">
        <button class="bm-btn ghost" :disabled="busy" @click="emit('close')">取消</button>
        <button class="bm-btn" :disabled="busy || loading" @click="confirm">
          {{ busy ? '移动中…' : '确认移动' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bm-overlay {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.bm-modal {
  width: min(520px, 96vw); max-height: 88vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 20px;
}
.bm-modal h3 { margin: 0 0 6px; font-size: 16px; }
.bm-hint { margin: 0 0 12px; font-size: 12px; color: var(--muted); line-height: 1.7; }
.bm-target { font-size: 13px; color: var(--text); margin-top: 2px; }
.bm-note { font-size: 12px; color: var(--muted); margin-top: 8px; }
.bm-error { margin-top: 8px; font-size: 13px; color: var(--danger, #dc2626); word-break: break-word; }
.bm-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.bm-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 8px 18px; font-size: 14px; cursor: pointer; font-family: inherit;
}
.bm-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.bm-btn:disabled { opacity: 0.6; cursor: default; }
</style>
