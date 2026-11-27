<script setup lang="ts">
// 拾光（日记 · 感悟 · 名言）—— 默认内置插件；开门密码保护（解锁令牌仅在内存，刷新/锁上后需重新输入）
import { computed, inject, onMounted, ref, type Ref } from 'vue'
import { api } from '../lib/api'
import { authHeaders } from '../lib/auth'

type EntryType = 'diary' | 'insight' | 'quote'

interface Entry {
  id: string
  type: EntryType
  date?: string
  title?: string
  content: string
  author?: string
  createdAt: string
  updatedAt: string
}

const TYPE_LABEL: Record<EntryType, string> = { diary: '日记', insight: '感悟', quote: '名言' }
const TYPE_ICON: Record<EntryType, string> = { diary: '📔', insight: '💡', quote: '❝' }

const loading = ref(true)
const busy = ref(false)
const error = ref('')
const notice = ref('')
/** 忘记密码：重置确认态（仅站主可用；清除密码、保留内容） */
const resetOpen = ref(false)

const userRole = inject<Ref<string>>('userRole', ref('guest'))
const isAdmin = computed(() => userRole.value === 'admin')

const hasPasscode = ref(false)
const token = ref('')
const mode = ref<'unlock' | 'setup' | 'change'>('unlock')
const pass1 = ref('')
const pass2 = ref('')
const oldPass = ref('')

const entries = ref<Entry[]>([])
const filter = ref<'all' | EntryType>('all')
const editing = ref<null | { id?: string; type: EntryType; date: string; title: string; author: string; content: string }>(
  null,
)
const confirmDeleteId = ref('')

// ---- AI 润色（仅日记 / 感悟）----
const polishing = ref(false)
const polishResult = ref('')
const polishError = ref('')

function resetPolish() {
  polishResult.value = ''
  polishError.value = ''
}

async function doPolish() {
  const v = editing.value
  if (!v || polishing.value || v.type === 'quote' || !v.content.trim()) return
  polishing.value = true
  polishResult.value = ''
  polishError.value = ''
  try {
    const r = await api<{ text: string }>('/api/shiguang/polish', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ type: v.type, content: v.content }),
    })
    polishResult.value = r.text
  } catch (e: any) {
    polishError.value = errMsg(e)
  } finally {
    polishing.value = false
  }
}

function applyPolish() {
  if (!editing.value || !polishResult.value) return
  editing.value.content = polishResult.value
  resetPolish()
  notice.value = '已采纳润色结果'
}

const locked = computed(() => !token.value)
const filtered = computed(() =>
  entries.value.filter((e) => (filter.value === 'all' ? true : e.type === filter.value)),
)

const hdrs = () => ({ ...authHeaders(), ...(token.value ? { 'x-shiguang-token': token.value } : {}) })

/** 把 api() 抛出的原始 JSON 文本（{error,code}）转成可读文案 */
function errMsg(e: any): string {
  const raw = e?.message ?? String(e ?? '')
  try {
    const j = JSON.parse(raw)
    if (j && typeof j.error === 'string') return j.error
  } catch {
    /* 非 JSON：原样返回 */
  }
  return raw
}

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadStatus() {
  loading.value = true
  error.value = ''
  try {
    const r = await api<{ hasPasscode: boolean; locked: boolean }>('/api/shiguang/status', {
      headers: authHeaders(),
    })
    hasPasscode.value = r.hasPasscode
    mode.value = r.hasPasscode ? 'unlock' : 'setup'
  } catch (e: any) {
    error.value = errMsg(e)
  } finally {
    loading.value = false
  }
}

async function doUnlock() {
  if (!pass1.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ token: string; expiresAt: string }>('/api/shiguang/unlock', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ passcode: pass1.value }),
    })
    token.value = r.token
    pass1.value = ''
    await loadEntries()
  } catch (e: any) {
    const msg = errMsg(e)
    // 数据里还没有密码（如刚被重置 / 首次进入）→ 直接切到设置态，避免误导成“密码错误”
    if (msg.includes('尚未设置开门密码')) {
      hasPasscode.value = false
      mode.value = 'setup'
      pass1.value = ''
    }
    error.value = msg
  } finally {
    busy.value = false
  }
}

/** 忘记密码（站主）：清除开门密码，内容保留，回到「设置密码」 */
async function doResetPasscode() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api('/api/shiguang/passcode/reset', { method: 'POST', headers: authHeaders() })
    token.value = ''
    entries.value = []
    hasPasscode.value = false
    resetOpen.value = false
    pass1.value = ''
    pass2.value = ''
    mode.value = 'setup'
    notice.value = '密码已重置，请重新设置开门密码（内容已保留）'
  } catch (e: any) {
    error.value = errMsg(e)
  } finally {
    busy.value = false
  }
}

async function doSetup() {
  if (busy.value) return
  if (pass1.value.length < 4) {
    error.value = '密码至少 4 位'
    return
  }
  if (pass1.value !== pass2.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await api('/api/shiguang/passcode', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ newPasscode: pass1.value }),
    })
    hasPasscode.value = true
    // 设置成功后直接用该密码解锁
    const r = await api<{ token: string }>('/api/shiguang/unlock', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ passcode: pass1.value }),
    })
    token.value = r.token
    pass1.value = ''
    pass2.value = ''
    notice.value = '开门密码已设置'
    await loadEntries()
  } catch (e: any) {
    error.value = errMsg(e)
  } finally {
    busy.value = false
  }
}

async function doChangePasscode() {
  if (busy.value) return
  if (pass1.value.length < 4) {
    error.value = '新密码至少 4 位'
    return
  }
  if (pass1.value !== pass2.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await api('/api/shiguang/passcode', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ oldPasscode: oldPass.value, newPasscode: pass1.value }),
    })
    token.value = ''
    mode.value = 'unlock'
    oldPass.value = ''
    pass1.value = ''
    pass2.value = ''
    notice.value = '密码已修改，请重新解锁'
  } catch (e: any) {
    error.value = errMsg(e)
  } finally {
    busy.value = false
  }
}

async function doLock() {
  if (token.value) {
    try {
      await api('/api/shiguang/lock', { method: 'POST', headers: hdrs() })
    } catch {
      /* 忽略：本地清空同样生效 */
    }
  }
  token.value = ''
  entries.value = []
  editing.value = null
  mode.value = 'unlock'
  notice.value = '已锁上'
}

async function loadEntries() {
  try {
    const r = await api<{ entries: Entry[] }>('/api/shiguang/entries', { headers: hdrs() })
    entries.value = r.entries
  } catch (e: any) {
    error.value = errMsg(e)
    if (String(e?.message ?? '').includes('解锁')) token.value = ''
  }
}

function startNew(type: EntryType) {
  editing.value = { type, date: type === 'diary' ? today() : '', title: '', author: '', content: '' }
  error.value = ''
  resetPolish()
}

function startEdit(e: Entry) {
  resetPolish()
  editing.value = {
    id: e.id,
    type: e.type,
    date: e.date ?? '',
    title: e.title ?? '',
    author: e.author ?? '',
    content: e.content,
  }
  error.value = ''
}

function cancelEdit() {
  editing.value = null
  resetPolish()
}

async function save() {
  const v = editing.value
  if (!v || busy.value) return
  if (!v.content.trim()) {
    error.value = '内容不能为空'
    return
  }
  busy.value = true
  error.value = ''
  const body = {
    type: v.type,
    content: v.content,
    date: v.type === 'diary' ? v.date || today() : undefined,
    title: v.title || undefined,
    author: v.author || undefined,
  }
  try {
    if (v.id) {
      await api(`/api/shiguang/entries/${v.id}`, { method: 'PATCH', headers: hdrs(), body: JSON.stringify(body) })
      notice.value = '已保存修改'
    } else {
      await api('/api/shiguang/entries', { method: 'POST', headers: hdrs(), body: JSON.stringify(body) })
      notice.value = '已记下'
    }
    editing.value = null
    await loadEntries()
  } catch (e: any) {
    error.value = errMsg(e)
  } finally {
    busy.value = false
  }
}

async function askDelete(id: string) {
  confirmDeleteId.value = id
}

async function doDelete() {
  const id = confirmDeleteId.value
  if (!id || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/api/shiguang/entries/${id}`, { method: 'DELETE', headers: hdrs() })
    confirmDeleteId.value = ''
    notice.value = '已删除'
    await loadEntries()
  } catch (e: any) {
    error.value = errMsg(e)
  } finally {
    busy.value = false
  }
}

onMounted(loadStatus)
</script>

<template>
  <div class="shiguang card">
    <div class="sg-head">
      <h2 style="margin: 0">拾光</h2>
      <span class="sg-sub">日记 · 感悟 · 名言</span>
      <span class="sg-spacer" />
      <template v-if="!locked">
        <button class="sg-btn ghost" @click="mode = 'change'">改密码</button>
        <button class="sg-btn" @click="doLock">🔒 锁上</button>
      </template>
    </div>

    <div v-if="error" class="sg-error">{{ error }}</div>
    <div v-if="notice" class="sg-notice">{{ notice }}</div>

    <div v-if="loading" class="sg-empty">加载中…</div>

    <!-- 锁定态：开门密码 -->
    <div v-else-if="locked" class="sg-lock">
      <div class="sg-lock-icon">🔐</div>
      <template v-if="mode === 'setup'">
        <p class="sg-lock-tip">第一次使用，请先设置<b>开门密码</b>（进入后需要输入它，密码仅保存哈希）</p>
        <input v-model="pass1" class="sg-input" type="password" placeholder="设置密码（至少 4 位）" @keydown.enter="doSetup" />
        <input v-model="pass2" class="sg-input" type="password" placeholder="再次输入" @keydown.enter="doSetup" />
        <button class="sg-btn primary" :disabled="busy" @click="doSetup">{{ busy ? '设置中…' : '设置并进入' }}</button>
      </template>
      <template v-else-if="mode === 'change'">
        <p class="sg-lock-tip">修改开门密码（需验证原密码）</p>
        <input v-model="oldPass" class="sg-input" type="password" placeholder="原密码" />
        <input v-model="pass1" class="sg-input" type="password" placeholder="新密码（至少 4 位）" />
        <input v-model="pass2" class="sg-input" type="password" placeholder="再次输入新密码" @keydown.enter="doChangePasscode" />
        <div class="sg-row">
          <button class="sg-btn ghost" @click="mode = 'unlock'">取消</button>
          <button class="sg-btn primary" :disabled="busy" @click="doChangePasscode">{{ busy ? '保存中…' : '确认修改' }}</button>
        </div>
      </template>
      <template v-else>
        <p class="sg-lock-tip">输入开门密码</p>
        <input v-model="pass1" class="sg-input" type="password" placeholder="开门密码" @keydown.enter="doUnlock" />
        <button class="sg-btn primary" :disabled="busy" @click="doUnlock">{{ busy ? '验证中…' : '解锁' }}</button>
        <!-- 忘记密码：站主可重置（清除密码、保留内容） -->
        <div v-if="isAdmin" class="sg-forgot">
          <button v-if="!resetOpen" class="sg-link" @click="resetOpen = true">忘记密码？</button>
          <div v-else class="sg-reset">
            <p class="sg-reset-tip">重置会清除开门密码（日记 / 感悟 / 名言内容保留），仅站主可操作。</p>
            <div class="sg-row">
              <button class="sg-btn sm ghost" @click="resetOpen = false">取消</button>
              <button class="sg-btn sm danger" :disabled="busy" @click="doResetPasscode">确认重置</button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 已解锁：内容 -->
    <template v-else>
      <div class="sg-toolbar">
        <div class="sg-tabs">
          <button class="sg-tab" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
          <button class="sg-tab" :class="{ on: filter === 'diary' }" @click="filter = 'diary'">📔 日记</button>
          <button class="sg-tab" :class="{ on: filter === 'insight' }" @click="filter = 'insight'">💡 感悟</button>
          <button class="sg-tab" :class="{ on: filter === 'quote' }" @click="filter = 'quote'">❝ 名言</button>
        </div>
        <span class="sg-spacer" />
        <button class="sg-btn sm" @click="startNew('diary')">＋日记</button>
        <button class="sg-btn sm" @click="startNew('insight')">＋感悟</button>
        <button class="sg-btn sm" @click="startNew('quote')">＋名言</button>
      </div>

      <!-- 编辑器 -->
      <div v-if="editing" class="sg-editor">
        <div class="sg-editor-head">
          <select v-model="editing.type" class="sg-select">
            <option value="diary">📔 日记</option>
            <option value="insight">💡 感悟</option>
            <option value="quote">❝ 名言</option>
          </select>
          <input v-if="editing.type === 'diary'" v-model="editing.date" class="sg-input sm" type="date" />
          <input v-model="editing.title" class="sg-input sm grow" placeholder="标题（可选）" />
          <input v-if="editing.type === 'quote'" v-model="editing.author" class="sg-input sm" placeholder="出处/作者" />
        </div>
        <textarea v-model="editing.content" class="sg-textarea" rows="6" placeholder="写点什么…" />
        <!-- AI 润色：仅日记 / 感悟 -->
        <div class="sg-editor-tools">
          <button
            v-if="editing.type !== 'quote'"
            class="sg-btn sm"
            :disabled="polishing || !editing.content.trim()"
            :title="editing.content.trim() ? '让 AI 优化表达（不改原意）' : '先写点内容'"
            @click="doPolish"
          >
            {{ polishing ? '润色中…' : '✨ AI 润色' }}
          </button>
          <span v-else class="sg-hint">名言不支持 AI 润色</span>
        </div>
        <div v-if="polishResult || polishError" class="sg-polish">
          <div class="sg-polish-head">AI 润色结果（不改原意，仅优化表达）</div>
          <div v-if="polishError" class="sg-polish-error">{{ polishError }}</div>
          <template v-else>
            <div class="sg-polish-text">{{ polishResult }}</div>
            <div class="sg-row">
              <button class="sg-btn sm ghost" @click="resetPolish">放弃</button>
              <button class="sg-btn sm primary" @click="applyPolish">采纳替换</button>
            </div>
          </template>
        </div>
        <div class="sg-row">
          <button class="sg-btn ghost" @click="cancelEdit">取消</button>
          <button class="sg-btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : editing.id ? '保存修改' : '记下' }}</button>
        </div>
      </div>

      <!-- 列表 -->
      <div v-if="!filtered.length" class="sg-empty">
        {{ entries.length ? '该分类还没有内容' : '还没有内容，点右上角「＋日记 / ＋感悟 / ＋名言」开始记录' }}
      </div>
      <div v-else class="sg-list">
        <div v-for="e in filtered" :key="e.id" class="sg-item">
          <div class="sg-item-head">
            <span class="sg-badge" :class="e.type">{{ TYPE_ICON[e.type] }} {{ TYPE_LABEL[e.type] }}</span>
            <span v-if="e.date" class="sg-date">{{ e.date }}</span>
            <span class="sg-spacer" />
            <span class="sg-time">{{ shortDate(e.createdAt) }}</span>
          </div>
          <div v-if="e.title" class="sg-item-title">{{ e.title }}</div>
          <div class="sg-item-content" :class="{ quote: e.type === 'quote' }">{{ e.content }}</div>
          <div v-if="e.author" class="sg-author">—— {{ e.author }}</div>
          <div class="sg-item-actions">
            <button class="sg-btn sm ghost" @click="startEdit(e)">编辑</button>
            <template v-if="confirmDeleteId === e.id">
              <button class="sg-btn sm danger" :disabled="busy" @click="doDelete">确认删除</button>
              <button class="sg-btn sm ghost" @click="confirmDeleteId = ''">取消</button>
            </template>
            <button v-else class="sg-btn sm danger-ghost" @click="askDelete(e.id)">删除</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.shiguang { max-width: 860px; margin: 0 auto; }
.sg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.sg-sub { font-size: 12px; color: var(--muted); }
.sg-spacer { flex: 1; }
.sg-btn {
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 6px 12px; font-size: 13px; font-family: inherit; cursor: pointer;
}
.sg-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary-dark); }
.sg-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.sg-btn.primary:hover:not(:disabled) { color: #fff; opacity: 0.92; }
.sg-btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }
.sg-btn.danger { background: var(--danger, #dc2626); border-color: var(--danger, #dc2626); color: #fff; }
.sg-btn.danger-ghost { border-color: transparent; background: transparent; color: var(--danger, #dc2626); }
.sg-btn.sm { padding: 4px 10px; font-size: 12px; }
.sg-btn:disabled { opacity: 0.6; cursor: default; }
.sg-error { font-size: 12px; color: var(--danger, #dc2626); margin-bottom: 8px; }
.sg-notice { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
.sg-empty { font-size: 13px; color: var(--muted); padding: 28px 8px; text-align: center; }

/* 锁定态 */
.sg-lock {
  max-width: 360px; margin: 28px auto; padding: 24px;
  border: 1px solid var(--border); border-radius: 14px; background: var(--panel);
  display: flex; flex-direction: column; gap: 10px; align-items: stretch;
}
.sg-lock-icon { font-size: 34px; text-align: center; }
.sg-lock-tip { margin: 0 0 2px; font-size: 12px; color: var(--muted); text-align: center; line-height: 1.7; }
.sg-input {
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  background: var(--bg); color: var(--text); font-size: 13px; font-family: inherit;
}
.sg-input:focus { outline: none; border-color: var(--primary); }
.sg-input.sm { padding: 6px 8px; font-size: 12px; }
.sg-input.grow { flex: 1 1 auto; min-width: 120px; }
.sg-row { display: flex; justify-content: flex-end; gap: 8px; }

/* 工具栏 / 列表 / 编辑器 */
.sg-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.sg-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.sg-tab {
  border: 1px solid var(--border); background: var(--panel); color: var(--muted);
  border-radius: 999px; padding: 4px 12px; font-size: 12px; font-family: inherit; cursor: pointer;
}
.sg-tab.on { border-color: var(--primary); color: var(--primary-dark); background: var(--primary-soft); font-weight: 600; }
.sg-editor {
  border: 1px solid var(--border); border-radius: 12px; padding: 12px;
  background: var(--panel); display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;
}
.sg-editor-head { display: flex; gap: 6px; flex-wrap: wrap; }
.sg-select {
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
  background: var(--bg); color: var(--text); font-size: 12px; font-family: inherit;
}
.sg-textarea {
  width: 100%; border: 1px solid var(--border); border-radius: 10px; padding: 10px;
  background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.7;
  font-family: inherit; resize: vertical; box-sizing: border-box;
}
.sg-textarea:focus { outline: none; border-color: var(--primary); }
.sg-list { display: flex; flex-direction: column; gap: 10px; }
.sg-item { border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--panel); }
.sg-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sg-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--primary-soft); color: var(--primary-dark); }
.sg-badge.diary { background: #e0f2fe; color: #0369a1; }
.sg-badge.insight { background: #fef9c3; color: #854d0e; }
.sg-badge.quote { background: #f3e8ff; color: #6b21a8; }
.sg-date { font-size: 11px; color: var(--muted); }
.sg-time { font-size: 11px; color: var(--muted); }
.sg-item-title { font-size: 14px; font-weight: 600; margin-top: 6px; }
.sg-item-content { margin-top: 6px; font-size: 14px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; }
.sg-item-content.quote { font-style: italic; }
.sg-author { margin-top: 6px; font-size: 12px; color: var(--muted); text-align: right; }
.sg-item-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
@media (max-width: 640px) {
  .sg-lock { margin: 12px auto; padding: 18px; }
  .sg-toolbar { gap: 4px; }
  .sg-btn.sm { padding: 4px 8px; }
}
.sg-forgot { margin-top: 2px; text-align: center; }
.sg-link {
  border: none; background: transparent; color: var(--muted);
  font-size: 12px; font-family: inherit; cursor: pointer; text-decoration: underline;
  padding: 2px 4px;
}
.sg-link:hover { color: var(--primary-dark); }
.sg-reset {
  margin-top: 6px; padding: 10px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg); text-align: left;
}
.sg-reset-tip { margin: 0 0 8px; font-size: 12px; color: var(--danger, #dc2626); line-height: 1.7; }
/* ---- AI 润色（2026-11-28）---- */
.sg-editor-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sg-hint { font-size: 12px; color: var(--muted); }
.sg-polish {
  border: 1px solid var(--primary); border-radius: 10px; padding: 10px 12px;
  background: var(--primary-soft); display: flex; flex-direction: column; gap: 8px;
}
.sg-polish-head { font-size: 12px; font-weight: 600; color: var(--primary-dark); }
.sg-polish-text { font-size: 14px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; color: var(--text); }
.sg-polish-error { font-size: 12px; color: var(--danger, #dc2626); }
</style>
