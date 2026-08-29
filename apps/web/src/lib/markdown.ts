import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/github-dark.css'

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

export interface TocItem {
  level: number
  text: string
  id: string
}

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

// 渲染时收集标题，用于生成目录（TOC）
let headings: TocItem[] = []

function extractText(inlineToken: any): string {
  return (
    inlineToken?.children
      ?.filter((t: any) => t.type === 'text' || t.type === 'code_inline')
      .map((t: any) => t.content)
      .join('') ?? ''
  )
}

// 自定义标题渲染：为每个标题生成 id，并记录到 TOC
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const level = Number(tokens[idx].tag.slice(1))
  const text = extractText(tokens[idx + 1])
  const id = `heading-${headings.length}`
  headings.push({ level, text, id })
  tokens[idx].attrSet('id', id)
  return self.renderToken(tokens, idx, options)
}

export function renderMarkdown(content: string): { html: string; toc: TocItem[] } {
  headings = []
  const html = md.render(content || '')
  return { html, toc: [...headings] }
}
