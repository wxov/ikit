// 后端插件包加载规范：
// 一个插件包 = 目录，含：
//   plugin.json  ：{ name, title, version, description, panel, entry, ... }
//   entry 指向的模块：export default { name, apply(ctx, config) }（apply 可返回 { dispose } 或 dispose 函数）
// 加载器扫描目录，动态 import 入口，校验 manifest，并支持按状态热注册/热卸载服务。
import { promises as fs } from 'node:fs'
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

  // 判断 target 是否落在插件目录根下（防路径穿越）
  const isWithinRoot = (target: string): boolean => {
    const resolved = path.resolve(target)
    return resolved === root || resolved.startsWith(root + path.sep)
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

  // 应用入口：调用插件 apply(ctx, config)，捕获返回的 dispose（服务注册一次；停用/卸载由注册表控制面板可见性）
  const runApply = (entry: LoadedEntry) => {
    const ret = entry.applyFn(ctx, { manifest: entry.manifest })
    if (typeof ret === 'function') entry.dispose = ret as () => void
    else if (ret && typeof ret.dispose === 'function') entry.dispose = () => (ret as { dispose: () => void }).dispose()
    entry.active = true
  }

  // 加载单个包目录（共享校验逻辑：manifest 结构 + entry 解析）
  const loadPackageDir = async (
    pkgDir: string,
    cacheBust = false,
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
      const url = pathToFileURL(entryPath).href + (cacheBust ? `?t=${Date.now()}` : '')
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

  // 单包重载：先释放旧实例（不删目录），再重新 import（cache-bust）+ 上报；若原实例处于激活态则重新应用
  async function reloadOne(name: string): Promise<LoadedPluginPackage> {
    const existing = packages.get(name)
    const wasActive = existing?.active ?? false
    if (existing) {
      try {
        if (existing.applied && existing.dispose) existing.dispose()
      } catch (e) {
        console.warn(`[plugin-loader] dispose failed during reload "${name}":`, e instanceof Error ? e.message : e)
      }
      packages.delete(name)
    }
    const pkgDir = existing?.pkgDir ?? resolvePkgDir(name)
    if (!pkgDir) {
      return { manifest: { name, title: name, version: '0.0.0' }, loaded: false, error: '包目录不存在或路径越界' }
    }
    const res = await loadPackageDir(pkgDir, true)
    if (res.error || !res.entry) {
      return {
        manifest: res.manifest ?? { name, title: name, version: '0.0.0' },
        loaded: false,
        error: res.error ?? '重载失败',
      }
    }
    packages.set(res.manifest!.name, res.entry)
    await register(res.manifest!, { manifest: res.manifest!, loaded: true })
    if (wasActive) activate(res.manifest!.name)
    console.log(`[plugin-loader] reloaded plugin package "${res.manifest!.name}" v${res.manifest!.version}`)
    return { manifest: res.manifest!, loaded: true }
  }

  // 激活插件包（启用时调用）：首次才注册服务，后续仅置 active
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
      if (entry.applied && entry.dispose) entry.dispose()
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

  return { loadAll, loadOne, reloadOne, activate, deactivate, uninstall }
}
