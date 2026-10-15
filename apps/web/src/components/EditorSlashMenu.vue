<script setup lang="ts">
// 飞书式编辑 · 斜杠命令菜单（自建浮层）
//
// 触发协议（**不用 Vditor 的 hint**，原因见 `lib/slashCommands.ts` 顶部说明）：
// - 当光标所在块为**空块**且用户键入 `/` 时，本组件拦截 `beforeinput`（`preventDefault`），
//   用 `execCommand('insertText', '/')` 自己插入 —— 相比让浏览器插入，这样能保证
//   「插入完成后立刻记录锚点」，不依赖 input 事件的先后顺序；
// - 之后用户继续输入即成为查询串（`/h1`、`/biaoti`），菜单实时过滤；
// - 锚点用**字符偏移**记录（`anchorOffset` = 可编辑区内 `/` 之后的字符数，0-based），
//   因为 Vditor 会重渲染块，DOM 节点引用立刻失效；删除 `/query` 时用 `pointAtOffset` 还原 Range，
//   并做「哨兵校验/长度校验」，避免误删正文；
// - ↑/↓ 选择、Enter/Tab 确认、Esc 关闭（Esc 会删掉已输入的 `/query`）。
//
// 插入一律 `bridge.insertMarkdown()`（Vditor 公开 API `insertMD`）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { groupSlashCommands, filterSlashCommands, templateCursorOffset, templateToMarkdown, type SlashCommand } from '../lib/slashCommands'
import type { EditorBridge } from '../lib/editorBridge'

const props = defineProps<{ bridge: EditorBridge }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const left = ref(0)
const top = ref(0)
const menuEl = ref<HTMLElement | null>(null)

const items = computed(() => filterSlashCommands(query.value))
const groups = computed(() => groupSlashCommands(items.value))
/** 扁平顺序（键盘导航用，与分组渲染顺序一致） */
const flat = computed(() => groups.value.flatMap((g) => g.items))

/** `/` 之后的字符偏移（**可编辑区整篇**内的字符数，0-based；-1 = 未记录） */
let anchorOffset = -1

function clearAnchor() {
  anchorOffset = -1
}

/** 把「可编辑区内的字符偏移」解析成 Range 端点 */
function pointAtOffset(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node = walker.nextNode()
  let last: Node | null = null
  while (node) {
    const len = node.textContent?.length ?? 0
    if (acc + len >= offset) return { node, offset: Math.max(0, Math.min(len, offset - acc)) }
    acc += len
    last = node
    node = walker.nextNode()
  }
  return { node: last ?? root, offset: last ? (last.textContent?.length ?? 0) : 0 }
}

/** `node` 之前的字符数（可编辑区整篇） */
function offsetOfPoint(root: HTMLElement, node: Node, nodeOffset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let cur = walker.nextNode()
  while (cur) {
    if (cur === node) return acc + nodeOffset
    acc += cur.textContent?.length ?? 0
    cur = walker.nextNode()
  }
  return acc
}

/** 记录 `/` 之后的字符偏移 */
function setAnchorAfterCaret() {
  const editable = props.bridge.editable()
  const sel = document.getSelection()
  if (!editable || !sel || sel.rangeCount === 0) return
  const r = sel.getRangeAt(0).cloneRange()
  r.collapse(true)
  anchorOffset = offsetOfPoint(editable, r.startContainer, r.startOffset)
}

/**
 * 光标所在（或光标为整个编辑器时：第一个）顶层块。
 *
 * ⚠️ 实测边界（Edge headless + CDP）：编辑器被**整块清空**后 `innerHTML` 为空、光标直接落在
 * `pre.vditor-reset` 上（`range.startContainer === editable`）。此时没有「光标所在的块」；
 * 若因此判定「非空块」，用户在空文档里敲 `/` 就永远弹不出菜单。这里统一回退到第一个块元素
 * 或（彻底为空时）编辑器自身。
 */
function currentBlock(): HTMLElement | null {
  const editable = props.bridge.editable()
  const sel = document.getSelection()
  if (!editable || !sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement | null)
  if (!el) return (editable.firstElementChild as HTMLElement | null) ?? editable
  // 光标直接在编辑器根上（空文档）→ 用第一个块（没有块就用编辑器自身）
  if (el === editable || !editable.contains(el)) {
    return (editable.firstElementChild as HTMLElement | null) ?? editable
  }
  let block: HTMLElement | null = el
  while (block && block.parentElement !== editable) block = block.parentElement
  return block ?? editable
}

/** 当前块是否为空块（斜杠菜单只在空块行首触发，与飞书一致） */
function inEmptyBlock(): boolean {
  const editable = props.bridge.editable()
  const sel = document.getSelection()
  if (!editable || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
  const range = sel.getRangeAt(0)
  const block = currentBlock()
  if (!block) return false
  const strip = (s: string) => s.replace(/[\u200b\s]/g, '')
  const text = strip(block.textContent ?? '')
  const before = (() => {
    if (!editable.contains(range.startContainer)) return ''
    try {
      const r = document.createRange()
      r.selectNodeContents(block)
      r.setEnd(range.startContainer, range.startOffset)
      return strip(r.toString())
    } catch {
      return ''
    }
  })()
  return text === '' && before === ''
}

function onBeforeInput(e: InputEvent) {
  if (!props.bridge.editable()) return
  if (e.inputType !== 'insertText' || e.data !== '/') return
  if (open.value) return
  if (!inEmptyBlock()) return
  // 自己插入 `/`（而不是放行浏览器）→ 插入完成后立刻记录锚点，不依赖事件先后顺序
  e.preventDefault()
  document.execCommand('insertText', false, '/')
  setAnchorAfterCaret()
  query.value = ''
  open.value = true
  activeIndex.value = 0
  void nextTick(position)
}

function currentBlockText(): string | null {
  const block = currentBlock()
  return block ? (block.textContent ?? '') : null
}

/** 输入事件：更新查询串；块不再是 `/xxx` 形态则关闭 */
function onInput() {
  if (!open.value) return
  const text = currentBlockText()
  if (text === null) return close()
  const m = /^\s*\/([^\s/]*)$/.exec(text.replace(/\u200b/g, ''))
  if (!m) return close()
  query.value = m[1]
  activeIndex.value = 0
  void nextTick(position)
}

function close(keepText = false) {
  if (!open.value) return
  open.value = false
  if (!keepText) removeQueryRange()
  clearAnchor()
  emit('close')
}

/**
 * 删除已输入的 `/query`（从块行首到当前光标）。
 *
 * 实现细节（实测踩坑）：
 * - 用 `Selection` + `execCommand('delete')` 而不是 `Range.deleteContents()`：后者在
 *   contenteditable 内删除纯文本节点在部分组合下不生效，且不会触发 Vditor 的输入管线；
 * - 起点用 `selectNodeContents(block)` 折叠到块行首，而**不是**字符偏移还原的 Range：
 *   菜单只在**空块**行首触发，故 `/query` 必然从块首开始，这样可完全避开
 *   「偏移 0 解析成元素节点 → `setStart` 抛 IndexSizeError」的边界。
 */
function removeQueryRange() {
  const editable = props.bridge.editable()
  if (!editable) return
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const block = currentBlock()
  if (!block) return
  try {
    const cur = sel.getRangeAt(0)
    const range = document.createRange()
    range.selectNodeContents(block)
    range.setEnd(cur.endContainer, cur.endOffset)
    if (range.collapsed || range.toString().replace(/\u200b/g, '').length > 25) {
      clearAnchor()
      return
    }
    sel.removeAllRanges()
    sel.addRange(range)
    document.execCommand('delete', false)
  } catch {
    /* 结构异常 → 放弃删除，只关闭菜单 */
  }
  clearAnchor()
}

/** 浮层定位：光标相对编辑器容器的坐标 */
function position() {
  const host = props.bridge.hostElement()
  const sel = document.getSelection()
  if (!host || !sel || sel.rangeCount === 0) return
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  const h = host.getBoundingClientRect()
  const height = menuEl.value?.offsetHeight ?? 280
  const hostW = h.width
  let l = rect.left - h.left
  let t = rect.bottom - h.top + 6
  // 视口底部空间不足 → 翻到光标上方
  if (rect.bottom + height + 12 > window.innerHeight) t = rect.top - h.top - height - 6
  const menuW = menuEl.value?.offsetWidth ?? 240
  l = Math.max(4, Math.min(l, hostW - menuW - 8))
  left.value = l
  top.value = Math.max(4, t)
}

function pick(cmd: SlashCommand) {
  const editable = props.bridge.editable()
  if (!editable) return
  // 先删 `/query`，再插入块 Markdown；插入后按模板标记定位光标
  removeQueryRange()
  const offset = templateCursorOffset(cmd.template)
  const md = templateToMarkdown(cmd.template)
  props.bridge.insertMarkdown(md)
  if (offset !== null) placeCursor(offset)
  close(true)
  props.bridge.notifyInput()
}

/** 把光标放到编辑器内「第 offset 个字符」之后（用于 `{{cursor}}` 落点） */
function placeCursor(offset: number) {
  const editable = props.bridge.editable()
  if (!editable) return
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node = walker.nextNode()
  while (node) {
    const len = node.textContent?.length ?? 0
    if (acc + len >= offset) {
      const range = document.createRange()
      range.setStart(node, Math.max(0, offset - acc))
      range.collapse(true)
      const sel = document.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    acc += len
    node = walker.nextNode()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    // Esc：删掉已输入的 `/query` 并关闭菜单（`keepText=false`）
    close()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    const n = flat.value.length
    if (!n) return
    activeIndex.value = (activeIndex.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    return
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    const cmd = flat.value[activeIndex.value]
    if (!cmd) return
    e.preventDefault()
    e.stopPropagation()
    pick(cmd)
  }
}

/** 点击外部 / 编辑器失焦 → 关闭并清掉 `/query` */
function onDocMouseDown(e: MouseEvent) {
  if (!open.value) return
  if (menuEl.value?.contains(e.target as Node)) return
  close()
}

/** 滚动 / 窗口尺寸变化导致定位漂移 → 直接关闭（与飞书一致，避免浮层错位） */
function onReposition() {
  if (open.value) close()
}

watch(items, () => {
  if (activeIndex.value >= flat.value.length) activeIndex.value = 0
})

onMounted(() => {
  const editable = props.bridge.editable()
  // 全部走**捕获阶段**：先于 Vditor 自己的 input/blur 处理，保证 `beforeinput` 拦截与查询串同步生效
  editable?.addEventListener('beforeinput', onBeforeInput as EventListener, true)
  editable?.addEventListener('input', onInput as EventListener, true)
  editable?.addEventListener('keydown', onKeydown as EventListener, true)
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('scroll', onReposition, true)
  window.addEventListener('resize', onReposition)
})

onBeforeUnmount(() => {
  const editable = props.bridge.editable()
  editable?.removeEventListener('beforeinput', onBeforeInput as EventListener, true)
  editable?.removeEventListener('input', onInput as EventListener, true)
  editable?.removeEventListener('keydown', onKeydown as EventListener, true)
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('scroll', onReposition, true)
  window.removeEventListener('resize', onReposition)
})

defineExpose({ isOpen: () => open.value, close })
</script>

<template>
  <div
    v-if="open"
    ref="menuEl"
    class="ikit-slash"
    :style="{ left: left + 'px', top: top + 'px' }"
    role="listbox"
    aria-label="斜杠命令"
    @mousedown.prevent
  >
    <div v-if="!flat.length" class="ikit-slash__empty">无匹配命令</div>
    <template v-for="g in groups" :key="g.group">
      <div class="ikit-slash__group">{{ g.label }}</div>
      <button
        v-for="cmd in g.items"
        :key="cmd.id"
        class="ikit-slash__item"
        :class="{ 'is-active': flat.indexOf(cmd) === activeIndex }"
        type="button"
        role="option"
        :aria-selected="flat.indexOf(cmd) === activeIndex"
        @mouseenter="activeIndex = flat.indexOf(cmd)"
        @click="pick(cmd)"
      >
        <span class="ikit-slash__icon">{{ cmd.icon }}</span>
        <span class="ikit-slash__title">{{ cmd.title }}</span>
        <span class="ikit-slash__id">/{{ cmd.id }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.ikit-slash {
  position: absolute;
  z-index: 40;
  width: 258px;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
}
.ikit-slash__group {
  padding: 6px 8px 3px;
  font-size: 11px;
  color: var(--muted);
}
.ikit-slash__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.ikit-slash__item.is-active,
.ikit-slash__item:hover {
  background: var(--primary-soft);
  color: var(--primary-dark);
}
.ikit-slash__icon {
  flex: 0 0 22px;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}
.ikit-slash__title { flex: 1; }
.ikit-slash__id { font-size: 11px; color: var(--muted); }
.ikit-slash__empty { padding: 10px; font-size: 12px; color: var(--muted); text-align: center; }
</style>
