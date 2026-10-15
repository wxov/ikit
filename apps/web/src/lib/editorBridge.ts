// 飞书式编辑 · 块级结构操作逻辑（纯逻辑模块，**不含任何模板/样式**，便于单测与复用）
//
// 定位原理（与 Lute 的 wysiwyg DOM 结构对齐，实测于 vditor@4.0.0）：
//   可编辑区的 `pre.vditor-reset[contenteditable]` 的**顶层子元素**就是文档的顶层块：
//   `h1[data-block=0]`、`p[data-block=0]`、`ul[data-block=0]`、`ol`、`blockquote[data-block=0]`
//   （提示块 callout 也是 `blockquote[data-type=callout]`）、`table[data-block=0]`、`hr`、
//   `div.vditor-wysiwyg__block[data-type=code-block|math-block]`。
//   因此「第 n 个顶层块 ↔ `splitBlocks(markdown)[n]`」成立（已用单测在真实 Lute 下校验）。
//
// 本模块提供：块的悬停定位、文档坐标计算、块级操作执行（全部经 Markdown 层 → `setValue`）。
import {
  applyBlockOp,
  blockLabel as blockLabelOf,
  blockTypeOf,
  isBlankBlockText,
  isTypeLocked,
  joinBlocks,
  parseTable,
  renderTable,
  splitBlocks,
  tableInsertCol,
  tableInsertRow,
  tableRemoveCol,
  tableRemoveRow,
  type BlockConvertTarget,
} from './editorBlocks'

export interface EditorBridge {
  /** 读取完整 Markdown（保存口径，恒为 Markdown） */
  readValue(): string
  /** 写入完整 Markdown（走 Vditor 公开 API `setValue`，仍会写入 undo 栈） */
  writeValue(md: string): void
  /** 光标处插入 Markdown（Vditor 公开 API `insertMD`） */
  insertMarkdown(md: string): void
  /** 当前 wysiwyg contenteditable 元素（未就绪返回 null） */
  editable(): HTMLElement | null
  /** 编辑器外层容器（浮层定位基准） */
  hostElement(): HTMLElement | null
  /** 触发一次「内容已变更」（自动保存 / 快照信号） */
  notifyInput(): void
}

/** 顶层块元素（跳过 Vditor 的 <wbr> / 文本节点 / 提示浮层等非块节点） */
const BLOCK_EXCLUDE = new Set(['WBR', 'SCRIPT', 'STYLE'])

/** 该节点是否为「文档顶层块」元素 */
export function isBlockElement(el: Element | null): el is HTMLElement {
  if (!el || el.nodeType !== 1) return false
  if (BLOCK_EXCLUDE.has(el.tagName)) return false
  // 行内元素（strong/em/code/a/span/img…）不会是顶层块
  if (['STRONG', 'EM', 'S', 'CODE', 'A', 'SPAN', 'IMG', 'DEL', 'MARK', 'SUP', 'SUB', 'BR'].includes(el.tagName)) {
    return false
  }
  return true
}

/** 从任意 DOM 节点向上找它所属的顶层块 */
export function closestBlock(node: Node | null, editable: HTMLElement): HTMLElement | null {
  let el: Node | null = node
  if (el && el.nodeType === 3) el = el.parentNode
  while (el && el !== editable) {
    if (el.parentNode === editable && isBlockElement(el as Element)) return el as HTMLElement
    el = el.parentNode
  }
  return null
}

/** 顶层块在编辑器中的序号（= Markdown 块序号；找不到返回 -1） */
export function blockIndexOf(el: Element | null, editable: HTMLElement): number {
  if (!el) return -1
  let idx = 0
  let cur: Element | null = editable.firstElementChild
  while (cur) {
    if (isBlockElement(cur)) {
      if (cur === el) return idx
      idx++
    }
    cur = cur.nextElementSibling
  }
  return -1
}

/** 相对编辑器容器的坐标（浮层定位用，避免受滚动影响） */
export function offsetIn(host: HTMLElement, el: Element): { left: number; top: number; height: number } {
  const h = host.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return { left: r.left - h.left, top: r.top - h.top, height: r.height }
}

/** 块菜单里的一项 */
export interface BlockMenuItem {
  id: string
  label: string
  /** 分组：move=移动/复制删除，convert=转类型，table=表格增删 */
  group: 'move' | 'convert' | 'table'
  danger?: boolean
  disabled?: boolean
}

/** 块类型展示名（菜单标题） */
export function blockLabel(md: string): string {
  return blockLabelOf(md)
}

/** 可转换的目标类型（按块类型给出可用项） */
export function convertTargets(md: string): { target: BlockConvertTarget; label: string }[] {
  const all: { target: BlockConvertTarget; label: string }[] = [
    { target: 'paragraph', label: '正文' },
    { target: 'heading1', label: '一级标题' },
    { target: 'heading2', label: '二级标题' },
    { target: 'heading3', label: '三级标题' },
    { target: 'list', label: '无序列表' },
    { target: 'ordered-list', label: '有序列表' },
    { target: 'task', label: '待办事项' },
    { target: 'quote', label: '引用' },
    { target: 'callout', label: '提示块' },
    { target: 'code', label: '代码块' },
  ]
  if (isTypeLocked(md)) return []
  const cur = blockTypeOf(md)
  // 已是该类型（或等价的标题级别）→ 不展示
  const skip = new Set<BlockConvertTarget>()
  if (cur === 'paragraph') skip.add('paragraph')
  if (cur === 'list') skip.add('list')
  if (cur === 'ordered-list') skip.add('ordered-list')
  if (cur === 'task') skip.add('task')
  if (cur === 'quote') skip.add('quote')
  if (cur === 'callout') skip.add('callout')
  if (cur.startsWith('heading')) {
    const lvl = /^#+/.exec(md.trimStart())?.[0].length ?? 1
    if (lvl === 1) skip.add('heading1')
    if (lvl === 2) skip.add('heading2')
    if (lvl === 3) skip.add('heading3')
  }
  return all.filter((t) => !skip.has(t.target))
}

/**
 * 执行块操作，返回新 Markdown（失败 / 不适用返回 null，调用方保持原状）。
 * `op` 与 `lib/editorBlocks.applyBlockOp` 一一对应。
 */
export function runBlockOp(
  markdown: string,
  op: { kind: 'up' | 'down' | 'duplicate' | 'delete' | 'convert'; index: number; target?: BlockConvertTarget },
): string | null {
  return applyBlockOp(markdown, op)
}

/** 表格可视化编辑：按操作返回新表格 Markdown（失败返回 null） */
export function runTableOp(
  markdown: string,
  index: number,
  op: { kind: 'row-above' | 'row-below' | 'col-left' | 'col-right' | 'row-remove' | 'col-remove'; at: number },
): string | null {
  const blocks = splitBlocks(markdown)
  const block = blocks[index]
  if (!block) return null
  const table = parseTable(block.md)
  if (!table) return null
  let next = table
  switch (op.kind) {
    case 'row-above':
      next = tableInsertRow(table, op.at)
      break
    case 'row-below':
      next = tableInsertRow(table, op.at + 1)
      break
    case 'col-left':
      next = tableInsertCol(table, op.at)
      break
    case 'col-right':
      next = tableInsertCol(table, op.at + 1)
      break
    case 'row-remove':
      next = tableRemoveRow(table, op.at)
      break
    case 'col-remove':
      next = tableRemoveCol(table, op.at)
      break
  }
  if (next === table) return null
  return replaceBlockMarkdown(markdown, index, renderTable(next))
}

/** 用新 Markdown 替换第 index 个块（保持其余块原样；越界返回 null） */
export function replaceBlockMarkdown(markdown: string, index: number, blockMd: string): string | null {
  const blocks = splitBlocks(markdown)
  if (index < 0 || index >= blocks.length) return null
  const all = blocks.map((b) => b.md)
  all[index] = blockMd
  return joinBlocks(all)
}

/** 空文档判定（斜杠命令 / 块操作的前置判断；与自动保存的「空草稿不建条目」语义无关） */
export function isDocEmpty(markdown: string): boolean {
  return isBlankBlockText(markdown.replace(/[\n\r]/g, ''))
}

// ---------------------------------------------------------------------------
// 光标 / 块定位工具（斜杠菜单、行内快捷、块手柄共用；都基于**字符偏移**而非 DOM 节点引用，
// 因为 Vditor 每次重渲染都会替换块的子节点，节点引用会失效）
// ---------------------------------------------------------------------------

/** 把「可编辑区内的字符偏移」解析成 Range 端点 */
export function pointAtOffset(root: HTMLElement, offset: number): { node: Node; offset: number } {
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
export function offsetOfPoint(root: HTMLElement, node: Node, nodeOffset: number): number {
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

/**
 * 光标所在（或光标为整个编辑器时：第一个）顶层块。
 * 编辑器被整块清空后光标会落在 `pre.vditor-reset` 上（`innerHTML` 为空）→ 回退到第一个块或编辑器自身。
 */
export function currentBlockOf(root: HTMLElement): HTMLElement | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const node = sel.getRangeAt(0).startContainer
  const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement | null)
  if (!el || el === root || !root.contains(el)) {
    return (root.firstElementChild as HTMLElement | null) ?? root
  }
  let block: HTMLElement | null = el
  while (block && block.parentElement !== root) block = block.parentElement
  return block ?? root
}

/** 光标当前字符偏移（可编辑区整篇） */
export function caretOffset(root: HTMLElement): number {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const r = sel.getRangeAt(0)
  return offsetOfPoint(root, r.startContainer, r.startOffset)
}

/** 把光标放到可编辑区内第 offset 个字符之后 */
export function placeCaretAt(root: HTMLElement, offset: number): void {
  const p = pointAtOffset(root, offset)
  const range = document.createRange()
  range.setStart(p.node, p.offset)
  range.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}


// ---------------------------------------------------------------------------
// 行内格式归一化（悬浮工具条 / Vditor 工具栏加粗的**必要修复**）
// ---------------------------------------------------------------------------
//
// 实测（Edge headless + CDP，vditor@4.0.0）：对「已加粗」的文字再执行一次加粗（取消加粗）时，
// 浏览器 `execCommand('bold')` 产出的是 `<span data-marker="**">加粗</span>`——**是 `<span>` 而非
// `<strong>`**。Lute 的 `Md2VditorDOM` 不会把无标记的 `<span>` 当成加粗，于是 DOM 里已被取消的
// 加粗在 Markdown 里**仍然保留**（`readValue()` 与实际所见不一致 → 保存后内容回退）。
// 归一化：按**计算样式**把无标记的行内包裹元素改写成 Lute 认得的标签 + `data-marker`：
//   font-weight ≥ 600 → STRONG[**]；font-style italic → EM[*]；line-through → S[~~]；等宽字体 → CODE[`]
// 然后由调用方派发一次 `input`，让 Vditor 重新渲染该块并刷新撤销栈。
const INLINE_TAGS = new Set(['SPAN', 'STRONG', 'B', 'EM', 'I', 'S', 'STRIKE', 'DEL', 'CODE', 'MARK', 'U'])

/** 计算样式 → (标签, data-marker)；无法识别返回 null */
function inlineMarkerOf(el: HTMLElement): { tag: string; marker: string } | null {
  let cs: CSSStyleDeclaration
  try {
    cs = window.getComputedStyle(el)
  } catch {
    return null
  }
  if (cs.textDecorationLine.includes('line-through')) return { tag: 's', marker: '~~' }
  const weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400)
  if (weight >= 600) return { tag: 'strong', marker: '**' }
  if (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique') return { tag: 'em', marker: '*' }
  if (cs.fontFamily && /mono|consolas|courier|menlo/i.test(cs.fontFamily)) return { tag: 'code', marker: '`' }
  return null
}

/**
 * 归一化可编辑区里的行内格式包裹元素（就地修改 DOM）。
 * @returns 被改写的元素数量（0 = 无需处理）
 */
export function normalizeInlineFormats(root: HTMLElement): number {
  const candidates: HTMLElement[] = []
  root.querySelectorAll<HTMLElement>('span, b, i, u, mark, strike').forEach((el) => {
    if (!INLINE_TAGS.has(el.tagName)) return
    // 已带 Lute 标记 → 只清理多余属性（浏览器可能塞进 style/class）
    if (el.hasAttribute('data-marker')) {
      el.removeAttribute('style')
      el.removeAttribute('class')
      return
    }
    candidates.push(el)
  })
  let changed = 0
  for (const el of candidates) {
    if (!el.isConnected) continue
    const m = inlineMarkerOf(el)
    if (!m) continue
    const doc = el.ownerDocument
    const wrapper = doc.createElement(m.tag)
    wrapper.setAttribute('data-marker', m.marker)
    while (el.firstChild) wrapper.appendChild(el.firstChild)
    el.replaceWith(wrapper)
    changed++
  }
  return changed
}


/** 块菜单项列表（供 `EditorBlockHandle.vue` 渲染） */
export function blockMenuItems(md: string, index: number, total: number): BlockMenuItem[] {
  const items: BlockMenuItem[] = [
    { id: 'up', label: '上移', group: 'move', disabled: index <= 0 },
    { id: 'down', label: '下移', group: 'move', disabled: index >= total - 1 },
    { id: 'duplicate', label: '复制', group: 'move' },
    { id: 'delete', label: '删除', group: 'move', danger: true },
  ]
  const conv = convertTargets(md)
  if (conv.length) {
    items.push({ id: '__convert-title', label: '转为', group: 'convert', disabled: true })
    for (const c of conv) {
      items.push({ id: `convert:${c.target}`, label: c.label, group: 'convert' })
    }
  }
  return items
}

/** 表格菜单项（在表格块内显示） */
export function tableMenuItems(table: ReturnType<typeof parseTable>, row: number, col: number): BlockMenuItem[] {
  if (!table) return []
  return [
    { id: `table:row-above:${row}`, label: '上方插入行', group: 'table' },
    { id: `table:row-below:${row}`, label: '下方插入行', group: 'table' },
    { id: `table:row-remove:${row}`, label: '删除本行', group: 'table', danger: true, disabled: table.rows.length <= 1 },
    { id: `table:col-left:${col}`, label: '左侧插入列', group: 'table' },
    { id: `table:col-right:${col}`, label: '右侧插入列', group: 'table' },
    { id: `table:col-remove:${col}`, label: '删除本列', group: 'table', danger: true, disabled: table.header.length <= 1 },
  ]
}
