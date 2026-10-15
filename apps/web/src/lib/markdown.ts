import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import markdownItKatex from 'markdown-it-katex'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import {
  DOC_LINK_ATTR,
  DOC_LINK_HREF_PREFIX,
  DOC_LINK_TITLE_HREF,
  classifyLink,
  type ClassifiedLink,
} from './docLinks'

// 按需注册常见语言（减小打包体积）
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('php', php)
hljs.registerLanguage('ruby', ruby)

// 常用别名
hljs.registerAliases(['js', 'node', 'jsx'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['cs'], { languageName: 'csharp' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const { value } = hljs.highlight(str, { language: lang, ignoreIllegals: true })
        return `<pre class="hljs"><code>${value}</code></pre>\n`
      } catch {
        /* fall through to default escaping */
      }
    }
    // 返回空字符串，让 markdown-it 用默认渲染（转义文本）
    return ''
  },
})

// 数学公式（KaTeX）：支持 $行内$ 和 $$块级$$
md.use(markdownItKatex)

// ---------------------------------------------------------------------------
// 文章互链（详见 `lib/docLinks.ts` 的语法说明）
// ---------------------------------------------------------------------------

/** 正文里出现的一处链接（供阅读端复用解析结果 / 单测断言） */
export interface MarkdownDocLink {
  link: ClassifiedLink
  /** 链接显示文本 */
  text: string
}

export interface MarkdownRenderResult {
  html: string
  /** 正文中所有链接（含锚点 / 外链 / 相对链接），按出现顺序 */
  links: MarkdownDocLink[]
  /** 其中「内部文档链接」（`[[标题]]` 与 `ikit://doc/<id>`） */
  docLinks: MarkdownDocLink[]
}

interface MarkdownEnv {
  links: MarkdownDocLink[]
  /** markdown-it 的 `Env` 要求字符串 + symbol 索引签名 */
  [key: string]: unknown
  [key: symbol]: unknown
}

/** 与 `md.utils.escapeHtml` 同一实现（属性值与文本安全） */
function esc(s: string): string {
  return md.utils.escapeHtml(s)
}

/**
 * 内部文档链接的安全 href：
 * - id 式 → `#ikit-doc-<id>`（页面上不存在该 id，浏览器不会滚动；`classifyLink` 能反向解析）；
 * - 标题式 → `#ikit-doc`。
 * **刻意不保留 `ikit://` 自定义协议**（浏览器把未知协议视为外部协议处理 → 控制台报错 / 弹协议对话框）。
 */
function safeDocHref(id?: string): string {
  return id ? `${DOC_LINK_HREF_PREFIX}${encodeURIComponent(id)}` : DOC_LINK_TITLE_HREF
}

/** 渲染一个内部文档链接（id 式或标题式） */
function renderDocLink(id: string | undefined, title: string, text: string): string {
  const attrs = [
    `class="ikit-doc-link"`,
    `href="${esc(safeDocHref(id))}"`,
    `${DOC_LINK_ATTR}="1"`,
    id ? `data-doc-id="${esc(id)}"` : `data-doc-title="${esc(title)}"`,
  ]
  return `<a ${attrs.join(' ')}>${esc(text)}</a>`
}

/**
 * `[[文章标题]]` 的 markdown-it inline 规则。
 *
 * 用**真正的 inline 规则**（而非粗糙的正则预替换）实现，天然不会命中：
 * - 围栏 / 缩进代码块（块级，不进入 inline 规则）；
 * - 行内代码 `` `[[x]]` ``（`backticks` 规则先消费整段）；
 * - 转义 `\[\[x\]\]`（`escape` 规则先消费 `\[`，且本规则注册在 `link` 之前、`escape` 之后）。
 */
function wikiLinkRule(state: any, silent: boolean): boolean {
  const start = state.pos
  const src: string = state.src
  if (src.charCodeAt(start) !== 0x5b /* [ */ || src.charCodeAt(start + 1) !== 0x5b) return false

  const end = src.indexOf(']]', start + 2)
  if (end < 0) return false

  const raw = src.slice(start + 2, end)
  const title = raw.trim()
  // 空标题 / 跨行 / 嵌套括号 → 不解析（按普通文本渲染）
  if (!title || /[[\]\r\n]/.test(title)) return false

  if (!silent) {
    const token = state.push('wiki_link', '', 0)
    token.content = title
    token.markup = '[['
  }
  state.pos = end + 2
  return true
}

md.inline.ruler.before('link', 'wiki_link', wikiLinkRule)

md.renderer.rules.wiki_link = (tokens, idx, _options, env) => {
  const title = tokens[idx].content
  const e = env as MarkdownEnv | undefined
  e?.links?.push({ link: { kind: 'doc', title, href: safeDocHref(undefined) }, text: title })
  return renderDocLink(undefined, title, title)
}

/**
 * `link_open` 统一改写：
 * - `ikit://doc/<id>` → 内部链接（`data-doc-id` + 安全 href，去掉自定义协议）；
 * - 外部 `http(s)` → `target="_blank" rel="noopener noreferrer"`（新标签打开，不离开当前页）；
 * - `#锚点` / 相对链接 → 原样。
 */
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  // `attrGet` 的静态类型为 `string | number | null`（运行时只会是 string/null），统一成字符串
  const href = String(token.attrGet('href') ?? '')
  const link = classifyLink(href)
  const e = env as MarkdownEnv | undefined

  if (link?.kind === 'doc') {
    const text = collectInlineText(tokens, idx)
    e?.links?.push({ link, text })
    token.attrSet('class', 'ikit-doc-link')
    token.attrSet(DOC_LINK_ATTR, '1')
    if (link.id) {
      token.attrSet('data-doc-id', link.id)
      token.attrSet('href', safeDocHref(link.id))
    } else {
      token.attrSet('href', safeDocHref(undefined))
    }
    return self.renderToken(tokens, idx, options)
  }

  if (link?.kind === 'external') {
    if (/^(https?:)?\/\//i.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    e?.links?.push({ link, text: collectInlineText(tokens, idx) })
    return self.renderToken(tokens, idx, options)
  }

  if (link) e?.links?.push({ link, text: collectInlineText(tokens, idx) })
  return self.renderToken(tokens, idx, options)
}

/** 取 `link_open`(idx) 之后的链接显示文本（markdown-it 把链接文字放成紧随的 `text` token） */
function collectInlineText(tokens: any[], idx: number): string {
  const next = tokens[idx + 1]
  if (!next) return ''
  if (next.type === 'text' || next.type === 'code_inline' || next.type === 'image') {
    return String(next.content ?? '')
  }
  return ''
}

// 渲染时为标题生成锚点 id（供页面内跳转/样式挂钩）
let headingSeq = 0

function extractText(inlineToken: any): string {
  return (
    inlineToken?.children
      ?.filter((t: any) => t.type === 'text' || t.type === 'code_inline')
      .map((t: any) => t.content)
      .join('') ?? ''
  )
}

// 自定义标题渲染：为每个标题生成 id
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const level = Number(tokens[idx].tag.slice(1))
  const text = extractText(tokens[idx + 1])
  tokens[idx].attrSet('id', `heading-${headingSeq++}`)
  void level
  void text
  return self.renderToken(tokens, idx, options)
}

/**
 * 渲染 Markdown。
 * 返回值在原有 `{ html }` 之上新增 `links` / `docLinks`（内部文档链接索引）——
 * 阅读端据此把「解析不到」的链接标记为**失效链接**（虚线/弱化色 + tooltip），无需二次解析 DOM。
 */
export function renderMarkdown(content: string): MarkdownRenderResult {
  headingSeq = 0
  const env: MarkdownEnv = { links: [] }
  const html = md.render(content || '', env)
  return {
    html,
    links: env.links,
    docLinks: env.links.filter((l) => l.link.kind === 'doc'),
  }
}
