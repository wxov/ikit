import { Schema } from 'cordis'
import type { Context } from 'cordis'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { JsonPluginStore } from './store.js'
import { createPluginRegistry } from './service.js'
import { createPluginPackageLoader } from './loader.js'
import { BUILTIN_TRUSTED_KEYS, resolveTrustedKeys } from './trusted-keys.js'
import { normalizeSignatureMode } from './signing.js'
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
  /**
   * 静态插件市场目录源 URL（registry.json）；空=关闭远端源。
   * 注意：优先读 process.env.PLUGIN_REGISTRY_URL，本项仅作兜底（二选一）。
   */
  registryUrl?: string
  /** 本地调试豁免：允许 http:// 明文下载插件包（生产环境请勿开启） */
  allowHttp?: boolean
  /**
   * 插件验签策略（完善⑥）：off | warn | enforce。默认 warn（验签但不拒装，仅状态+日志+徽标）。
   * 注意：优先读 process.env.PLUGIN_SIGNATURE_MODE，本项仅作兜底（二选一）。
   */
  signatureMode?: string
  /**
   * 信任表（keyId → 公钥）：供 JSON 配置注入；env PLUGIN_SIGNING_KEYS 优先级更高。
   * 公钥可接受 PEM（含字面 \n 的单行）或 base64 SPKI；keyId 必须等于派生值，否则该项被忽略。
   */
  trustedKeys?: Record<string, string>
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  pluginDir: Schema.string().default('./plugins'),
  registryUrl: Schema.string().default(''),
  allowHttp: Schema.boolean().default(false),
  signatureMode: Schema.string().default('warn'),
  trustedKeys: Schema.dict(Schema.string()).default({}),
})

export function apply(ctx: Context, config: Config) {
  const dataDir = config.dataDir || './data'
  mkdirSync(dataDir, { recursive: true })
  const store = new JsonPluginStore(path.join(dataDir, 'plugins.json'))

  // 远端静态目录源：优先读环境变量 PLUGIN_REGISTRY_URL，其次 Config.registryUrl（二选一，env 优先）
  const registryUrl = (process.env.PLUGIN_REGISTRY_URL || config.registryUrl || '').trim()
  // 本地调试豁免：Config.allowHttp 或环境变量 PLUGIN_REGISTRY_ALLOW_HTTP=1
  const allowHttp = !!config.allowHttp || process.env.PLUGIN_REGISTRY_ALLOW_HTTP === '1'

  // ---- 插件签名（完善⑥）----
  // 策略：env PLUGIN_SIGNATURE_MODE 优先于 Config.signatureMode（默认 warn）；非法值按 warn 处理
  const signatureMode = normalizeSignatureMode(process.env.PLUGIN_SIGNATURE_MODE || config.signatureMode)
  // 信任表：内置常量 ∪ env 三键（PLUGIN_SIGNING_KEYS 优先于 PUBKEY(_FILE)）；Config.trustedKeys 仅作 PLUGIN_SIGNING_KEYS 的兜底
  const configKeysJson =
    config.trustedKeys && Object.keys(config.trustedKeys).length ? JSON.stringify(config.trustedKeys) : ''
  const trustedKeys = resolveTrustedKeys({
    builtin: BUILTIN_TRUSTED_KEYS,
    json: process.env.PLUGIN_SIGNING_KEYS || configKeysJson,
    pem: process.env.PLUGIN_SIGNING_PUBKEY,
    pemFile: process.env.PLUGIN_SIGNING_PUBKEY_FILE,
  })

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

  const registry = createPluginRegistry(store, defaults, {
    pluginDir: config.pluginDir || './plugins',
    registryUrl,
    allowHttp,
    signatureMode,
    trustedKeys,
  })
  ctx.set('pluginRegistry', registry)

  // 加载第三方插件包：扫描 pluginDir，动态 import 入口，注册到注册表
  const pluginDir = config.pluginDir || './plugins'
  const loader = createPluginPackageLoader(ctx, pluginDir, (manifest, res) => {
    if (res.loaded) {
      // 先记录到注册表，再根据注册表 enabled 状态决定是否激活服务（await 由 loader 保证）
      // F1：**不**上报 manifest.sha256（包内自报值不可信）——服务端安装时计算的哈希是唯一权威，
      // 否则每次启动 loadAll 都会用包自报的假哈希覆盖 plugins.json 中的真实值。
      return registry.upsertPackage({
        name: manifest.name,
        title: manifest.title,
        version: manifest.version,
        panel: manifest.panel,
        description: manifest.description,
        author: manifest.author,
        category: manifest.category,
        deps: manifest.deps,
        minIkit: manifest.minIkit,
        minVersion: manifest.minVersion,
      })
    }
  })
  // 联动：注册表启/禁/卸/单包载入/重载 → 插件包服务热装/热卸
  registry.setLoaderHooks({
    onEnable: (name) => loader.activate(name),
    onDisable: (name) => loader.deactivate(name),
    onUninstall: (name) => loader.uninstall(name),
    onLoadOne: (pkgRef) => loader.loadOne(pkgRef),
    onReloadOne: (name) => loader.reloadOne(name),
    // 安装/更新失败回滚：丢弃本次尝试装入内存的失败包（目录与记录已由注册表回滚）
    onDiscard: (name) => loader.discard(name),
  })
  void loader.loadAll().then(() => {
    // 加载完成后，按注册表中的 enabled 态决定是否激活各包（默认启用的包激活其服务）
    for (const p of registry.list()) {
      if (!p.enabled) continue
      try {
        loader.activate(p.name)
      } catch (e) {
        // 启动期 apply 抛错：目录与记录都真实存在（**不是**幽灵记录），因此**保留记录不删**
        // （删除会丢 sha256/签名/order/visibleGroups 等唯一权威字段，且下次启动扫描又会重建 → 反复抖动）。
        // 这里只做逐包隔离：把异常收敛为该插件的错误日志，避免未处理拒绝（Node 默认会终止进程）
        // 阻断后续插件的激活。
        console.error(
          `[plugin-registry] failed to activate plugin "${p.name}" on startup:`,
          e instanceof Error ? e.message : e,
        )
      }
    }
  })

  console.log(
    `[plugin-registry] plugin started (signature mode=${signatureMode}, trustedKeys=${Object.keys(trustedKeys).length})`,
  )
  ctx.on('dispose', () => {
    console.log('[plugin-registry] plugin disposed')
  })
}

export default { name, apply, Config }
export type {
  PluginRecord,
  PluginRole,
  PluginRegistryService,
  PluginInstallResult,
  ScanSummary,
  PluginSignatureStatus,
  SignatureMode,
  SignatureVerdict,
} from './types.js'
export { BUILTIN_TRUSTED_KEYS } from './trusted-keys.js'
