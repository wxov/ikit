// 插件注册表前端类型 + API
import { api } from './api'
import { apiUrl } from './config'
import { authHeaders } from './auth'

export type PluginRole = 'guest' | 'user' | 'admin'

export interface PluginRecord {
  name: string
  title: string
  version: string
  enabled: boolean
  builtin: boolean
  order: number
  visibleGroups: string[]
  panel?: string
  /** 安装时危险 API 启发式扫描警告（缺省 = 未扫描） */
  scanWarnings?: string[]
  /** 扫描时间（ISO） */
  scannedAt?: string
  // ---- 插件签名（完善⑥，与后端 types.ts 同步）----
  /** 验签状态（undefined = 未评估/不适用） */
  signatureStatus?: PluginSignatureStatus
  /** 签名密钥 keyId */
  signerKeyId?: string
  /** 服务端验签时间（ISO） */
  signatureVerifiedAt?: string
  /** 验签失败原因 */
  signatureError?: string
  /** 签名方自报签发时间（ISO，信息性） */
  signedAt?: string
  /** 原始签名值（base64url；仅后端导出使用） */
  signature?: string
}

export interface VisiblePlugins {
  role: PluginRole
  groups?: string[]
  plugins: PluginRecord[]
}

export function fetchAllPlugins(): Promise<{ plugins: PluginRecord[] }> {
  return api<{ plugins: PluginRecord[] }>('/api/plugins', { headers: authHeaders() })
}

export function setPluginEnabled(name: string, enabled: boolean): Promise<{ plugins: PluginRecord[] }> {
  return api(`/api/plugins/${name}/enable`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ enabled }),
  })
}

export function setPluginOrder(ordered: string[]): Promise<{ plugins: PluginRecord[] }> {
  return api('/api/plugins/order', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ordered }),
  })
}

export function setPluginGroups(name: string, groups: string[]): Promise<{ plugins: PluginRecord[] }> {
  return api(`/api/plugins/${name}/visibility`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ groups }),
  })
}

// ---- 插件商店 ----
export interface PluginReview {
  id: string
  author: string
  score: number
  comment: string
  createdAt: string
}
export interface PluginStoreItem {
  name: string
  title: string
  description: string
  version: string
  author: string
  installed?: boolean
  installedVersion?: string
  category?: string
  rating?: number
  ratingCount?: number
  reviews?: PluginReview[]
  screenshots?: string[]
  source?: 'catalog' | 'local' | 'remote'
  packageUrl?: string
  sha256?: string
  deps?: string[]
  minIkit?: string
  updateAvailable?: boolean
  /** 是否可安装/可更新（false = 明确不可安装，如远端条目缺 sha256） */
  installable?: boolean
  /** 不可安装原因 */
  blockedReason?: string
  /** 安装时危险 API 启发式扫描警告（缺省 = 未扫描） */
  scanWarnings?: string[]
  /** 扫描时间（ISO） */
  scannedAt?: string
  // ---- 插件签名（完善⑥，与后端 types.ts 同步；catalog/builtin 恒为 undefined → 不显示徽标）----
  /** 验签状态（undefined = 不适用/未评估） */
  signatureStatus?: PluginSignatureStatus
  /** 签名密钥 keyId */
  signerKeyId?: string
  /** 服务端验签时间（ISO） */
  signatureVerifiedAt?: string
  /** 验签失败原因 */
  signatureError?: string
  /** 签名方自报签发时间（ISO，信息性） */
  signedAt?: string
}

/** 验签状态枚举（与后端 signing.ts 同步） */
export type PluginSignatureStatus = 'unsigned' | 'unverified' | 'verified' | 'invalid' | 'unknown-key'

/** 验签策略：off=不验签 / warn=验签但不拒装（默认）/ enforce=拒装 */
export type SignatureMode = 'off' | 'warn' | 'enforce'

/** 一次安装/导入/更新的验签结论（catalog 假安装与 off 模式无此字段） */
export interface SignatureVerdict {
  status: PluginSignatureStatus
  keyId?: string
  signedAt?: string
  verifiedAt?: string
  error?: string
  warning?: string
}

/** 请求体可选的签名平铺字段（覆盖包内 zip comment；缺省时由服务端读 comment） */
export interface SignatureInput {
  signature?: string
  keyId?: string
  signedHash?: string
  signedAt?: string
}

/** 安装/更新/导入返回的安全扫描摘要（catalog 假安装无此字段） */
export interface ScanSummary {
  warnings: string[]
  scannedAt: string
  scannedFiles: string[]
  truncatedFiles: string[]
  truncated: boolean
}

export function fetchPluginStore(): Promise<{
  store: PluginStoreItem[]
  signatureMode?: SignatureMode
  trustedKeyIds?: string[]
}> {
  return api<{ store: PluginStoreItem[]; signatureMode?: SignatureMode; trustedKeyIds?: string[] }>(
    '/api/plugin-store',
    { headers: authHeaders() },
  )
}
export function fetchPluginCategories(): Promise<{ categories: string[] }> {
  return api<{ categories: string[] }>('/api/plugin-store/categories', { headers: authHeaders() })
}
export function installPlugin(
  input: string | { name: string; packageUrl?: string; sha256?: string } & SignatureInput,
): Promise<{
  plugins: PluginRecord[]
  store: PluginStoreItem[]
  scan?: ScanSummary
  signature?: SignatureVerdict
}> {
  const body = typeof input === 'string' ? { name: input } : input
  return api('/api/plugin-store/install', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
}
export function updatePlugin(name: string): Promise<{
  plugins: PluginRecord[]
  store: PluginStoreItem[]
  scan?: ScanSummary
  signature?: SignatureVerdict
}> {
  return api(`/api/plugin-store/${name}/update`, { method: 'POST', headers: authHeaders() })
}
export function uninstallPlugin(name: string): Promise<{ plugins: PluginRecord[]; store: PluginStoreItem[] }> {
  return api(`/api/plugin-store/${name}`, { method: 'DELETE', headers: authHeaders() })
}
export function importPlugin(
  data: string,
  sha256?: string,
  sigInput?: SignatureInput,
): Promise<{
  plugins: PluginRecord[]
  store: PluginStoreItem[]
  scan?: ScanSummary
  signature?: SignatureVerdict
}> {
  return api('/api/plugin-store/import', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ data, sha256, ...sigInput }),
  })
}
export function ratePlugin(name: string, score: number, comment: string): Promise<{ store: PluginStoreItem[] }> {
  return api('/api/plugin-store/rate', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, score, comment }),
  })
}

// 导出：fetch 携带鉴权头拿到 zip Blob，再触发浏览器下载（<a href> 无法带 Authorization）
export async function downloadPlugin(name: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/plugin-store/${name}/export`), { headers: authHeaders() })
  if (!res.ok) {
    let msg = `导出失败 (HTTP ${res.status})`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
