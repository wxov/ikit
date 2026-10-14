// Vditor 懒加载单例（完善⑦）
//
// - 只有进入「编辑态」才调用 loadVditor()：阅读态/游客永不下载 Vditor（首屏体积零变化）。
// - JS 与 CSS 都走动态 import → Vite 产出独立 chunk，随编辑态按需注入。
// - 运行时资源（Lute 引擎 / 图标 / 语言包 / KaTeX / highlight.js / 内容主题 / emoji）由
//   `options.cdn = '/vditor'` 指向本地 `public/vditor/dist/**`（scripts/sync-vditor-assets.mjs 同步），
//   默认的 unpkg CDN 在内网 / Docker / Tauri / Capacitor 下不可用。
// - 加载失败 → 抛错（调用方降级为纯 Markdown textarea，见 VditorEditor.vue）；
//   失败后会把单例 Promise 重置，允许「点击重试」。
import type Vditor from 'vditor'

export type VditorCtor = typeof Vditor
export type EditorTheme = 'light' | 'dark'

/** 本地资源根（`public/vditor` → 站点根 `/vditor`） */
export const VDITOR_CDN = '/vditor'

/** 门户主题 → Vditor 三段主题（编辑器 UI / 内容区 / 代码高亮） */
export function vditorThemeOf(theme: EditorTheme): {
  editor: 'classic' | 'dark'
  content: 'light' | 'dark'
  code: string
} {
  return theme === 'dark'
    ? { editor: 'dark', content: 'dark', code: 'github-dark' }
    : { editor: 'classic', content: 'light', code: 'github' }
}

let pending: Promise<VditorCtor> | null = null

/** 加载 Vditor（整个会话只加载一次；失败后可重试） */
export function loadVditor(): Promise<VditorCtor> {
  if (!pending) {
    pending = (async () => {
      await import('vditor/dist/index.css')
      const mod = (await import('vditor')) as unknown as { default?: VditorCtor } & VditorCtor
      const ctor = (mod?.default ?? mod) as VditorCtor
      if (typeof ctor !== 'function') throw new Error('Vditor 构造函数不可用')
      return ctor
    })()
    // 失败不缓存：清空单例，允许用户「点击重试」
    pending.catch(() => {
      pending = null
    })
  }
  return pending
}
