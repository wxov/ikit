<script setup lang="ts">
// 飞书式编辑 · 选中文字悬浮格式工具条（自建增强）
//
// 为什么可行（已核对 vditor@4.0.0 源码）：
// - Vditor 在 wysiwyg 下**没有**内建的「选中文字浮条」：`vditor.wysiwyg.selectPopover`
//   （dist/index.js:15244-15247）只在 `comment.enable` 为真时用于「添加评论」，本项目未开启评论；
// - 但 Vditor 工具栏按钮的格式动作是**公开可用的渲染管线**：`MenuItem` 给
//   `this.element.children[0]` 绑定了 `getEventName()`（CustomEvent）监听
//   （dist/index.js:9356-9370），命中后进入 `toolbarEvent()`（dist/index.js:9050+），
//   走 `document.getSelection()` 的当前选区 → 执行 `execCommand('bold'|'italic'|…)` 或 link 包裹，
//   并刷新 `<wbr>` 光标、写入 undo 栈。
// - 因此本组件「点击 = 派发同一个 CustomEvent」，与用户点工具栏完全等价，**不碰 DOM 结构 → 不破坏撤销**。
//
// 选区保持：浮条自身在 `mousedown` 上 `preventDefault()`，浏览器不会移动焦点/清空选区，
// `toolbarEvent()` 的 `getEditorRange()` 仍能拿到原选区（本项目浮条渲染在编辑器容器内，不影响 Vditor 的 blur 逻辑）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { normalizeInlineFormats, type EditorBridge } from '../lib/editorBridge'

const props = defineProps<{
  bridge: EditorBridge
  /** 点击「文档互链」时由宿主打开选择器（Vditor 工具栏的链接按钮做的是普通链接包裹） */
  onDocLink?: () => void
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const open = ref(false)
const left = ref(0)
const top = ref(0)
const barEl = ref<HTMLElement | null>(null)
/** 链接输入态（行内输入框；Enter 应用 / Esc 取消） */
const linkOpen = ref(false)
const linkValue = ref('')
const linkInput = ref<HTMLInputElement | null>(null)

/** 当前选区快照（用于判断是否仍有效 / 输入 URL 时恢复选区） */
let savedText = ''
/** 选区 Range 快照：点开链接输入框会让编辑器失焦，Chrome 会清空选区 → 应用前恢复 */
let savedRange: Range | null = null

const FORMATS = [
  { id: 'bold', label: 'B', title: '加粗（Ctrl+B）', cls: 'fw-bold' },
  { id: 'italic', label: 'I', title: '斜体（Ctrl+I）', cls: 'fw-italic' },
  { id: 'strike', label: 'S', title: '删除线', cls: 'fw-strike' },
  { id: 'inline-code', label: '</>', title: '行内代码', cls: 'fw-code' },
] as const

const hasSelection = computed(() => open.value && savedText.trim().length > 0)

/**
 * 点击格式按钮：派发 Vditor 工具栏监听的 CustomEvent（等价于用户点工具栏，见文件头注释）。
 * 随后立刻做一次**行内格式归一化**：Vditor 的 `toolbarEvent` 用 `execCommand` 改 DOM，
 * 取消加粗时浏览器产出 `<span data-marker="**">`（而非 `<strong>`），Lute 不会据此写出 `**`，
 * 会造成「DOM 已取消加粗、Markdown 仍是加粗」的不一致（详见 `normalizeInlineFormats` 注释）。
 */
function runToolbarAction(name: string): boolean {
  const host = props.bridge.hostElement()
  const container = host?.closest('.md-editor') ?? document.querySelector('.md-editor') ?? document
  const btn = container.querySelector<HTMLElement>(`.vditor-toolbar [data-type="${name}"]`)
  if (!btn) return false
  btn.dispatchEvent(new CustomEvent('click'))
  return true
}

function applyFormat(name: string) {
  runToolbarAction(name)
  const editable = props.bridge.editable()
  if (editable) {
    const changed = normalizeInlineFormats(editable)
    if (changed > 0) {
      // 让 Vditor 重新渲染该块并把这次改动写入撤销栈（内容本身仍由 Vditor 从 DOM 转 Markdown）
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    }
  }
  // Vditor 的 toolbarEvent 不触发 `input` 事件（execCommand 分支），这里补一次变更通知，
  // 保证自动保存 / 草稿快照被调度
  props.bridge.notifyInput()
  void nextTick(update)
}

function openLink() {
  // 记录选区（点开输入框会让 contenteditable 失焦，选区可能被清空）
  const sel = document.getSelection()
  savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
  linkOpen.value = true
  linkValue.value = ''
  void nextTick(() => linkInput.value?.focus())
}

/** 恢复快照选区（应用链接前调用） */
function restoreSelection(): boolean {
  if (!savedRange) return false
  try {
    const sel = document.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(savedRange)
    return true
  } catch {
    return false
  }
}

function applyLink() {
  const url = linkValue.value.trim()
  const editable = props.bridge.editable()
  if (!url || !editable) return cancelLink()
  try {
    restoreSelection()
    document.execCommand('createLink', false, url)
    props.bridge.notifyInput()
  } catch {
    /* 选区失效 → 忽略 */
  }
  linkOpen.value = false
  void nextTick(update)
}

function cancelLink() {
  linkOpen.value = false
  linkValue.value = ''
}

/** 选区变化 → 显示 / 隐藏浮条 */
function update() {
  if (linkOpen.value) return
  const host = props.bridge.hostElement()
  const editable = props.bridge.editable()
  const sel = document.getSelection()
  if (!host || !editable || !sel || sel.rangeCount === 0 || sel.isCollapsed) return hide()
  const range = sel.getRangeAt(0)
  if (!editable.contains(range.commonAncestorContainer)) return hide()
  const text = range.toString()
  if (!text.trim()) return hide()
  savedText = text
  savedRange = range.cloneRange()
  const rect = range.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return hide()
  const h = host.getBoundingClientRect()
  const bar = barEl.value
  open.value = true
  void nextTick(() => {
    const w = bar?.offsetWidth ?? 240
    const hgt = bar?.offsetHeight ?? 36
    let l = rect.left - h.left + rect.width / 2 - w / 2
    let t = rect.top - h.top - hgt - 8
    if (rect.top - hgt - 8 < 0) t = rect.bottom - h.top + 8 // 顶部空间不足 → 翻到选区下方
    l = Math.max(4, Math.min(l, h.width - w - 8))
    left.value = l
    top.value = Math.max(4, t)
  })
}

function hide() {
  open.value = false
  linkOpen.value = false
  savedText = ''
  savedRange = null
}

/** 点击浮层外部 / 编辑器失焦 → 隐藏 */
function onDocMouseDown(e: MouseEvent) {
  if (!open.value) return
  if (barEl.value?.contains(e.target as Node)) return
  hide()
}

/** 编辑器滚动 / 窗口变化 → 直接收起（避免浮层脱位） */
function onReposition() {
  if (open.value) hide()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    if (linkOpen.value) cancelLink()
    else hide()
  }
}

onMounted(() => {
  const editable = props.bridge.editable()
  editable?.addEventListener('mouseup', update)
  editable?.addEventListener('keyup', update)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('scroll', onReposition, true)
  window.addEventListener('resize', onReposition)
  document.addEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(() => {
  const editable = props.bridge.editable()
  editable?.removeEventListener('mouseup', update)
  editable?.removeEventListener('keyup', update)
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('scroll', onReposition, true)
  window.removeEventListener('resize', onReposition)
  document.removeEventListener('keydown', onKeydown, true)
})

/** selectionchange 也要响应（拖选/键盘选择）；用微任务去抖，避免抖动 */
let selTimer: ReturnType<typeof setTimeout> | null = null
function onSelectionChange() {
  if (selTimer) clearTimeout(selTimer)
  selTimer = setTimeout(() => {
    selTimer = null
    update()
  }, 60)
}

defineExpose({ hide })
</script>

<template>
  <div
    v-if="open"
    ref="barEl"
    class="ikit-selbar"
    :style="{ left: left + 'px', top: top + 'px' }"
    role="toolbar"
    aria-label="文字格式"
    @mousedown.prevent
  >
    <button
      v-for="f in FORMATS"
      :key="f.id"
      class="ikit-selbar__btn"
      :class="f.cls"
      type="button"
      :title="f.title"
      @click="applyFormat(f.id)"
    >
      {{ f.label }}
    </button>
    <span class="ikit-selbar__sep" />
    <button
      class="ikit-selbar__btn"
      type="button"
      title="插入链接（Ctrl+K）"
      :disabled="!hasSelection"
      @click="openLink"
    >
      🔗
    </button>
    <button
      v-if="props.onDocLink"
      class="ikit-selbar__btn"
      type="button"
      title="插入文档互链 [[标题]]"
      @click="props.onDocLink?.(); hide()"
    >
      📄
    </button>
    <span v-if="linkOpen" class="ikit-selbar__link">
      <input
        ref="linkInput"
        v-model="linkValue"
        class="ikit-selbar__input"
        placeholder="https://…"
        @keydown.enter.prevent="applyLink"
        @keydown.esc.prevent="cancelLink"
      />
      <button class="ikit-selbar__ok" type="button" @click="applyLink">确定</button>
    </span>
  </div>
</template>

<style scoped>
.ikit-selbar {
  position: absolute;
  z-index: 41;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
}
.ikit-selbar__btn {
  min-width: 26px;
  height: 26px;
  padding: 0 5px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  line-height: 1;
  cursor: pointer;
}
.ikit-selbar__btn:hover:not(:disabled) { background: var(--primary-soft); color: var(--primary-dark); }
.ikit-selbar__btn:disabled { opacity: 0.4; cursor: default; }
.ikit-selbar__btn.fw-bold { font-weight: 700; }
.ikit-selbar__btn.fw-italic { font-style: italic; font-family: Georgia, serif; }
.ikit-selbar__btn.fw-strike { text-decoration: line-through; }
.ikit-selbar__btn.fw-code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.ikit-selbar__sep { width: 1px; height: 16px; margin: 0 3px; background: var(--border); }
.ikit-selbar__link { display: flex; align-items: center; gap: 4px; margin-left: 4px; }
.ikit-selbar__input {
  width: 168px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}
.ikit-selbar__ok {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--primary);
  border-radius: 5px;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
</style>
