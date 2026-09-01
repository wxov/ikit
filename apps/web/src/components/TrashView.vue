<script setup lang="ts">
import { ref, computed, onMounted, inject, type Ref } from 'vue'
import { api, type KnowledgeEntry } from '../lib/api'
import { authHeaders } from '../lib/auth'

const emit = defineEmits<{ (e: 'open', entry: KnowledgeEntry): void }>()

const userRole = inject<Ref<string>>('userRole', ref('guest'))
const isAdmin = computed(() => userRole.value === 'admin')

const entries = ref<KnowledgeEntry[]>([])
const loading = ref(false)
const error = ref('')
const notice = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await api<{ entries: KnowledgeEntry[] }>('/api/knowledge/trash')
    entries.value = r.entries || []
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function setNotice(msg: string) {
  notice.value = msg
  if (msg) setTimeout(() => (notice.value = ''), 2500)
}

async function restore(e: KnowledgeEntry) {
  try {
    await api(`/api/knowledge/trash/${e.id}/restore`, { method: 'POST', headers: authHeaders() })
    setNotice(`已恢复「${e.title}」`)
    await load()
  } catch (err: any) {
    setNotice(err.message)
  }
}
async function purge(e: KnowledgeEntry) {
  if (!confirm(`彻底删除「${e.title}」？此操作不可恢复！`)) return
  try {
    await api(`/api/knowledge/trash/${e.id}`, { method: 'DELETE', headers: authHeaders() })
    setNotice(`已彻底删除「${e.title}」`)
    await load()
  } catch (err: any) {
    setNotice(err.message)
  }
}
async function emptyAll() {
  if (!confirm('确认清空回收站？此操作不可恢复！')) return
  try {
    await api('/api/knowledge/trash', { method: 'DELETE', headers: authHeaders() })
    setNotice('回收站已清空')
    await load()
  } catch (err: any) {
    setNotice(err.message)
  }
}

onMounted(load)
</script>

<template>
  <div class="trash">
    <div class="tr-head">
      <h3>回收站</h3>
      <div class="tr-actions">
        <span v-if="notice" class="tr-notice">{{ notice }}</span>
        <button v-if="isAdmin && entries.length" class="tr-btn danger" @click="emptyAll">🗑 清空回收站</button>
      </div>
    </div>
    <div v-if="loading" class="tr-empty">加载中…</div>
    <div v-else-if="error" class="tr-empty bad">{{ error }}</div>
    <div v-else-if="!entries.length" class="tr-empty">回收站为空</div>
    <div v-else class="tr-list">
      <div v-for="e in entries" :key="e.id" class="tr-item">
        <span class="tr-title" @click="emit('open', e)">{{ e.title }}</span>
        <span class="tr-date">{{ e.deletedAt?.slice(0, 10) }}</span>
        <div class="tr-ops">
          <button v-if="isAdmin" class="tr-btn" @click="restore(e)">恢复</button>
          <button v-if="isAdmin" class="tr-btn danger" @click="purge(e)">彻底删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trash { max-width: 860px; margin: 0 auto; padding: 16px; }
.tr-head { display: flex; align-items: center; justify-content: space-between; }
.tr-head h3 { margin: 0; }
.tr-actions { display: flex; align-items: center; gap: 10px; }
.tr-notice { font-size: 12px; color: var(--ok); }
.tr-empty { padding: 40px; text-align: center; color: var(--muted); }
.tr-empty.bad { color: var(--danger); }
.tr-list { margin-top: 12px; display: flex; flex-direction: column; }
.tr-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 8px; border-bottom: 1px solid var(--border);
}
.tr-title { flex: 1; font-size: 14px; cursor: pointer; }
.tr-title:hover { color: var(--primary-dark); }
.tr-date { font-size: 12px; color: var(--muted); }
.tr-ops { display: flex; gap: 6px; }
.tr-btn { border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
.tr-btn.danger { color: var(--danger); border-color: var(--danger); }
</style>
