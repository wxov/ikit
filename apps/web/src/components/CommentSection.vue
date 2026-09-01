<script setup lang="ts">
import { ref, computed, watch, inject, type Ref } from 'vue'
import { api, type KnowledgeComment } from '../lib/api'
import { authHeaders } from '../lib/auth'

const props = defineProps<{ entryId?: string }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const canWrite = inject<Ref<boolean>>('canWrite', ref(false))
const userRole = inject<Ref<string>>('userRole', ref('guest'))
const username = inject<Ref<string>>('username', ref(''))
const comments = ref<KnowledgeComment[]>([])
const text = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')

async function load() {
  if (!props.entryId) return
  try {
    const r = await api<{ comments: KnowledgeComment[] }>(`/api/knowledge/entries/${props.entryId}/comments`)
    comments.value = r.comments
  } catch {
    comments.value = []
  }
}

async function add() {
  if (!props.entryId || !text.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/api/knowledge/entries/${props.entryId}/comments`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: text.value }),
    })
    text.value = ''
    notice.value = '评论成功'
    emit('changed')
    await load()
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function del(c: KnowledgeComment) {
  if (!confirm(`删除这条评论？`)) return
  try {
    await api(`/api/knowledge/comments/${c.id}`, { method: 'DELETE', headers: authHeaders() })
    emit('changed')
    await load()
  } catch (e: any) {
    error.value = e.message
  }
}

function time(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const canWriteAny = computed(() => canWrite.value && props.entryId)
const canDelete = (c: KnowledgeComment) => (username.value && c.author === username.value) || userRole.value === 'admin'

watch(
  () => props.entryId,
  () => {
    text.value = ''
    error.value = ''
    load()
  },
  { immediate: true },
)

</script>

<template>
  <div class="comments">
    <div class="cmt-head">
      <span class="cmt-title">评论</span>
      <span class="cmt-count">{{ comments.length }}</span>
    </div>

    <div v-if="notice" class="cmt-notice ok">{{ notice }}</div>
    <div v-if="error" class="cmt-notice bad">{{ error }}</div>

    <div v-if="comments.length" class="cmt-list">
      <div v-for="c in comments" :key="c.id" class="cmt-item">
        <span class="cmt-avatar">{{ c.author.slice(0, 1).toUpperCase() }}</span>
        <div class="cmt-body">
          <div class="cmt-line">
            <span class="cmt-author">{{ c.author }}</span>
            <span class="cmt-time">{{ time(c.createdAt) }}</span>
          </div>
          <div class="cmt-content">{{ c.content }}</div>
        </div>
        <button v-if="canDelete(c)" class="cmt-del" title="删除" @click="del(c)">×</button>
      </div>
    </div>
    <div v-else class="cmt-empty">暂无评论，来抢沙发～</div>

    <div v-if="canWriteAny" class="cmt-add">
      <textarea v-model="text" class="cmt-input" placeholder="写点评论…" @keydown.enter.meta.prevent="add" />
      <button class="cmt-btn" :disabled="busy || !text.trim()" @click="add">{{ busy ? '提交中…' : '发表评论' }}</button>
    </div>
    <div v-else class="cmt-login">登录后可发表评论</div>
  </div>
</template>

<style scoped>
.comments { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.cmt-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.cmt-title { font-weight: 600; font-size: 14px; }
.cmt-count { font-size: 12px; color: var(--muted); }
.cmt-notice { font-size: 12px; margin-bottom: 8px; }
.cmt-notice.ok { color: var(--ok); }
.cmt-notice.bad { color: var(--danger); }
.cmt-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
.cmt-item { display: flex; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--bg); position: relative; }
.cmt-avatar {
  width: 30px; height: 30px; border-radius: 50%; flex: 0 0 auto;
  background: var(--primary); color: #fff; display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600;
}
.cmt-body { flex: 1; min-width: 0; }
.cmt-line { display: flex; gap: 10px; align-items: baseline; }
.cmt-author { font-size: 13px; font-weight: 600; }
.cmt-time { font-size: 11px; color: var(--muted); }
.cmt-content { font-size: 13px; margin-top: 3px; line-height: 1.6; word-break: break-word; }
.cmt-del { border: none; background: transparent; color: var(--muted); font-size: 16px; cursor: pointer; line-height: 1; align-self: flex-start; }
.cmt-del:hover { color: var(--danger); }
.cmt-empty { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.cmt-add { display: flex; flex-direction: column; gap: 8px; }
.cmt-input {
  width: 100%; min-height: 64px; padding: 9px 12px;
  border: 1px solid var(--border); border-radius: 8px; font-size: 13px;
  font-family: inherit; background: var(--panel); color: var(--text); resize: vertical;
}
.cmt-btn {
  align-self: flex-end; border: 1px solid var(--primary); background: var(--primary); color: #fff;
  border-radius: 8px; padding: 7px 16px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.cmt-btn:disabled { opacity: 0.6; }
.cmt-login { font-size: 12px; color: var(--muted); }
</style>
