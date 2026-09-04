// 插件商店默认目录源（内置 7 条元数据，无安装物；外置自 service.ts 以便后续替换为远端目录源）
import type { PluginStoreItem } from './types.js'

// 生成简单的内联 SVG 截图（真实可渲染的 img 源，无外部依赖）
function screenshotDataUrl(title: string, color: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="340"><rect width="100%" height="100%" fill="${color}"/><text x="24" y="40" font-size="20" fill="#fff" font-family="sans-serif">${title}</text><rect x="24" y="60" width="592" height="200" rx="8" fill="rgba(255,255,255,0.85)"/><text x="40" y="150" font-size="16" fill="#334155" font-family="sans-serif">${label}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// 插件商店目录（可官方/第三方扩展；agent/knowledge 为内置不在商店）
export const STORE_CATALOG: PluginStoreItem[] = [
  {
    name: 'stats',
    title: '数据统计',
    description: '展示系统访问、知识库增长的统计面板。',
    version: '1.0.0',
    author: 'i-kit 官方',
    category: '工具',
    screenshots: [
      screenshotDataUrl('数据统计', '#3b82f6', '仪表盘视图'),
      screenshotDataUrl('数据统计', '#2563eb', '趋势图表'),
    ],
  },
  {
    name: 'notes',
    title: '便签',
    description: '快速记录碎片化灵感的轻量便签插件。',
    version: '1.1.0',
    author: 'i-kit 官方',
    category: '效率',
    screenshots: [
      screenshotDataUrl('便签', '#f59e0b', '便签列表'),
      screenshotDataUrl('便签', '#d97706', '快速输入'),
    ],
  },
  {
    name: 'calendar',
    title: '日历',
    description: '日程与待办日历插件。',
    version: '0.9.0',
    author: '社区',
    category: '效率',
    screenshots: [
      screenshotDataUrl('日历', '#10b981', '月视图'),
      screenshotDataUrl('日历', '#059669', '日程详情'),
    ],
  },
  {
    name: 'todo',
    title: '待办清单',
    description: '轻量待办清单：勾选完成、增删待办。',
    version: '1.0.0',
    author: 'i-kit 官方',
    category: '效率',
    screenshots: [
      screenshotDataUrl('待办清单', '#8b5cf6', '勾选完成'),
      screenshotDataUrl('待办清单', '#7c3aed', '快速添加'),
    ],
  },
  {
    name: 'weather',
    title: '天气',
    description: '实时天气查询（按城市）。',
    version: '1.0.0',
    author: 'i-kit 官方',
    category: '工具',
    screenshots: [
      screenshotDataUrl('天气', '#06b6d4', '当前天气'),
      screenshotDataUrl('天气', '#0891b2', '城市查询'),
    ],
  },
  {
    name: 'rss',
    title: 'RSS 订阅',
    description: '抓取 RSS 地址生成订阅标题列表。',
    version: '1.0.0',
    author: 'i-kit 官方',
    category: '资讯',
    screenshots: [
      screenshotDataUrl('RSS 订阅', '#f97316', '订阅列表'),
      screenshotDataUrl('RSS 订阅', '#ea580c', '条目抓取'),
    ],
  },
  {
    name: 'mdclip',
    title: 'Markdown 剪贴板',
    description: '粘贴/保存/复制 Markdown 片段。',
    version: '1.0.0',
    author: 'i-kit 官方',
    category: '效率',
    screenshots: [
      screenshotDataUrl('Markdown 剪贴板', '#64748b', '保存片段'),
      screenshotDataUrl('Markdown 剪贴板', '#475569', '快速复制'),
    ],
  },
]
