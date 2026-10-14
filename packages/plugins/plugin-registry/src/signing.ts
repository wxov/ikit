// 插件签名与验签（ed25519，**零新依赖**：仅 node:crypto）
//
// ---- 被签名字节定义（语义冻结；任何变更必须 bump 信封 schema 并经历双接受期） ----
//   payload    = UTF-8/ASCII 编码的 <signedHash> 字符串（64 个小写 hex 字符 = 64 字节）
//   signedHash = sha256OfFileTree(files)（`utils.ts`，语义已冻结，本模块不改其定义）
//   signature  = ed25519_sign(privateKey, payload) → base64url（86 字符）
//   VERIFY     = signedHash === sha256OfFileTree(解压文件)
//                && crypto.verify(null, Buffer.from(signedHash,'utf8'), trustedKeys[keyId], sig)
//
// 说明：**不**做 hex→digest 解码、**不**使用 zip 原始字节、**不**加任何前缀/后缀/换行。
// 这样 `registry.json` / `plugins.json` 里的 sha256 值可被直接复制粘贴复现（见 scripts/sign-plugin.mjs）。
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { isSha256Hex } from './utils.js'

/** zip archive comment 中签名信封的固定前缀（不匹配即视为「无签名」，避免误判第三方普通 comment） */
export const SIG_COMMENT_PREFIX = 'ikit-plugin-signature:'

/** 当前信封/载荷定义版本（载荷定义变更必须 bump） */
export const SIG_SCHEMA = 1

/** 唯一允许的签名算法（其它值 → MALFORMED，不静默降级） */
export const SIG_ALG = 'ed25519'

/** zip comment 长度上限（超出视为无签名并附错误，防异常大 comment） */
export const SIG_COMMENT_MAX_BYTES = 4096

/** 签名策略：off=不验签（等价现状）/ warn=验签但不拒装（默认）/ enforce=拒装 */
export type SignatureMode = 'off' | 'warn' | 'enforce'

/**
 * 签名状态：
 * - `unsigned`    无签名
 * - `unverified`  已声明签名、本机尚未验证（未安装的远端条目 / off 模式 / 无公钥可查）
 * - `verified`    验签通过
 * - `invalid`     验签失败（格式非法、signedHash 与内容不一致、crypto.verify 失败）
 * - `unknown-key` 签名密钥不在信任表
 * `undefined` = 不适用（catalog/builtin）或旧记录未评估。
 */
export type PluginSignatureStatus = 'unsigned' | 'unverified' | 'verified' | 'invalid' | 'unknown-key'

/** 签名信封（registry 平铺字段 / zip comment / API 请求体 三处载体共用同一结构） */
export interface SignatureEnvelope {
  /** 信封/载荷定义版本，当前 1 */
  schema: number
  /** 仅允许 'ed25519' */
  alg: string
  /** 必填；必须等于由公钥派生的 keyId（`ikit-` + sha256(SPKI DER)[:16]） */
  keyId: string
  /** 必填；被签名载荷 = 树哈希（64 位小写 hex） */
  signedHash: string
  /** 必填；sign(signedHash 的 UTF-8 字节)，base64url */
  signature: string
  /** 可选、纯信息性（不参与验签与信任决策） */
  signedAt?: string
}

/** 平铺形态的签名输入（registry.json 条目 / API 请求体；`schema`/`alg` 可省） */
export interface SignatureInput {
  signature?: string
  keyId?: string
  signedHash?: string
  signedAt?: string
  schema?: number | string
  alg?: string
}

/** 验签结论（HTTP 响应与落库状态共用） */
export interface SignatureVerdict {
  status: PluginSignatureStatus
  keyId?: string
  signedAt?: string
  /** 服务端权威验证时间（仅 verified 时有值） */
  verifiedAt?: string
  /** 失败原因（invalid / unknown-key 时给出） */
  error?: string
  /** 非致命提示（如密钥已 retired） */
  warning?: string
  /** 内部标志：错误源于信封字段格式（用于选 PLUGIN_SIGNATURE_MALFORMED） */
  malformed?: boolean
}

/** 信任表条目 */
export interface TrustedKey {
  /** 公钥（规范化为 PEM SPKI） */
  publicKey: string
  /** active=当前启用；retired=已轮换（仍验签通过，附 warning） */
  status: 'active' | 'retired'
  note?: string
}

/** 信任表：keyId（派生值）→ 条目 */
export type TrustedKeyTable = Record<string, TrustedKey>

/** keyId 形态约束（信任表键） */
export const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/

/** ed25519 detached signature 的 base64url 形态（解码 64 字节 → 86 字符） */
export const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/

/** 归一化签名策略：非法值按 warn 处理（不 crash），并 warn 一行 */
export function normalizeSignatureMode(v: unknown, warn: (msg: string) => void = console.warn): SignatureMode {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!s) return 'warn'
  if (s === 'off' || s === 'warn' || s === 'enforce') return s
  warn(`[plugin-registry][signature] 非法 PLUGIN_SIGNATURE_MODE="${String(v)}"，已按 warn 处理`)
  return 'warn'
}

/** 解析公钥：支持 PEM（含字面 `\n` 的单行形态）与 base64/base64url 的 SPKI DER */
export function decodePublicKey(input: string | Buffer | KeyObject): KeyObject {
  if (typeof input === 'object' && input !== null && 'export' in input) return input as KeyObject
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new Error('公钥为空')
  // env 单行形态：字面 \n 还原为真实换行（Docker/K8s Secret 注入常见）
  const restored = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
  if (restored.includes('-----BEGIN')) return createPublicKey(restored)
  const b64 = restored.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/=_-]+$/.test(b64)) throw new Error('公钥格式非法（既不是 PEM 也不是 base64）')
  const der = Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64')
  if (!der.length) throw new Error('公钥 base64 解码为空')
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

/** 由公钥派生 keyId：`ikit-` + sha256(SPKI DER)[:16]（不可人为指定，杜绝标签与密钥错位） */
export function deriveKeyId(publicKey: string | Buffer | KeyObject): string {
  const key = decodePublicKey(publicKey)
  const der = key.export({ format: 'der', type: 'spki' })
  return `ikit-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`
}

/** 公钥规范化：任意可接受形态 → 单行可存储的 PEM（SPKI） */
export function normalizePublicKeyPem(publicKey: string | Buffer | KeyObject): string {
  return decodePublicKey(publicKey).export({ format: 'pem', type: 'spki' }).toString()
}

/** 校验信封字段格式；返回错误说明（null = 合法） */
export function validateEnvelope(env: SignatureEnvelope | undefined): string | null {
  if (!env || typeof env !== 'object') return '签名信封缺失'
  if (Number(env.schema) !== SIG_SCHEMA) {
    return `签名信封 schema 不受支持（${String(env.schema)}，仅支持 ${SIG_SCHEMA}）`
  }
  if (env.alg !== SIG_ALG) return `签名算法不受支持（${String(env.alg)}，仅支持 ${SIG_ALG}）`
  if (typeof env.keyId !== 'string' || !KEY_ID_RE.test(env.keyId)) {
    return `keyId 非法（${env.keyId ? env.keyId : '空'}）`
  }
  if (!isSha256Hex(env.signedHash)) return 'signedHash 非法（应为 64 位小写十六进制）'
  if (typeof env.signature !== 'string' || !SIGNATURE_RE.test(env.signature)) {
    return `signature 非法（应为 86 字符 base64url，当前长度 ${env.signature?.length ?? 0}）`
  }
  return null
}

/** 平铺签名字段 → 信封。无任何签名字段时返回空对象（= 无签名）；格式非法返回 error（**唯一**入口） */
export function parseSignatureInput(
  flat: SignatureInput | null | undefined,
): { envelope?: SignatureEnvelope; error?: string } {
  if (!flat || typeof flat !== 'object') return {}
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const signature = str(flat.signature)
  const keyId = str(flat.keyId)
  const signedHash = str(flat.signedHash)
  // `signedAt` 单独出现不算「有签名」（纯信息性字段）
  if (!signature && !keyId && !signedHash) return {}
  const env: SignatureEnvelope = {
    schema: flat.schema === undefined || flat.schema === null || (flat.schema as string) === '' ? SIG_SCHEMA : Number(flat.schema),
    alg: str(flat.alg) || SIG_ALG,
    keyId,
    signedHash: signedHash.toLowerCase(),
    signature,
    signedAt: str(flat.signedAt) || undefined,
  }
  const error = validateEnvelope(env)
  return error ? { error } : { envelope: env }
}

/** 解析 zip archive comment（前缀不匹配 → 视为无签名，不误判第三方普通 comment） */
export function parseSignatureComment(comment: string | null | undefined): {
  envelope?: SignatureEnvelope
  error?: string
} {
  const raw = typeof comment === 'string' ? comment : ''
  if (!raw.trim() || !raw.startsWith(SIG_COMMENT_PREFIX)) return {}
  if (Buffer.byteLength(raw, 'utf8') > SIG_COMMENT_MAX_BYTES) {
    return { error: `zip 签名 comment 超过 ${SIG_COMMENT_MAX_BYTES} 字节上限` }
  }
  const body = raw.slice(SIG_COMMENT_PREFIX.length).trim()
  let obj: unknown
  try {
    obj = JSON.parse(body)
  } catch (e) {
    return { error: `zip 签名 comment 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!obj || typeof obj !== 'object') return { error: 'zip 签名 comment 结构非法（应为 JSON 对象）' }
  return parseSignatureInput(obj as SignatureInput)
}

/** 信封 → zip archive comment（单行 ASCII JSON，前缀固定） */
export function buildSignatureComment(env: SignatureEnvelope): string {
  const payload: SignatureEnvelope = {
    schema: Number(env.schema) === SIG_SCHEMA ? SIG_SCHEMA : Number(env.schema),
    alg: env.alg || SIG_ALG,
    keyId: env.keyId,
    signedHash: String(env.signedHash || '').toLowerCase(),
    signature: env.signature,
    ...(env.signedAt ? { signedAt: env.signedAt } : {}),
  }
  return SIG_COMMENT_PREFIX + JSON.stringify(payload)
}

/**
 * 纯函数验签（不触磁盘/网络）。
 * 顺序严格遵循方案 §4.3.2 第 5–8 步：信封格式 → keyId 查表 → signedHash 一致 → crypto.verify。
 * 空信任表豁免：表为空时「有签名但无表可查」记 `unverified`（而非 unknown-key），避免新装即满屏红标。
 */
export function verifyTreeSignature(args: {
  treeSha256: string
  envelope?: SignatureEnvelope
  trustedKeys: TrustedKeyTable
}): SignatureVerdict {
  const { treeSha256, envelope, trustedKeys } = args
  if (!envelope) return { status: 'unsigned' }

  const fmtErr = validateEnvelope(envelope)
  if (fmtErr) {
    return { status: 'invalid', keyId: envelope.keyId || undefined, signedAt: envelope.signedAt, error: fmtErr, malformed: true }
  }
  const tableSize = Object.keys(trustedKeys).length
  if (tableSize === 0) {
    return {
      status: 'unverified',
      keyId: envelope.keyId,
      signedAt: envelope.signedAt,
      warning: '未配置任何签名公钥，签名一律无法验证（可设 PLUGIN_SIGNING_PUBKEY / _FILE / _KEYS 或登记内置信任表）',
    }
  }
  const tk = trustedKeys[envelope.keyId]
  if (!tk) {
    return {
      status: 'unknown-key',
      keyId: envelope.keyId,
      signedAt: envelope.signedAt,
      error: `签名密钥未受信任（keyId=${envelope.keyId}）；当前实例信任：${Object.keys(trustedKeys).join('、') || '（空）'}`,
    }
  }
  if (envelope.signedHash !== treeSha256) {
    return {
      status: 'invalid',
      keyId: envelope.keyId,
      signedAt: envelope.signedAt,
      error: `验签失败：签名与内容不匹配（keyId=${envelope.keyId}，signedHash=${envelope.signedHash.slice(0, 8)}… ≠ 实际 ${treeSha256.slice(0, 8)}…）`,
    }
  }
  let key: KeyObject
  try {
    key = decodePublicKey(tk.publicKey)
  } catch (e) {
    return {
      status: 'invalid',
      keyId: envelope.keyId,
      signedAt: envelope.signedAt,
      error: `信任表公钥解析失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  let ok = false
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(envelope.signedHash, 'utf8'),
      key,
      Buffer.from(envelope.signature, 'base64url'),
    )
  } catch {
    ok = false
  }
  if (!ok) {
    return {
      status: 'invalid',
      keyId: envelope.keyId,
      signedAt: envelope.signedAt,
      error: `验签失败：签名与内容不匹配（keyId=${envelope.keyId}）`,
    }
  }
  return {
    status: 'verified',
    keyId: envelope.keyId,
    signedAt: envelope.signedAt,
    verifiedAt: new Date().toISOString(),
    ...(tk.status === 'retired' ? { warning: `签名密钥已轮换（keyId=${envelope.keyId} 状态 retired），本次签名仍有效` } : {}),
  }
}
