<script setup lang="ts">
// 详情页**文档容器**（无模式：始终可编辑 + 点外部收起）—— 完善⑧（2026-10-16）
//
// 交互模型（用户已确认）：
//   - 站主打开文章详情 → 正文**始终**是可直接编辑的文档（飞书/Notion 式，点哪改哪）；**没有「编辑页」概念、无视图切换**。
//   - 编辑器**常驻挂载**：外壳（Vditor 工具栏 + 底部状态条 + 字段控件视觉）随焦点显隐，**不随焦点卸载/重挂编辑器**。
//   - 点击文档区外（`pointerdown` / `focusout` 且目标不在容器内）→ flush 自动保存 + 收起外壳（正文仍完整呈现）。
//   - 进入详情**不等于**开始编辑：只聚焦/点击不输入不会产生 PATCH（沿用 `lib/autosave.ts` 的 unchanged 指纹短路）。
//   - 游客 / 非站主仍走 `ArticleDetail.vue` 只读渲染（本组件不参与）。
//
// 零布局跳动：外壳收起时用「工具栏高度占位 + 定高底栏槽」保证**两态下容器与正文的宽高、内边距完全一致**
// （工具栏高度由 `VditorEditor.toolbarElement()` 实测，`is-measuring` 期间借用一帧显示后立即复位，不产生可见闪烁）。
//
// 保留的既有能力（不得回归）：Vditor 就绪排队与降级、图片上传、互链 `[[` 补全与工具栏插入、
// 互链点击跳转（wysiwyg 下 `link.click` 接管 + `[[标题]]` 的 Ctrl/Cmd+点击）、页内锚点滚动、
// 失效链接提示、自动保存（防抖 2s + maxWait 10s + 串行 + 退避）、草稿快照、发布/撤回、飞书式增强（wysiwyg/斜杠/悬浮条/块手柄）。
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
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
import {
  DOC_LINK_MISSING_TIP,
  classifyLink,
  docLocationOf,
  matchHeadingByText,
  resolveDocLink,
  type ClassifiedLink,
  type DocIndexItem,
} from '../lib/docLinks'
import { docIndex, refreshDocIndex } from '../lib/docIndex'
import VditorEditor from './VditorEditor.vue'

const props = withDefaults(
  defineProps<{
    /** null = 虚拟草稿（新建，尚无服务端 id） */
    entry?: KnowledgeEntry | null
    /** 新建时的挂载父档（目录树「＋ 新建子文档」） */
    parentId?: string
    /** 分类候选（datalist） */
    categories?: string[]
    /** 返回按钮文案（App 依返回栈深度给出：`← 返回上一篇` / `← 返回列表`） */
    backLabel?: string
    /** 新建 / 目录树「编辑」进入时：自动进入编辑外壳并把光标放进正文 */
    autofocus?: boolean
  }>(),
  { entry: null, parentId: '', categories: () => [], backLabel: '← 返回列表', autofocus: false },
)

const emit = defineEmits<{
  (e: 'created', entry: KnowledgeEntry): void
  (e: 'saved', entry: KnowledgeEntry): void
  (e: 'status', entry: KnowledgeEntry): void
  /** 本端即将发起一次写入（POST/PATCH）：供 App 层识别 WS 自更新回声（AC-24，WS 广播先于 HTTP 响应到达） */
  (e: 'writing'): void
  (e: 'deleted'): void
  /** 返回（回列表 / 上一篇）：App 负责返回栈语义 */
  (e: 'back'): void
  /** 内部文档链接命中 → 同页切换到目标文章（App 负责返回栈） */
  (e: 'open-doc', id: string): void
  /** 轻提示（无法跳转等；由 App 统一展示 toast） */
  (e: 'notify', msg: string): void
  /** 编辑外壳显隐（App 据此选择多端冲突提示条口径） */
  (e: 'shell', active: boolean): void
}>()

const theme = inject<Ref<'light' | 'dark'>>('theme', ref('light'))
// 可见文章索引：优先用 App 注入的同一份（模块级单例，天然去重请求）；未注入时退回模块单例
const injectedIndex = inject<Ref<KnowledgeEntry[] | null> | null>('docIndex', null)
const index = injectedIndex ?? docIndex
const indexReady = computed(() => Array.isArray(index.value))

const rootRef = ref<HTMLElement | null>(null)
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
const updatedAt = ref(props.entry?.updatedAt ?? '')
const busy = ref(false)
const publishing = ref(false)
const inlineError = ref('')
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const picker = ref<{ label: string; matches: DocIndexItem[] } | null>(null)
const pickerItems = computed(() => (picker.value ? picker.value.matches.slice(0, 5) : []))

const parseTags = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean)
const isDraft = computed(() => (status.value ?? 'published') !== 'published')
const catPaths = computed(() => props.categories ?? [])

const LINK_HINT =
  '互链：[[文章标题]] 或 [文字](ikit://doc/<id>)；工具栏「插入文档链接」可搜索插入，输入 [[ 弹出标题补全；' +
  '行首输入 / 打开块命令菜单；正文内 [[标题]] 用 Ctrl/Cmd+点击可跳转；Ctrl/Cmd+S 立即保存，Esc 收起编辑外壳'

function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------------------
// 编辑外壳（shell）：显隐 + 零布局跳动的工具栏占位测量
// ---------------------------------------------------------------------------
/** 外壳是否展开（焦点在文档内 / 点击文档内 → true；点外部 / Esc / 焦点离开容器 → false） */
const shellActive = ref(false)
/** 工具栏测量窗口（借用一帧显示工具栏以取得真实高度；同一任务内复位，不产生可见闪烁） */
const measuring = ref(false)
/** 实测工具栏高度（外壳收起时作为占位，保证两态正文几何一致） */
const toolbarH = ref(0)
let resizeTimer: ReturnType<typeof setTimeout> | null = null

function setShell(next: boolean) {
  if (shellActive.value === next) return
  shellActive.value = next
  emit('shell', next)
  if (next) {
    // 展开时工具栏可见 → 顺手实测一次真实高度（窗口宽度变化可能让它换行）
    void nextTick(measureToolbar)
  } else {
    void autosaver.flush() // 收起即落盘（未变更 → 指纹短路，不发请求）
  }
}

async function measureToolbar() {
  const el = editorRef.value?.toolbarElement?.() ?? null
  if (!el) return
  const wasMeasuring = measuring.value
  if (!shellActive.value && !wasMeasuring) {
    measuring.value = true
    await nextTick()
  }
  const h = Math.round(el.getBoundingClientRect().height)
  if (h > 0) toolbarH.value = h
  if (measuring.value && !shellActive.value) {
    measuring.value = false
    await nextTick()
  }
}

function collapseShell() {
  setShell(false)
}

function onRootFocusIn() {
  setShell(true)
}

/**
 * 焦点离开容器 → 收起外壳。
 *
 * ⚠️ 实测坑：`relatedTarget === null`（焦点落到 body / 不可聚焦处）**不能**作为「点到文档区外」的判据——
 * 容器内的正常操作也会产生这种 focusout：① 点容器内的不可聚焦区域；② **Vditor 重渲染会整体替换
 * `pre.vditor-reset` 可编辑元素**（`setValue` / 块操作 / 斜杠菜单关闭 / 撤销重做），焦点随之丢失。
 * 因此：
 *   - 真正「点击文档区外」由 `document pointerdown`（`onDocPointerDown`，按 `contains(target)` 判定）负责；
 *   - 这里只在**焦点明确移交给容器外的可聚焦元素**时收起（等价键盘 Tab 出容器）；
 *   - `relatedTarget === null` 且 pointerdown 落在容器内 → 保持外壳展开。
 */
function onRootFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (!next) return // 落到非可聚焦处（含 Vditor 重渲染替换元素）：不据此收起
  if (rootRef.value?.contains(next)) return // 焦点仍在容器内（标题 → 正文 → 字段之间移动）
  collapseShell()
}

/**
 * 指针按下的统一判据（点哪改哪）：
 *   - 落在详情容器内 → 展开编辑外壳（**不能只靠 focusin**：`Esc` 收起外壳后焦点仍在正文里，
 *     此时再点正文不会触发 `focusin` → 外壳将永远收不回来）；
 *   - 落在容器外 → 收起外壳 + flush。
 */
function onDocPointerDown(e: PointerEvent) {
  const t = e.target as Node | null
  if (t && rootRef.value?.contains(t)) {
    setShell(true)
    return
  }
  collapseShell()
}

/**
 * 是否有自建/内建浮层处于展开态（Esc 优先交给它们处理，避免误收外壳）。
 * 实测要点：Vditor 的 `.vditor-panel--none` 是**常驻的空壳浮层**（`display:block` 但无内容/零面积），
 * 因此判据必须是「有实际可见面积」而不是「存在于 DOM / 有 clientRect」。
 */
function overlayOpen(): boolean {
  const root = rootRef.value
  if (!root) return false
  const sel = '.ikit-slash, .ikit-selbar, .vd-doc-picker, .vditor-hint, .vditor-panel:not(.vditor-panel--none)'
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).some((el) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 4 && r.height > 4
  })
}

/**
 * Esc：**优先让浮层自己关**（自建斜杠菜单 / 悬浮格式条 / 互链选择器 / Vditor 内建 hint·panel 都在
 * 捕获阶段监听 `keydown`）。
 *
 * 为什么挂在 `document` 的捕获阶段而不是容器上：**Vditor 重渲染会整体替换可编辑元素**（斜杠菜单
 * 关闭时就是走 `setValue` 改 Markdown），替换瞬间焦点会掉到 `body`，此时键事件不再经过容器 →
 * 挂在容器上的 Esc 处理会「失联」。document 捕获既能覆盖这种情况，又能保证在任何浮层之前读到
 * 「浮层仍开着」的初始状态：浮层开着 → 放行交给浮层；浮层都关了 / 没有浮层 → 收起外壳。
 */
function onDocKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (overlayOpen()) return // 交给浮层（Vditor / 自建）自行关闭
  collapseShell()
}

/** 点击正文空白区 → 把光标交给编辑器（内容区内的点击由 Vditor 原生处理） */
function onRootClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t) return
  if (
    t.closest(
      'a, button, input, select, textarea, [contenteditable="true"], .vditor-toolbar, .vditor-panel, .vditor-hint, .ikit-slash, .ikit-selbar, .ikit-block, .vd-doc-picker',
    )
  ) {
    return
  }
  if (!t.closest('.vditor-content, .vditor-wysiwyg, .vditor-ir')) return
  editorRef.value?.focus()
}

// ---------------------------------------------------------------------------
// 文章互链：编辑器内点击跳转 / 锚点滚动 / 失效处理
// ---------------------------------------------------------------------------
function linkOf(a: HTMLAnchorElement): ClassifiedLink | null {
  return classifyLink(a.getAttribute('href'), {
    docId: a.dataset.docId,
    docTitle: a.dataset.docTitle,
  })
}

/** Vditor wysiwyg 下点中 `<a>` 的回调（宿主接管 Vditor 的默认 `window.open`） */
async function onEditorLinkClick(a: HTMLAnchorElement) {
  const link = linkOf(a)
  if (!link) return
  if (link.kind === 'external' || link.kind === 'relative') {
    if (link.href) window.open(link.href, '_blank', 'noopener,noreferrer')
    return
  }
  if (link.kind === 'anchor') {
    scrollToAnchor(link.anchor ?? '')
    return
  }
  await jumpToDoc(link)
}

/** 内部文档链接：命中「当前用户可见索引」才跳转（不存在 / 不可见 → 提示；同名多篇 → 轻量选择列表） */
async function jumpToDoc(link: ClassifiedLink) {
  if (!index.value) {
    await refreshDocIndex()
    if (!index.value) {
      emit('notify', '文档索引加载失败，请稍后重试')
      return
    }
    applyLinkStates()
  }
  const res = resolveDocLink(link, index.value, { isAdmin: true })
  if (res.kind === 'missing') {
    emit('notify', DOC_LINK_MISSING_TIP)
    return
  }
  if (res.kind !== 'doc') return
  if (res.matches.length > 1) {
    picker.value = { label: link.title || link.id || '', matches: res.matches }
    return
  }
  picker.value = null
  emit('open-doc', res.id)
}

function chooseDoc(id: string) {
  picker.value = null
  emit('open-doc', id)
}

/**
 * `[[标题]]` 在编辑器内是**纯文本**（Lute 不会把它渲染成 `<a>`），无法走 `link.click`。
 * 约定：**Ctrl/Cmd + 点击** 命中 wiki 链接文本即同页跳转（与编辑器内「链接需修饰键」的既有约定一致，
 * 普通单击保持「把光标放进文本继续编辑」不变）。
 */
function onRootClickCapture(e: MouseEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  const editable = editorRef.value?.editableElement() ?? null
  if (!editable) return
  const t = e.target as HTMLElement | null
  if (!t || !editable.contains(t)) return
  if (t.closest('a')) return // 真实 `<a>` 由 Vditor 的 link.click → onEditorLinkClick 处理
  const title = wikiTitleAtPoint(e.clientX, e.clientY, editable)
  if (!title) return
  e.preventDefault()
  e.stopPropagation()
  void jumpToDoc({ kind: 'doc', title, href: '' })
}

/** 取点击位置所在的 `[[标题]]`（按文本节点的字符偏移判定；跨节点书写的 wiki 链接不在此列） */
function wikiTitleAtPoint(x: number, y: number, editable: HTMLElement): string | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  // Chromium（WebView2 / Tauri / 移动端）走 caretRangeFromPoint；WebKit/Gecko 回退 caretPositionFromPoint
  let node: Node | null = null
  let offset = 0
  const range = doc.caretRangeFromPoint?.(x, y) ?? null
  if (range) {
    node = range.startContainer
    offset = range.startOffset
  } else {
    const pos = doc.caretPositionFromPoint?.(x, y) ?? null
    if (pos) {
      node = pos.offsetNode
      offset = pos.offset
    }
  }
  if (!node || node.nodeType !== 3 || !editable.contains(node)) return null
  const text = node.textContent ?? ''
  const re = /\[\[([^[\]\n]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (offset >= m.index && offset <= m.index + m[0].length) {
      return m[1].trim() || null
    }
  }
  return null
}

/** 编辑器内锚点：① 精确 id ② 阅读端 `heading-N` 同序回退 ③ 按标题文本匹配（忽略大小写与空白） */
function scrollToAnchor(anchor: string) {
  const root = editorRef.value?.editableElement() ?? null
  if (!root) return
  const frag = String(anchor ?? '').replace(/^#/, '').trim()
  if (!frag) return
  const heads = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
  // ① 精确 id（兼容手写 id）
  let el: HTMLElement | null =
    Array.from(root.querySelectorAll<HTMLElement>('[id]')).find((n) => n.id === frag) ?? null
  // ② 阅读端 `lib/markdown.ts` 生成的 `heading-N`（0 基、全篇标题序号）→ 编辑区按同序回退
  if (!el) {
    const m = /^heading-(\d+)$/.exec(frag)
    if (m) el = heads[Number(m[1])] ?? null
  }
  // ③ 按标题文本匹配
  if (!el) {
    const idx = matchHeadingByText(frag, heads.map((h) => h.textContent ?? ''))
    if (idx >= 0) el = heads[idx]
  }
  if (!el) {
    emit('notify', `未找到锚点「${frag}」`)
    return
  }
  const scroller = findScrollableAncestor(el)
  if (scroller) {
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12
    try {
      scroller.scrollTo({ top, behavior: 'smooth' })
    } catch {
      scroller.scrollTop = top
    }
    return
  }
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch {
    el.scrollIntoView()
  }
}

function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement
  while (p) {
    const overflowY = getComputedStyle(p).overflowY
    if (/(auto|scroll|overlay)/.test(overflowY) && p.scrollHeight > p.clientHeight + 1) return p
    p = p.parentElement
  }
  return null
}

/**
 * 编辑器内失效互链的视觉标注（虚线 + 弱化色）。
 * **只加 class，不写 `title`/`data-*` 属性**：Vditor 的 DOM→Markdown（Lute `VditorDOM2Md`）会把
 * `<a title>` 转成 `[文字](url "title")`，改写属性等于改写用户内容；class 不参与 Markdown 往返。
 * （tooltip 由点击时的 toast 承担，见 `DOC_LINK_MISSING_TIP`。）
 */
function applyLinkStates() {
  const root = editorRef.value?.editableElement() ?? null
  if (!root) return
  const list = index.value
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const link = linkOf(a)
    if (!link || link.kind !== 'doc') {
      a.classList.remove('ikit-doc-link--missing')
      return
    }
    const res = resolveDocLink(link, list, { isAdmin: true })
    a.classList.toggle('ikit-doc-link--missing', indexReady.value && res.kind === 'missing')
  })
}

let linkStateTimer: ReturnType<typeof setTimeout> | null = null
function scheduleLinkStates() {
  if (linkStateTimer) clearTimeout(linkStateTimer)
  linkStateTimer = setTimeout(() => {
    linkStateTimer = null
    applyLinkStates()
  }, 300)
}

watch(index, () => void nextTick(applyLinkStates))

// ---------------------------------------------------------------------------
// 本地快照（刷新 / 崩溃恢复，非弹窗提示条）
// ---------------------------------------------------------------------------
const pendingSnap = ref<DraftSnapshot | null>(null)
const snapDismissed = ref(false)

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

// ---- 本地快照节流器：input 回调**不读** getValue()，由 500ms 定时器统一读一次 ----
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
    // 同一个节流窗口内顺手刷新字数（复用这一次读值，不额外调用 getValue）
    refreshStats()
    writeSnapshot(currentKey(), snapshot())
  }, SNAP_THROTTLE)
}

// ---------------------------------------------------------------------------
// 底部状态条（飞书式）：字数 + 保存状态 + 最后保存时间
// 性能红线：字数**不在 input 回调里读**，只在上面 500ms 节流窗口里复用同一次读值
// ---------------------------------------------------------------------------
const bodyChars = ref(0)
const bodyWords = ref(0)

function countOf(text: string): { chars: number; words: number } {
  const chars = text.replace(/\s/g, '').length
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const latin = (
    text
      .replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9_'-]+/g) ?? []
  ).length
  return { chars, words: cjk + latin }
}

function refreshStats() {
  const c = countOf(editorRef.value?.readValue() ?? '')
  bodyChars.value = c.chars
  bodyWords.value = c.words
}

// ---- 保存状态 ----
const saveState = ref<SaveState>('idle')
const savedAt = ref(0)
const nowTick = ref(Date.now())

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
      updatedAt.value = r.entry.updatedAt ?? updatedAt.value
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
    updatedAt.value = r.entry.updatedAt ?? updatedAt.value
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
  // 注意：这里**不能**用「有 input ⇒ 展开外壳」——Vditor 在重渲染（如斜杠菜单关闭时改写 Markdown）后
  // 约 200ms 会补发一次 `input` 回调，会把刚被 Esc 收起的外壳又弹开。外壳显隐只由
  // 「容器内 pointerdown / 容器内 focusin」驱动（见 onDocPointerDown / onRootFocusIn）。
  autosaver.schedule()
  touchSnapshot()
  scheduleLinkStates() // 编辑器重渲染会清掉失效链接的 class → 重新标注
}
function onBlur() {
  void autosaver.flush()
}

function focusEditor() {
  setShell(true)
  void nextTick(() => editorRef.value?.focus())
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

// ---- 编辑器 ready：建立「已保存」基线（避免空草稿立即建条目 / 首次误判为脏）+ 工具栏占位测量 ----
function onEditorReady() {
  autosaver.prime()
  refreshStats()
  void measureToolbar()
  void nextTick(applyLinkStates)
  // 本地存在比服务端更新的内容 → 非弹窗提示条
  const snap = readSnapshot(initialKey)
  if (
    snap &&
    (entryId.value
      ? isNewerThan(snap, props.entry?.updatedAt)
      : !!snap.content.trim() || !!snap.title.trim())
  ) {
    pendingSnap.value = snap
  }
  // 新建（空文档）→ 直接进入编辑外壳并把光标放进正文
  if (props.autofocus) focusEditor()
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
    updatedAt.value = r.entry.updatedAt ?? updatedAt.value
    clearSnapshot(currentKey())
    emit('status', r.entry)
  } catch (e) {
    inlineError.value = errText(e)
  } finally {
    publishing.value = false
  }
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

function onWindowFocus() {
  autosaver.retryFailed()
}

function onWindowResize() {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    resizeTimer = null
    void measureToolbar() // 工具栏可能换行 → 占位高度跟随
  }, 150)
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
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onDocKeydown, true)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('beforeunload', onBeforeUnload)
  nowTick.value = Date.now()
  // 驱动「已保存 HH:MM」10s 后淡化（不参与输入路径，开销可忽略）
  nowTimer = setInterval(() => (nowTick.value = Date.now()), 5000)
  if (!index.value) void refreshDocIndex()
  emit('shell', shellActive.value)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown, true)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('beforeunload', onBeforeUnload)
  if (nowTimer) clearInterval(nowTimer)
  if (resizeTimer) clearTimeout(resizeTimer)
  if (linkStateTimer) clearTimeout(linkStateTimer)
  // 卸载（切 tab / 换文章前的兜底）：仍脏 → 立刻写本地快照，返回时可「恢复」
  if (autosaver.isDirty()) writeSnapNow()
  cancelSnapTimer()
  autosaver.dispose()
})

defineExpose({
  /** 供 App 层在跳转 / Ctrl+S 前调用；返回是否保存成功 */
  flush: () => autosaver.flush(),
  isDirty: () => autosaver.isDirty(),
  focus: () => focusEditor(),
  /** 收起编辑外壳（供 App 层在离开详情 / 切文章前调用；当前 App 未用，保留为容器对外契约） */
  collapse: () => setShell(false),
  /** 以下为**自动化验证 / 上层判定**用的只读探针（与 `VditorEditor` 的 `isReady/isFallback/editableElement` 同一定位） */
  shellActive: () => shellActive.value,
  readValue: () => editorRef.value?.readValue() ?? '',
  editorReady: () => editorRef.value?.isReady() ?? false,
  editorFallback: () => editorRef.value?.isFallback() ?? false,
})
</script>

<template>
  <section
    ref="rootRef"
    class="article-doc"
    :class="{ 'is-active': shellActive, 'is-collapsed': !shellActive && !measuring, 'is-measuring': measuring }"
    :data-shell="shellActive ? 'active' : 'collapsed'"
    :style="{ '--ikit-toolbar-h': `${toolbarH}px` }"
    @focusin="onRootFocusIn"
    @focusout="onRootFocusOut"
    @click.capture="onRootClickCapture"
    @click="onRootClick"
  >
    <!-- 顶部：返回（导航，恒可见）+ 状态徽标 + 就地编辑提示 + 发布/撤回/删除 -->
    <div class="ad-bar">
      <button class="ad-btn ghost" @click="emit('back')">{{ backLabel }}</button>
      <span class="ad-badge" :class="isDraft ? 'draft' : 'published'">
        {{ isDraft ? '草稿 · 仅站主可见' : '已发布' }}
      </span>
      <span class="ad-spacer" />
      <span class="ad-edit-hint" :class="{ 'is-hidden': shellActive }">✎ 点击正文即可编辑</span>
      <button v-if="entryId" class="ad-btn danger-ghost" :disabled="busy" @click="remove">🗑 删除</button>
      <button class="ad-btn primary" :disabled="publishing" @click="togglePublish">
        {{ publishing ? '处理中…' : isDraft ? '发布' : '撤回' }}
      </button>
    </div>

    <!-- 本地快照恢复（非弹窗；属于「内容安全」提示，不随外壳收起） -->
    <div v-if="pendingSnap && !snapDismissed" class="ad-banner">
      <span>检测到未保存的草稿（本地快照）</span>
      <button class="ad-btn sm primary" @click="restoreSnap">恢复</button>
      <button class="ad-btn sm ghost" @click="discardSnap">丢弃</button>
    </div>

    <div v-if="inlineError" class="ad-error">{{ inlineError }}</div>

    <!-- 同名多篇：轻量选择列表（非遮罩弹窗，可取消） -->
    <div v-if="picker" class="ad-picker" role="dialog" aria-label="选择同名文档">
      <div class="adp-head">「{{ picker.label }}」匹配到 {{ picker.matches.length }} 篇同名文档，请选择：</div>
      <button v-for="m in pickerItems" :key="m.id" class="adp-item" @click="chooseDoc(m.id)">
        <span class="adp-title">{{ m.title }}</span>
        <span class="adp-path">{{ docLocationOf(m, index ?? []) }}</span>
      </button>
      <div v-if="picker.matches.length > pickerItems.length" class="adp-more">
        仅显示前 {{ pickerItems.length }} 篇（共 {{ picker.matches.length }} 篇）
      </div>
      <div class="adp-foot">
        <button class="adp-cancel" @click="picker = null">取消</button>
      </div>
    </div>

    <!-- 标题：非聚焦/悬停时以文档标题的静态样式呈现，悬停或聚焦即出现输入控件 -->
    <input
      v-model="title"
      class="ad-field ad-title"
      placeholder="文章标题（发布前必填）"
      aria-label="文章标题"
      @input="onFieldInput"
      @keydown.enter.prevent="focusBody"
      @blur="onBlur"
    />

    <!-- 元信息：分类（就地可改）+ 最近更新时间 -->
    <div class="ad-meta">
      <span class="am-ico">📂</span>
      <input
        v-model="category"
        class="ad-field ad-cat"
        list="ad-cats"
        placeholder="未分类"
        aria-label="分类（路径）"
        @input="onFieldInput"
        @blur="onBlur"
      />
      <datalist id="ad-cats">
        <option v-for="c in catPaths" :key="c" :value="c" />
      </datalist>
      <span v-if="updatedAt" class="am"><b>🕑</b> {{ shortDate(updatedAt) }}</span>
      <span v-if="entry?.views" class="am"><b>👁</b> {{ entry.views }}</span>
    </div>

    <!-- 标签：逗号分隔，就地可改 -->
    <div class="ad-field-row">
      <span class="ad-ico">#</span>
      <input
        v-model="tagsText"
        class="ad-field ad-tags-input"
        placeholder="标签（逗号分隔，如 ai, 教程, 笔记）"
        aria-label="标签（逗号分隔）"
        @input="onFieldInput"
        @blur="onBlur"
      />
    </div>

    <!-- 封面：URL 就地可改 + 上传（控件随焦点/悬停出现）+ 预览 -->
    <div class="ad-field-row ad-cover">
      <span class="ad-ico">🖼</span>
      <input
        v-model="cover"
        class="ad-field ad-cover-input"
        placeholder="封面图 URL（可选）"
        aria-label="封面图 URL"
        @input="onFieldInput"
        @blur="onBlur"
      />
      <span class="ad-cover-actions">
        <button class="ad-btn sm ghost" :disabled="uploading" @click="fileInput?.click()">
          {{ uploading ? '上传中…' : '📤 上传图片' }}
        </button>
      </span>
      <input ref="fileInput" type="file" accept="image/*" hidden @change="onFilePick" />
    </div>
    <div v-if="cover" class="ad-cover-preview">
      <img :src="cover" alt="封面预览" />
    </div>

    <!-- 正文：常驻 Vditor（wysiwyg 富文本即文档形态）；工具栏随外壳显隐，收起时按实测高度占位 -->
    <VditorEditor
      ref="editorRef"
      :value="entry?.content ?? ''"
      :theme="theme"
      :link-click="onEditorLinkClick"
      @input="onBodyInput"
      @blur="onBlur"
      @ready="onEditorReady"
    />

    <!-- 底部状态条槽：**高度恒定**（收起时留空），保证两态容器几何一致 -->
    <div class="ad-foot">
      <div v-show="shellActive" class="ad-foot-inner">
        <span class="ad-stat" :title="`正文 ${bodyChars} 字 / ${bodyWords} 词`">
          {{ bodyChars }} 字 · {{ bodyWords }} 词
        </span>
        <span class="ad-stat-sep">·</span>
        <span
          class="ad-save"
          :class="[saveState, { stale: saveState === 'saved' && nowTick - savedAt >= 10000 }]"
          :title="saveState === 'error' ? '点击重试' : ''"
          @click="saveState === 'error' && autosaver.flush()"
        >
          {{ saveText }}
        </span>
        <span v-if="saveState === 'dirty'" class="ad-hint warn">有未保存的修改</span>
        <span class="ad-hint">{{
          isDraft ? '草稿仅站主可见；点「发布」后游客可见' : '已发布；点「撤回」可退回草稿（仅站主可见）'
        }}</span>
        <span class="ad-hint ad-hint-link" :title="LINK_HINT">互链 <code>[[ ]]</code> ⓘ</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 容器：与阅读态的正文同宽同内边距（两态一致）。 */
.article-doc {
  padding: 8px 2px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ---- 顶部条（恒在流内，两态同高） ---- */
.ad-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 34px;
}
.ad-spacer { flex: 1; }
.ad-badge { font-size: 12px; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.ad-badge.draft {
  background: var(--warn-soft, #fef3c7); color: var(--warn, #b45309); border: 1px solid var(--warn, #f59e0b);
}
.ad-badge.published {
  background: var(--ok-soft, #dcfce7); color: var(--ok, #15803d); border: 1px solid var(--ok, #22c55e);
}
/* 就地编辑提示：展开外壳时隐藏但**保留占位**（visibility），避免顶部条高度变化引发跳动 */
.ad-edit-hint { font-size: 12px; color: var(--muted); }
.ad-edit-hint.is-hidden { visibility: hidden; }
.ad-btn {
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 13px;
  font-size: 13px; cursor: pointer; font-family: inherit; background: var(--panel); color: var(--text);
  white-space: nowrap;
}
.ad-btn.sm { padding: 4px 10px; font-size: 12px; }
.ad-btn.primary { border-color: var(--primary); background: var(--primary); color: #fff; }
.ad-btn.ghost { background: var(--panel); color: var(--text); }
.ad-btn.danger-ghost { color: var(--danger); border-color: var(--danger); background: var(--panel); }
.ad-btn:disabled { opacity: 0.6; cursor: default; }

.ad-banner {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--primary-soft); color: var(--primary-dark); border: 1px solid var(--primary);
}
.ad-error {
  font-size: 12px; padding: 8px 12px; border-radius: 8px;
  background: rgba(220, 38, 38, 0.08); color: var(--danger); border: 1px solid var(--danger);
}

/* ---- 字段：非焦点态＝静态文本（透明边框/底色，不改变任何几何）；悬停 / 聚焦 / 外壳展开 → 出现输入控件外观 ---- */
.ad-field {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  border-radius: 8px;
  padding: 6px 10px;
  width: 100%;
  outline: none;
  transition: border-color 0.12s ease, background-color 0.12s ease;
}
.ad-field:hover,
.ad-field:focus,
.article-doc.is-active .ad-field {
  border-color: var(--border);
  background: var(--bg);
}
.ad-title {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.3;
  padding: 6px 10px;
  margin: 0;
}
.ad-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px;
  font-size: 13px; color: var(--muted);
  min-height: 34px;
}
.ad-cat { width: auto; min-width: 120px; max-width: 320px; font-size: 13px; padding: 5px 8px; }
.am-ico { font-size: 13px; }
.am b { font-weight: 400; margin-right: 2px; }
.ad-field-row { display: flex; align-items: center; gap: 6px; min-height: 34px; }
.ad-ico { color: var(--muted); font-size: 13px; flex: 0 0 auto; }
.ad-tags-input, .ad-cover-input { font-size: 13px; padding: 5px 8px; }
/* 封面上传按钮：随焦点/悬停出现（字段控件按需出现），行高由输入框决定 → 不影响纵向几何 */
.ad-cover-actions { display: none; flex: 0 0 auto; }
.article-doc.is-active .ad-cover-actions,
.ad-cover:hover .ad-cover-actions,
.ad-cover:focus-within .ad-cover-actions { display: inline-flex; }
.ad-cover-preview { display: flex; align-items: center; gap: 10px; }
.ad-cover-preview img { height: 64px; border-radius: 8px; border: 1px solid var(--border); object-fit: cover; }

/* ---- 编辑外壳：工具栏 / 状态条 随焦点显隐；收起时工具栏高度以占位补齐（零布局跳动） ---- */
.article-doc.is-collapsed :deep(.md-editor) {
  padding-top: var(--ikit-toolbar-h, 0px);
}
.article-doc.is-collapsed :deep(.vditor-toolbar) {
  display: none;
}
.ad-foot { min-height: 30px; } /* 定高槽：收起时留空 → 容器总高一致 */
.ad-foot-inner {
  display: flex; align-items: center; flex-wrap: nowrap; gap: 0 10px;
  height: 30px; overflow: hidden;
  font-size: 12px; color: var(--muted);
}
.ad-stat { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ad-stat-sep { opacity: 0.5; }
.ad-save { font-size: 12px; color: var(--muted); cursor: default; white-space: nowrap; }
.ad-save.stale { opacity: 0.5; }
.ad-save.error { color: var(--danger); cursor: pointer; font-weight: 600; }
.ad-save.saving { color: var(--primary-dark); }
.ad-save.dirty { color: var(--warn, #b45309); }
.ad-hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ad-hint.warn { color: var(--warn, #b45309); }
.ad-hint-link { margin-left: auto; flex: 0 0 auto; }
.ad-hint-link code {
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; font-size: 11px;
}

/* ---- 同名多篇选择（与阅读态同构） ---- */
.ad-picker {
  border: 1px solid var(--primary); background: var(--primary-soft);
  border-radius: 10px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.adp-head { font-size: 13px; color: var(--primary-dark); font-weight: 600; }
.adp-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 7px 10px; cursor: pointer; font-family: inherit; font-size: 13px;
}
.adp-item:hover { border-color: var(--primary); }
.adp-title { font-weight: 600; }
.adp-path { font-size: 11px; color: var(--muted); }
.adp-more { font-size: 11px; color: var(--muted); }
.adp-foot { display: flex; justify-content: flex-end; }
.adp-cancel {
  border: 1px solid var(--border); background: var(--panel); color: var(--muted);
  border-radius: 8px; padding: 4px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}

/* 编辑器内的失效互链（只加 class，不改属性 → 不影响 Markdown 往返） */
.article-doc :deep(.vditor-reset a.ikit-doc-link--missing) {
  color: var(--muted);
  border-bottom: 1px dashed var(--muted);
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .ad-title { font-size: 22px; }
  .ad-meta { gap: 4px 10px; }
  .ad-hint { display: none; }
}
</style>
