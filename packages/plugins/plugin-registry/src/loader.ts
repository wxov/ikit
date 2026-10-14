// 后端插件包加载规范：
// 一个插件包 = 目录，含：
//   plugin.json  ：{ name, title, version, description, panel, entry, ... }
//   entry 指向的模块：export default { name, apply(ctx, config) }（apply 可返回 { dispose } 或 dispose 函数）
// 加载器扫描目录，动态 import 入口，校验 manifest，并支持按状态热注册/热卸载服务。
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'cordis'
import type { PluginUninstallResult } from './types.js'
import { isEntryExtensionAllowed } from './utils.js'

export interface PluginPackageManifest {
  name: string
  title: string
  version: string
  description?: string
  panel?: string
  entry?: string
  permission?: string[]
  author?: string
  category?: string
  deps?: string[]
  minIkit?: string
  minVersion?: string
  sha256?: string
}

export interface LoadedPluginPackage {
  manifest: PluginPackageManifest
  loaded: boolean
  /**
   * 模块加载成功后**是否已激活**（`apply` 调用成功）。
   * 仅 `reloadOne` 会尝试激活并按真实结果上报；`loadOne`/`loadAll` 只负责装载（激活由注册表按 `enabled` 另调 `activate`），
   * 因此它们不写该字段。
   */
  activated?: boolean
  error?: string
}

export interface PluginPackageModule {
  default?: { name?: string; apply?: (ctx: Context, config?: any) => any }
  apply?: (ctx: Context, config?: any) => any
}

interface LoadedEntry {
  manifest: PluginPackageManifest
  applyFn: (ctx: Context, config?: any) => any
  /** 是否已应用过（服务只注册一次，避免 Cordis 覆盖冲突） */
  applied: boolean
  /** 当前是否启用（决定前台面板可见性，由注册表控制） */
  active: boolean
  /** apply 返回的清理函数（dispose），用于热卸载/重载时释放实例 */
  dispose?: () => void
  /** 插件包所在目录（来自 readdir 扫描结果，非用户输入） */
  pkgDir: string
  /** 入口文件绝对路径 */
  entryPath: string
}

function sanitizeManifest(raw: any): PluginPackageManifest | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw.name)) return null
  return {
    name: raw.name,
    title: typeof raw.title === 'string' ? raw.title : raw.name,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    description: typeof raw.description === 'string' ? raw.description : '',
    panel: typeof raw.panel === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.panel) ? raw.panel : raw.name,
    entry: typeof raw.entry === 'string' ? raw.entry : 'index.js',
    permission: Array.isArray(raw.permission) ? raw.permission.filter((x: any) => typeof x === 'string') : [],
    author: typeof raw.author === 'string' ? raw.author : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    deps: Array.isArray(raw.deps) ? raw.deps.filter((x: any) => typeof x === 'string') : undefined,
    minIkit: typeof raw.minIkit === 'string' ? raw.minIkit : undefined,
    minVersion: typeof raw.minVersion === 'string' ? raw.minVersion : undefined,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
  }
}

export function createPluginPackageLoader(
  ctx: Context,
  dir: string,
  register: (m: PluginPackageManifest, loaded: LoadedPluginPackage) => unknown,
) {
  const packages = new Map<string, LoadedEntry>()
  const root = path.resolve(dir)
  // 热重载计数：与时间戳一起构成 import 查询串，避免「同一毫秒内两次重载」拿到同一条 URL 缓存
  let reloadSeq = 0

  // Node/tsx 的 CJS 模块缓存（`require.cache`）：以**文件绝对路径**为键，全局共享
  const nodeRequire = createRequire(import.meta.url)

  // 判断 target 是否落在插件目录根下（防路径穿越）
  const isWithinRoot = (target: string): boolean => {
    const resolved = path.resolve(target)
    return resolved === root || resolved.startsWith(root + path.sep)
  }

  // 判断 target 是否落在某个包目录下
  const isWithinPkgDir = (pkgDir: string, target: string): boolean => {
    const pkg = path.resolve(pkgDir)
    const t = path.resolve(target)
    return t === pkg || t.startsWith(pkg + path.sep)
  }

  /**
   * 清掉某个包目录在 Node/tsx **CJS 模块缓存**（`require.cache`，以文件路径为键）中的全部旧条目。
   *
   * 为什么不只靠 `import(url + '?t=…')` 的查询串（R2-3 根因之一）：
   * 项目开发与生产都用 tsx 运行（`packages/server` 的 `start`/`dev` 均为 tsx），而 tsx 会把「包目录内没有 `type:module` 的
   * `.js` 入口」按 **CJS** 处理，其缓存键是**文件路径**（查询串被忽略）→ 重载时 `import()` 直接返回**旧模块实例**：
   * 新版本的 `apply()` 从未被调用（因此 apply 抛错也观察不到），注册记录/磁盘已是新版本、实际运行态仍是旧版本，直到重启才暴露。
   * 清缓存后同样的 `import()` 会重新读取磁盘上的当前代码（`.ts`/`.mjs`/`type:module` 的 `.js` 本就走 ESM 缓存，多这一步无副作用）。
   */
  const clearPackageModuleCache = (pkgDir: string): number => {
    const cache = nodeRequire.cache
    if (!cache) return 0
    let cleared = 0
    for (const key of Object.keys(cache)) {
      if (!path.isAbsolute(key)) continue
      if (!isWithinPkgDir(pkgDir, key)) continue
      try {
        delete cache[key]
        cleared++
      } catch {
        /* 个别键不可删：忽略（不影响后续 import 的缓存穿透语义） */
      }
    }
    return cleared
  }

  // 由「目录名（相对 root）或绝对路径」解析包目录；越界返回 null
  const resolvePkgDir = (pkgRef: string): string | null => {
    const candidate = path.isAbsolute(pkgRef) ? pkgRef : path.join(root, pkgRef)
    const resolved = path.resolve(candidate)
    return isWithinRoot(resolved) ? resolved : null
  }

  // 解析入口文件路径：必须落在包目录内（防 entry 穿越），且扩展名在白名单内
  const resolveEntryPath = (pkgDir: string, entry: string): string | null => {
    const pkgRoot = path.resolve(pkgDir)
    const resolved = path.resolve(pkgRoot, entry)
    if (resolved !== pkgRoot && !resolved.startsWith(pkgRoot + path.sep)) return null
    if (!isEntryExtensionAllowed(resolved)) return null
    return resolved
  }

  /**
   * 应用入口：调用插件 apply(ctx, config)，捕获返回的 dispose。
   *
   * 服务注销兜底：插件常忽略 `ctx.set()` 的返回值（apply 不返回 dispose），那样旧实例在重载/卸载时**不会释放**
   * 它注册的服务，导致新版本 apply 再次 `ctx.set` 同名服务被 cordis 拒绝（`service x has been registered`）——
   * 既会把「正常更新」误判为激活失败，也会让回滚无法恢复旧版本服务。
   * 因此这里在 apply 期间**同步**临时接管 `ctx.set` 记录注销器（调用结束立即还原，不改 ctx 身份）：
   * apply 自带返回值时以返回值为准（同一函数去重），否则用记录的注销器兜底；apply 中途抛错也保留这些注销器，
   * 供 `discard`/回滚路径释放「半注册」状态。
   */
  const runApply = (entry: LoadedEntry) => {
    const registered: Array<() => void> = []
    const originalSet = ctx.set
    const hadOwnSet = Object.prototype.hasOwnProperty.call(ctx, 'set')
    const releaseAll = () => {
      for (const dispose of registered.splice(0).reverse()) {
        try {
          dispose()
        } catch (e) {
          console.warn(
            `[plugin-loader] failed to undo ctx.set of "${entry.manifest.name}":`,
            e instanceof Error ? e.message : e,
          )
        }
      }
    }
    let patched = false
    try {
      ;(ctx as any).set = function (this: unknown, name: string, value: unknown) {
        const dispose = originalSet.call((this ?? ctx) as Context, name, value)
        if (typeof dispose === 'function') registered.push(dispose as () => void)
        return dispose
      }
      patched = true
    } catch {
      /* ctx.set 不可写：退回既有行为（不记录注销器） */
    }
    // 先挂兜底 dispose：即使 apply 抛错，已注册的服务也能被 discard/回滚释放（不留半注册状态）
    entry.dispose = releaseAll
    let ret: unknown
    try {
      ret = entry.applyFn(ctx, { manifest: entry.manifest })
    } finally {
      if (patched) {
        try {
          if (hadOwnSet) (ctx as any).set = originalSet
          else delete (ctx as any).set
        } catch {
          /* 还原失败：忽略（最坏情况保留一层等价包装） */
        }
      }
    }
    let primary: (() => void) | undefined
    if (typeof ret === 'function') primary = ret as () => void
    else if (ret && typeof (ret as { dispose?: () => void }).dispose === 'function') {
      primary = () => (ret as { dispose: () => void }).dispose()
    }
    if (primary) {
      // 插件自带的 dispose 与记录到的 ctx.set 注销器同名（常见：apply 直接 return ctx.set(...)）时去重
      const dup = registered.indexOf(primary)
      if (dup >= 0) registered.splice(dup, 1)
      entry.dispose = () => {
        try {
          primary!()
        } catch (e) {
          console.warn(
            `[plugin-loader] dispose failed for "${entry.manifest.name}":`,
            e instanceof Error ? e.message : e,
          )
        }
        releaseAll()
      }
    }
    entry.active = true
  }

  // 加载单个包目录（共享校验逻辑：manifest 结构 + entry 解析）；
  // 始终以唯一 URL import（见下方说明），因此不再需要调用方区分「首次加载 / 重载」
  const loadPackageDir = async (
    pkgDir: string,
  ): Promise<{ manifest?: PluginPackageManifest; entry?: LoadedEntry; error?: string }> => {
    const manifestPath = path.join(pkgDir, 'plugin.json')
    let raw: any
    try {
      raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
    const manifest = sanitizeManifest(raw)
    if (!manifest) return { error: 'manifest 无效' }
    const entryPath = resolveEntryPath(pkgDir, manifest.entry || 'index.js')
    if (!entryPath) return { manifest, error: '入口路径越界或扩展名不在白名单' }
    let mod: PluginPackageModule
    try {
      // 每次装载/重载都用一个**唯一 URL**（查询串含时间戳 + 自增序号），并在 import 前清掉该包在 CJS 模块缓存
      // （`require.cache`，按**文件路径**为键）中的旧条目：
      //   · 唯一查询串 → 穿透 Node/tsx 的 ESM 模块表（按**完整 URL** 缓存，同 URL 直接返回旧命名空间）；
      //   · 清 CJS 缓存 → 穿透 tsx 把「无 type:module 的 .js」当 CJS 时的按路径缓存（此时查询串无效）。
      // 两者缺一都会让「重装/热更新」拿到**旧模块实例**（新版本 apply 从未执行，故障要等重启才暴露，R2-3）。
      clearPackageModuleCache(pkgDir)
      const url = `${pathToFileURL(entryPath).href}?t=${Date.now()}-${++reloadSeq}`
      mod = (await import(url)) as PluginPackageModule
    } catch (e) {
      return { manifest, error: e instanceof Error ? e.message : String(e) }
    }
    const applyFn = mod.default?.apply || mod.apply
    if (typeof applyFn !== 'function') return { manifest, error: '入口无 apply 函数' }
    return {
      manifest,
      entry: { manifest, applyFn, applied: false, active: false, pkgDir, entryPath },
    }
  }

  async function loadAll(): Promise<LoadedPluginPackage[]> {
    const results: LoadedPluginPackage[] = []
    let subdirs: string[] = []
    try {
      subdirs = (await fs.readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      subdirs = []
    }
    for (const name of subdirs) {
      const pkgDir = path.join(root, name)
      const res = await loadPackageDir(pkgDir)
      if (res.error || !res.entry) {
        results.push({
          manifest: res.manifest ?? { name, title: name, version: '0.0.0' },
          loaded: false,
          error: res.error ?? '加载失败',
        })
        console.warn(`[plugin-loader] failed to load plugin "${name}":`, res.error)
        continue
      }
      packages.set(res.manifest!.name, res.entry)
      // 上报到插件注册表（先记 loaded，激活由 registry 按 enabled 决定）；await 确保注册表先落盘
      await register(res.manifest!, { manifest: res.manifest!, loaded: true })
      results.push({ manifest: res.manifest!, loaded: true })
      console.log(`[plugin-loader] loaded plugin package "${res.manifest!.name}" v${res.manifest!.version}`)
    }
    return results
  }

  // 单包加载：按「目录名（相对 pluginDir）或绝对路径」加载，供安装后局部生效（不重启整个服务）
  async function loadOne(pkgRef: string): Promise<LoadedPluginPackage> {
    const pkgDir = resolvePkgDir(pkgRef)
    if (!pkgDir) {
      const name = path.basename(pkgRef)
      return { manifest: { name, title: name, version: '0.0.0' }, loaded: false, error: '包路径越界或不在插件目录下' }
    }
    const fallback = path.basename(pkgDir)
    const res = await loadPackageDir(pkgDir)
    if (res.error || !res.entry) {
      return {
        manifest: res.manifest ?? { name: fallback, title: fallback, version: '0.0.0' },
        loaded: false,
        error: res.error ?? '加载失败',
      }
    }
    packages.set(res.manifest!.name, res.entry)
    await register(res.manifest!, { manifest: res.manifest!, loaded: true })
    console.log(`[plugin-loader] loaded plugin package "${res.manifest!.name}" v${res.manifest!.version} (loadOne)`)
    return { manifest: res.manifest!, loaded: true }
  }

  // 单包重载：先释放旧实例（不删目录），再重新 import（cache-bust + 清 CJS 缓存）+ 上报；若原实例处于激活态则重新应用，
  // 并**校验激活结果**：加载成功 ≠ 可用。`apply` 抛错时不得静默返回成功（R2-3：更新到「能加载但 apply 抛错」的版本会被误判成功）。
  async function reloadOne(name: string): Promise<LoadedPluginPackage> {
    const existing = packages.get(name)
    const wasActive = existing?.active ?? false
    if (existing) {
      try {
        // 不论 applied 与否都释放：上一次 apply 可能「注册了服务后抛错」，半注册状态必须清掉，
        // 否则本次重载/回滚再注册同名服务会被 cordis 拒绝
        if (existing.dispose) existing.dispose()
      } catch (e) {
        console.warn(`[plugin-loader] dispose failed during reload "${name}":`, e instanceof Error ? e.message : e)
      }
      packages.delete(name)
    }
    const pkgDir = existing?.pkgDir ?? resolvePkgDir(name)
    if (!pkgDir) {
      return { manifest: { name, title: name, version: '0.0.0' }, loaded: false, error: '包目录不存在或路径越界' }
    }
    const res = await loadPackageDir(pkgDir)
    if (res.error || !res.entry) {
      return {
        manifest: res.manifest ?? { name, title: name, version: '0.0.0' },
        loaded: false,
        error: res.error ?? '重载失败',
      }
    }
    packages.set(res.manifest!.name, res.entry)
    await register(res.manifest!, { manifest: res.manifest!, loaded: true })
    // 激活结果校验：原实例为激活态时必须确认新实例真的激活成功；
    // 失败**不吞掉**——错误级日志 + 返回 loaded:false（调用方 service.reloadOne 会抛错，更新分支据此走既有回滚路径）。
    let activated = false
    if (wasActive) {
      try {
        activate(res.manifest!.name)
        activated = true
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(
          `[plugin-loader] plugin "${res.manifest!.name}" v${res.manifest!.version} loaded but failed to activate:`,
          msg,
        )
        return {
          manifest: res.manifest!,
          loaded: false,
          activated: false,
          error: `插件已加载但激活失败（apply 抛错）：${msg}`,
        }
      }
    }
    console.log(`[plugin-loader] reloaded plugin package "${res.manifest!.name}" v${res.manifest!.version}`)
    return { manifest: res.manifest!, loaded: true, activated }
  }

  // 激活插件包（启用时调用）：首次才注册服务，后续仅置 active。
  // `apply` 抛错时**向上传播**（不吞）：启动期由 index.ts 的逐包 try/catch 收敛为错误日志（进程不终止），
  // 更新期由 `reloadOne` 捕获后转为 `loaded:false` 失败结果（触发既有回滚）。
  function activate(name: string): boolean {
    const entry = packages.get(name)
    if (!entry) return false
    if (!entry.applied) {
      runApply(entry)
      entry.applied = true
      console.log(`[plugin-loader] applied service "${name}"`)
    }
    entry.active = true
    return true
  }

  // 停用插件包（禁用时调用）：置 active=false；服务保留（前台面板可见性由注册表控制）
  function deactivate(name: string): boolean {
    const entry = packages.get(name)
    if (!entry) return false
    entry.active = false
    console.log(`[plugin-loader] deactivated "${name}"`)
    return true
  }

  // 卸载插件包：释放实例（dispose）+ 从内存移除 + 物理删除目录（仅限插件根下，防穿越）
  async function uninstall(name: string): Promise<PluginUninstallResult> {
    const entry = packages.get(name)
    if (!entry) {
      // 未加载的目录包（如商店目录元数据条目）：无目录可删
      return { handled: false, ok: true }
    }
    // 先校验目录在插件根内（防御性：避免越界时已释放/移除内存但未删目录的半状态）
    if (!isWithinRoot(entry.pkgDir)) {
      console.error(`[plugin-loader] refuse to delete "${entry.pkgDir}" (outside plugin dir root)`)
      return { handled: true, ok: false, error: '目录越界，已拒绝删除' }
    }
    try {
      // 不论 applied 与否都释放（含「注册了服务后 apply 抛错」的半注册状态）
      if (entry.dispose) entry.dispose()
    } catch (e) {
      console.warn(`[plugin-loader] dispose failed during uninstall "${name}":`, e instanceof Error ? e.message : e)
    }
    packages.delete(name)
    try {
      await fs.rm(entry.pkgDir, { recursive: true, force: true })
      console.log(`[plugin-loader] uninstalled package "${name}": directory removed`)
      return { handled: true, ok: true }
    } catch (e) {
      console.error(`[plugin-loader] failed to remove directory "${entry.pkgDir}":`, e instanceof Error ? e.message : e)
      return { handled: true, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // 丢弃内存中的包实例（**不删目录**）：安装/更新失败回滚时清掉本次尝试装入的半状态。
  // 与 uninstall 的区别：uninstall 会释放实例 + 删目录；discard 只清内存表（磁盘由注册表回滚处理）。
  function discard(name: string): boolean {
    const entry = packages.get(name)
    if (!entry) return false
    try {
      // 不论 applied 与否都释放：apply 抛错前已注册的服务也要清掉（否则重装/回滚再注册同名服务会被 cordis 拒绝）
      if (entry.dispose) entry.dispose()
    } catch (e) {
      console.warn(`[plugin-loader] dispose failed during discard "${name}":`, e instanceof Error ? e.message : e)
    }
    packages.delete(name)
    console.log(`[plugin-loader] discarded in-memory package instance "${name}" (install rollback)`)
    return true
  }

  return { loadAll, loadOne, reloadOne, activate, deactivate, uninstall, discard }
}
