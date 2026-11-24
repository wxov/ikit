<script setup lang="ts">
// 飞书式编辑 · 块拖拽手柄 + 块菜单（自建增强）
//
// 能力边界（如实说明，见最终报告）：
// - **已实现**：**光标所在块左侧常驻手柄**（2026-11-24 由悬停改为跟随光标）→ 点击弹块菜单 → 编辑样式（转类型）/ 上移 / 下移 / 复制 / 删除
//   （正文、H1-H3、无序/有序/待办、引用、提示块 callout、代码块）
//   以及**表格块的增删行列**（在表格内悬停时菜单追加表格项）。
// - **未实现（降级）**：真正的「按住拖拽把块拖到别处」——Vditor 的 wysiwyg 没有公开的
//   块拖拽 API，自建拖拽需要直接搬动 Lute 渲染出的 DOM（`data-marker`/`<wbr>` 光标协议会被破坏），
//   风险高于收益，故按「宁缺毋滥」不做。位置调整用菜单里的「上移/下移」等价完成。
//
// 所有结构操作都走 **Markdown 层**：`bridge.readValue() → lib/editorBlocks → bridge.writeValue()`，
// 不影响 Markdown 事实源；Vditor 的 `setValue` 内部仍会写入 undo 栈（dist/index.js:16082-16088）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  applyInlineFormat,
  blockIndexOf,
  blockLabel,
  blockMenuItems,
  currentBlockOf,
  formatMenuItems,
  offsetIn,
  runBlockOp,
  runTableOp,
  runToolbarAction,
  tableMenuItems,
  type BlockMenuItem,
  type EditorBridge,
} from '../lib/editorBridge'
import { parseTable, splitBlocks, type BlockConvertTarget } from '../lib/editorBlocks'

const props = defineProps<{ bridge: EditorBridge }>()

const handleTop = ref(0)
const handleVisible = ref(false)
const menuOpen = ref(false)
const menuLeft = ref(0)
const menuTop = ref(0)
/** 手柄的 left（CSS 固定为 2px，这里同步为常量，供菜单定位计算） */
const HANDLE_LEFT = 2
const menuItems = ref<BlockMenuItem[]>([])
const menuTitle = ref('')
const rootEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
/** 「插入链接」行内输入态 */
const linkOpen = ref(false)
const linkValue = ref('')
const linkInput = ref<HTMLInputElement | null>(null)
let savedRange: Range | null = null

/** 当前锚定的块 */
let anchorBlock: HTMLElement | null = null
let anchorIndex = -1

/** 表格单元上下文（悬停在表格内时用于行列增删） */
let cellCtx: { row: number; col: number } | null = null

const hasMenu = computed(() => menuItems.value.length > 0)

/** 2026-11-24：手柄改为**跟随光标所在块**（不再依赖鼠标悬停）：光标移到哪一行，左侧就出现菜单入口 */
let caretRaf = 0

function syncFromCaret() {
  if (menuOpen.value) return // 菜单打开时保持锚定
  const editable = props.bridge.editable()
  const host = props.bridge.hostElement()
  if (!editable || !host) return hideHandle()
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return hideHandle()
  const range = sel.getRangeAt(0)
  if (!editable.contains(range.startContainer)) return hideHandle()
  const block = currentBlockOf(editable)
  if (!block || block === editable || !host.contains(block)) return hideHandle()
  const { top, height } = offsetIn(host, block)
  if (anchorBlock !== block) {
    anchorBlock = block
    anchorIndex = blockIndexOf(block, editable)
    cellCtx = cellContextOf(range.startContainer, editable)
  }
  handleTop.value = top + Math.min(6, Math.max(0, height / 2 - 13))
  handleVisible.value = true
}

function onSelectionChange() {
  if (caretRaf) return
  caretRaf = requestAnimationFrame(() => {
    caretRaf = 0
    syncFromCaret()
  })
}

/** 焦点移出编辑器（且不是点手柄/菜单）→ 收起手柄 */
function onFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (next && rootEl.value?.contains(next)) return
  if (menuOpen.value) return
  hideHandle()
}

/** 指针下的表格单元（行/列序号，0-based；非表格单元格返回 null） */
function cellContextOf(target: Node, editable: HTMLElement): { row: number; col: number } | null {
  const cell = findTableAncestor(target, editable)
  if (!cell) return null
  const row = cell.parentElement
  if (!row) return null
  const table = row.closest('table')
  if (!table) return null
  const rows = Array.from(table.querySelectorAll('tr'))
  const r = rows.indexOf(row as HTMLTableRowElement)
  const cells = Array.from(row.children)
  const c = cells.indexOf(cell)
  if (r < 0 || c < 0) return null
  // 表头行在 Markdown 里对应 `header`（rows 从数据行开始）；这里换算成 Markdown 数据行序号
  return { row: Math.max(0, r - 1), col: c }
}

/** 从节点向上找 TH/TD（不越过 TABLE） */
function findTableAncestor(start: Node | null, editable: HTMLElement): HTMLTableCellElement | null {
  let el: Node | null = start
  if (el && el.nodeType === 3) el = el.parentNode
  while (el && el !== editable) {
    const tag = (el as HTMLElement).tagName
    if (tag === 'TH' || tag === 'TD') return el as HTMLTableCellElement
    if (tag === 'TABLE') return null
    el = el.parentNode
  }
  return null
}

function hideHandle() {
  if (menuOpen.value) return
  handleVisible.value = false
  anchorBlock = null
  anchorIndex = -1
  cellCtx = null
}

/** 打开块菜单 */
function openMenu() {
  if (anchorIndex < 0) return
  const md = props.bridge.readValue()
  const blocks = splitBlocks(md)
  const block = blocks[anchorIndex]
  if (!block) return
  menuTitle.value = blockLabel(block.md)
  // 顶部工具栏已隐藏（2026-11-24）：其功能并入本弹窗 —— 格式组（行内格式/链接/图片/互链/撤销重做/全屏）
  const items = [...formatMenuItems(), ...blockMenuItems(block.md, anchorIndex, blocks.length)]
  if (block.type === 'table' && cellCtx) {
    const table = parseTable(block.md)
    items.push(...tableMenuItems(table, cellCtx.row, cellCtx.col))
  }
  menuItems.value = items
  menuOpen.value = true
  void nextTick(() => {
    const host = props.bridge.hostElement()
    if (!host) return
    const h = host.getBoundingClientRect()
    // 菜单 Teleport 到 body + fixed：用视口坐标定位（贴在手柄右侧；右侧空间不足时贴到手柄左侧）
    const menuW = menuEl.value?.offsetWidth ?? 190
    const handleViewportX = h.left + HANDLE_LEFT
    let l = handleViewportX + 26
    if (l + menuW > window.innerWidth - 8) l = Math.max(8, handleViewportX - menuW - 6)
    menuLeft.value = l
    // 纵向：先随锚定块，再夹到视口内（max-height 340 + 12 余量），避免菜单下半截不可达
    const rawTop = h.top + Math.min(handleTop.value, Math.max(4, h.height - 12))
    menuTop.value = Math.max(4, Math.min(rawTop, window.innerHeight - 352))
  })
}

function closeMenu() {
  menuOpen.value = false
  menuItems.value = []
  linkOpen.value = false
  linkValue.value = ''
  hideHandle()
  anchorBlock = null
  anchorIndex = -1
  cellCtx = null
}

/** 执行「格式」组动作（来自被隐藏的顶部工具栏） */
function runFormat(name: string) {
  if (name === 'bold' || name === 'italic' || name === 'strike' || name === 'inline-code') {
    applyInlineFormat(props.bridge, name)
    closeMenu()
    return
  }
  if (name === 'link') {
    openLinkInput()
    return
  }
  // upload / undo / redo / fullscreen / doc-link（自定义互链按钮）
  runToolbarAction(props.bridge, name === 'doc-link' ? 'ikit-doc-link' : name)
  closeMenu()
}

function openLinkInput() {
  const sel = document.getSelection()
  savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
  linkOpen.value = true
  linkValue.value = ''
  void nextTick(() => linkInput.value?.focus({ preventScroll: true }))
}

function applyLink() {
  const url = linkValue.value.trim()
  if (!url) return cancelLink()
  if (savedRange) {
    try {
      const sel = document.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(savedRange)
      document.execCommand('createLink', false, url)
    } catch {
      /* 选区失效 → 忽略 */
    }
  }
  props.bridge.notifyInput()
  closeMenu()
}

function cancelLink() {
  linkOpen.value = false
  linkValue.value = ''
}

/** 执行一个块菜单项 */
function runItem(item: BlockMenuItem) {
  if (item.disabled) return
  if (item.id.startsWith('format:')) {
    runFormat(item.id.slice('format:'.length))
    return
  }
  const md = props.bridge.readValue()
  let next: string | null = null
  if (item.id === 'up' || item.id === 'down' || item.id === 'duplicate' || item.id === 'delete') {
    next = runBlockOp(md, { kind: item.id, index: anchorIndex })
  } else if (item.id.startsWith('convert:')) {
    const target = item.id.slice('convert:'.length) as BlockConvertTarget
    next = runBlockOp(md, { kind: 'convert', index: anchorIndex, target })
  } else if (item.id.startsWith('table:')) {
    const [, kind, atRaw] = item.id.split(':')
    next = runTableOp(md, anchorIndex, {
      kind: kind as 'row-above' | 'row-below' | 'col-left' | 'col-right' | 'row-remove' | 'col-remove',
      at: Number(atRaw),
    })
  }
  if (next === null || next === md) {
    closeMenu()
    return
  }
  props.bridge.writeValue(next)
  props.bridge.notifyInput()
  closeMenu()
}

function onDocMouseDown(e: MouseEvent) {
  if (!menuOpen.value) return
  if (menuEl.value?.contains(e.target as Node)) return
  if (rootEl.value?.contains(e.target as Node) && (e.target as HTMLElement).closest('.ikit-block__handle')) return
  closeMenu()
}

function onScroll(e: Event) {
  // 菜单自身滚动（Teleport 到 body 的 fixed 菜单）不关闭，否则滚动菜单会被误关
  const t = e.target as Node | null
  if (t && menuEl.value && (t === menuEl.value || menuEl.value.contains(t))) return
  if (linkOpen.value) return // 链接输入态：不因滚动/聚焦关闭菜单
  if (menuOpen.value) closeMenu()
  else onSelectionChange() // 滚动后重新对齐（手柄定位是相对宿主容器的，通常不变，这里兜底）
}

onMounted(() => {
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('focusout', onFocusOut, true)
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('focusout', onFocusOut, true)
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
})

defineExpose({ closeMenu })
</script>

<template>
  <div ref="rootEl" class="ikit-block">
    <!-- 块手柄：悬停块的左侧 -->
    <button
      v-show="handleVisible"
      class="ikit-block__handle"
      type="button"
      title="块操作"
      aria-label="块操作"
      :style="{ top: handleTop + 'px' }"
      @mousedown.prevent
      @click="openMenu"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="5" cy="4" r="1.4" />
        <circle cx="11" cy="4" r="1.4" />
        <circle cx="5" cy="8" r="1.4" />
        <circle cx="11" cy="8" r="1.4" />
        <circle cx="5" cy="12" r="1.4" />
        <circle cx="11" cy="12" r="1.4" />
      </svg>
    </button>

    <!-- 块菜单：Teleport 到 body + fixed，避免被编辑器容器裁剪、保证可滚动/可点击 -->
    <Teleport to="body">
      <div
        v-if="menuOpen && hasMenu"
        ref="menuEl"
        class="ikit-block__menu"
        :style="{ left: menuLeft + 'px', top: menuTop + 'px' }"
        role="menu"
      >
      <div class="ikit-block__title">{{ menuTitle }}</div>
      <div v-if="linkOpen" class="ikit-block__link">
        <input
          ref="linkInput"
          v-model="linkValue"
          placeholder="https://…"
          @keydown.enter.prevent="applyLink"
          @keydown.esc.prevent="cancelLink"
        />
        <button class="ikit-block__link-ok" type="button" @mousedown.prevent @click="applyLink">确定</button>
      </div>
      <template v-for="(item, i) in menuItems" :key="item.id">
        <div v-if="item.group === 'format' && (i === 0 || menuItems[i - 1].group !== 'format')" class="ikit-block__sep" />
        <div v-if="item.group === 'convert' && (i === 0 || menuItems[i - 1].group !== 'convert')" class="ikit-block__sep" />
        <div v-if="item.group === 'table' && (i === 0 || menuItems[i - 1].group !== 'table')" class="ikit-block__sep" />
        <button
          class="ikit-block__item"
          :class="{ 'is-danger': item.danger, 'is-disabled': item.disabled, 'is-title': item.id === '__convert-title' }"
          type="button"
          role="menuitem"
          :disabled="item.disabled"
          @mousedown.prevent
          @click="runItem(item)"
        >
          {{ item.label }}
        </button>
      </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ikit-block__handle {
  position: absolute;
  left: 2px;
  z-index: 35;
  width: 22px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.ikit-block__handle:hover { background: var(--primary-soft); color: var(--primary-dark); }
/* 光标所在块的手柄：常驻显示，略淡；hover 加深 */
.ikit-block__handle { opacity: 0.72; transition: opacity 0.12s ease; }
.ikit-block__handle svg { fill: currentColor; }
.ikit-block__menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1200;
  min-width: 168px;
  max-height: 340px;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  -webkit-overflow-scrolling: touch;
  padding: 5px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.2);
}
.ikit-block__title {
  padding: 5px 8px 6px;
  font-size: 11px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
.ikit-block__sep { height: 1px; margin: 4px 6px; background: var(--border); }
.ikit-block__link { display: flex; align-items: center; gap: 4px; margin: 4px 4px 6px; }
.ikit-block__link input {
  flex: 1; min-width: 0; height: 26px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text); font-size: 12px; font-family: inherit;
}
.ikit-block__link-ok {
  flex: 0 0 auto; height: 26px; padding: 0 10px;
  border: 1px solid var(--primary); border-radius: 6px;
  background: var(--primary); color: #fff; font-size: 12px; cursor: pointer; font-family: inherit;
}
.ikit-block__item {
  display: block;
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
.ikit-block__item:hover:not(:disabled) { background: var(--primary-soft); color: var(--primary-dark); }
.ikit-block__item.is-danger { color: var(--danger); }
.ikit-block__item.is-disabled,
.ikit-block__item.is-title { color: var(--muted); font-size: 11px; cursor: default; }
</style>
