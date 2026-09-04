// 插件生态共享工具：入口扩展名白名单、名称正则、内容哈希、基础 semver 比较、路径包含判断
import { createHash } from 'node:crypto'
import path from 'node:path'

/** 插件入口文件扩展名白名单（QA 观察①：import 侧 + loader 侧 resolveEntryPath 共用） */
export const ENTRY_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.cjs', '.mjs', '.ts'])

/** 导入/远端市场的插件名约束：仅小写字母/数字/下划线/连字符 */
export const IMPORT_NAME_RE = /^[a-z0-9_-]+$/

/** loader 侧 manifest 名称约束（保持 P0 现状，允许大写） */
export const MANIFEST_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/** 入口扩展名是否在白名单内 */
export function isEntryExtensionAllowed(entryPath: string): boolean {
  const ext = path.posix.extname(entryPath).toLowerCase()
  return ENTRY_EXTENSIONS.has(ext)
}

/** 计算单个 buffer 的 sha256（小写 hex） */
export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 计算「解压后文件树」的规范序 sha256（导入/远端市场统一语义）：
 * 按相对路径（POSIX 分隔）升序，依次哈希 `<relPath>\0<content>`。
 * 与 zip 本身字节无关，只取决于包内文件内容与相对路径。
 */
export function sha256OfFileTree(files: { relPath: string; data: Buffer }[]): string {
  const h = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  for (const f of sorted) {
    h.update(f.relPath)
    h.update('\0')
    h.update(f.data)
  }
  return h.digest('hex')
}

/**
 * 基础 semver 比较：仅按数字点分（major.minor.patch）比较，忽略 pre-release/build。
 * 返回 >0 = a 更新；<0 = b 更新；0 = 相同。解析失败按 0.0.0 处理。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

function parseSemver(v: string): [number, number, number] {
  const m = String(v ?? '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return [0, 0, 0]
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** 判断 target 是否位于 root 目录内（含等于 root；防路径穿越） */
export function isWithinDir(root: string, target: string): boolean {
  const r = path.resolve(root)
  const t = path.resolve(target)
  return t === r || t.startsWith(r + path.sep)
}

/**
 * 归一化 zip 条目相对路径为 POSIX 分隔的安全路径；
 * 拒绝绝对路径、盘符、`..`、`.`、空段、空字符。不合法返回 null。
 */
export function normalizeRelPath(p: string): string | null {
  if (typeof p !== 'string') return null
  const s = p.replace(/\\/g, '/')
  if (s.includes('\0')) return null
  if (s.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(s)) return null
  const segs = s.split('/')
  if (segs.some((x) => x === '..' || x === '.' || x === '')) return null
  return segs.join('/')
}
