// 插件注册表类型定义
export type PluginRole = 'guest' | 'user' | 'admin'

/** 插件来源：catalog=商店目录（内置元数据）、local=本地第三方包、remote=远端市场 */
export type PluginSource = 'catalog' | 'local' | 'remote'

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
  /** 可见用户组 id 列表（内置 guest/user/admin + 自定义组） */
  visibleGroups: string[]
  /** 前端挂载的 panel 组件标识 */
  panel?: string
  /** 来源（可选，向后兼容旧记录） */
  source?: PluginSource
  /** 安装物下载地址（远端市场安装时复用，可选） */
  packageUrl?: string
  /** 内容哈希（sha256，校验 + 更新比对，可选） */
  sha256?: string
  /** 插件声明的依赖（服务名/其他插件名列表，可选） */
  deps?: string[]
  /** 最低 i-kit 版本约束（semver，可选） */
  minIkit?: string
  /** 最低版本约束别名（可选） */
  minVersion?: string
  /** 作者（可选） */
  author?: string
  /** 描述（可选） */
  description?: string
  /** 分类（可选） */
  category?: string
  /** 安装时间（ISO，可选） */
  installedAt?: string
  /** 更新时间（ISO，可选） */
  updatedAt?: string
}

/** 由 loader 上报到注册表的第三方插件包信息（可选字段对齐 manifest） */
export interface PluginPackageInfo {
  name: string
  title?: string
  version?: string
  panel?: string
  description?: string
  author?: string
  category?: string
  deps?: string[]
  minIkit?: string
  minVersion?: string
  sha256?: string
  source?: PluginSource
  packageUrl?: string
}

/** 静态 registry.json 单条目（评估草案字段：单版本 + packageUrl/sha256） */
export interface RemoteRegistryPlugin {
  name: string
  title?: string
  description?: string
  author?: string
  category?: string
  packageUrl?: string
  sha256?: string
  version?: string
  minIkit?: string
  deps?: string[]
  homepage?: string
}

/** 静态 registry.json 根结构 */
export interface RemoteRegistry {
  schema?: number
  name?: string
  updatedAt?: string
  plugins: RemoteRegistryPlugin[]
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
  /** 来源（catalog=内置目录 / remote=远端市场 / local=本地导入） */
  source?: PluginSource
  /** 下载地址（remote） */
  packageUrl?: string
  /** 内容哈希（remote/local） */
  sha256?: string
  /** 依赖声明 */
  deps?: string[]
  /** 最低 i-kit 版本约束 */
  minIkit?: string
  /** 是否存在可更新版本（按 semver 比较；catalog 保留字符串比较语义） */
  updateAvailable?: boolean
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

/** loader.uninstall 的返回：服务据此决定是否移除注册记录（失败时保留记录以便回滚恢复） */
export interface PluginUninstallResult {
  /** 是否命中已加载的目录包（false=仅注册表元数据，无目录可删） */
  handled: boolean
  /** 实例释放 + 目录删除是否成功 */
  ok: boolean
  /** 失败原因（ok=false 时） */
  error?: string
}

/** loader 单包加载/重载返回（结构兼容 loader.ts 的 LoadedPluginPackage） */
export interface PluginLoadResult {
  manifest: { name: string; title?: string; version?: string }
  loaded: boolean
  error?: string
}

/** 注册表 ↔ 加载器 联动钩子 */
export interface PluginLoaderHooks {
  onEnable?: (name: string) => boolean
  onDisable?: (name: string) => boolean
  onUninstall?: (name: string) => Promise<PluginUninstallResult> | PluginUninstallResult
  onLoadOne?: (pkgRef: string) => Promise<PluginLoadResult> | PluginLoadResult
  onReloadOne?: (name: string) => Promise<PluginLoadResult> | PluginLoadResult
}

/** 插件安装入参：仅名称（沿用商店条目）或显式 packageUrl+sha256（直接远端安装） */
export type PluginInstallInput = string | { name?: string; packageUrl?: string; sha256?: string }

export interface PluginRegistryService {
  list(): PluginRecord[]
  /** 按用户组返回可见且启用的插件（admin 恒可见） */
  visibleFor(groups: string[], isAdmin: boolean): PluginRecord[]
  enable(name: string, on: boolean): Promise<PluginRecord[]>
  setOrder(orderedNames: string[]): Promise<PluginRecord[]>
  setGroups(name: string, groups: string[]): Promise<PluginRecord[]>
  /** 插件商店目录（内置目录 + 远端条目 + 已装第三方包，含安装/更新状态） */
  store(): PluginStoreItem[]
  /** 安装插件：内置目录=注册标记；远端/显式 packageUrl=下载+校验+落盘+热载 */
  install(input: PluginInstallInput): Promise<PluginRecord[]>
  /** 卸载非内置插件（释放实例 + 删除目录 + 移除注册记录） */
  uninstall(name: string): Promise<PluginRecord[]>
  /** 更新插件（catalog 改版本；remote 走真实下载替换） */
  update(name: string): Promise<PluginRecord[]>
  /** 给插件评分/评论 */
  rate(name: string, author: string, score: number, comment: string): Promise<PluginStoreItem[]>
  /** 插件可用分类 */
  categories(): string[]
  /** 注册已加载的第三方插件包（由 loader 调用，加入注册表并启用） */
  upsertPackage(p: PluginPackageInfo): Promise<PluginRecord[]>
  /** 导出第三方目录包为 zip Buffer；内置/不存在/不可导出抛错 */
  exportPackage(name: string): Promise<{ buffer: Buffer; filename: string }>
  /** 导入 zip（base64 + 可选 sha256）：校验通过后落盘并热载 */
  importPackage(data: string, sha256?: string): Promise<PluginRecord[]>
  /** 强制刷新远端静态目录源（registry.json） */
  refreshRegistry(): Promise<void>
  /** 当前生效的远端目录源 URL（空=关闭） */
  registryUrl(): string
  /** 设置加载器钩子（启用/禁用/卸载/单包载入/重载时联动服务热装/热卸） */
  setLoaderHooks(hooks: PluginLoaderHooks): void
}
