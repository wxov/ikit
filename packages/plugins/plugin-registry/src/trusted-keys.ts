// 插件签名信任表：内置常量（默认空） + 环境变量三键合并
//
// 信任表 = BUILTIN_TRUSTED_KEYS（本文件常量，默认空）
//        ∪ PLUGIN_SIGNING_PUBKEY      （单个公钥：PEM 单行或 base64 SPKI）
//        ∪ PLUGIN_SIGNING_PUBKEY_FILE （单个公钥：PEM 文件）
//        ∪ PLUGIN_SIGNING_KEYS        （JSON 映射，多密钥/轮换过渡）
// 同 keyId 冲突时优先级：PLUGIN_SIGNING_KEYS > PUBKEY(_FILE) > BUILTIN
//
// 安全口径：每一项的 keyId 必须等于「由该公钥派生的 keyId」；不一致 → warn 并**忽略该项**（fail-closed，
// 不会因为贴错公钥而误信）。公钥是公开信息，可随配置/镜像分发；私钥永不入库（.keys/ 已 gitignore）。
import { readFileSync } from 'node:fs'
import {
  decodePublicKey,
  deriveKeyId,
  normalizePublicKeyPem,
  type TrustedKey,
  type TrustedKeyTable,
} from './signing.js'

/**
 * 内置信任表：**默认空表**（官方密钥未生成前不得臆造；空表时按「未配置任何签名公钥」处理）。
 *
 * 官方发布构建在生成密钥后，把 `node scripts/gen-plugin-key.mjs` 打印的片段粘贴到这里，
 * 例如：
 * ```ts
 * export const BUILTIN_TRUSTED_KEYS: TrustedKeyTable = {
 *   'ikit-e62c2f517b242c05': { publicKey: '<base64 SPKI 或 PEM>', status: 'active' },
 * }
 * ```
 * 轮换：新公钥追加为 `active`，旧 keyId 改 `status: 'retired'`（旧包仍验签通过）；吊销：删除该项。
 */
export const BUILTIN_TRUSTED_KEYS: TrustedKeyTable = {}

export interface TrustedKeySources {
  /** 内置常量（默认 BUILTIN_TRUSTED_KEYS） */
  builtin?: TrustedKeyTable
  /** PLUGIN_SIGNING_KEYS：{"<keyId>":"<base64 SPKI>"|{"publicKey":…,"status":"active|retired","note":…}} */
  json?: string
  /** PLUGIN_SIGNING_PUBKEY：PEM（含字面 \n 的单行）或 base64 SPKI */
  pem?: string
  /** PLUGIN_SIGNING_PUBKEY_FILE：PEM 文件路径 */
  pemFile?: string
  /** 注入点（测试可替换） */
  readFile?: (p: string) => string
  warn?: (msg: string) => void
}

/** 解析并合并信任表；非法项一律 warn + 忽略，不抛错（不阻断启动） */
export function resolveTrustedKeys(sources: TrustedKeySources = {}): TrustedKeyTable {
  const warn = sources.warn ?? ((msg: string) => console.warn(msg))
  const readFile = sources.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
  const out: TrustedKeyTable = {}

  const put = (givenId: string | undefined, publicKey: string, status: unknown, origin: string, note?: string) => {
    if (!publicKey || !publicKey.trim()) {
      warn(`[plugin-registry][signature] ignore ${origin}: 公钥为空`)
      return
    }
    let derived: string
    let pem: string
    try {
      derived = deriveKeyId(publicKey)
      pem = normalizePublicKeyPem(publicKey)
    } catch (e) {
      warn(`[plugin-registry][signature] ignore ${origin}: 公钥解析失败（${e instanceof Error ? e.message : String(e)}）`)
      return
    }
    if (givenId && givenId !== derived) {
      // 配置错位（贴错公钥/复制粘贴串行）在启动时暴露，而不是表现为「验签莫名失败」
      warn(`[plugin-registry][signature] ignore key "${givenId}" (derived: ${derived})`)
      return
    }
    out[derived] = {
      publicKey: pem,
      status: status === 'retired' ? 'retired' : 'active',
      ...(note ? { note } : {}),
    }
  }

  // 1) 内置常量（最低优先级）
  for (const [keyId, tk] of Object.entries(sources.builtin ?? {})) {
    if (!tk || typeof tk !== 'object') continue
    put(keyId, String(tk.publicKey ?? ''), tk.status, `builtin "${keyId}"`, tk.note)
  }

  // 2) 单公钥文件（PLUGIN_SIGNING_PUBKEY_FILE）
  const pemFilePath = (sources.pemFile ?? '').trim()
  if (pemFilePath) {
    try {
      put(undefined, readFile(pemFilePath), 'active', `PLUGIN_SIGNING_PUBKEY_FILE (${pemFilePath})`)
    } catch (e) {
      warn(
        `[plugin-registry][signature] ignore PLUGIN_SIGNING_PUBKEY_FILE "${pemFilePath}": 读取失败（${
          e instanceof Error ? e.message : String(e)
        }）`,
      )
    }
  }

  // 3) 单公钥内联（PLUGIN_SIGNING_PUBKEY）
  const pemInline = (sources.pem ?? '').trim()
  if (pemInline) put(undefined, pemInline, 'active', 'PLUGIN_SIGNING_PUBKEY')

  // 4) JSON 映射（PLUGIN_SIGNING_KEYS，最高优先级）
  const json = (sources.json ?? '').trim()
  if (json) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (e) {
      warn(`[plugin-registry][signature] ignore PLUGIN_SIGNING_KEYS: 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`)
      parsed = undefined
    }
    if (parsed && typeof parsed === 'object') {
      for (const [keyId, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') put(keyId, v, 'active', `PLUGIN_SIGNING_KEYS ("${keyId}")`)
        else if (v && typeof v === 'object') {
          const obj = v as { publicKey?: unknown; status?: unknown; note?: unknown }
          put(
            keyId,
            String(obj.publicKey ?? ''),
            obj.status,
            `PLUGIN_SIGNING_KEYS ("${keyId}")`,
            typeof obj.note === 'string' ? obj.note : undefined,
          )
        } else {
          warn(`[plugin-registry][signature] ignore PLUGIN_SIGNING_KEYS["${keyId}"]: 取值非法`)
        }
      }
    }
  }

  return out
}

export type { TrustedKey, TrustedKeyTable }
