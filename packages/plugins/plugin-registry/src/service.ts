// 插件注册表服务
import { randomUUID } from 'node:crypto'
import type {
  PluginConfig,
  PluginRegistryService,
  PluginRecord,
  PluginStoreItem,
} from './types.js'
import type { JsonPluginStore } from './store.js'

function defaultVisibility(): string[] {
  return ['guest', 'user', 'admin']
}

// 默认功能插件：随系统内置，不在插件库中管理（不显示、不可卸载、不参与可见性配置）
const DEFAULT_FEATURES = new Set(['knowledge'])

// 生成简单的内联 SVG 截图（真实可渲染的 img 源，无外部依赖）
function screenshotDataUrl(title: string, color: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="340"><rect width="100%" height="100%" fill="${color}"/><text x="24" y="40" font-size="20" fill="#fff" font-family="sans-serif">${title}</text><rect x="24" y="60" width="592" height="200" rx="8" fill="rgba(255,255,255,0.85)"/><text x="40" y="150" font-size="16" fill="#334155" font-family="sans-serif">${label}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// 插件商店目录（可官方/第三方扩展；agent/knowledge 为内置不在商店）
const STORE_CATALOG: PluginStoreItem[] = [
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

export function createPluginRegistry(
  store: JsonPluginStore,
  seed: PluginRecord[] = [],
): PluginRegistryService {
  let loaded = false
  let config: PluginConfig = { plugins: [] as PluginRecord[], reviews: {} }
  let loaderHooks: { onEnable?: (name: string) => boolean; onDisable?: (name: string) => boolean; onUninstall?: (name: string) => boolean } = {}

  const ensureLoaded = async () => {
    if (loaded) return
    config = await store.load()
    if (!config.reviews) config.reviews = {}
    // 默认功能插件已从插件库剥离：剔除历史持久化里的对应项，避免出现在插件管理中
    const removed = config.plugins.filter((p) => DEFAULT_FEATURES.has(p.name))
    if (removed.length) {
      config.plugins = config.plugins.filter((p) => !DEFAULT_FEATURES.has(p.name))
      await store.save(config)
    }
    // 迁移：旧「visibility 布尔对象」→「visibleGroups 组集合」
    let migrated = false
    for (const p of config.plugins as any[]) {
      if (!Array.isArray(p.visibleGroups)) {
        const g: string[] = []
        if (p.visibility && typeof p.visibility === 'object') {
          if (p.visibility.guest) g.push('guest')
          if (p.visibility.user) g.push('user')
          if (p.visibility.admin) g.push('admin')
        }
        p.visibleGroups = g.length ? g : defaultVisibility()
        migrated = true
      }
      delete p.visibility
    }
    if (migrated) await store.save(config)
    loaded = true
    await applySeed(seed)
  }

  const applySeed = async (defaults: PluginRecord[]) => {
    const byName = new Map(config.plugins.map((p) => [p.name, p]))
    let changed = false
    for (const d of defaults) {
      if (!byName.has(d.name)) {
        config.plugins.push({ ...structuredClone(d), visibleGroups: defaultVisibility() })
        changed = true
      } else {
        const existing = byName.get(d.name)!
        if (!existing.title) existing.title = d.title
        if (!existing.panel) existing.panel = d.panel
        existing.builtin = !!d.builtin || existing.builtin
        existing.version = d.version ?? existing.version
      }
    }
    if (changed) await persist()
  }

  const persist = async () => {
    await store.save(config)
  }

  // 从目录 + 评论生成店面条目（含已安装状态与评分评论）
  const enrichedStore = (): PluginStoreItem[] => {
    const byName = new Map(config.plugins.map((p) => [p.name, p]))
    return STORE_CATALOG.map((item) => {
      const installed = byName.get(item.name)
      const reviews = config.reviews[item.name] ?? []
      const rating = reviews.length ? reviews.reduce((s, r) => s + (r.score || 0), 0) / reviews.length : 0
      return {
        ...item,
        installed: !!installed,
        installedVersion: installed?.version,
        rating: Math.round(rating * 10) / 10,
        ratingCount: reviews.length,
        reviews,
      }
    })
  }

  // 同步初始化：立即触发（不阻塞路由，但保证首次读取前 seed 完成）
  void ensureLoaded()

  return {
    list() {
      return config.plugins
    },

    visibleFor(groups: string[], isAdmin: boolean) {
      return config.plugins
        .filter((p) => p.enabled && (isAdmin || p.visibleGroups.some((g) => groups.includes(g))))
        .sort((a, b) => a.order - b.order)
    },

    async enable(name, on) {
      await ensureLoaded()
      const p = config.plugins.find((x) => x.name === name)
      if (!p) return config.plugins
      const changed = p.enabled !== on
      p.enabled = on
      if (changed) {
        // 联动插件包服务热装/热卸（注册表级即时生效）
        if (on) loaderHooks.onEnable?.(name)
        else loaderHooks.onDisable?.(name)
      }
      await persist()
      return config.plugins
    },

    setLoaderHooks(hooks) {
      loaderHooks = hooks
    },

    async setOrder(orderedNames) {
      await ensureLoaded()
      const byName = new Map(config.plugins.map((p) => [p.name, p]))
      orderedNames.forEach((n, i) => {
        const p = byName.get(n)
        if (p) p.order = i
      })
      await persist()
      return config.plugins
    },

    async setGroups(name, groups) {
      await ensureLoaded()
      const p = config.plugins.find((x) => x.name === name)
      if (!p) return config.plugins
      p.visibleGroups = [...new Set((groups || []).filter((g) => typeof g === 'string'))]
      await persist()
      return config.plugins
    },

    store() {
      return enrichedStore()
    },

    async rate(name, author, score, comment) {
      await ensureLoaded()
      const item = STORE_CATALOG.find((x) => x.name === name)
      if (!item) throw new Error('商店中不存在该插件')
      if (!config.reviews[name]) config.reviews[name] = []
      config.reviews[name].push({
        id: randomUUID(),
        author: author || '匿名',
        score: Math.max(1, Math.min(5, Math.round(score || 5))),
        comment: (comment || '').trim(),
        createdAt: new Date().toISOString(),
      })
      await persist()
      return enrichedStore()
    },

    categories() {
      return [...new Set(STORE_CATALOG.map((a) => a.category).filter(Boolean))] as string[]
    },

    async upsertPackage(p) {
      await ensureLoaded()
      const existing = config.plugins.find((x) => x.name === p.name)
      if (existing) {
        existing.title = p.title || existing.title
        existing.version = p.version || existing.version
        existing.panel = p.panel || existing.panel
        existing.enabled = true
      } else {
        config.plugins.push({
          name: p.name,
          title: p.title || p.name,
          version: p.version,
          enabled: true,
          builtin: false,
          order: config.plugins.length,
          visibleGroups: defaultVisibility(),
          panel: p.panel || p.name,
        })
      }
      await persist()
      return config.plugins
    },

    async install(name) {
      await ensureLoaded()
      const item = STORE_CATALOG.find((x) => x.name === name)
      if (!item) throw new Error('商店中不存在该插件')
      if (config.plugins.some((p) => p.name === name)) return config.plugins
      config.plugins.push({
        name: item.name,
        title: item.title,
        version: item.version,
        enabled: true, // 真实插件包：安装即启用，可在插件管理关闭
        builtin: false,
        order: config.plugins.length,
        visibleGroups: defaultVisibility(),
        panel: item.name,
      })
      await persist()
      return config.plugins
    },

    async uninstall(name) {
      await ensureLoaded()
      const p = config.plugins.find((x) => x.name === name)
      if (!p) return config.plugins
      if (p.builtin) throw new Error('内置插件不可卸载')
      config.plugins = config.plugins.filter((x) => x.name !== name)
      await persist()
      return config.plugins
    },

    async update(name) {
      await ensureLoaded()
      const p = config.plugins.find((x) => x.name === name)
      const item = STORE_CATALOG.find((x) => x.name === name)
      if (!p || !item) return config.plugins
      p.version = item.version
      p.title = item.title
      await persist()
      return config.plugins
    },
  }
}
