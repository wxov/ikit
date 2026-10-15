// 文章互链（内部文档链接）的**纯函数**解析层：链接分类 / 目标解析 / 路径与转义工具。
//
// 与 Vue / DOM / 网络完全解耦 —— 便于无头单测（`classifyLink` / `resolveDocLink` / 锚点匹配）。
//
// 支持的两种语法（阅读端 `lib/markdown.ts` 渲染，编辑端 `VditorEditor.vue` 插入）：
//   1. `[[文章标题]]`            —— wiki 式，**按标题**解析（忽略大小写与空白差异；同名多篇返回 matches）
//   2. `[文字](ikit://doc/<id>)` —— **按 id** 解析
// 解析目标必须存在于「当前用户可见的文章索引」（`GET /api/knowledge/entries?limit=1000` + `authHeaders()`）；
// 不在索引内（不存在 / 不可见 / 草稿对非站主不可见）→ `kind:'missing'` → 不可跳转。
import type { KnowledgeEntry } from './api'

/** 内部链接渲染到 HTML 上的标记属性（供阅读端事件委托识别） */
export const DOC_LINK_ATTR = 'data-doc-link'
/** id 式内部链接的安全 href 前缀（**不保留 `ikit://` 自定义协议**，避免浏览器报「未知协议」） */
export const DOC_LINK_HREF_PREFIX = '#ikit-doc-'
/** wiki（标题式）内部链接的安全 href（无 id，解析靠 `data-doc-title`） */
export const DOC_LINK_TITLE_HREF = '#ikit-doc'
/** 自定义协议前缀（编辑端插入 / 手工书写的原始形态） */
export const DOC_LINK_PROTOCOL = 'ikit://doc/'

/** 解析用索引项：`KnowledgeEntry` 的结构子集（列表接口返回的完整条目天然满足） */
export interface DocIndexItem {
  id: string
  title: string
  category?: string
  parentId?: string
  status?: KnowledgeEntry['status']
}

export type DocLinkKind = 'doc' | 'anchor' | 'external' | 'relative'

/** `classifyLink()` 的产物：链接「是什么」，与「能不能跳」无关 */
export interface ClassifiedLink {
  kind: DocLinkKind
  /** kind='doc' 且按 id 定位时的文档 id */
  id?: string
  /** kind='doc' 且按标题定位时的标题原文 */
  title?: string
  /** kind='anchor' 时的锚点（已去掉 `#` 前缀、已 decodeURIComponent） */
  anchor?: string
  /** 原始 href（未改写） */
  href: string
}

/** 解析失败原因（决定提示文案与可测性） */
export type DocResolveMiss = 'id-not-found' | 'title-not-found' | 'draft-restricted' | 'no-target'

export type DocResolution =
  | { kind: 'doc'; id: string; matches: DocIndexItem[] }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'external' }
  | { kind: 'relative' }
  | { kind: 'missing'; reason: DocResolveMiss }

/** 失效链接的统一 tooltip 文案（与需求原文一致） */
export const DOC_LINK_MISSING_TIP = '文档不存在或无权访问'

/**
 * 标题归一化：去首尾空白 + 内部连续空白折叠为单空格 + 小写。
 * 用于 `[[标题]]` 解析的「忽略大小写 / 空白差异」匹配。
 */
export function normalizeTitle(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** 锚点文本归一化：**去掉所有空白** + 小写（页内锚点按标题文本匹配时使用） */
export function normalizeAnchorKey(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 链接分类（**纯函数**，无 DOM）：判定一个 `a[href]` + 其 dataset 属于哪一类。
 *
 * 优先级：`data-doc-id` > `data-doc-title` > href 形态。这样渲染端即使把自定义协议改写成安全 href
 * （`#ikit-doc-<id>` / `#ikit-doc`），仍然能被稳定识别回来。
 */
export function classifyLink(
  href: string | null | undefined,
  dataset?: { docId?: string | null; docTitle?: string | null } | null,
): ClassifiedLink | null {
  const raw = String(href ?? '').trim()
  const docId = String(dataset?.docId ?? '').trim()
  if (docId) return { kind: 'doc', id: docId, href: raw }
  const docTitle = String(dataset?.docTitle ?? '').trim()
  if (docTitle) return { kind: 'doc', title: docTitle, href: raw }
  if (!raw) return null

  // 1) 自定义协议（编辑端插入 / 手工书写的原文）
  if (raw.toLowerCase().startsWith(DOC_LINK_PROTOCOL)) {
    return { kind: 'doc', id: safeDecode(raw.slice(DOC_LINK_PROTOCOL.length)).trim(), href: raw }
  }
  // 2) 渲染端改写后的安全 href
  if (raw.startsWith(DOC_LINK_HREF_PREFIX)) {
    return { kind: 'doc', id: safeDecode(raw.slice(DOC_LINK_HREF_PREFIX.length)).trim(), href: raw }
  }
  if (raw === DOC_LINK_TITLE_HREF) return { kind: 'doc', href: raw }
  // 3) 页内锚点
  if (raw.startsWith('#')) return { kind: 'anchor', anchor: safeDecode(raw.slice(1)), href: raw }
  // 4) 外链（http/https/协议相对/mailto 等绝对 URL）
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return { kind: 'external', href: raw }
  }
  // 5) 普通相对链接
  return { kind: 'relative', href: raw }
}

/** 该条索引项对当前查看者是否可见（草稿仅站主；缺省 status 视为已发布） */
export function isDocVisible(item: DocIndexItem, opts?: { isAdmin?: boolean } | null): boolean {
  if (opts?.isAdmin) return true
  return (item.status ?? 'published') === 'published'
}

/**
 * 解析内部文档链接到具体目标（**纯函数**）。
 *
 * - 非 doc 类链接原样返回分类（锚点 / 外链 / 相对链接），由调用方决定浏览器默认行为；
 * - `index` 必须是**当前用户可见**的条目列表；为 `null/undefined`（尚未加载）时按空索引处理
 *   → doc 类链接会得到 missing（调用方应先确保索引已加载，见 `ArticleDetail.vue`）；
 * - id 命中但不可见（草稿 + 非 admin）→ `missing/draft-restricted`；
 * - 标题命中多篇 → `kind:'doc'` + `matches.length > 1`（调用方弹「同名选择」）。
 */
export function resolveDocLink(
  link: ClassifiedLink | null | undefined,
  index: readonly DocIndexItem[] | null | undefined,
  opts?: { isAdmin?: boolean } | null,
): DocResolution {
  if (!link) return { kind: 'missing', reason: 'no-target' }
  if (link.kind === 'anchor') return { kind: 'anchor', anchor: link.anchor ?? '' }
  if (link.kind === 'external') return { kind: 'external' }
  if (link.kind === 'relative') return { kind: 'relative' }

  const list = index ?? []

  if (link.id) {
    const hit = list.find((it) => it.id === link.id)
    if (!hit) return { kind: 'missing', reason: 'id-not-found' }
    if (!isDocVisible(hit, opts)) return { kind: 'missing', reason: 'draft-restricted' }
    return { kind: 'doc', id: hit.id, matches: [hit] }
  }

  if (link.title) {
    const key = normalizeTitle(link.title)
    if (!key) return { kind: 'missing', reason: 'title-not-found' }
    const sameTitle = list.filter((it) => normalizeTitle(it.title) === key)
    const matches = sameTitle.filter((it) => isDocVisible(it, opts))
    if (!matches.length) {
      return { kind: 'missing', reason: sameTitle.length ? 'draft-restricted' : 'title-not-found' }
    }
    return { kind: 'doc', id: matches[0].id, matches }
  }

  return { kind: 'missing', reason: 'no-target' }
}

/**
 * 「分类 / 父路径」定位文案（同名多篇选择列表 + 编辑器选择器共用）。
 * 例：`分类：技术/前端 · 路径：技术笔记 / Vue`
 */
export function docLocationOf(item: DocIndexItem, index: readonly DocIndexItem[]): string {
  const parts: string[] = []
  if (item.category) parts.push(`分类：${item.category}`)
  const parent = item.parentId ? docPathOf(item.parentId, index) : ''
  if (parent) parts.push(`路径：${parent}`)
  return parts.join(' · ') || '未分类'
}

/** 由 `parentId` 关系回溯完整路径（含根到指定文档自身的标题链）；有环时自动截断 */
export function docPathOf(id: string, index: readonly DocIndexItem[]): string {
  const byId = new Map(index.map((it) => [it.id, it]))
  const parts: string[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    parts.unshift(cur.title)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return parts.join(' / ')
}

/** 页内锚点匹配：优先按 id（`heading-N`）→ 由调用方处理；此处按**标题文本**匹配，忽略大小写/空白 */
export function matchHeadingByText(anchor: string | null | undefined, headings: readonly string[]): number {
  const key = normalizeAnchorKey(anchor)
  if (!key) return -1
  return headings.findIndex((h) => normalizeAnchorKey(h) === key)
}

/** HTML 转义（hint 候选 / 属性值；阅读端渲染由 markdown-it 负责） */
export function escapeHtmlText(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const MD_LINK_TEXT_SPECIAL = /([\\[\]])/g

/** 转义 Markdown 链接**文字**部分的特殊字符（`\` `[` `]`），保证 `[文字](…)` 解析正确 */
export function escapeMarkdownLinkText(title: string): string {
  return String(title ?? '').replace(MD_LINK_TEXT_SPECIAL, '\\$1')
}

/** `[[标题]]` 形式的互链：标题含 `[` `]` 或换行时语法会歧义 → 返回 null（调用方改用 id 式） */
export function wikiLinkMarkdown(title: string): string | null {
  const t = String(title ?? '').trim()
  if (!t || /[[\]\r\n]/.test(t)) return null
  return `[[${t}]]`
}

/** `[标题](ikit://doc/<id>)` 形式的互链（标题做 Markdown 转义） */
export function docLinkMarkdown(title: string, id: string): string {
  return `[${escapeMarkdownLinkText(title)}](${DOC_LINK_PROTOCOL}${encodeURIComponent(String(id ?? '').trim())})`
}

/**
 * 编辑端插入文本：优先 wiki 式（`[[标题]]`），标题含特殊字符时退回 id 式
 * （两者阅读端等价，都能跳转）。
 */
export function insertableDocLink(title: string, id: string): string {
  return wikiLinkMarkdown(title) ?? docLinkMarkdown(title, id)
}

/**
 * 候选过滤（编辑器工具栏选择器 / `[[` 补全共用）：按标题/分类路径模糊匹配（忽略大小写与空白），
 * 命中数受 `limit` 限制。
 */
export function filterDocCandidates(
  query: string,
  index: readonly DocIndexItem[] | null | undefined,
  limit = 20,
): DocIndexItem[] {
  const list = index ?? []
  const q = normalizeAnchorKey(query)
  const hit = q
    ? list.filter(
        (it) =>
          normalizeAnchorKey(it.title).includes(q) ||
          normalizeAnchorKey(it.category ?? '').includes(q),
      )
    : list
  return hit.slice(0, Math.max(0, limit))
}
