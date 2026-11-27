/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>
  export default component
}

declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it'
  /** 第二个参数会**直接透传**给 `katex.renderToString`（如 trust / throwOnError / strict） */
  const plugin: (md: MarkdownIt, options?: Record<string, unknown>) => void
  export default plugin
}
