<script setup lang="ts">
// 详情页「编辑态」（完善⑦）：标题 / 正文（Vditor IR）/ 分类 / 标签 / 封面 **全部就地编辑，无弹窗**
//
// - 虚拟草稿（`entry === null`）：首次自动保存即 `POST`（`status:'draft'`，带 `parentId`）→ 拿到 id 后切 `PATCH`
// - 自动保存（防抖 2s + maxWait 10s + 串行 + rev + 退避重试）由 lib/autosave 提供
// - 本地快照（localStorage）负责刷新/崩溃恢复；保存成功后清除
// - 「取消」为二次确认态（非弹窗）；「返回阅读」先 flush，失败则留在编辑态（不静默丢内容）
import { computed, inject, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { api, type KnowledgeEntry } from '../lib/api'
import { authHeaders } from '../lib/auth'
import { createAutosaver, type SaveState } from '../lib/autosave'
import {
  clearSnapshot,
  flushSnapshots,
  isNewerThan,
  readSnapshot,
  snapKey,
  writeSnapshot,
  type DraftSnapshot,
} from '../lib/draftSnapshot'
import VditorEditor from './VditorEditor.vue'

const props = defineProps<{
  /** null = 虚拟草稿（新建，尚无服务端 id） */
  entry?: KnowledgeEntry | null
  /** 新建时的挂载父档（目录树「＋ 新建子文档」） */
  parentId?: string
  /** 分类候选（datalist） */
  categories?: string[]
}>()

const emit = defineEmits<{
  (e: 'created', entry: KnowledgeEntry): void
  (e: 'saved', entry: KnowledgeEntry): void
  (e: 'status', entry: KnowledgeEntry): void
  /** 本端即将发起一次写入（POST/PATCH）：供 App 层识别 WS 自更新回声（AC-24，WS 广播先于 HTTP 响应到达） */
  (e: 'writing'): void
  (e: 'exit', to: 'read' | 'list'): void
  (e: 'deleted'): void
}>()

const theme = inject<Ref<'light' | 'dark'>>('theme', ref('light'))
const editorRef = ref<InstanceType<typeof VditorEditor> | null>(null)

// 快照 key：进入时的 key（虚拟草稿 key 会在创建成功后变化，两个都要清）
const initialKey = snapKey(props.entry?.id ?? null, props.parentId)
const currentKey = () => snapKey(entryId.value, props.parentId)

const entryId = ref<string | null>(props.entry?.id ?? null)
const title = ref(props.entry?.title ?? '')
const category = ref(props.entry?.category ?? '')
const tagsText = ref((props.entry?.tags ?? []).join(', '))
const cover = ref(props.entry?.cover ?? '')
const status = ref<KnowledgeEntry['status']>(props.entry?.status ?? 'draft')
const busy = ref(false)
const publishing = ref(false)
const inlineError = ref('')
const toast = ref('')
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// 本地快照恢复（非弹窗提示条）
const pendingSnap = ref<DraftSnapshot | null>(null)
const snapDismissed = ref(false)

const parseTags = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean)
const isDraft = computed(() => status.value !== 'published')
const catPaths = computed(() => props.categories ?? [])

// ---- 保存状态 ----
const saveState = ref<SaveState>('idle')
const savedAt = ref(0)
const nowTick = ref(Date.now())

function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  try {
    const j = JSON.parse(raw) as { error?: string }
    if (j?.error) return j.error
  } catch {
    /* 非 JSON：原样展示 */
  }
  return raw
}

function snapshot(): DraftSnapshot {
  return {
    title: title.value,
    content: editorRef.value?.readValue() ?? '',
    category: category.value,
    tags: parseTags(tagsText.value),
    cover: cover.value,
    updatedAt: Date.now(),
    entryId: entryId.value,
  }
}

// 本地快照节流器：input 回调**不读** getValue()，由 500ms 定时器统一读一次
const SNAP_THROTTLE = 500
let snapTimer: ReturnType<typeof setTimeout> | null = null
function cancelSnapTimer() {
  if (snapTimer) clearTimeout(snapTimer)
  snapTimer = null
}
function writeSnapNow() {
  cancelSnapTimer()
  writeSnapshot(currentKey(), snapshot())
}
function touchSnapshot() {
  if (snapTimer) return
  snapTimer = setTimeout(() => {
    snapTimer = null
    writeSnapshot(currentKey(), snapshot())
  }, SNAP_THROTTLE)
}

const autosaver = createAutosaver<DraftSnapshot>({
  snapshot,
  fingerprint: (s) => JSON.stringify([s.title, s.content, s.category, s.tags, s.cover]),
  save: async (snap) => {
    if (!entryId.value && !snap.title.trim() && !snap.content.trim()) return // 全新空草稿不建条目
    // 通知 App：本端开始写入（用于 WS 回声识别的「写入在途」判定；每次重试也刷新）
    emit('writing')
    if (!entryId.value) {
      const body: Record<string, unknown> = {
        content: snap.content,
        category: snap.category.trim(),
        tags: snap.tags,
        cover: snap.cover.trim(),
        status: 'draft',
      }
      if (snap.title.trim()) body.title = snap.title.trim()
      if (props.parentId) body.parentId = props.parentId
      const r = await api<{ entry: KnowledgeEntry }>('/api/knowledge/entries', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      entryId.value = r.entry.id
      status.value = r.entry.status ?? 'draft'
      clearSnapshot(initialKey)
      clearSnapshot(currentKey())
      pendingSnap.value = null
      emit('created', r.entry)
      return
    }
    const body: Record<string, unknown> = {
      content: snap.content,
      // 显式传空 = 清空（与 service.update 的语义一致；不能传 undefined，否则被 JSON 丢弃）
      category: snap.category.trim(),
      tags: snap.tags,
      cover: snap.cover.trim(),
      autosave: true,
    }
    if (snap.title.trim()) body.title = snap.title.trim()
    const r = await api<{ entry: KnowledgeEntry }>(`/api/knowledge/entries/${entryId.value}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
    status.value = r.entry.status ?? status.value
    clearSnapshot(currentKey())
    pendingSnap.value = null
    emit('saved', r.entry)
  },
  onState: (s, info) => {
    saveState.value = s
    if (s === 'saved') {
      if (info?.at) savedAt.value = info.at
      cancelSnapTimer()
      clearSnapshot(currentKey())
    }
    if (s === 'saving' && inlineError.value.startsWith('保存失败')) inlineError.value = '' // 新一轮保存开始 → 清掉上轮失败提示
    if (s === 'error') {
      writeSnapNow() // 保存失败 → 立刻把内容落到本地快照（防止刷新丢内容）
      inlineError.value = `保存失败：${errText(info?.error)}`
    }
  },
})

const saveText = computed(() => {
  switch (saveState.value) {
    case 'dirty':
      return '未保存'
    case 'saving':
      return '保存中…'
    case 'saved': {
      if (!savedAt.value) return '已保存'
      const d = new Date(savedAt.value)
      const p = (n: number) => String(n).padStart(2, '0')
      return `已保存 ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    case 'error':
      return '保存失败 · 点击重试'
    default:
      return '已同步'
  }
})

// ---- 字段变更 → 调度自动保存 ----
function onFieldInput() {
  autosaver.schedule()
  touchSnapshot()
}
function onBodyInput() {
  autosaver.schedule()
  touchSnapshot()
}
function onBlur() {
  void autosaver.flush()
}

function focusBody() {
  editorRef.value?.focus()
}

// ---- 封面（沿用既有上传行为：base64 JSON → /api/upload → /uploads/<file>） ----
async function onFilePick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    inlineError.value = '仅支持图片文件'
    return
  }
  if (file.size > 5 * 1024 * 1024) {
    inlineError.value = '图片过大（最大 5MB）'
    return
  }
  uploading.value = true
  inlineError.value = ''
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('读取文件失败'))
      r.readAsDataURL(file)
    })
    const r = await api<{ url: string }>('/api/upload', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: file.name, data: dataUrl }),
    })
    cover.value = r.url
    onFieldInput()
  } catch (e) {
    inlineError.value = errText(e)
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

// ---- 编辑器 ready：建立「已保存」基线（避免空草稿立即建条目 / 首次误判为脏） ----
function onEditorReady() {
  autosaver.prime()
  // 本地存在比服务端更新的内容 → 非弹窗提示条
  const snap = readSnapshot(initialKey)
  if (snap && (entryId.value ? isNewerThan(snap, props.entry?.updatedAt) : !!snap.content.trim() || !!snap.title.trim())) {
    pendingSnap.value = snap
  }
}

function restoreSnap() {
  const s = pendingSnap.value
  if (!s) return
  title.value = s.title
  category.value = s.category
  tagsText.value = s.tags.join(', ')
  cover.value = s.cover
  editorRef.value?.setValue(s.content)
  pendingSnap.value = null
  autosaver.schedule()
}

function discardSnap() {
  clearSnapshot(initialKey)
  pendingSnap.value = null
  snapDismissed.value = true
}

// ---- 发布 / 撤回 ----
async function togglePublish() {
  if (publishing.value || busy.value) return
  const target = isDraft.value ? 'published' : 'draft'
  inlineError.value = ''
  const snap = snapshot()
  if (target === 'published' && (!snap.title.trim() || !snap.content.trim())) {
    inlineError.value = '发布前需填写标题与正文'
    return
  }
  publishing.value = true
  try {
    // 先 flush：保证发布的就是最新正文（失败则中止，不发布旧内容）
    if (!(await autosaver.flush())) {
      inlineError.value = '保存失败，已取消发布'
      return
    }
    const body: Record<string, unknown> = {
      content: snap.content,
      category: snap.category.trim(),
      tags: snap.tags,
      cover: snap.cover.trim(),
      status: target,
    }
    if (snap.title.trim()) body.title = snap.title.trim()
    emit('writing') // 发布/撤回同样是一次本端写入（WS 回声识别）
    let id = entryId.value
    if (!id) {
      const created = await api<{ entry: KnowledgeEntry }>('/api/knowledge/entries', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...body, parentId: props.parentId || undefined }),
      })
      id = created.entry.id
      entryId.value = id
      clearSnapshot(initialKey)
      emit('created', created.entry)
    }
    const r = await api<{ entry: KnowledgeEntry }>(`/api/knowledge/entries/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
    status.value = r.entry.status ?? target
    clearSnapshot(currentKey())
    emit('status', r.entry)
    showToast(target === 'published' ? '已发布 · 游客现已可见' : '已撤回 · 仅站主可见')
  } catch (e) {
    inlineError.value = errText(e)
  } finally {
    publishing.value = false
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(msg: string) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 3000)
}

// ---- 退出编辑态 ----
async function exitTo(to: 'read' | 'list') {
  if (!(await autosaver.flush())) {
    inlineError.value = '保存失败，已留在编辑态（内容已存本地快照）'
    return
  }
  cancelSnapTimer()
  clearSnapshot(initialKey)
  clearSnapshot(currentKey())
  emit('exit', to)
}

const confirmDiscard = ref(false)
const discardLeft = ref(3)
let discardTimer: ReturnType<typeof setInterval> | null = null

function resetDiscard() {
  confirmDiscard.value = false
  discardLeft.value = 3
  if (discardTimer) clearInterval(discardTimer)
  discardTimer = null
}

function onCancel() {
  if (!autosaver.isDirty()) {
    void exitTo('read')
    return
  }
  if (!confirmDiscard.value) {
    confirmDiscard.value = true
    discardLeft.value = 3
    discardTimer = setInterval(() => {
      discardLeft.value--
      if (discardLeft.value <= 0) resetDiscard()
    }, 1000)
    return
  }
  // 二次确认：回滚到「最近一次保存的快照」后返回阅读态
  const last = autosaver.lastSaved()
  if (last) {
    title.value = last.title
    category.value = last.category
    tagsText.value = last.tags.join(', ')
    cover.value = last.cover
    editorRef.value?.setValue(last.content)
  }
  resetDiscard()
  cancelSnapTimer()
  clearSnapshot(initialKey)
  clearSnapshot(currentKey())
  emit('exit', 'read')
}

async function remove() {
  if (!entryId.value || busy.value) return
  if (!confirm(`确认删除「${title.value || '未命名草稿'}」？此操作将移入回收站。`)) return
  busy.value = true
  inlineError.value = ''
  try {
    // 通知 App：本端开始写入（WS 回声识别的「写入在途」判定，与 autosave/发布同一机制）——
    // 服务端 soft-delete 的 `remove` 广播先于 HTTP 响应到达时不会误弹「已被删除」
    emit('writing')
    await api(`/api/knowledge/entries/${entryId.value}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    cancelSnapTimer()
    clearSnapshot(initialKey)
    clearSnapshot(currentKey())
    emit('deleted')
  } catch (e) {
    inlineError.value = errText(e)
  } finally {
    busy.value = false
  }
}

// ---- 生命周期：flush 触发点 ----
function onVisibility() {
  if (document.visibilityState === 'hidden') {
    if (!autosaver.isDirty()) return
    writeSnapNow()
    void autosaver.flush()
    return
  }
  // 回到前台（AC-10）：上次保存失败且仍脏 → 立刻再试一次，无需用户手动点击
  autosaver.retryFailed()
}

/** 窗口获焦（含从其它应用/窗口切回）：同样尝试自动恢复保存 */
function onWindowFocus() {
  autosaver.retryFailed()
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  flushSnapshots()
  if (autosaver.isDirty()) {
    writeSnapNow() // beforeunload 里同步写快照（异步请求大概率来不及）
    e.preventDefault()
    e.returnValue = ''
  }
}

let nowTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('beforeunload', onBeforeUnload)
  nowTick.value = Date.now()
  // 驱动「已保存 HH:MM」10s 后淡化（不参与输入路径，开销可忽略）
  nowTimer = setInterval(() => (nowTick.value = Date.now()), 5000)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('beforeunload', onBeforeUnload)
  resetDiscard()
  if (toastTimer) clearTimeout(toastTimer)
  if (nowTimer) clearInterval(nowTimer)
  cancelSnapTimer()
  autosaver.dispose()
})

defineExpose({
  /** 供 App 层在跳转 / Ctrl+S 前调用；返回是否保存成功 */
  flush: () => autosaver.flush(),
  isDirty: () => autosaver.isDirty(),
  focus: () => editorRef.value?.focus(),
})
</script>

<template>
  <section class="ae">
    <!-- 工具条 -->
    <div class="ae-bar">
      <button class="ae-btn ghost" @click="exitTo('read')">← 返回阅读</button>
      <span class="ae-badge" :class="isDraft ? 'draft' : 'published'">
        {{ isDraft ? '草稿 · 仅站主可见' : '已发布' }}
      </span>
      <span
        class="ae-save"
        :class="[saveState, { stale: saveState === 'saved' && nowTick - savedAt >= 10000 }]"
        :title="saveState === 'error' ? '点击重试' : ''"
        @click="saveState === 'error' && autosaver.flush()"
      >
        {{ saveText }}
      </span>
      <span class="ae-spacer" />
      <button v-if="confirmDiscard" class="ae-btn danger" @click="onCancel">
        确认放弃未保存修改？（{{ discardLeft }}s）
      </button>
      <button v-else class="ae-btn ghost" @click="onCancel">取消</button>
      <button class="ae-btn primary" :disabled="publishing" @click="togglePublish">
        {{ publishing ? '处理中…' : isDraft ? '发布' : '撤回' }}
      </button>
      <button v-if="entryId" class="ae-btn danger-ghost" :disabled="busy" @click="remove">🗑 删除</button>
    </div>

    <div v-if="toast" class="ae-toast">{{ toast }}</div>

    <!-- 本地快照恢复（非弹窗） -->
    <div v-if="pendingSnap && !snapDismissed" class="ae-banner">
      <span>检测到未保存的草稿（本地快照）</span>
      <button class="ae-btn sm primary" @click="restoreSnap">恢复</button>
      <button class="ae-btn sm ghost" @click="discardSnap">丢弃</button>
    </div>

    <div v-if="inlineError" class="ae-error">{{ inlineError }}</div>

    <!-- 标题 -->
    <input
      v-model="title"
      class="ae-title"
      placeholder="文章标题（发布前必填）"
      @input="onFieldInput"
      @keydown.enter.prevent="focusBody"
    />

    <!-- 元信息 -->
    <div class="ae-row">
      <div class="ae-field">
        <label>分类（路径）</label>
        <input
          v-model="category"
          class="ae-input"
          list="ae-cats"
          placeholder="如：技术/后端"
          @input="onFieldInput"
          @blur="onBlur"
        />
        <datalist id="ae-cats">
          <option v-for="c in catPaths" :key="c" :value="c" />
        </datalist>
      </div>
      <div class="ae-field">
        <label>封面图 URL（可选）</label>
        <div class="ae-cover-row">
          <input
            v-model="cover"
            class="ae-input"
            placeholder="https://…/cover.png 或点击右侧上传"
            @input="onFieldInput"
            @blur="onBlur"
          />
          <button class="ae-btn sm ghost" :disabled="uploading" @click="fileInput?.click()">
            {{ uploading ? '上传中…' : '📤 上传图片' }}
          </button>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onFilePick" />
        </div>
        <div v-if="cover" class="ae-cover-preview">
          <img :src="cover" alt="封面预览" />
          <span class="ae-cover-hint">封面预览（存储于 /uploads）</span>
        </div>
      </div>
    </div>

    <div class="ae-field">
      <label>标签（逗号分隔）</label>
      <input
        v-model="tagsText"
        class="ae-input"
        placeholder="ai, 教程, 笔记"
        @input="onFieldInput"
        @blur="onBlur"
      />
    </div>

    <!-- 正文：Vditor IR -->
    <VditorEditor ref="editorRef" :value="entry?.content ?? ''" :theme="theme" @input="onBodyInput" @blur="onBlur" @ready="onEditorReady" />

    <div class="ae-foot">
      <span class="ae-hint">
        {{ isDraft ? '草稿仅站主可见；点「发布」后游客可见' : '已发布；点「撤回」可退回草稿（仅站主可见）' }}
      </span>
      <span v-if="saveState === 'dirty'" class="ae-hint warn">有未保存的修改</span>
    </div>
  </section>
</template>

<style scoped>
.ae { padding: 4px 2px 24px; display: flex; flex-direction: column; gap: 12px; }
.ae-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ae-spacer { flex: 1; }
.ae-badge {
  font-size: 12px; padding: 3px 10px; border-radius: 999px; white-space: nowrap;
}
.ae-badge.draft { background: var(--warn-soft, #fef3c7); color: var(--warn, #b45309); border: 1px solid var(--warn, #f59e0b); }
.ae-badge.published { background: var(--ok-soft, #dcfce7); color: var(--ok, #15803d); border: 1px solid var(--ok, #22c55e); }
.ae-save { font-size: 12px; color: var(--muted); cursor: default; white-space: nowrap; }
.ae-save.stale { opacity: 0.5; }
.ae-save.error { color: var(--danger); cursor: pointer; font-weight: 600; }
.ae-save.saving { color: var(--primary-dark); }
.ae-save.dirty { color: var(--warn, #b45309); }
.ae-toast {
  align-self: flex-start; font-size: 12px; padding: 6px 12px; border-radius: 8px;
  background: var(--primary-soft); color: var(--primary-dark); border: 1px solid var(--primary);
}
.ae-banner {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--primary-soft); color: var(--primary-dark); border: 1px solid var(--primary);
}
.ae-error {
  font-size: 12px; padding: 8px 12px; border-radius: 8px;
  background: rgba(220, 38, 38, 0.08); color: var(--danger); border: 1px solid var(--danger);
}
.ae-title {
  width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px;
  font-size: 22px; font-weight: 700; font-family: inherit; background: var(--bg); color: var(--text);
}
.ae-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ae-field { display: flex; flex-direction: column; gap: 4px; }
.ae-field label { font-size: 12px; color: var(--muted); }
.ae-input {
  width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px;
  font-size: 14px; font-family: inherit; background: var(--bg); color: var(--text);
}
.ae-cover-row { display: flex; gap: 8px; align-items: center; }
.ae-cover-row .ae-input { flex: 1; }
.ae-cover-preview { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.ae-cover-preview img { height: 64px; border-radius: 8px; border: 1px solid var(--border); object-fit: cover; }
.ae-cover-hint { font-size: 11px; color: var(--muted); }
.ae-foot { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--muted); }
.ae-hint.warn { color: var(--warn, #b45309); }
.ae-btn {
  border: 1px solid var(--border); border-radius: 8px; padding: 7px 14px;
  font-size: 13px; cursor: pointer; font-family: inherit; background: var(--panel); color: var(--text);
  white-space: nowrap;
}
.ae-btn.sm { padding: 5px 10px; font-size: 12px; }
.ae-btn.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
.ae-btn.ghost { background: var(--panel); color: var(--text); }
.ae-btn.danger { color: #fff; border-color: var(--danger); background: var(--danger); }
.ae-btn.danger-ghost { color: var(--danger); border-color: var(--danger); background: var(--panel); }
.ae-btn:disabled { opacity: 0.6; cursor: default; }
@media (max-width: 640px) {
  .ae-row { grid-template-columns: 1fr; }
  .ae { padding-bottom: 72px; }
}
</style>
