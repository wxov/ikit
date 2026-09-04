// 插件包打包/解包与安全校验（导出 zip + 导入/远端市场的统一校验链）
// 信任边界：导入/远端下载的 zip 内容可能来自不可信来源，所有校验在落盘前完成；
// 校验失败即抛错，不写任何文件（半状态由 service 层统一清理）。
import AdmZip from 'adm-zip'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ENTRY_EXTENSIONS,
  IMPORT_NAME_RE,
  isEntryExtensionAllowed,
  normalizeRelPath,
  sha256OfFileTree,
} from './utils.js'
import type { PluginPackageManifest } from './loader.js'

// ---- 大小/炸弹上限 ----
export const ZIP_MAX_BYTES = 2 * 1024 * 1024 // zip 原始字节 ≤2MB
export const EXTRACT_TOTAL_MAX_BYTES = 10 * 1024 * 1024 // 解压后总大小 ≤10MB
export const FILE_MAX_BYTES = 2 * 1024 * 1024 // 单文件 ≤2MB
export const MAX_FILES = 200 // 文件数 ≤200

// 导出时排除的无关节目录/文件（不泄露无关目录，仅打包该包目录内文件）
const EXPORT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'data', '.staging', '.backup'])

export interface ExtractedFile {
  /** 归一化后的相对路径（POSIX 分隔，相对包根） */
  relPath: string
  data: Buffer
}

export interface ZipValidation {
  /** 校验/规范化后的 manifest */
  manifest: PluginPackageManifest
  /** 包内全部文件（含 plugin.json） */
  files: ExtractedFile[]
  /** 解压后文件树的规范序 sha256 */
  treeSha256: string
}

/** 将 base64 解码为 zip Buffer，并做原始大小上限校验（可容忍 data:…;base64, 前缀） */
export function decodeZipBase64(data: string): Buffer {
  if (typeof data !== 'string' || !data.trim()) throw new Error('缺少 zip 数据')
  let b64 = data.trim()
  const m = /^data:[^;]*;base64,/.exec(b64)
  if (m) b64 = b64.slice(m[0].length)
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    throw new Error('zip base64 解码失败')
  }
  if (!buf.length) throw new Error('zip 数据为空')
  if (buf.length > ZIP_MAX_BYTES) {
    throw new Error(`zip 超过 ${Math.round(ZIP_MAX_BYTES / 1024)}KB 上限`)
  }
  return buf
}

/** 判断 zip 条目是否为符号链接（unix 文件类型位，best-effort） */
function isSymlinkEntry(entry: AdmZip.IZipEntry): boolean {
  const S_IFLNK = 0o120000
  const TYPE_MASK = 0o170000
  const attrs = [entry.attr, entry.header?.attr].filter((x) => typeof x === 'number')
  return attrs.some((a) => (((a as number) >>> 16) & TYPE_MASK) === S_IFLNK)
}

/** 从解析后的 manifest 中提取 entry 指向的相对路径（安全归一化） */
function resolveEntryRelPath(entry: string): string | null {
  const safe = normalizeRelPath(entry)
  if (!safe) return null
  return safe
}

/**
 * 校验 zip Buffer（大小/炸弹/条目路径/manifest/entry/树哈希），不落盘。
 * 返回规范化 manifest、文件列表与树哈希；任何不通过抛错。
 */
export function validateZipBuffer(zipBuf: Buffer): ZipValidation {
  if (zipBuf.length > ZIP_MAX_BYTES) {
    throw new Error(`zip 超过 ${Math.round(ZIP_MAX_BYTES / 1024)}KB 上限`)
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(zipBuf)
  } catch (e) {
    throw new Error(`zip 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  const entries = zip.getEntries()
  const fileEntries = entries.filter((e) => !e.isDirectory && !e.entryName.endsWith('/'))
  if (fileEntries.length > MAX_FILES) {
    throw new Error(`zip 文件数超过 ${MAX_FILES} 上限`)
  }
  const files: ExtractedFile[] = []
  let total = 0
  for (const entry of fileEntries) {
    const rel = normalizeRelPath(entry.entryName)
    if (!rel) throw new Error(`非法条目路径: ${entry.entryName}`)
    if (isSymlinkEntry(entry)) throw new Error(`拒绝符号链接条目: ${entry.entryName}`)
    let data: Buffer
    try {
      data = entry.getData()
    } catch (e) {
      throw new Error(`条目解压失败 ${entry.entryName}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (data.length > FILE_MAX_BYTES) {
      throw new Error(`单文件超过 ${Math.round(FILE_MAX_BYTES / 1024)}KB 上限: ${entry.entryName}`)
    }
    total += data.length
    if (total > EXTRACT_TOTAL_MAX_BYTES) {
      throw new Error(`解压后总大小超过 ${Math.round(EXTRACT_TOTAL_MAX_BYTES / 1024 / 1024)}MB 上限`)
    }
    files.push({ relPath: rel, data })
  }

  // plugin.json 必须存在于包根
  const manifestFile = files.find((f) => f.relPath === 'plugin.json')
  if (!manifestFile) throw new Error('缺少 plugin.json')
  let raw: any
  try {
    raw = JSON.parse(manifestFile.data.toString('utf-8'))
  } catch (e) {
    throw new Error(`plugin.json 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('plugin.json 结构非法')
  if (typeof raw.name !== 'string' || !IMPORT_NAME_RE.test(raw.name)) {
    throw new Error('plugin.json 的 name 非法（须 ^[a-z0-9_-]+$）')
  }
  const entry = typeof raw.entry === 'string' && raw.entry.trim() ? raw.entry.trim() : 'index.js'
  if (!isEntryExtensionAllowed(entry)) {
    throw new Error(`入口文件扩展名不在白名单（${[...ENTRY_EXTENSIONS].join('/')}）`)
  }
  const entryRel = resolveEntryRelPath(entry)
  if (!entryRel) throw new Error('入口文件路径非法（不得越界）')
  if (!files.some((f) => f.relPath === entryRel)) {
    throw new Error('入口文件在包内不存在')
  }

  const manifest: PluginPackageManifest = {
    name: raw.name,
    title: typeof raw.title === 'string' ? raw.title : raw.name,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    description: typeof raw.description === 'string' ? raw.description : '',
    panel:
      typeof raw.panel === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.panel) ? raw.panel : raw.name,
    entry,
    permission: Array.isArray(raw.permission) ? raw.permission.filter((x: any) => typeof x === 'string') : [],
    author: typeof raw.author === 'string' ? raw.author : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    deps: Array.isArray(raw.deps) ? raw.deps.filter((x: any) => typeof x === 'string') : undefined,
    minIkit: typeof raw.minIkit === 'string' ? raw.minIkit : undefined,
    minVersion: typeof raw.minVersion === 'string' ? raw.minVersion : undefined,
  }

  return { manifest, files, treeSha256: sha256OfFileTree(files) }
}

/** 校验可选 sha256（若提供）：与树哈希比对，不匹配抛错 */
export function assertSha256(provided: string | undefined, treeSha256: string): void {
  if (!provided) return
  if (String(provided).toLowerCase() !== treeSha256) {
    throw new Error('sha256 校验失败')
  }
}

/** 将包目录打包为 zip Buffer（仅包目录内文件，排除无关目录） */
export async function exportPackageToZip(pkgDir: string): Promise<Buffer> {
  const root = path.resolve(pkgDir)
  let stat
  try {
    stat = await fs.stat(root)
  } catch {
    throw new Error('包目录不存在')
  }
  if (!stat.isDirectory()) throw new Error('不是有效的包目录')

  const zip = new AdmZip()
  const walk = async (dir: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true })
    for (const it of items) {
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) {
        if (EXPORT_EXCLUDE_DIRS.has(it.name)) continue
        await walk(abs)
        continue
      }
      if (!it.isFile()) continue
      if (it.name.endsWith('.log')) continue
      const rel = path.relative(root, abs).split(path.sep).join('/')
      // 用 addFile 而非 addLocalFile：addLocalFile 会把 zipPath 当目录拼出 `<zipPath>/<文件名>`，
      // 导致导出的 plugin.json 变成 `plugin.json/plugin.json`；addFile 直接以 rel 为条目名。
      zip.addFile(rel, await fs.readFile(abs))
    }
  }
  await walk(root)
  return zip.toBuffer()
}
