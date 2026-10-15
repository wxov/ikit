// 飞书式编辑 · 斜杠命令（`/` 菜单）数据源 —— 纯数据 + 纯函数，无 DOM / 无 Vue 依赖（可直跑单测）
//
// 设计与 Vditor 的分工：
// - 菜单本体由 `EditorSlashMenu.vue` 渲染（自建浮层），**不复用 Vditor 的 hint**：hint 的插入语义是
//   「把候选 value 插到光标处」，而斜杠命令需要「删掉已输入的 `/xxx`，再插入一个新块」，
//   两者行为不同；且 hint 会污染 `[[` 文档补全的候选来源。
// - 插入一律走 Vditor 公开 API `insertMD(markdown)`（内部 `lute.Md2VditorDOM` + `execAfterRender`，
//   见 dist/index.js:16056-16069），不直接拼 DOM，避免破坏 Lute 渲染约定。
// - 模板里的 `{{cursor}}` 标记光标落点：插入前从 Markdown 中剔除，插入后用 Range 定位。

export type SlashGroup = 'basic' | 'list' | 'block' | 'table' | 'media'

export interface SlashCommand {
  /** 唯一 id（也是测试断言用的稳定标识） */
  id: string
  /** 菜单标题 */
  title: string
  /** 搜索关键字（拼音首字母 / 英文 / 同义词） */
  keywords: string
  group: SlashGroup
  /** 单字符图标（避免额外图标资源加载） */
  icon: string
  /** 插入的 Markdown；`{{cursor}}` 为光标落点标记 */
  template: string
}

export const SLASH_GROUP_LABEL: Record<SlashGroup, string> = {
  basic: '基础',
  list: '列表',
  block: '块',
  table: '表格',
  media: '媒体',
}

/** 菜单命令表（顺序即展示顺序） */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'text', title: '正文', keywords: 'text zhengwen p', group: 'basic', icon: 'T', template: '{{cursor}}' },
  { id: 'h1', title: '一级标题', keywords: 'h1 heading biaoti title', group: 'basic', icon: 'H1', template: '# {{cursor}}' },
  { id: 'h2', title: '二级标题', keywords: 'h2 heading biaoti title', group: 'basic', icon: 'H2', template: '## {{cursor}}' },
  { id: 'h3', title: '三级标题', keywords: 'h3 heading biaoti title', group: 'basic', icon: 'H3', template: '### {{cursor}}' },
  { id: 'bullet', title: '无序列表', keywords: 'ul bullet list liebiao', group: 'list', icon: '•', template: '- {{cursor}}' },
  { id: 'ordered', title: '有序列表', keywords: 'ol ordered list liebiao', group: 'list', icon: '1.', template: '1. {{cursor}}' },
  { id: 'todo', title: '待办事项', keywords: 'todo task check daiban', group: 'list', icon: '☐', template: '- [ ] {{cursor}}' },
  { id: 'quote', title: '引用', keywords: 'quote blockquote yinyong', group: 'block', icon: '❝', template: '> {{cursor}}' },
  {
    id: 'callout-note',
    title: '提示块 · 说明',
    keywords: 'callout note tishi',
    group: 'block',
    icon: '💡',
    template: '> [!NOTE] 说明\n> {{cursor}}',
  },
  {
    id: 'callout-warning',
    title: '提示块 · 注意',
    keywords: 'callout warning caution tishi',
    group: 'block',
    icon: '⚠️',
    template: '> [!WARNING] 注意\n> {{cursor}}',
  },
  { id: 'code', title: '代码块', keywords: 'code daima pre', group: 'block', icon: '</>', template: '```{{cursor}}\n```' },
  { id: 'math', title: '公式块', keywords: 'math katex formula gongshi', group: 'block', icon: '∑', template: '$$\n{{cursor}}\n$$' },
  { id: 'hr', title: '分割线', keywords: 'hr line divider fengexian', group: 'block', icon: '—', template: '---' },
  {
    id: 'table',
    title: '表格',
    keywords: 'table biaoge grid',
    group: 'table',
    icon: '▦',
    template: '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| {{cursor}} |  |  |',
  },
  { id: 'image', title: '图片', keywords: 'image img picture tupian', group: 'media', icon: '🖼', template: '![{{cursor}}](url)' },
  { id: 'doc-link', title: '文档互链', keywords: 'link doc wiki hulian lianjie', group: 'media', icon: '🔗', template: '[[{{cursor}}]]' },
]

const CURSOR = '{{cursor}}'

/** 模板 → 插入用 Markdown（剔除光标标记） */
export function templateToMarkdown(template: string): string {
  return (template ?? '').replace(CURSOR, '')
}

/**
 * 光标落点：插入后内容相对插入点的字符偏移。
 * `{{cursor}}` 之前（剔除标记后）的字符数即偏移；无标记返回 null（不移动光标）。
 */
export function templateCursorOffset(template: string): number | null {
  const idx = (template ?? '').indexOf(CURSOR)
  if (idx < 0) return null
  return templateToMarkdown(template.slice(0, idx)).length
}

/** 按关键字过滤命令（空查询返回全部；标题/关键字命中优先，其次前缀命中） */
export function filterSlashCommands(query: string, limit = 12): SlashCommand[] {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return SLASH_COMMANDS.slice(0, limit)
  const scored: { cmd: SlashCommand; score: number }[] = []
  for (const cmd of SLASH_COMMANDS) {
    const title = cmd.title.toLowerCase()
    const kw = cmd.keywords.toLowerCase()
    const id = cmd.id.toLowerCase()
    let score = -1
    if (title.startsWith(q) || id.startsWith(q)) score = 0
    else if (kw.split(/\s+/).some((k) => k.startsWith(q))) score = 1
    else if (title.includes(q) || kw.includes(q)) score = 2
    if (score >= 0) scored.push({ cmd, score })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((s) => s.cmd)
}

/** 菜单项按分组排列（渲染用；空分组自动省略） */
export function groupSlashCommands(cmds: readonly SlashCommand[]): { group: SlashGroup; label: string; items: SlashCommand[] }[] {
  const order: SlashGroup[] = ['basic', 'list', 'block', 'table', 'media']
  return order
    .map((g) => ({ group: g, label: SLASH_GROUP_LABEL[g], items: cmds.filter((c) => c.group === g) }))
    .filter((g) => g.items.length > 0)
}

/** 该行的 `/查询` 触发串是否成立：行首（允许空白）以 `/` 开头且其后无空白 */
export function slashQueryOf(lineText: string): string | null {
  const m = /^\s*\/([^\s/]*)$/.exec(lineText ?? '')
  return m ? m[1] : null
}
