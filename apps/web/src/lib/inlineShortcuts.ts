// 飞书式编辑 · 行内快捷转换（`# ` → 标题、`- ` → 列表、`> ` → 引用、Enter 续行）
//
// 为什么需要自建（已核对 vditor@4.0.0 源码 dist/index.js:15511-15581）：
// Vditor 的 wysiwyg 输入处理里只有一个「输入法风格」快捷：`isHeadingMD`（`# `）会走到
// `input_input` → `lute.SpinVditorDOM` 完成转换；而 `- ` / `> ` / `1. ` 会被
// `endSpace` 判定（该行目前只有 `<标记>+空格`）**提前 return**，不触发转换
// ——即 Vditor 本身**不做**列表/引用/待办的 `- ` 快捷。本模块用同一套公开渲染管线补上：
// 在 `beforeinput` 阶段删掉「标记 + 光标前文本」，再 `insertMD` 插入真正的块标记
// （`insertMD` = `lute.Md2VditorDOM` + `execAfterRender`），光标落在块内可直接继续输入。
//
// 本文件是**纯逻辑**（无 DOM / 无 Vue），便于 node 直跑单测。

/** 行内快捷：`marker` 前缀 → 目标块标记（插入用 Markdown） */
export interface InlineShortcut {
  id: string
  /** 触发前缀（含空格） */
  prefix: string
  /** 插入的 Markdown（以标记 + 空格结尾，光标落在其后继续输入） */
  replacement: string
}

const SHORTCUTS: InlineShortcut[] = [
  { id: 'list-dash', prefix: '- ', replacement: '- ' },
  { id: 'list-star', prefix: '* ', replacement: '- ' },
  { id: 'list-plus', prefix: '+ ', replacement: '- ' },
  { id: 'ordered', prefix: '1. ', replacement: '1. ' },
  { id: 'quote', prefix: '> ', replacement: '> ' },
]

const TASK_PREFIXES = ['- [ ] ', '- [] ', '- [x] ', '- [X] ']

/**
 * 判断「当前块文本 + 刚输入的空格」是否命中行内快捷。
 * @param blockText 块的**纯文本**（不含光标后内容时请自行裁剪）
 * @returns 命中的快捷（未命中返回 null）
 */
export function matchInlineShortcut(blockText: string): InlineShortcut | null {
  const text = (blockText ?? '').replace(/\u200b/g, '')
  for (const s of SHORTCUTS) {
    if (text === s.prefix) return s
  }
  for (const t of TASK_PREFIXES) {
    if (text === t) return { id: 'task', prefix: t, replacement: '- [ ] ' }
  }
  return null
}

/**
 * Enter 续行：块首行是列表/待办/引用时，返回新块应插入的标记；否则 null（交给 Vditor 处理）。
 * - 待办续行总是新的未勾选（`- [ ] `），引用续行仍是 `> `；
 * - 有序列表按当前序号 +1。
 */
export function matchContinuation(blockText: string): string | null {
  const first = (blockText ?? '').replace(/\u200b/g, '').split('\n')[0]?.trimEnd() ?? ''
  if (!first) return null
  if (/^>/.test(first)) return '> '
  if (/^-\s\[[ xX]\]\s/.test(first)) return '- [ ] '
  if (/^[-*+]\s/.test(first)) return '- '
  const m = /^(\d{1,9})[.)]\s/.exec(first)
  if (m) return `${Number(m[1]) + 1}. `
  return null
}

/** 块首行是否为空待办（`- [ ] ` 后无内容）→ Enter 应结束待办（不续行） */
export function isEmptyTaskLine(blockText: string): boolean {
  const first = (blockText ?? '').replace(/\u200b/g, '').split('\n')[0]?.trimEnd() ?? ''
  return /^[-*+]\s\[[ xX]\]$/.test(first)
}

/** 块首行是否为空列表项（`- ` 后无内容）→ Enter 应结束列表（不续行） */
export function isEmptyListItem(blockText: string): boolean {
  const first = (blockText ?? '').replace(/\u200b/g, '').split('\n')[0]?.trimEnd() ?? ''
  return /^([-*+]|\d{1,9}[.)])\s?$/.test(first)
}
