// 后端插件包加载规范：
// 一个插件包 = 目录，含：
//   plugin.json  ：{ name, title, version, description, panel, entry }
//   entry 指向的模块：export default { name, apply(ctx, config) }（可返回 { dispose } 或注册 ctx.on('dispose')）
// 加载器扫描目录，动态 import 入口，校验 manifest，并支持按状态热注册/热卸载服务。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'cordis'

export interface PluginPackageManifest {
  name: string
  title: string
  version: string
  description?: string
  panel?: string
  entry?: string
  permission?: string[]
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
}

const SAFE_KEYS = ['name', 'title', 'version', 'description', 'panel', 'entry', 'permission']

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
  }
}

export function createPluginPackageLoader(
  ctx: Context,
  dir: string,
  register: (m: PluginPackageManifest, loaded: LoadedPluginPackage) => void,
) {
  const packages = new Map<string, LoadedEntry>()

  // 应用入口：调用插件 apply(ctx, config)（服务注册一次；停用/卸载由注册表控制面板可见性）
  const runApply = (entry: LoadedEntry) => {
    entry.applyFn(ctx, { manifest: entry.manifest })
    entry.active = true
  }

  async function loadAll(): Promise<LoadedPluginPackage[]> {
    const results: LoadedPluginPackage[] = []
    let subdirs: string[] = []
    try {
      subdirs = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      subdirs = []
    }
    for (const name of subdirs) {
      const pkgDir = path.join(dir, name)
      const manifestPath = path.join(pkgDir, 'plugin.json')
      try {
        const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
        const manifest = sanitizeManifest(raw)
        if (!manifest) {
          results.push({ manifest: { name, title: name, version: '0.0.0' }, loaded: false, error: 'manifest 无效' })
          continue
        }
        const entryPath = path.join(pkgDir, manifest.entry || 'index.js')
        const mod = (await import(pathToFileURL(entryPath).href)) as PluginPackageModule
        const applyFn = mod.default?.apply || mod.apply
        if (typeof applyFn !== 'function') {
          results.push({ manifest, loaded: false, error: '入口无 apply 函数' })
          continue
        }
        packages.set(manifest.name, { manifest, applyFn, applied: false, active: false })
        // 上报到插件注册表（先记 loaded，激活由 registry 按 enabled 决定）
        register(manifest, { manifest, loaded: true })
        results.push({ manifest, loaded: true })
        console.log(`[plugin-loader] loaded plugin package "${manifest.name}" v${manifest.version}`)
      } catch (e) {
        results.push({
          manifest: { name, title: name, version: '0.0.0' },
          loaded: false,
          error: e instanceof Error ? e.message : String(e),
        })
        console.warn(`[plugin-loader] failed to load plugin "${name}":`, e instanceof Error ? e.message : e)
      }
    }
    return results
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

  // 卸载插件包：停用并从内存移除（重启不再加载除非目录仍在）
  function uninstall(name: string): boolean {
    deactivate(name)
    return packages.delete(name)
  }

  return { loadAll, activate, deactivate, uninstall }
}
