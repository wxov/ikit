<script setup lang="ts">
// 飞书式编辑 · 块拖拽手柄 + 块菜单（自建增强）
//
// 能力边界（如实说明，见最终报告）：
// - **已实现**：悬停块左侧出现手柄 → 点击弹块菜单 → 上移 / 下移 / 复制 / 删除 / 转类型
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
  blockIndexOf,
  blockLabel,
  blockMenuItems,
  closestBlock,
  offsetIn,
  runBlockOp,
  runTableOp,
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

/** 当前锚定的块 */
let anchorBlock: HTMLElement | null = null
let anchorIndex = -1

/** 表格单元上下文（悬停在表格内时用于行列增删） */
let cellCtx: { row: number; col: number } | null = null

const hasMenu = computed(() => menuItems.value.length > 0)

/** 悬停：定位手柄到指针下的顶层块左侧 */
function onMouseMove(e: MouseEvent) {
  const editable = props.bridge.editable()
  const host = props.bridge.hostElement()
  if (!editable || !host) return
  if (menuOpen.value) return // 菜单打开时保持锚定，避免指针移动导致菜单跳动
  const target = e.target as Node
  if (!editable.contains(target)) return
  const block = closestBlock(target, editable)
  if (!block) return hideHandle()
  const { top, height } = offsetIn(host, block)
  if (anchorBlock !== block) {
    anchorBlock = block
    anchorIndex = blockIndexOf(block, editable)
    cellCtx = cellContextOf(target, editable)
  }
  handleTop.value = top + Math.min(6, Math.max(0, height / 2 - 13))
  handleVisible.value = true
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
  const items = blockMenuItems(block.md, anchorIndex, blocks.length)
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
    // 菜单贴在手柄右侧；右侧空间不足时贴到手柄左侧
    const menuW = menuEl.value?.offsetWidth ?? 190
    const handleViewportX = h.left + HANDLE_LEFT
    let l = handleViewportX + 26
    if (l + menuW > window.innerWidth - 8) l = Math.max(8, handleViewportX - menuW - 6)
    menuLeft.value = l - h.left
    menuTop.value = Math.max(4, Math.min(handleTop.value, Math.max(4, h.height - 12)))
  })
}

function closeMenu() {
  menuOpen.value = false
  menuItems.value = []
  hideHandle()
  anchorBlock = null
  anchorIndex = -1
  cellCtx = null
}

/** 执行一个块菜单项 */
function runItem(item: BlockMenuItem) {
  if (item.disabled) return
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

function onScroll() {
  if (menuOpen.value) closeMenu()
  else hideHandle()
}

onMounted(() => {
  const editable = props.bridge.editable()
  editable?.addEventListener('mousemove', onMouseMove)
  editable?.addEventListener('mouseleave', () => hideHandle())
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
})

onBeforeUnmount(() => {
  const editable = props.bridge.editable()
  editable?.removeEventListener('mousemove', onMouseMove)
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

    <!-- 块菜单 -->
    <div
      v-if="menuOpen && hasMenu"
      ref="menuEl"
      class="ikit-block__menu"
      :style="{ left: menuLeft + 'px', top: menuTop + 'px' }"
      role="menu"
      @mousedown.prevent
    >
      <div class="ikit-block__title">{{ menuTitle }}</div>
      <template v-for="(item, i) in menuItems" :key="item.id">
        <div v-if="item.group === 'convert' && (i === 0 || menuItems[i - 1].group !== 'convert')" class="ikit-block__sep" />
        <div v-if="item.group === 'table' && (i === 0 || menuItems[i - 1].group !== 'table')" class="ikit-block__sep" />
        <button
          class="ikit-block__item"
          :class="{ 'is-danger': item.danger, 'is-disabled': item.disabled, 'is-title': item.id === '__convert-title' }"
          type="button"
          role="menuitem"
          :disabled="item.disabled"
          @click="runItem(item)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
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
  cursor: grab;
}
.ikit-block__handle:hover { background: var(--primary-soft); color: var(--primary-dark); }
.ikit-block__handle svg { fill: currentColor; }
.ikit-block__menu {
  position: absolute;
  z-index: 42;
  min-width: 168px;
  max-height: 320px;
  overflow-y: auto;
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
