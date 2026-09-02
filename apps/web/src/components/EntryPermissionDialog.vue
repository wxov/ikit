<script setup lang="ts">
import { ref } from 'vue'
import { api, type KnowledgeEntry, type EntryVisibility } from '../lib/api'
import { authHeaders, type Group } from '../lib/auth'

const props = defineProps<{
  entry: KnowledgeEntry
  groups: Group[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
}>()

const VIS_OPTIONS: { key: EntryVisibility; label: string; hint: string }[] = [
  { key: 'public', label: '公开', hint: '所有人（含游客）可见' },
  { key: 'login', label: '仅登录用户', hint: '所有登录用户可见' },
  { key: 'groups', label: '指定组', hint: '仅选中的用户组可见' },
  { key: 'private', label: '仅站主', hint: '只有站主可见' },
]

const visibility = ref<EntryVisibility>(props.entry.visibility ?? 'public')
const selectedGroups = ref<string[]>([...(props.entry.visibleGroups ?? [])])
const mode = ref<'self' | 'same' | 'all'>('self')
const busy = ref(false)
const notice = ref('')

async function save() {
  if (visibility.value === 'groups' && !selectedGroups.value.length) {
    notice.value = '请至少选择一个用户组'
    return
  }
  busy.value = true
  notice.value = ''
  try {
    await api(`/api/knowledge/entries/${props.entry.id}/visibility`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({
        visibility: visibility.value,
        visibleGroups: visibility.value === 'groups' ? selectedGroups.value : undefined,
        mode: mode.value,
      }),
    })
    emit('saved')
  } catch (e: any) {
    notice.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="perm-overlay" @click.self="emit('close')">
    <div class="perm-modal">
      <h3>🔒 权限设置</h3>
      <p class="perm-title">{{ entry.title }}</p>

      <div class="perm-levels">
        <label v-for="o in VIS_OPTIONS" :key="o.key" class="perm-level" :class="{ on: visibility === o.key }">
          <input type="radio" v-model="visibility" :value="o.key" />
          <span class="pl-name">{{ o.label }}</span>
          <span class="pl-hint">{{ o.hint }}</span>
        </label>
      </div>

      <div v-if="visibility === 'groups'" class="perm-groups">
        <div class="pg-label">选择可见用户组（可多选）</div>
        <label v-for="g in groups" :key="g.id" class="perm-group" :class="{ on: selectedGroups.includes(g.id) }">
          <input type="checkbox" :value="g.id" v-model="selectedGroups" />
          {{ g.name }}<i v-if="g.builtin" class="pg-builtin">内置</i>
        </label>
      </div>

      <div class="perm-modes">
        <div class="pm-label">子文件同步范围</div>
        <label><input type="radio" v-model="mode" value="self" /> 仅本文件</label>
        <label><input type="radio" v-model="mode" value="same" /> 只同步与父文件权限相同的子文件</label>
        <label><input type="radio" v-model="mode" value="all" /> 更改所有子文件</label>
      </div>

      <div v-if="notice" class="perm-notice">{{ notice }}</div>
      <div class="perm-actions">
        <button class="perm-btn" :disabled="busy" @click="save">保存</button>
        <button class="perm-btn ghost" @click="emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perm-overlay {
  position: fixed; inset: 0; z-index: 520;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.perm-modal {
  width: min(520px, 96vw);
  max-height: 88vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 14px; padding: 20px;
}
.perm-modal h3 { margin: 0 0 4px; }
.perm-title { margin: 0 0 14px; font-size: 13px; color: var(--muted); }
.perm-levels { display: flex; flex-direction: column; gap: 8px; }
.perm-level {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
  cursor: pointer; font-size: 14px;
}
.perm-level.on { background: var(--primary-soft); border-color: var(--primary); color: var(--primary-dark); }
.perm-level input { accent-color: var(--primary); }
.pl-name { font-weight: 600; }
.pl-hint { font-size: 12px; color: var(--muted); }
.perm-groups { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.pg-label, .pm-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.perm-group {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; font-size: 13px;
}
.perm-group.on { background: var(--primary-soft); border-color: var(--primary); }
.perm-group input { accent-color: var(--primary); }
.pg-builtin { font-style: normal; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; }
.perm-modes { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.perm-modes label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.perm-modes input { accent-color: var(--primary); }
.perm-notice { margin-top: 10px; font-size: 12px; color: var(--danger); }
.perm-actions { display: flex; gap: 10px; margin-top: 16px; }
.perm-btn {
  border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 8px 18px; font-size: 14px; cursor: pointer; font-family: inherit;
}
.perm-btn.ghost { border-color: var(--border); background: var(--panel); color: var(--text); }
.perm-btn:disabled { opacity: 0.6; cursor: default; }
</style>
