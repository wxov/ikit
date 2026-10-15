// 飞书式可视化编辑 · **Markdown 级块操作**（纯函数，无 DOM / 无 Vue 依赖 → 可 node 直跑单测）
//
// 为什么在 Markdown 层做块操作（而不是直接操作 contenteditable DOM）：
// 1. 编辑内容的事实源恒为 Markdown（`readValue()` 口径不变），块操作的输入输出都是 Markdown，
//    不引入新的中间表示，自动保存 / 互链 / 导入流程零回归；
// 2. 直接改 DOM 极易破坏 Lute 的渲染约定（`data-marker` / `data-block` / `vditor-wysiwyg__*` 包裹）
//    与 Vditor 的 `<wbr>` 光标协议 —— 那是「不稳定实现」，宁缺毋滥；
// 3. 换块 = `getValue() → 本模块 → setValue()`，Vditor 的 `setValue` 内部走 `renderDomByMd` 且
//    `enableAddUndoStack: true`，仍会写入 undo 栈（见 dist/index.js:16071-16113、8966-8979）。
//
// 分块规则（与 Lute 的块边界对齐）：以「空行 / 围栏切换 / 顶层块起始标记 / 表格起始」为切点，
// **块内保留缩进**（嵌套列表行、块引用内的代码围栏、列表内代码块都属于同一个块），
// 因此 `joinBlocks(splitBlocks(md))` 与原 Markdown 语义等价。

/** 块类型（用于块菜单的「转为」项与块识别展示） */
export type EditorBlockType =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'ordered-list'
  | 'task'
  | 'quote'
  | 'callout'
  | 'code'
  | 'math'
  | 'table'
  | 'hr'
  | 'html'

/** 提示块（callout）类型：GFM `> [!NOTE]` 语法，Lute 原生支持（`SetCallout`） */
export type CalloutKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

/** 一个顶层块 */
export interface EditorBlock {
  /** 块 Markdown 原文（不含首尾空行；结尾无换行） */
  md: string
  /** 起止行号（0-based，闭区间），相对整篇文档 */
  startLine: number
  endLine: number
  type: EditorBlockType
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** 分隔线（--- / *** / ___）；**不含反引号**（反引号是围栏，必须能被 FENCE_RE 命中） */
const HR_RE = /^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:_\s*){3,}$/
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s|$)/
const TASK_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+\[[ xX]\](\s|$)/
const QUOTE_RE = /^ {0,3}>/
const CALLOUT_RE = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i

/** 该行是否为围栏代码块起止标记（``` / ~~~，允许 ```` 更长的围栏） */
function fenceOf(line: string): { mark: string; rest: string } | null {
  const m = FENCE_RE.exec(line)
  if (!m) return null
  // 反引号围栏的 info string 里不允许出现反引号（CommonMark）
  if (m[1][0] === '`' && m[2].includes('`')) return null
  return { mark: m[1], rest: m[2] }
}

/**
 * 列表行的缩进（列数）；非列表行返回 -1。
 * ★ 关键：只有**缩进大于当前作用域**的列表标记才可能是子级（归入当前块），
 *   等缩进或更浅 → 是同级/新的顶层块（必须切开）。
 */
function listIndentOf(line: string): number {
  const m = LIST_RE.exec(line)
  return m ? m[1].length : -1
}

/** 从 `i` 行开始（含）的表格块长度（表头 + 分隔行 + 连续含 `|` 的数据行）；0 = 不是表格 */
function tableRunLength(lines: string[], i: number): number {
  const head = lines[i]
  const sep = lines[i + 1]
  if (head === undefined || sep === undefined) return 0
  if (!head.includes('|')) return 0
  const sepTrim = sep.trim()
  if (!sepTrim.includes('|') || !/^[|\-: ]+$/.test(sepTrim) || !sepTrim.includes('-')) return 0
  let j = i + 2
  while (j < lines.length && lines[j].trim() && lines[j].includes('|')) j++
  return j - i
}

/** 该行是否为顶层（缩进 < 4 的普通行 / 任意标题 / 引用）块起始标记 */
function isTopLevelStart(line: string): boolean {
  if (!line.trim()) return false
  if (HEADING_RE.test(line) || QUOTE_RE.test(line)) return true
  const indent = line.length - line.trimStart().length
  return indent < 4
}

/** 列表「家族」：无序 / 有序 / 待办 —— 家族不同即不同块（Lute 也是各自独立的 `<ul>`/`<ol>`） */
function listFamilyOf(line: string): 'ul' | 'ol' | 'task' | null {
  const m = LIST_RE.exec(line)
  if (!m) return null
  if (TASK_RE.test(line)) return 'task'
  return /^\d/.test(m[2]) ? 'ol' : 'ul'
}

/**
 * 判断「当前正在累积的块」是否应该在这一行结束（该行另起一个新块）。
 *
 * ★ 这块判定是「块 index ↔ wysiwyg 顶层元素 index」能对上的前提（块手柄的定位基础）：
 * - 当前块是**列表块**时：缩进 ≥ 本列表作用域的同类列表行属于本块（更深的缩进即嵌套子级，
 *   Lute 会输出嵌套 `<ul>`），**家族切换**（无序 ⇄ 有序 ⇄ 待办）或缩进回退到更浅层级才另起一块；
 *   非列表行只要缩进 ≥ 4（列表项内的缩进代码块 / 续行）也留在本块；
 * - 当前块是**块引用 / 提示块**时，继续以 `>` 开头的行属于本块（callout 的 `> [!X]` 与正文都在同一 `<blockquote>`）；
 * - 其余情况等同于 `isTopLevelStart`。
 *
 * @param scope 本块列表作用域（本列表的缩进）；非列表块为 -1
 * @param family 本块首行的列表家族；非列表块为 null
 */
function endsCurrentBlock(
  line: string,
  type: EditorBlockType,
  scope: number,
  family: 'ul' | 'ol' | 'task' | null,
  inFence: boolean,
  inMath: boolean,
): boolean {
  if (inFence || inMath) return false
  if (!line.trim()) return false
  if (HR_RE.test(line)) return true // 分隔线恒为独立块
  if (type === 'list' || type === 'ordered-list' || type === 'task') {
    const fam = listFamilyOf(line)
    if (fam) {
      if (family && fam !== family) return true // 家族切换 → 另起一块
      return scope >= 0 && listIndentOf(line) < scope // 缩进回退到更浅层级 → 本列表结束
    }
    if (QUOTE_RE.test(line)) return false
    const indent = line.length - line.trimStart().length
    return indent < 4 // 缩进 ≥ 4 的行（列表内的缩进代码块 / 续行）留在本块
  }
  if (type === 'quote' || type === 'callout') {
    if (QUOTE_RE.test(line)) return false // callout 的 `> [!X]` 行与后续 `>` 行属同一块
    return true
  }
  return isTopLevelStart(line)
}

/** 把整篇 Markdown 切成顶层块（空行 / 围栏切换 / 顶层块起始 / 表格起始 / 分隔线为切点） */
export function splitBlocks(markdown: string): EditorBlock[] {
  const src = markdown ?? ''
  if (!src.trim()) return []
  const lines = src.split('\n')
  const out: EditorBlock[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++
      continue
    }
    const start = i
    let inFence: string | null = null
    /** 是否在 `$$` 块级公式内（公式体内的空行 / `#` / `-` 都不是块边界） */
    let inMath = false
    let type: EditorBlockType = 'paragraph'

    // 1) 表格块：表头 + 分隔行起，连续含 `|` 的行
    const tRun = tableRunLength(lines, i)
    if (tRun > 0) {
      const md = lines.slice(i, i + tRun).join('\n').replace(/\s+$/, '')
      out.push({ md, startLine: i, endLine: i + tRun - 1, type: 'table' })
      i += tRun
      continue
    }

    // 2) 分隔线：独立成块
    if (HR_RE.test(lines[i])) {
      out.push({ md: lines[i].trim(), startLine: i, endLine: i, type: 'hr' })
      i++
      continue
    }

    // 3) 其余块：首行确定类型，后续行按 endsCurrentBlock 决定去留
    type = blockTypeOf(lines[i])
    // 列表作用域 / 家族：更深缩进的同类列表行是它的子级 → 留在本块（与 Lute 输出的 `<ul>` 嵌套结构一致）
    let scope = type === 'list' || type === 'ordered-list' || type === 'task' ? listIndentOf(lines[start]) : -1
    const family = listFamilyOf(lines[start])
    while (i < lines.length) {
      const line = lines[i]
      if (inFence) {
        // 围栏内：空行也是块内容，不切块
        i++
        const f = fenceOf(line)
        if (f && inFence[0] === f.mark[0] && f.mark.length >= inFence.length && !f.rest.trim()) inFence = null
        continue
      }
      if (inMath) {
        i++
        if (/^\s*\$\$\s*$/.test(line)) inMath = false
        continue
      }
      if (i > start) {
        if (!line.trim()) break
        if (endsCurrentBlock(line, type, scope, family, false, false)) break
      }
      const f = fenceOf(line)
      if (f) {
        inFence = f.mark
        i++
        continue
      }
      if (/^\s*\$\$\s*$/.test(line) || /^\s*\$\$.+\$\$\s*$/.test(line)) {
        inMath = true
        i++
        continue
      }
      i++
    }
    const md = lines.slice(start, i).join('\n').replace(/\s+$/, '')
    if (md) out.push({ md, startLine: start, endLine: i - 1, type: blockTypeOf(md) })
    // 防御：内层循环理论上必推进；万一未推进则强制前进一格，杜绝死循环
    if (i === start) i++
  }
  return out
}

/** 用规范空行（`\n\n`）重新拼装块序列 */
export function joinBlocks(blocks: readonly string[]): string {
  return blocks
    .map((b) => (b ?? '').replace(/^\n+|\n+$/g, ''))
    .filter((b) => b.length > 0)
    .join('\n\n')
}

/** 段落的类型是可从首行推断的 — 用于块菜单 / 块手柄的展示与「转为」项 */
export function blockTypeOf(md: string): EditorBlockType {
  const first = (md ?? '').split('\n').find((l) => l.trim()) ?? ''
  const head = first.trimStart()
  if (!head) return 'paragraph'
  if (fenceOf(head)) return 'code'
  if (CALLOUT_RE.test(first)) return 'callout'
  if (HEADING_RE.test(first)) return 'heading'
  if (TASK_RE.test(first)) return 'task'
  const li = listIndentOf(first)
  if (li >= 0) return /^\s*\d/.test(first) ? 'ordered-list' : 'list'
  if (QUOTE_RE.test(first)) return 'quote'
  if (/^\$\$/.test(head)) return 'math'
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(head)) return 'hr'
  if (head.startsWith('<') && /^<\/?[a-zA-Z]/.test(head)) return 'html'
  return 'paragraph'
}

/** 是否命中代码围栏（含行内围栏标记）——用于「不允许改这类块的类型」的守卫 */
export function isCodeBlock(block: EditorBlock | string): boolean {
  const md = typeof block === 'string' ? block : block.md
  return blockTypeOf(md) === 'code'
}

/** 分隔线 / 空块之类不可转类型的块 */
export function isTypeLocked(block: EditorBlock | string): boolean {
  const t = typeof block === 'string' ? blockTypeOf(block) : block.type
  return t === 'code' || t === 'hr' || t === 'html' || t === 'math' || t === 'table'
}

// ---------------------------------------------------------------------------
// 块文本提取 / 标记剥离
// ---------------------------------------------------------------------------

/** 去掉 0..maxIndent 列的缩进（更多缩进原样保留，交给 Markdown 语义） */
function stripIndentTo(line: string, maxIndent: number): string {
  const m = /^(\s*)(.*)$/.exec(line)
  if (!m) return line
  const keep = m[1].length <= maxIndent ? '' : m[1].slice(maxIndent)
  return keep + m[2]
}

/** 去掉列表标记（连同其后的待办复选框），保留超出 maxIndent 的缩进 */
function stripListMarker(line: string, maxIndent: number): string {
  return line.replace(TASK_RE, (_all, indent: string) => {
    const keep = indent.length <= maxIndent ? '' : indent.slice(maxIndent)
    return keep
  }).replace(LIST_RE, (_all, indent: string) => {
    const keep = indent.length <= maxIndent ? '' : indent.slice(maxIndent)
    return keep
  })
}

/** 去掉块引用标记（`> ` / `>`），保留更多缩进 */
function stripQuoteMarker(line: string): string {
  return line.replace(/^ {0,3}> ?/, '')
}

/**
 * 块的纯文本（用于「转为普通段落 / 转换块类型」）。
 * ★ 只剥离**与首行同级**的结构标记（更深的嵌套子级——如列表里的子列表——原样保留），
 *   否则转换会把嵌套列表压平成多行文本。
 */
export function blockToText(md: string, type: EditorBlockType = blockTypeOf(md)): string {
  let lines = (md ?? '').split('\n')
  // 围栏代码块 / 公式块：去掉首尾围栏，正文原样保留
  if (type === 'code') {
    const fence = fenceOf(lines[0])
    if (fence) lines = lines.slice(1)
    if (lines.length && fence && fenceOf(lines[lines.length - 1])) lines = lines.slice(0, -1)
    return lines.join('\n')
  }
  if (type === 'math') {
    if (/^\s*\$\$/.test(lines[0])) lines = lines.slice(1)
    if (lines.length && /^\s*\$\$\s*$/.test(lines[lines.length - 1])) lines = lines.slice(0, -1)
    return lines.join('\n')
  }
  // 块引用 / 提示块：`> ` 行先整体去引用标记；提示块首行的 `[!TYPE] 标题` 也一并去掉
  if (type === 'quote' || type === 'callout') {
    const unquoted = lines.map(stripQuoteMarker)
    if (type === 'callout' && CALLOUT_RE.test(md)) unquoted.shift()
    return trimBlank(unquoted).join('\n')
  }
  // 列表 / 标题 / 段落：按「首行的缩进」作为剥离基准（同级剥、嵌套子级原样保留）
  const base = lines[0].length - lines[0].trimStart().length
  const out = lines.map((l) => {
    const indent = l.length - l.trimStart().length
    let s = stripIndentTo(l, base)
    if (HEADING_RE.test(s)) s = s.replace(/^ {0,3}#{1,6}\s*/, '')
    // 更深的嵌套子级（缩进 > 基准）不剥标记：`- x` / `  - y` → `x` / `  - y`
    if (indent <= base && LIST_RE.test(s)) s = stripListMarker(s, 0)
    return s
  })
  return trimBlank(out).join('\n')
}

/** 去掉数组首尾的空行 / 全空白行 */
function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a].trim()) a++
  while (b > a && !lines[b - 1].trim()) b--
  return lines.slice(a, b)
}

/** callout 首行的类型（`> [!TIP]` → `TIP`），非 callout 返回 null */
export function calloutKindOf(md: string): CalloutKind | null {
  const m = CALLOUT_RE.exec(md ?? '')
  if (!m) return null
  return m[1].toUpperCase() as CalloutKind
}

/** 块首行（去缩进；空块返回 ''） */
function firstLine(md: string): string {
  return (md ?? '').split('\n').find((l) => l.trim()) ?? ''
}

// ---------------------------------------------------------------------------
// 块类型转换（block transform）
// ---------------------------------------------------------------------------

/** 块类型转换的完整选项（含表格块 → 表格块的一致性由调用方保证） */
export type BlockConvertTarget =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'quote'
  | 'list'
  | 'ordered-list'
  | 'task'
  | 'code'
  | 'callout'

const CALLOUT_TITLE: Record<CalloutKind, string> = {
  NOTE: '说明',
  TIP: '提示',
  IMPORTANT: '重要',
  WARNING: '注意',
  CAUTION: '警告',
}

/**
 * 把一块 Markdown 转成另一种块类型（纯文本级重写，不解析行内结构 → 行内 Markdown 原样保留）。
 * 返回 null 表示「该目标类型对这块不适用」（调用方应禁用该项）。
 */
export function convertBlock(md: string, target: BlockConvertTarget): string | null {
  const type = blockTypeOf(md)
  if (isTypeLocked(md)) return null
  const text = blockToText(md, type)
  const isEmpty = !text.trim()
  switch (target) {
    case 'paragraph':
      return isEmpty ? '' : text
    case 'heading1':
      return `# ${text}`.trimEnd()
    case 'heading2':
      return `## ${text}`.trimEnd()
    case 'heading3':
      return `### ${text}`.trimEnd()
    case 'quote':
      return (isEmpty ? [''] : text.split('\n')).map((l) => `> ${l}`.trimEnd()).join('\n')
    case 'list':
      // 已是列表行的（嵌套子级）保留原样，避免出现 `- - 子项` 这种双重标记
      return (isEmpty ? [''] : text.split('\n')).map((l) => (LIST_RE.test(l) ? l : `- ${l}`)).join('\n')
    case 'ordered-list':
      return (isEmpty ? [''] : text.split('\n'))
        .map((l) => (LIST_RE.test(l) ? l : `1. ${l}`.trimEnd()))
        .join('\n')
    case 'task':
      return (isEmpty ? [''] : text.split('\n'))
        .map((l) => {
          if (LIST_RE.test(l)) return l
          return `- [ ] ${l}`.trimEnd()
        })
        .join('\n')
    case 'code': {
      const fence = '```'
      return `${fence}\n${type === 'code' ? md : text}\n${fence}`
    }
    case 'callout': {
      const kind: CalloutKind = calloutKindOf(md) ?? 'NOTE'
      const body = (isEmpty ? [''] : text.split('\n')).map((l) => (l ? `> ${l}` : '>'))
      return [`> [!${kind}] ${CALLOUT_TITLE[kind]}`, ...body].join('\n')
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// 表格（可视化增删行列）
// ---------------------------------------------------------------------------

export interface TableData {
  header: string[]
  rows: string[][]
  /** 各列对齐方式 */
  align: ('left' | 'center' | 'right' | 'none')[]
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function alignOf(sepCell: string): 'left' | 'center' | 'right' | 'none' {
  const s = sepCell.trim()
  const l = s.startsWith(':')
  const r = s.endsWith(':')
  if (l && r) return 'center'
  if (r) return 'right'
  if (l) return 'left'
  return 'none'
}

/** 解析 Markdown 表格块（首行表头 + 第二行分隔行；无表格结构返回 null） */
export function parseTable(md: string): TableData | null {
  const lines = (md ?? '').split('\n').filter((l) => l.trim())
  if (lines.length < 2) return null
  if (!lines[1].includes('|')) return null
  const header = splitRow(lines[0])
  const align = splitRow(lines[1]).map(alignOf)
  const rows = lines.slice(2).map(splitRow)
  const cols = header.length
  // 列数对齐（Markdown 表格列数以表头为准）
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '')
  return { header: pad(header), rows: rows.map(pad), align: Array.from({ length: cols }, (_, i) => align[i] ?? 'none') }
}

/**
 * 渲染一个单元格：两侧各一个空格，内容按列内最大宽度左对齐（`contentWidth(w) = w + 2`）。
 * 分隔行也用同一内容宽度，保证「表头 / 分隔行 / 数据行」三者的列宽完全一致 → 渲染幂等。
 */
function renderCell(s: string, align: TableData['align'][number], width: number): string {
  const cell = (s ?? '').replace(/\|/g, '\\|')
  const pad = Math.max(0, width - cell.length)
  if (align === 'center') {
    const l = Math.floor(pad / 2)
    return ` ${' '.repeat(l)}${cell}${' '.repeat(pad - l)} `
  }
  if (align === 'right') return ` ${' '.repeat(pad)}${cell} `
  return ` ${cell}${' '.repeat(pad)} `
}

/** 渲染 Markdown 表格（列宽统一，生成稳定、可读、幂等的 Markdown） */
export function renderTable(t: TableData): string {
  const cols = t.header.length
  const widths = Array.from({ length: cols }, (_, c) => {
    const cells = [t.header[c] ?? '', ...t.rows.map((r) => r[c] ?? '')]
    return Math.max(3, ...cells.map((x) => x.replace(/\|/g, '\\|').length))
  })
  // 分隔行内容宽度与数据行一致（数据行两侧各 1 空格 → 宽度 = widths[c] + 2；对齐标记占 1 个 '-'）
  const sep = Array.from({ length: cols }, (_, c) => {
    const w = widths[c] + 2
    switch (t.align[c]) {
      case 'center':
        return `:${'-'.repeat(Math.max(1, w - 2))}:`
      case 'right':
        return `${'-'.repeat(Math.max(1, w - 1))}:`
      case 'left':
        return `:${'-'.repeat(Math.max(1, w - 1))}`
      default:
        return '-'.repeat(w)
    }
  })
  const line = (cells: string[]) => `|${cells.map((c, i) => renderCell(c, t.align[i], widths[i])).join('|')}|`
  return [line(t.header), line(sep), ...t.rows.map(line)].join('\n')
}

/** 表格增删行 / 列（越界操作为 no-op，返回原表） */
export function tableInsertRow(t: TableData, at: number): TableData {
  const rows = t.rows.slice()
  rows.splice(Math.max(0, Math.min(rows.length, at)), 0, t.header.map(() => ''))
  return { ...t, rows }
}

export function tableRemoveRow(t: TableData, at: number): TableData {
  if (at < 0 || at >= t.rows.length) return t
  const rows = t.rows.slice()
  rows.splice(at, 1)
  return { ...t, rows }
}

export function tableInsertCol(t: TableData, at: number): TableData {
  const idx = Math.max(0, Math.min(t.header.length, at))
  const ins = <T,>(arr: T[], v: T) => [...arr.slice(0, idx), v, ...arr.slice(idx)]
  return {
    header: ins(t.header, `列${t.header.length + 1}`),
    rows: t.rows.map((r) => ins(r, '')),
    align: ins(t.align, 'none' as const),
  }
}

export function tableRemoveCol(t: TableData, at: number): TableData {
  if (t.header.length <= 1 || at < 0 || at >= t.header.length) return t
  const del = <T,>(arr: T[]) => [...arr.slice(0, at), ...arr.slice(at + 1)]
  return { header: del(t.header), rows: t.rows.map(del), align: del(t.align) }
}

// ---------------------------------------------------------------------------
// 块级操作（上移 / 下移 / 复制 / 删除）
// ---------------------------------------------------------------------------

/** 在块序列里上移一块（首块 no-op） */
export function moveBlockUp(blocks: readonly string[], index: number): string[] | null {
  const arr = blocks.slice()
  if (index <= 0 || index >= arr.length) return null
  ;[arr[index - 1], arr[index]] = [arr[index], arr[index - 1]]
  return arr
}

/** 在块序列里下移一块（末块 no-op） */
export function moveBlockDown(blocks: readonly string[], index: number): string[] | null {
  const arr = blocks.slice()
  if (index < 0 || index >= arr.length - 1) return null
  ;[arr[index + 1], arr[index]] = [arr[index], arr[index + 1]]
  return arr
}

/** 复制一块（副本紧跟原块之后；首尾块均可） */
export function duplicateBlock(blocks: readonly string[], index: number): string[] | null {
  if (index < 0 || index >= blocks.length) return null
  const arr = blocks.slice()
  arr.splice(index + 1, 0, arr[index])
  return arr
}

/** 删除一块（仅剩一块时保留空块，避免文档结构为「无块」） */
export function removeBlock(blocks: readonly string[], index: number): string[] | null {
  if (index < 0 || index >= blocks.length) return null
  const arr = blocks.slice()
  arr.splice(index, 1)
  return arr.length ? arr : ['']
}

/** 替换一块（转类型用） */
export function replaceBlock(blocks: readonly string[], index: number, md: string): string[] | null {
  if (index < 0 || index >= blocks.length) return null
  const arr = blocks.slice()
  arr[index] = md
  return arr
}

/**
 * 文档级便捷封装：对整篇 Markdown 执行一次块操作。
 * @returns 新 Markdown；操作不适用（越界 / 类型锁定）返回 null
 */
export function applyBlockOp(
  markdown: string,
  op: { kind: 'up' | 'down' | 'duplicate' | 'delete' | 'convert'; index: number; target?: BlockConvertTarget },
): string | null {
  const blocks = splitBlocks(markdown).map((b) => b.md)
  let next: string[] | null = null
  switch (op.kind) {
    case 'up':
      next = moveBlockUp(blocks, op.index)
      break
    case 'down':
      next = moveBlockDown(blocks, op.index)
      break
    case 'duplicate':
      next = duplicateBlock(blocks, op.index)
      break
    case 'delete':
      next = removeBlock(blocks, op.index)
      break
    case 'convert': {
      const cur = blocks[op.index]
      if (cur === undefined || !op.target) return null
      const converted = convertBlock(cur, op.target)
      if (converted === null) return null
      next = replaceBlock(blocks, op.index, converted)
      break
    }
  }
  if (!next) return null
  return joinBlocks(next)
}

/** 斜杠命令插入用：块内是否为空（只有空白 / 零宽空格） */
export function isBlankBlockText(text: string): boolean {
  return (text ?? '').replace(/[\u200b\s]/g, '') === ''
}

/** 块在文档中的展示名（块菜单标题） */
export function blockLabel(md: string): string {
  const t = blockTypeOf(md)
  const text = firstLine(md).replace(/^[\s>#*+\-]+/, '').trim()
  const names: Record<EditorBlockType, string> = {
    paragraph: '正文',
    heading: '标题',
    list: '无序列表',
    'ordered-list': '有序列表',
    task: '待办',
    quote: '引用',
    callout: '提示块',
    code: '代码块',
    math: '公式块',
    table: '表格',
    hr: '分割线',
    html: 'HTML',
  }
  const name = names[t] ?? '正文'
  if (t === 'callout') {
    const k = calloutKindOf(md)
    return k ? `${name} · ${CALLOUT_TITLE[k]}` : name
  }
  return text ? `${name} · ${text.slice(0, 24)}` : name
}
