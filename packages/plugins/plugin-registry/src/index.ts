import { Schema } from 'cordis'
import type { Context } from 'cordis'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { JsonPluginStore } from './store.js'
import { createPluginRegistry } from './service.js'
import { createPluginPackageLoader } from './loader.js'
import type { PluginRecord } from './types.js'

declare module 'cordis' {
  interface Context {
    pluginRegistry: ReturnType<typeof createPluginRegistry>
  }
}

export const name = 'plugin-registry'

export interface Config {
  dataDir?: string
  /** 第三方插件包目录（含 plugin.json + entry 的包） */
  pluginDir?: string
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  pluginDir: Schema.string().default('./plugins'),
})

export function apply(ctx: Context, config: Config) {
  const dataDir = config.dataDir || './data'
  mkdirSync(dataDir, { recursive: true })
  const store = new JsonPluginStore(path.join(dataDir, 'plugins.json'))

  // 默认插件（agent 为系统内置，不可卸载；knowledge 已抽取为默认功能，不在插件库管理）
  const defaults: PluginRecord[] = [
    {
      name: 'agent',
      title: 'AI Agent',
      version: '0.1.3',
      enabled: true,
      builtin: true,
      order: 2,
      visibleGroups: ['guest', 'user', 'admin'],
      panel: 'agent',
    },
  ]

  const registry = createPluginRegistry(store, defaults)
  ctx.set('pluginRegistry', registry)

  // 加载第三方插件包：扫描 pluginDir，动态 import 入口，注册到注册表
  const pluginDir = config.pluginDir || './plugins'
  const loader = createPluginPackageLoader(ctx, pluginDir, (manifest, res) => {
    if (res.loaded) {
      // 先记录到注册表，再根据注册表 enabled 状态决定是否激活服务
      void registry.upsertPackage({
        name: manifest.name,
        title: manifest.title,
        version: manifest.version,
        panel: manifest.panel,
      })
    }
  })
  // 联动：注册表启/禁/卸 → 插件包服务热装/热卸
  registry.setLoaderHooks({
    onEnable: (name) => loader.activate(name),
    onDisable: (name) => loader.deactivate(name),
    onUninstall: (name) => loader.uninstall(name),
  })
  void loader.loadAll().then(() => {
    // 加载完成后，按注册表中的 enabled 态决定是否激活各包（默认启用的包激活其服务）
    for (const p of registry.list()) {
      if (p.enabled) loader.activate(p.name)
    }
  })

  console.log('[plugin-registry] plugin started')
  ctx.on('dispose', () => {
    console.log('[plugin-registry] plugin disposed')
  })
}

export default { name, apply, Config }
export type { PluginRecord, PluginRole, PluginRegistryService } from './types.js'
