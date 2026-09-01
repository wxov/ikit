// 插件注册表类型定义
export type PluginRole = 'guest' | 'user' | 'admin'

export interface PluginVisibility {
  /** 游客（未登录）可见 */
  guest: boolean
  /** 注册用户可见 */
  user: boolean
  /** 站主可见 */
  admin: boolean
}

export interface PluginRecord {
  /** 插件标识：agent / knowledge / system ... */
  name: string
  /** 显示名称 */
  title: string
  /** 版本号 */
  version: string
  /** 是否启用 */
  enabled: boolean
  /** 是否系统内置默认插件（不可卸载） */
  builtin: boolean
  /** 排序序号（越小越靠前） */
  order: number
  /** 按角色可见性 */
  visibility: PluginVisibility
  /** 前端挂载的 panel 组件标识 */
  panel?: string
}

/** 插件商店条目 */
export interface PluginStoreItem {
  name: string
  title: string
  description: string
  version: string
  author: string
  /** 是否已安装（由注册表判断） */
  installed?: boolean
  /** 已安装版本 */
  installedVersion?: string
  /** 兼容类别 */
  category?: string
  /** 平均评分（1-5） */
  rating?: number
  /** 评分人数 */
  ratingCount?: number
  /** 评论列表 */
  reviews?: PluginReview[]
  /** 截图 URL 列表 */
  screenshots?: string[]
}

/** 插件评价 */
export interface PluginReview {
  id: string
  author: string
  score: number
  comment: string
  createdAt: string
}

export interface PluginConfig {
  plugins: PluginRecord[]
  /** 插件名 → 评价列表 */
  reviews: Record<string, PluginReview[]>
}

export interface PluginRegistryService {
  list(): PluginRecord[]
  /** 按角色返回可见且启用的插件 */
  visibleFor(role: PluginRole): PluginRecord[]
  enable(name: string, on: boolean): Promise<PluginRecord[]>
  setOrder(orderedNames: string[]): Promise<PluginRecord[]>
  setVisibility(name: string, role: PluginRole, visible: boolean): Promise<PluginRecord[]>
  /** 插件商店目录（含已安装状态 + 评分评论） */
  store(): PluginStoreItem[]
  /** 安装商店插件（加入注册表，非内置） */
  install(name: string): Promise<PluginRecord[]>
  /** 卸载非内置插件 */
  uninstall(name: string): Promise<PluginRecord[]>
  /** 更新插件（版本号递增） */
  update(name: string): Promise<PluginRecord[]>
  /** 给插件评分/评论 */
  rate(name: string, author: string, score: number, comment: string): Promise<PluginStoreItem[]>
  /** 插件可用分类 */
  categories(): string[]
  /** 注册已加载的第三方插件包（由 loader 调用，加入注册表并启用） */
  upsertPackage(p: { name: string; title: string; version: string; panel?: string }): Promise<PluginRecord[]>
  /** 设置加载器钩子（启用/禁用/卸载时联动服务热装/热卸） */
  setLoaderHooks(hooks: { onEnable?: (name: string) => boolean; onDisable?: (name: string) => boolean; onUninstall?: (name: string) => boolean }): void
}
