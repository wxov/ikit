// 安全抓取（SSRF 防护，2026-11-28，对应 code-review P1-1）
//
// 用于把「服务端抓取用户提供的 URL」统一收敛到一处（agent `web_fetch`、store-data `rss` 等）：
// 1) 协议白名单：仅 http / https；
// 2) 地址校验：DNS 解析后拒绝 loopback / 私网 / 链路本地（含云元数据 169.254.169.254）/ CGNAT / 保留段；
// 3) 重定向：手动逐跳跟随（最多 N 跳），**每一跳都重新做地址校验**（防「公网 302 到内网」）；
// 4) 响应体上限：流式读取并在超过 maxBytes 时中止（防大文件撑爆内存）；
// 5) 超时：AbortSignal 超时。
//
// 残余风险（如实说明）：DNS 重绑定（TOCTOU）——校验用的解析结果与实际连接时的解析可能不同。
// 彻底规避需「按解析出的 IP 连接 + 校验证书/SNI」，复杂度高，当前按「私网拦截 + 逐跳校验」的实用方案处理。

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

export class SafeFetchError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'SafeFetchError'
  }
}

export interface SafeFetchOptions {
  /** 单次请求超时（毫秒，默认 15000） */
  timeoutMs?: number
  /** 响应体上限（字节，默认 1MB） */
  maxBytes?: number
  /** 最大重定向跳数（默认 3） */
  maxRedirects?: number
  userAgent?: string
}

export interface SafeFetchResult {
  status: number
  ok: boolean
  /** 已按上限截断/校验后的响应文本 */
  text: string
  /** 最终 URL（跟随重定向后） */
  finalUrl: string
}

/** 判断是否为「不应被服务端访问」的地址（loopback/私网/链路本地/CGNAT/保留/多播） */
export function isBlockedAddress(ip: string): boolean {
  if (!isIP(ip)) return true // 非法地址一律拒绝
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true // 链路本地 / ULA
    if (lower.startsWith('ff')) return true // 多播
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower)
    if (mapped) return isBlockedAddress(mapped[1])
    // IPv4-mapped 的十六进制写法（::ffff:7f00:1）——无法可靠还原时按拒绝处理更安全
    if (lower.startsWith('::ffff:')) return true
    return false
  }
  const p = ip.split('.').map((x) => Number(x))
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
  const [a, b] = p
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 / 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a >= 224) return true // 多播 / 保留
  return false
}

/** 校验 URL 的协议与目标主机（域名会先解析，任一解析结果命中黑名单即拒绝） */
async function assertUrlAllowed(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('E_PROTOCOL', '仅支持 http/https 链接')
  }
  const host = url.hostname
  if (!host) throw new SafeFetchError('E_BAD_URL', 'URL 缺少主机名')
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new SafeFetchError('E_PRIVATE_ADDRESS', '禁止访问内网/本机地址')
    return
  }
  let list: Array<{ address: string }>
  try {
    list = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new SafeFetchError('E_DNS_FAILED', `域名解析失败：${host}`)
  }
  if (!list.length) throw new SafeFetchError('E_DNS_FAILED', `域名无解析结果：${host}`)
  for (const item of list) {
    if (isBlockedAddress(item.address)) {
      throw new SafeFetchError('E_PRIVATE_ADDRESS', `禁止访问内网/本机地址（${host} → ${item.address}）`)
    }
  }
}

/** 流式读取响应体，超过 maxBytes 立即中止（返回已读内容/抛错） */
async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* 忽略取消异常 */
      }
      throw new SafeFetchError('E_TOO_LARGE', `响应体超过上限（${Math.round(maxBytes / 1024)} KB）`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** 安全抓取文本：协议/内网/重定向/体积/超时均受控 */
export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const maxRedirects = Math.max(0, options.maxRedirects ?? 3)
  const userAgent = options.userAgent ?? 'i-kit-safe-fetch/1.0'

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SafeFetchError('E_BAD_URL', 'URL 格式不正确')
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertUrlAllowed(url)
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,text/xml,application/xml,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location')
      if (!location) throw new SafeFetchError('E_REDIRECT', `重定向缺少 Location（HTTP ${res.status}）`)
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new SafeFetchError('E_REDIRECT', '重定向地址不合法')
      }
      url = next // 下一跳会重新做协议 + 地址校验
      continue
    }
    const text = await readTextLimited(res, maxBytes)
    return { status: res.status, ok: res.ok, text, finalUrl: url.toString() }
  }
  throw new SafeFetchError('E_TOO_MANY_REDIRECTS', `重定向次数超过 ${maxRedirects} 次`)
}
