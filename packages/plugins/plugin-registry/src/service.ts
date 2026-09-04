// 插件注册表服务
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  PluginConfig,
  PluginInstallInput,
  PluginLoaderHooks,
  PluginPackageInfo,
  PluginRecord,
  PluginRegistryService,
  PluginSource,
  PluginStoreItem,
  PluginUninstallResult,
  RemoteRegistryPlugin,
} from './types.js'
import type { JsonPluginStore } from './store.js'
import { STORE_CATALOG } from './catalog.js'
import {
  ZIP_MAX_BYTES,
  assertSha256,
  decodeZipBase64,
  exportPackageToZip,
  validateZipBuffer,
  type ExtractedFile,
} from './packaging.js'
import { compareSemver, isWithinDir, normalizeRelPath } from './utils.js'
import type { PluginPackageManifest } from './loader.js'

function defaultVisibility(): string[] {
  return ['guest', 'user', 'admin']
}

// 默认功能插件：随系统内置，不在插件库中管理（不显示、不可卸载、不参与可见性配置）
const DEFAULT_FEATURES = new Set(['knowledge'])

export interface PluginRegistryOptions {
  /** 第三方插件包根目录（导入/导出的落盘边界） */
  pluginDir?: string
  /** 静态插件市场目录源 URL（registry.json）；空=关闭远端源 */
  registryUrl?: string
  /** 本地调试豁免：允许 http:// 明文下载（生产环境勿开启） */
  allowHttp?: boolean
}

/** 校验并规范化远端 registry.json 响应结构（非法/缺失关键字段的条目丢弃） */
function sanitizeRemoteRegistry(data: any): RemoteRegistryPlugin[] {
  if (!data || typeof data !== 'object' || !Array.isArray(data.plugins)) return []
  const out: RemoteRegistryPlugin[] = []
  for (const p of data.plugins) {
    if (!p || typeof p !== 'object') continue
    if (typeof p.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.name)) continue
    if (typeof p.packageUrl !== 'string' || !p.packageUrl) continue
    if (typeof p.version !== 'string' || !p.version) continue
    out.push({
      name: p.name,
      title: typeof p.title === 'string' ? p.title : p.name,
      description: typeof p.description === 'string' ? p.description : '',
      author: typeof p.author === 'string' ? p.author : '',
      category: typeof p.category === 'string' ? p.category : '',
      packageUrl: p.packageUrl,
      sha256: typeof p.sha256 === 'string' ? p.sha256 : undefined,
      version: p.version,
      minIkit: typeof p.minIkit === 'string' ? p.minIkit : undefined,
      deps: Array.isArray(p.deps) ? p.deps.filter((x: any) => typeof x === 'string') : undefined,
      homepage: typeof p.homepage === 'string' ? p.homepage : undefined,
    })
  }
  return out
}

export function createPluginRegistry(
  store: JsonPluginStore,
  seed: PluginRecord[] = [],
  options: PluginRegistryOptions = {},
): PluginRegistryService {
  let loaded = false
  let config: PluginConfig = { plugins: [] as PluginRecord[], reviews: {} }
  let loaderHooks: PluginLoaderHooks = {}
  let remoteCatalog: RemoteRegistryPlugin[] = []

  const pluginDir = options.pluginDir ? path.resolve(options.pluginDir) : ''
  const registryUrl = (options.registryUrl || '').trim()
  const allowHttp = !!options.allowHttp

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

  const dirExists = async (p: string): Promise<boolean> => {
    try {
      return (await fs.stat(p)).isDirectory()
    } catch {
      return false
    }
  }

  const fileExists = async (p: string): Promise<boolean> => {
    try {
      return (await fs.stat(p)).isFile()
    } catch {
      return false
    }
  }

  // 由「目录名」解析插件包目录（仅限插件根下，防穿越）
  const pkgDirOf = (name: string): string | null => {
    if (!pluginDir || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return null
    const resolved = path.resolve(pluginDir, name)
    return isWithinDir(pluginDir, resolved) ? resolved : null
  }

  const reviewsOf = (name: string) => config.reviews[name] ?? []
  const ratingOf = (name: string): number => {
    const rs = reviewsOf(name)
    return rs.length ? Math.round((rs.reduce((s, r) => s + (r.score || 0), 0) / rs.length) * 10) / 10 : 0
  }

  // 从目录 + 评论生成店面条目（含已安装状态与评分评论）
  const enrichedStore = (): PluginStoreItem[] => {
    const byName = new Map(config.plugins.map((p) => [p.name, p]))
    const out: PluginStoreItem[] = []
    const seen = new Set<string>()

    const enrich = (base: PluginStoreItem, source: PluginSource): PluginStoreItem => {
      const installed = byName.get(base.name)
      const instVersion = installed?.version
      let updateAvailable = false
      if (installed && instVersion) {
        // catalog 保留字符串比较语义；remote/local 用 semver 数字点分比较
        updateAvailable =
          source === 'catalog' ? instVersion !== base.version : compareSemver(base.version, instVersion) > 0
      }
      return {
        ...base,
        source,
        installed: !!installed,
        installedVersion: installed?.version,
        updateAvailable,
        rating: ratingOf(base.name),
        ratingCount: reviewsOf(base.name).length,
        reviews: reviewsOf(base.name),
      }
    }

    // 1) 内置 7 条目录源（假安装行为不变）
    for (const item of STORE_CATALOG) {
      seen.add(item.name)
      out.push(enrich({ ...item }, 'catalog'))
    }
    // 2) 远端静态目录源（与内置目录同名时内置优先）
    for (const r of remoteCatalog) {
      if (seen.has(r.name)) continue
      seen.add(r.name)
      out.push(
        enrich(
          {
            name: r.name,
            title: r.title ?? r.name,
            description: r.description ?? '',
            version: r.version ?? '0.0.0',
            author: r.author ?? '',
            category: r.category,
            packageUrl: r.packageUrl,
            sha256: r.sha256,
            deps: r.deps,
            minIkit: r.minIkit,
          },
          'remote',
        ),
      )
    }
    // 3) 已安装的第三方包（local/remote，未在上面列出者），供导出/卸载/更新
    for (const p of config.plugins) {
      if (seen.has(p.name) || p.builtin) continue
      seen.add(p.name)
      out.push({
        name: p.name,
        title: p.title,
        description: p.description ?? '',
        version: p.version,
        author: p.author ?? '',
        category: p.category,
        installed: true,
        installedVersion: p.version,
        source: p.source === 'remote' ? 'remote' : 'local',
        packageUrl: p.packageUrl,
        sha256: p.sha256,
        deps: p.deps,
        minIkit: p.minIkit,
        rating: ratingOf(p.name),
        ratingCount: reviewsOf(p.name).length,
        reviews: reviewsOf(p.name),
      })
    }
    return out
  }

  // 单包加载/重载（经 loader 钩子；失败抛错）
  const loadOne = async (name: string): Promise<void> => {
    if (!loaderHooks.onLoadOne) throw new Error('加载器未就绪')
    const res = await loaderHooks.onLoadOne(name)
    if (!res.loaded) throw new Error(res.error || '插件加载失败')
    // 安装即启用：新导入/远端安装的包注册为 enabled=true，立即激活其服务
    loaderHooks.onEnable?.(name)
  }
  const reloadOne = async (name: string): Promise<void> => {
    if (!loaderHooks.onReloadOne) throw new Error('加载器未就绪')
    const res = await loaderHooks.onReloadOne(name)
    if (!res.loaded) throw new Error(res.error || '插件重载失败')
  }

  // 注册/更新插件包元数据（信任字段：source/sha256/packageUrl 显式回写，不丢）
  const upsertPackage = async (p: PluginPackageInfo) => {
    await ensureLoaded()
    const now = new Date().toISOString()
    const existing = config.plugins.find((x) => x.name === p.name)
    if (existing) {
      const versionChanged = !!p.version && p.version !== existing.version
      existing.title = p.title || existing.title
      existing.version = p.version || existing.version
      existing.panel = p.panel || existing.panel
      existing.enabled = true
      if (p.source) existing.source = p.source
      else if (!existing.source) existing.source = 'local'
      if (p.packageUrl !== undefined) existing.packageUrl = p.packageUrl
      if (p.description) existing.description = p.description
      if (p.author) existing.author = p.author
      if (p.category) existing.category = p.category
      if (p.deps) existing.deps = p.deps
      if (p.minIkit) existing.minIkit = p.minIkit
      if (p.minVersion) existing.minVersion = p.minVersion
      if (p.sha256) existing.sha256 = p.sha256
      if (versionChanged) existing.updatedAt = now
      if (!existing.installedAt) existing.installedAt = now
    } else {
      config.plugins.push({
        name: p.name,
        title: p.title || p.name,
        version: p.version ?? '0.0.0',
        enabled: true,
        builtin: false,
        order: config.plugins.length,
        visibleGroups: defaultVisibility(),
        panel: p.panel || p.name,
        source: p.source ?? 'local',
        packageUrl: p.packageUrl,
        sha256: p.sha256,
        deps: p.deps,
        minIkit: p.minIkit,
        minVersion: p.minVersion,
        author: p.author,
        description: p.description,
        category: p.category,
        installedAt: now,
        updatedAt: now,
      })
    }
    await persist()
    return config.plugins
  }

  // 校验后的文件树落盘 + 原子替换 + 单包热载（导入与远端市场共用）
  const installFilesAtomically = async (
    manifest: PluginPackageManifest,
    files: ExtractedFile[],
    source: PluginSource,
    packageUrl: string | undefined,
    treeSha256: string,
  ): Promise<void> => {
    if (!pluginDir) throw new Error('插件目录未配置')
    const name = manifest.name
    const target = path.join(pluginDir, name)
    const staging = path.join(pluginDir, `.staging-${randomUUID()}`)
    const backup = path.join(pluginDir, `.backup-${randomUUID()}`)
    await fs.mkdir(staging, { recursive: true })
    try {
      for (const f of files) {
        // 防御性二次校验（validateZipBuffer 已校验过，此处再兜底）
        const safe = normalizeRelPath(f.relPath)
        if (!safe) throw new Error(`非法条目路径: ${f.relPath}`)
        const dest = path.resolve(staging, ...safe.split('/'))
        if (!isWithinDir(staging, dest)) throw new Error(`条目越界: ${f.relPath}`)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, f.data)
      }

      const wasExisting = await dirExists(target)
      if (wasExisting) {
        // 更新：备份旧目录 → 替换 → reloadOne；失败回滚保留旧版
        await fs.rename(target, backup)
        let moved = false
        try {
          await fs.rename(staging, target)
          moved = true
          await reloadOne(name)
        } catch (e) {
          if (moved) await fs.rm(target, { recursive: true, force: true }).catch(() => {})
          await fs.rename(backup, target).catch(() => {})
          await reloadOne(name).catch(() => {}) // 恢复旧实例服务
          throw e
        }
        await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
      } else {
        // 全新安装：落位后 loadOne；失败删除目标目录不留半状态
        await fs.rename(staging, target)
        try {
          await loadOne(name)
        } catch (e) {
          await fs.rm(target, { recursive: true, force: true }).catch(() => {})
          throw e
        }
      }

      await upsertPackage({
        name,
        title: manifest.title,
        version: manifest.version,
        panel: manifest.panel,
        description: manifest.description,
        author: manifest.author,
        category: manifest.category,
        deps: manifest.deps,
        minIkit: manifest.minIkit,
        minVersion: manifest.minVersion,
        sha256: treeSha256,
        source,
        packageUrl,
      })
    } catch (e) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }

  // 远端市场安装：下载（https，可选 http 豁免）→ 统一校验链 → 落盘 → 热载
  const installRemote = async (input: { name?: string; packageUrl: string; sha256?: string }) => {
    await ensureLoaded()
    const url = (input.packageUrl || '').trim()
    if (!url) throw new Error('缺少 packageUrl')
    let proto: string
    try {
      proto = new URL(url).protocol
    } catch {
      throw new Error('packageUrl 非法')
    }
    if (proto !== 'https:') {
      if (proto === 'http:' && allowHttp) {
        console.warn('[plugin-registry] allowHttp=true：允许 http 明文下载（仅限本地调试）')
      } else {
        throw new Error(
          proto === 'http:'
            ? '拒绝 http 明文下载（本地调试可设 PLUGIN_REGISTRY_ALLOW_HTTP=1）'
            : '仅支持 https 下载',
        )
      }
    }
    let zipBuf: Buffer
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ab = await res.arrayBuffer()
      if (ab.byteLength > ZIP_MAX_BYTES) {
        throw new Error(`zip 超过 ${Math.round(ZIP_MAX_BYTES / 1024)}KB 上限`)
      }
      zipBuf = Buffer.from(ab)
    } catch (e) {
      throw new Error(`下载失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    const { manifest, files, treeSha256 } = validateZipBuffer(zipBuf)
    if (input.name && input.name !== manifest.name) {
      throw new Error(`插件名不匹配（期望 ${input.name}，实际 ${manifest.name}）`)
    }
    if (input.sha256 && String(input.sha256).trim()) {
      assertSha256(String(input.sha256).trim(), treeSha256)
    } else {
      console.warn(`[plugin-registry] remote install "${manifest.name}" without sha256（registry 未提供哈希）`)
    }
    await installFilesAtomically(manifest, files, 'remote', url, treeSha256)
    return config.plugins
  }

  // 同步初始化：立即触发（不阻塞路由，但保证首次读取前 seed 完成）
  void ensureLoaded()
  // 拉取远端静态目录源（异步，失败降级为仅内置并 warn）
  const refreshRegistry = async (): Promise<void> => {
    if (!registryUrl) {
      remoteCatalog = []
      return
    }
    try {
      const res = await fetch(registryUrl, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as any
      remoteCatalog = sanitizeRemoteRegistry(data)
      console.log(`[plugin-registry] remote registry loaded: ${remoteCatalog.length} plugins`)
    } catch (e) {
      console.warn(
        `[plugin-registry] remote registry fetch failed, falling back to builtin:`,
        e instanceof Error ? e.message : e,
      )
      remoteCatalog = []
    }
  }
  void refreshRegistry()

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
      const exists =
        STORE_CATALOG.some((x) => x.name === name) ||
        remoteCatalog.some((x) => x.name === name) ||
        config.plugins.some((p) => p.name === name)
      if (!exists) throw new Error('商店中不存在该插件')
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
      const cats = new Set<string>()
      for (const c of STORE_CATALOG) if (c.category) cats.add(c.category)
      for (const r of remoteCatalog) if (r.category) cats.add(r.category)
      return [...cats]
    },

    upsertPackage,

    async install(input: PluginInstallInput) {
      await ensureLoaded()
      const inputObj = typeof input === 'object' && input !== null ? input : null
      const name = typeof input === 'string' ? input : (inputObj?.name ?? '')
      const packageUrl = inputObj?.packageUrl
      const sha256 = inputObj?.sha256

      if (packageUrl) {
        return installRemote({ name: name || undefined, packageUrl, sha256 })
      }
      // 内置 7 条 catalog 的旧「假安装」行为保持不变（仅注册标记）
      const item = STORE_CATALOG.find((x) => x.name === name)
      if (item) {
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
          source: 'catalog',
          author: item.author,
          description: item.description,
          category: item.category,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        await persist()
        return config.plugins
      }
      // 远端目录源条目：真实下载+校验+落盘
      const remote = remoteCatalog.find((x) => x.name === name)
      if (remote && remote.packageUrl) {
        return installRemote({ name, packageUrl: remote.packageUrl, sha256: remote.sha256 })
      }
      throw new Error('商店中不存在该插件')
    },

    async uninstall(name) {
      await ensureLoaded()
      const p = config.plugins.find((x) => x.name === name)
      if (!p) return config.plugins
      if (p.builtin) throw new Error('内置插件不可卸载')
      // 联动 loader：释放实例（dispose）+ 物理删除目录（仅第三方目录包会命中）
      if (loaderHooks.onUninstall) {
        const result = await loaderHooks.onUninstall(name)
        if (!result.ok) {
          // 目录删除失败/越界：保留注册记录（可恢复），抛错终止
          throw new Error(result.error || '插件目录删除失败，注册记录已保留')
        }
      }
      config.plugins = config.plugins.filter((x) => x.name !== name)
      await persist()
      return config.plugins
    },

    async update(name) {
      await ensureLoaded()
      const p = config.plugins.find((x) => x.name === name)
      const item = STORE_CATALOG.find((x) => x.name === name)
      if (item) {
        if (!p) return config.plugins
        p.version = item.version
        p.title = item.title
        await persist()
        return config.plugins
      }
      const remote = remoteCatalog.find((x) => x.name === name)
      if (remote && remote.packageUrl) {
        return installRemote({ name, packageUrl: remote.packageUrl, sha256: remote.sha256 })
      }
      return config.plugins
    },

    async exportPackage(name) {
      await ensureLoaded()
      if (!pluginDir) throw new Error('插件目录未配置')
      if (typeof name !== 'string' || !name) throw new Error('插件不存在或不是第三方目录包')
      const rec = config.plugins.find((x) => x.name === name)
      const catalogItem = STORE_CATALOG.find((x) => x.name === name)
      if (catalogItem || (rec && (rec.builtin || rec.source === 'catalog'))) {
        throw new Error('内置插件不可导出')
      }
      const pkgDir = pkgDirOf(name)
      if (!pkgDir) throw new Error('插件不存在或不是第三方目录包')
      if (!(await fileExists(path.join(pkgDir, 'plugin.json')))) {
        throw new Error('插件不存在或不是第三方目录包')
      }
      const buffer = await exportPackageToZip(pkgDir)
      return { buffer, filename: `${name}.zip` }
    },

    async importPackage(data, sha256) {
      await ensureLoaded()
      if (!pluginDir) throw new Error('插件目录未配置')
      const zipBuf = decodeZipBase64(data)
      const { manifest, files, treeSha256 } = validateZipBuffer(zipBuf)
      if (sha256 && String(sha256).trim()) {
        assertSha256(String(sha256).trim(), treeSha256)
      } else {
        console.warn(`[plugin-registry] import "${manifest.name}" without sha256（未校验内容，仅安装受信任来源）`)
      }
      await installFilesAtomically(manifest, files, 'local', undefined, treeSha256)
      return config.plugins
    },

    refreshRegistry,

    registryUrl() {
      return registryUrl
    },
  }
}
