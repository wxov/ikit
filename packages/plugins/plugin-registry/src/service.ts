// 插件注册表服务
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  PluginConfig,
  PluginInstallInput,
  PluginInstallResult,
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
import { PLUGIN_ERR, PluginError } from './errors.js'
import { scanPackageCode, type ScanSummary } from './scanner.js'
import { compareSemver, SHA256_HEX_RE, isSha256Hex, isWithinDir, normalizeRelPath } from './utils.js'
import {
  buildSignatureComment,
  normalizeSignatureMode,
  parseSignatureInput,
  verifyTreeSignature,
  type PluginSignatureStatus,
  type SignatureEnvelope,
  type SignatureInput,
  type SignatureMode,
  type SignatureVerdict,
  type TrustedKeyTable,
} from './signing.js'
import { BUILTIN_TRUSTED_KEYS, resolveTrustedKeys } from './trusted-keys.js'
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
  /** 验签策略（off/warn/enforce，默认 warn）；未传时读 PLUGIN_SIGNATURE_MODE */
  signatureMode?: SignatureMode | string
  /** 信任表（keyId → 公钥/状态）；未传时由 PLUGIN_SIGNING_* 三键 + 内置表解析 */
  trustedKeys?: TrustedKeyTable
}

/** 一次验签判定结果（verdict 落库/回响应；envelope 为原始签名值来源，供导出保留） */
interface ResolvedSignature {
  verdict: SignatureVerdict
  envelope?: SignatureEnvelope
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
      // 签名字段（完善⑥）透传：缺则 undefined（不丢弃条目，便于管理员看到原因）
      signature: typeof p.signature === 'string' ? p.signature : undefined,
      keyId: typeof p.keyId === 'string' ? p.keyId : undefined,
      signedHash: typeof p.signedHash === 'string' ? p.signedHash : undefined,
      signedAt: typeof p.signedAt === 'string' ? p.signedAt : undefined,
      schema: typeof p.schema === 'number' ? p.schema : undefined,
      alg: typeof p.alg === 'string' ? p.alg : undefined,
    })
  }
  return out
}

/**
 * 危险 API 扫描的降级封装：扫描函数自身异常时只产出「扫描失败」警告，**不阻断**安装。
 */
function safeScan(files: ExtractedFile[], entry: string | undefined): ScanSummary {
  try {
    return scanPackageCode(files, entry || 'index.js')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[plugin-registry] 安全扫描失败（不影响安装）: ${msg}`)
    return {
      warnings: [`安全扫描失败：${msg}（不影响安装）`],
      scannedAt: new Date().toISOString(),
      scannedFiles: [],
      truncatedFiles: [],
      truncated: false,
    }
  }
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
  // ---- 签名策略与信任表（完善⑥）：off=不验签（完全等价现状）/ warn=验签不拒装（默认）/ enforce=拒装 ----
  const signatureMode = normalizeSignatureMode(
    options.signatureMode !== undefined ? options.signatureMode : process.env.PLUGIN_SIGNATURE_MODE,
  )
  const trustedKeys: TrustedKeyTable =
    options.trustedKeys ??
    resolveTrustedKeys({
      builtin: BUILTIN_TRUSTED_KEYS,
      json: process.env.PLUGIN_SIGNING_KEYS,
      pem: process.env.PLUGIN_SIGNING_PUBKEY,
      pemFile: process.env.PLUGIN_SIGNING_PUBKEY_FILE,
    }) ??
    {}
  if (signatureMode !== 'off') {
    const ids = Object.keys(trustedKeys)
    console.log(
      `[plugin-registry] signature mode=${signatureMode} trustedKeys=${ids.length}${ids.length ? ` (${ids.join('、')})` : ''}`,
    )
    if (!ids.length) {
      console.warn(
        '[plugin-registry][signature] 未配置任何签名公钥（PLUGIN_SIGNING_PUBKEY / _PUBKEY_FILE / _KEYS 与内置信任表均为空），签名一律无法验证（状态记为 unverified）',
      )
    }
  }

  /**
   * 统一签名判定（远端安装与本地导入共用，调用点一律在 `installFilesAtomically` 落盘**之前**）。
   * 优先级：API 请求体签名字段 > zip archive comment；`off` 模式返回 undefined（不验签、不写任何签名字段）。
   * `enforce` 模式下失败即抛 `PluginError`（带 PLUGIN_SIGNATURE_* 码）→ 路由 400 且磁盘零副作用。
   * 严格顺序：信封格式 → keyId 查表 → signedHash 一致 → crypto.verify（见 signing.verifyTreeSignature）。
   */
  const resolveSignature = (args: {
    name: string
    treeSha256: string
    source: PluginSource
    /** zip comment 中的信封（packaging.validateZipBuffer 已解析） */
    zipEnvelope?: SignatureEnvelope
    /** zip comment 前缀匹配但信封非法时的说明 */
    zipEnvelopeError?: string
    /** API 请求体平铺字段解析出的信封（优先） */
    bodyEnvelope?: SignatureEnvelope
    bodyError?: string
  }): ResolvedSignature | undefined => {
    if (signatureMode === 'off') return undefined
    const bodyEnv = args.bodyEnvelope
    const zipEnv = args.zipEnvelope
    if (bodyEnv && zipEnv && (bodyEnv.signature !== zipEnv.signature || bodyEnv.keyId !== zipEnv.keyId || bodyEnv.signedHash !== zipEnv.signedHash)) {
      console.warn(
        `[plugin-registry][signature] "${args.name}": 请求体签名与包内 zip comment 签名不一致，以请求体为准`,
      )
    }
    const envelope = bodyEnv ?? zipEnv
    let verdict: SignatureVerdict
    if (envelope) {
      verdict = verifyTreeSignature({ treeSha256: args.treeSha256, envelope, trustedKeys })
    } else if (args.bodyError || args.zipEnvelopeError) {
      verdict = { status: 'invalid', error: args.bodyError ?? args.zipEnvelopeError, malformed: true }
    } else {
      verdict = { status: 'unsigned' }
    }

    if (signatureMode === 'enforce' && verdict.status !== 'verified') {
      // enforce：未签名 / 密钥未知 / 空信任表无法验证 / 格式非法 / 验签失败 一律拒装
      const code =
        verdict.status === 'unsigned'
          ? PLUGIN_ERR.SIGNATURE_REQUIRED
          : verdict.status === 'unknown-key' || verdict.status === 'unverified'
            ? PLUGIN_ERR.SIGNATURE_KEY_UNKNOWN
            : verdict.malformed
              ? PLUGIN_ERR.SIGNATURE_MALFORMED
              : PLUGIN_ERR.SIGNATURE_INVALID
      const message =
        verdict.status === 'unsigned'
          ? '当前策略要求插件签名（PLUGIN_SIGNATURE_MODE=enforce），该包未携带签名，已拒绝安装。请使用带签名的包或改用已受信任密钥签名后重试'
          : verdict.status === 'unverified'
            ? `签名密钥未受信任：当前实例未配置任何签名公钥（PLUGIN_SIGNING_PUBKEY / _PUBKEY_FILE / _KEYS 与内置信任表均为空），无法验证 keyId=${verdict.keyId ?? '-'}`
            : verdict.error || '验签失败，已拒绝安装'
      throw new PluginError(message, code)
    }

    // 日志：任何分支都不输出密钥内容（仅 keyId / 哈希前 8 位）
    const line = `[plugin-registry][signature] install "${args.name}" mode=${signatureMode} source=${args.source} status=${verdict.status} keyId=${verdict.keyId ?? '-'} hash=${args.treeSha256.slice(0, 8)}…`
    if (verdict.status === 'verified') {
      console.log(`${line}${verdict.warning ? ` warning=${verdict.warning}` : ''}`)
    } else {
      console.warn(`${line}${verdict.error ? ` error=${verdict.error}` : ''}${verdict.warning ? ` warning=${verdict.warning}` : ''}`)
    }
    return { verdict, envelope }
  }

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

  /**
   * 未安装的远端条目：按其声明的签名字段推断展示状态。
   * **不做任何加密/哈希运算**（store()/list() 是读路径，只查 keyId 表 + 字段格式）：
   * 无签名 → unsigned；信封非法 → invalid；信任表空 → unverified；keyId 未知 → unknown-key；其余 → unverified。
   */
  const declaredSignatureStatus = (r: RemoteRegistryPlugin): PluginSignatureStatus => {
    const parsed = parseSignatureInput({
      signature: r.signature,
      keyId: r.keyId,
      signedHash: r.signedHash,
      signedAt: r.signedAt,
      schema: r.schema,
      alg: r.alg,
    })
    if (parsed.error) return 'invalid'
    if (!parsed.envelope) return 'unsigned'
    if (Object.keys(trustedKeys).length === 0) return 'unverified'
    return trustedKeys[parsed.envelope.keyId] ? 'unverified' : 'unknown-key'
  }

  /** 已装记录：取安装时落库结论；旧记录（本功能上线前）按「有无原始签名」回推 */
  const recordedSignatureStatus = (p: PluginRecord): PluginSignatureStatus =>
    p.signatureStatus ?? (p.signature ? 'unverified' : 'unsigned')

  /**
   * enforce 模式下的「签名不可安装」原因（复用 ⑤ 的 installable/blockedReason 单一事实源，前端不重复判断策略）；
   * 非 enforce 或状态为 verified 时返回 undefined。
   */
  const signatureBlockReason = (status: PluginSignatureStatus | undefined, keyId?: string): string | undefined => {
    if (signatureMode !== 'enforce' || status === undefined || status === 'verified') return undefined
    if (status === 'unsigned') return '未签名：当前策略要求插件签名（PLUGIN_SIGNATURE_MODE=enforce）'
    if (status === 'unknown-key') return `签名密钥未受信任（${keyId || '未知 keyId'}）`
    if (status === 'invalid') return '验签失败：签名与内容不匹配或签名信封非法'
    // unverified：仅「信任表为空 → 无法验证」时视为不可安装（密钥已知时的 unverified 已是安装后结论，不拦）
    return Object.keys(trustedKeys).length === 0 ? '签名无法验证：未配置任何签名公钥（信任表为空）' : undefined
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
        scanWarnings: installed?.scanWarnings,
        scannedAt: installed?.scannedAt,
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
      const installed = byName.get(r.name)
      // 缺 sha256 的远端条目**不丢弃**（管理员需可见可排查），但明确标注不可安装
      const hasSha = isSha256Hex(r.sha256)
      // 已装 → 用安装时落库结论；未装 → 按条目声明推断（两者都只查表，不做加密运算）
      const sigStatus = installed ? recordedSignatureStatus(installed) : declaredSignatureStatus(r)
      const sigReason = signatureBlockReason(sigStatus, r.keyId ?? installed?.signerKeyId)
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
            signatureStatus: sigStatus,
            signerKeyId: r.keyId ?? installed?.signerKeyId,
            signedAt: r.signedAt ?? installed?.signedAt,
            signatureVerifiedAt: installed?.signatureVerifiedAt,
            signatureError: installed?.signatureError,
            // 签名原因优先展示（enforce 下）；sha256 缺失始终不可安装
            installable: hasSha && !sigReason,
            blockedReason:
              sigReason ??
              (hasSha
                ? undefined
                : '缺少 sha256 校验值，已按安全策略禁止安装（请在 registry.json 为该版本补充 sha256）'),
          },
          'remote',
        ),
      )
    }
    // 3) 已安装的第三方包（local/remote，未在上面列出者），供导出/卸载/更新
    for (const p of config.plugins) {
      if (seen.has(p.name) || p.builtin) continue
      seen.add(p.name)
      // 已装的远端包若无 sha256：不可更新（更新同样会走强制校验），引导卸载后重装
      const remoteWithoutSha = p.source === 'remote' && !isSha256Hex(p.sha256)
      const sigStatus = recordedSignatureStatus(p)
      const sigReason = signatureBlockReason(sigStatus, p.signerKeyId)
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
        signatureStatus: sigStatus,
        signerKeyId: p.signerKeyId,
        signedAt: p.signedAt,
        signatureVerifiedAt: p.signatureVerifiedAt,
        signatureError: p.signatureError,
        rating: ratingOf(p.name),
        ratingCount: reviewsOf(p.name).length,
        reviews: reviewsOf(p.name),
        installable: !remoteWithoutSha && !sigReason,
        blockedReason:
          sigReason ??
          (remoteWithoutSha ? '缺少 sha256，无法更新；卸载后从带校验值的目录源重装' : undefined),
        scanWarnings: p.scanWarnings,
        scannedAt: p.scannedAt,
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
  /**
   * 单包重载（经 loader 钩子；失败抛错）。
   * `opts.requireActive` = 该包在注册表里应为**启用态**（更新分支按失败前的记录传 `enabled`）：
   * 此时「加载成功」还不够，必须确认实例**已激活**（`apply` 成功）——否则抛错，让 `installFilesAtomically`
   * 的更新分支走既有回滚路径（目录 + 旧版本 reload + 记录 restoreRecord）。覆盖两种形态：
   *   ① loader 内 activate 抛错 → `res.loaded === false`（loader 已把 `apply` 异常转为失败结果）；
   *   ② 记录启用但 loader 内存实例未激活（如上次启动激活失败留下的包被更新）→ 此处补激活并校验返回值。
   */
  const reloadOne = async (name: string, opts?: { requireActive?: boolean }): Promise<void> => {
    if (!loaderHooks.onReloadOne) throw new Error('加载器未就绪')
    const res = await loaderHooks.onReloadOne(name)
    if (!res.loaded) throw new Error(res.error || '插件重载失败')
    if (opts?.requireActive) {
      let ok: boolean | undefined
      try {
        ok = loaderHooks.onEnable?.(name)
      } catch (e) {
        throw new Error(`插件已重载但激活失败（apply 抛错）：${e instanceof Error ? e.message : String(e)}`)
      }
      if (ok === false) throw new Error('插件已重载但未能激活（加载器内存中不存在该包实例）')
    }
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
      // 扫描字段：undefined 不清空（保护 loader loadAll 上报路径，避免每次启动抹掉安装期扫描结果）
      if (p.scanWarnings !== undefined) existing.scanWarnings = p.scanWarnings
      if (p.scannedAt) existing.scannedAt = p.scannedAt
      // 签名字段（完善⑥）：undefined 不清空（loader 启动上报不带签名字段，避免每次重启抹掉安装期结论）；
      // null = 显式清除（安装/导入路径重算结论时用，例如从上一次的 verified 变为 invalid）
      if (p.signatureStatus !== undefined) existing.signatureStatus = p.signatureStatus
      if (p.signerKeyId !== undefined) existing.signerKeyId = p.signerKeyId ?? undefined
      if (p.signedAt !== undefined) existing.signedAt = p.signedAt ?? undefined
      if (p.signatureVerifiedAt !== undefined) existing.signatureVerifiedAt = p.signatureVerifiedAt ?? undefined
      if (p.signatureError !== undefined) existing.signatureError = p.signatureError ?? undefined
      if (p.signature !== undefined) existing.signature = p.signature ?? undefined
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
        scanWarnings: p.scanWarnings,
        scannedAt: p.scannedAt,
        signatureStatus: p.signatureStatus,
        signerKeyId: p.signerKeyId ?? undefined,
        signedAt: p.signedAt ?? undefined,
        signatureVerifiedAt: p.signatureVerifiedAt ?? undefined,
        signatureError: p.signatureError ?? undefined,
        signature: p.signature ?? undefined,
      })
    }
    await persist()
    return config.plugins
  }

  /**
   * 注册记录快照（深拷贝）：安装/导入/更新落盘前的**唯一回滚依据**。
   * 只快照本次尝试涉及的那一条记录（不整表快照），保证「回滚只影响本次尝试」。
   */
  const snapshotRecord = (name: string): PluginRecord | undefined => {
    const rec = config.plugins.find((x) => x.name === name)
    return rec ? structuredClone(rec) : undefined
  }

  /**
   * 把注册记录回滚到快照（幂等；只影响 `name` 这一条记录，其它记录/数组顺序不动）：
   * - 快照为 `undefined` = 本次尝试**新建**了记录 → 删除（不留幽灵条目）；
   * - 快照存在 = 本次尝试**修改/替换**了旧记录 → **原地**逐字段恢复
   *   （保留数组位置与对象标识；`sha256`/签名/`installedAt`/`updatedAt`/`enabled` 等一并还原，
   *   不残留本次失败尝试的痕迹）；
   * - 记录已不在（理论不可达）→ 按快照重新插入，保证幂等。
   * 写盘失败只告警：不掩盖调用方正在抛出的原始安装错误。
   */
  const restoreRecord = async (name: string, before: PluginRecord | undefined): Promise<void> => {
    const idx = config.plugins.findIndex((x) => x.name === name)
    if (before === undefined) {
      if (idx < 0) return
      config.plugins.splice(idx, 1)
    } else if (idx < 0) {
      config.plugins.push(structuredClone(before))
    } else {
      const target = config.plugins[idx] as unknown as Record<string, unknown>
      for (const k of Object.keys(target)) delete target[k]
      Object.assign(target, structuredClone(before))
    }
    try {
      await persist()
    } catch (e) {
      console.warn(
        `[plugin-registry] 回滚注册记录写盘失败 "${name}":`,
        e instanceof Error ? e.message : e,
      )
    }
  }

  // 校验后的文件树落盘 + 原子替换 + 单包热载（导入与远端市场共用）；返回本次安全扫描摘要与验签结论
  const installFilesAtomically = async (
    manifest: PluginPackageManifest,
    files: ExtractedFile[],
    source: PluginSource,
    packageUrl: string | undefined,
    treeSha256: string,
    sig?: ResolvedSignature,
  ): Promise<{ scan: ScanSummary; signature?: SignatureVerdict }> => {
    if (!pluginDir) throw new Error('插件目录未配置')
    const name = manifest.name
    await ensureLoaded()
    // 落盘/热载前的注册记录快照：失败时据此精确回滚（见 restoreRecord）。
    // 覆盖路径：loadOne → register → upsertPackage 先落盘记录、随后 apply 抛错的幽灵记录缺陷。
    const recordBefore = snapshotRecord(name)
    // 安全扫描：落盘前对代码文件做启发式扫描（仅产警告，不阻断；扫描自身异常降级为「扫描失败」）
    const scan = safeScan(files, manifest.entry)
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
        // 更新：备份旧目录 → 替换 → reloadOne；失败回滚保留旧版（目录 + 注册记录 + 旧实例服务）
        await fs.rename(target, backup)
        let moved = false
        try {
          await fs.rename(staging, target)
          moved = true
          // R2-3：更新分支必须校验**激活结果**（不只是「能加载」）。失败前的记录为启用态时要求新实例激活成功，
          // 否则 reloadOne 抛错 → 走下方既有回滚路径（还原目录 → reloadOne 旧版 → 恢复旧服务 → restoreRecord）。
          await reloadOne(name, { requireActive: !!recordBefore?.enabled })
        } catch (e) {
          if (moved) await fs.rm(target, { recursive: true, force: true }).catch(() => {})
          await fs.rename(backup, target).catch(() => {})
          // 旧目录已回位：重新 import 旧入口（reloadOne 会按旧 manifest 回写记录，
          // 随后由外层 catch 的 restoreRecord 精确还原记录全部字段）；
          // 旧版本原为启用态时再 apply 一次，恢复其服务（reloadOne 不会激活未曾激活过的入口）
          try {
            await reloadOne(name)
            if (recordBefore?.enabled) loaderHooks.onEnable?.(name)
          } catch (restoreErr) {
            console.warn(
              `[plugin-registry] 更新失败后恢复旧版本实例失败 "${name}":`,
              restoreErr instanceof Error ? restoreErr.message : restoreErr,
            )
          }
          throw e
        }
        await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
      } else {
        // 全新安装：落位后 loadOne；失败删除目标目录 + 丢弃 loader 内存半状态（记录由外层 catch 回滚）
        await fs.rename(staging, target)
        try {
          await loadOne(name)
        } catch (e) {
          await fs.rm(target, { recursive: true, force: true }).catch(() => {})
          // register 已把本次失败的包装入 loader 内存（apply 抛错）→ 丢弃，避免残留指向已删除目录的实例
          try {
            loaderHooks.onDiscard?.(name)
          } catch (discardErr) {
            console.warn(
              `[plugin-registry] 丢弃失败包实例出错 "${name}":`,
              discardErr instanceof Error ? discardErr.message : discardErr,
            )
          }
          throw e
        }
      }

      // 签名结论落库：`off` 模式不写任何签名字段（verdict=undefined）；其余模式显式覆盖（null 清除旧值）
      const sigFields =
        sig === undefined
          ? {}
          : {
              signatureStatus: sig.verdict.status,
              signerKeyId: sig.verdict.keyId ?? null,
              signedAt: sig.verdict.signedAt ?? sig.envelope?.signedAt ?? null,
              signatureVerifiedAt:
                sig.verdict.status === 'verified' ? (sig.verdict.verifiedAt ?? new Date().toISOString()) : null,
              signatureError: sig.verdict.error ?? null,
              signature: sig.envelope?.signature ?? null,
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
        scanWarnings: scan.warnings,
        scannedAt: scan.scannedAt,
        ...sigFields,
      })
      return { scan, ...(sig ? { signature: sig.verdict } : {}) }
    } catch (e) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      // 注册记录回滚（与上面的目录回滚同时发生）：本次尝试新建 → 删除；已有旧记录 → 还原原字段。
      // 放在最后：上面的内层 catch 已完成目录回滚（更新分支还会 reloadOne 回写记录），此处以其为最终态。
      await restoreRecord(name, recordBefore)
      throw e
    }
  }

  // 远端市场安装：下载（https，可选 http 豁免）→ 统一校验链 → 落盘 → 热载
  // 信任边界：远端为跨网络不可信来源，**必须**携带 sha256（缺失/格式非法在下载前拒装）；registry 来源还须版本一致（F2）
  const installRemote = async (input: {
    name?: string
    packageUrl: string
    sha256?: string
    expectedVersion?: string
    /** API 请求体平铺签名字段（优先级高于包内 zip comment） */
    sigInput?: SignatureInput
  }): Promise<PluginInstallResult> => {
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

    // ---- 下载前置校验：sha256 必须存在且为 64 位 hex（避免白下载；失败零磁盘副作用） ----
    const expected = String(input.sha256 ?? '').trim().toLowerCase()
    if (!expected) {
      let host = url
      try {
        host = new URL(url).host
      } catch {
        /* 保留原 url 作为来源提示 */
      }
      throw new PluginError(
        `远端安装必须提供 sha256 校验值（来源：${host}）。请在目录条目（registry.json）或安装参数中携带 sha256 后重试`,
        PLUGIN_ERR.SHA256_REQUIRED,
      )
    }
    if (!SHA256_HEX_RE.test(expected)) {
      throw new PluginError(
        `sha256 格式非法（应为 64 位十六进制，当前长度 ${expected.length}，值 ${expected.slice(0, 8)}…）`,
        PLUGIN_ERR.SHA256_INVALID,
      )
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
    const { manifest, files, treeSha256, envelope: zipEnvelope, envelopeError: zipEnvelopeError } =
      validateZipBuffer(zipBuf)
    if (input.name && input.name !== manifest.name) {
      throw new Error(`插件名不匹配（期望 ${input.name}，实际 ${manifest.name}）`)
    }
    // F2：目录条目声明的版本必须与包内 plugin.json 一致（防「旧包冒充新版本」静默降级）
    const expectedVersion = String(input.expectedVersion ?? '').trim()
    if (expectedVersion && expectedVersion !== manifest.version) {
      throw new PluginError(
        `目录条目声明的版本（${expectedVersion}）与包内 plugin.json（${manifest.version}）不一致，已拒绝安装`,
        PLUGIN_ERR.STORE_VERSION_MISMATCH,
      )
    }
    // 下载后内容强比对：远端一律要求哈希一致（无 warn 放行分支）
    assertSha256(expected, treeSha256)
    // 验签（落盘前；严格在 sha256 比对之后）：请求体签名字段优先于 zip comment
    const bodySig = parseSignatureInput(input.sigInput)
    const sig = resolveSignature({
      name: manifest.name,
      treeSha256,
      source: 'remote',
      zipEnvelope,
      zipEnvelopeError,
      bodyEnvelope: bodySig.envelope,
      bodyError: bodySig.error,
    })
    const { scan, signature } = await installFilesAtomically(manifest, files, 'remote', url, treeSha256, sig)
    return { plugins: config.plugins, scan, ...(signature ? { signature } : {}) }
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
      // 缺 sha256 的条目保留在商店中（管理员可见可排查），但标记为不可安装 → 汇总 warn
      const missing = remoteCatalog.filter((p) => !isSha256Hex(p.sha256))
      if (missing.length) {
        console.warn(
          `[plugin-registry] ${missing.length} 条远端条目缺少 sha256，已标记为不可安装：${missing
            .map((p) => p.name)
            .join('、')}`,
        )
      }
      // 签名汇总（完善⑥）：未签名 / keyId 未受信任各一条 warn（不改失败降级逻辑）
      if (signatureMode !== 'off') {
        const unsigned = remoteCatalog.filter((p) => !p.signature)
        const unknown = remoteCatalog.filter(
          (p) => !!p.signature && !!p.keyId && Object.keys(trustedKeys).length > 0 && !trustedKeys[p.keyId],
        )
        if (unsigned.length) {
          console.warn(
            `[plugin-registry] ${unsigned.length} 条远端条目未签名（PLUGIN_SIGNATURE_MODE=${signatureMode}）`,
          )
        }
        if (unknown.length) {
          console.warn(
            `[plugin-registry] ${unknown.length} 条远端条目的签名密钥未受信任（keyId 不在信任表）：${unknown
              .map((p) => p.name)
              .join('、')}`,
          )
        }
      }
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
      // 写盘失败时回滚内存 order，保证「服务端内存与磁盘一致」
      const prev = config.plugins.map((p) => [p.name, p.order] as const)
      orderedNames.forEach((n, i) => {
        const p = byName.get(n)
        if (p) p.order = i
      })
      try {
        await persist()
      } catch (e) {
        const before = new Map(prev)
        for (const p of config.plugins) {
          const o = before.get(p.name)
          if (o !== undefined) p.order = o
        }
        throw e
      }
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
        return installRemote({ name: name || undefined, packageUrl, sha256, sigInput: inputObj ?? undefined })
      }
      // 内置 7 条 catalog 的旧「假安装」行为保持不变（仅注册标记，无真实包体 → 无 scan）
      const item = STORE_CATALOG.find((x) => x.name === name)
      if (item) {
        if (config.plugins.some((p) => p.name === name)) return { plugins: config.plugins }
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
        return { plugins: config.plugins }
      }
      // 远端目录源条目：真实下载+校验+验签+落盘（缺 sha256 / 版本不一致 / enforce 下未签名一律拒装）
      const remote = remoteCatalog.find((x) => x.name === name)
      if (remote && remote.packageUrl) {
        if (!isSha256Hex(remote.sha256)) {
          throw new PluginError(
            `目录条目「${name}」缺少 sha256 校验值，已按安全策略禁止安装（请在 registry.json 为该版本补充 sha256）`,
            PLUGIN_ERR.SHA256_REQUIRED,
          )
        }
        // enforce：条目未声明签名 → 下载前即拒（避免白下载；磁盘零副作用）
        if (signatureMode === 'enforce' && !remote.signature) {
          throw new PluginError(
            `当前策略要求插件签名（PLUGIN_SIGNATURE_MODE=enforce），目录条目「${name}」未携带签名，已拒绝安装`,
            PLUGIN_ERR.SIGNATURE_REQUIRED,
          )
        }
        return installRemote({
          name,
          packageUrl: remote.packageUrl,
          sha256: remote.sha256,
          expectedVersion: remote.version,
          sigInput: remote,
        })
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
        if (!p) return { plugins: config.plugins }
        p.version = item.version
        p.title = item.title
        await persist()
        return { plugins: config.plugins }
      }
      const remote = remoteCatalog.find((x) => x.name === name)
      if (remote && remote.packageUrl) {
        // 更新与安装同一把关点：缺 sha256 / 版本不一致 / enforce 下未签名同样拒装（供应链一致）
        if (!isSha256Hex(remote.sha256)) {
          throw new PluginError(
            `目录条目「${name}」缺少 sha256 校验值，已按安全策略禁止安装（请在 registry.json 为该版本补充 sha256）`,
            PLUGIN_ERR.SHA256_REQUIRED,
          )
        }
        if (signatureMode === 'enforce' && !remote.signature) {
          throw new PluginError(
            `当前策略要求插件签名（PLUGIN_SIGNATURE_MODE=enforce），目录条目「${name}」未携带签名，已拒绝更新`,
            PLUGIN_ERR.SIGNATURE_REQUIRED,
          )
        }
        return installRemote({
          name,
          packageUrl: remote.packageUrl,
          sha256: remote.sha256,
          expectedVersion: remote.version,
          sigInput: remote,
        })
      }
      return { plugins: config.plugins }
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
      // 导出→导入闭环：把库中保存的签名重新写入 zip archive comment（**不新增 zip 条目**，树哈希不变）
      let signatureComment: string | undefined
      if (rec?.signature && isSha256Hex(rec.sha256) && rec.signerKeyId) {
        signatureComment = buildSignatureComment({
          schema: 1,
          alg: 'ed25519',
          keyId: rec.signerKeyId,
          signedHash: String(rec.sha256).trim().toLowerCase(),
          signature: rec.signature,
          ...(rec.signedAt ? { signedAt: rec.signedAt } : {}),
        })
      }
      const buffer = await exportPackageToZip(pkgDir, signatureComment ? { signatureComment } : undefined)
      return { buffer, filename: `${name}.zip` }
    },

    async importPackage(data, sha256, sigInput) {
      await ensureLoaded()
      if (!pluginDir) throw new Error('插件目录未配置')
      const zipBuf = decodeZipBase64(data)
      const { manifest, files, treeSha256, envelope: zipEnvelope, envelopeError: zipEnvelopeError } =
        validateZipBuffer(zipBuf)
      if (sha256 && String(sha256).trim()) {
        assertSha256(String(sha256).trim(), treeSha256)
      } else {
        // 本地导入保持 warn 放行（管理员本机文件 + 二次确认，哈希为可选完整性自校验）
        console.warn(`[plugin-registry] import "${manifest.name}" without sha256（未校验内容，仅安装受信任来源）`)
      }
      // 验签（落盘前；enforce 下本地导入同样强制 —— 签名策略与来源无关）
      const bodySig = parseSignatureInput(sigInput)
      const sig = resolveSignature({
        name: manifest.name,
        treeSha256,
        source: 'local',
        zipEnvelope,
        zipEnvelopeError,
        bodyEnvelope: bodySig.envelope,
        bodyError: bodySig.error,
      })
      const { scan, signature } = await installFilesAtomically(manifest, files, 'local', undefined, treeSha256, sig)
      return { plugins: config.plugins, scan, ...(signature ? { signature } : {}) }
    },

    refreshRegistry,

    registryUrl() {
      return registryUrl
    },

    signatureInfo() {
      return { mode: signatureMode, trustedKeyIds: Object.keys(trustedKeys) }
    },
  }
}
