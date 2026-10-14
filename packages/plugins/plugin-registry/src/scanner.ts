// 危险 API 启发式扫描（警告级：只产出人类可读提示，不阻断安装）
//
// 设计口径（与 docs/ai-delivery/完善⑤-P2lite-方案.md §4.2 一致）：
// - 两遍匹配：A 类（模块名型，需字符串字面量）在**原文**上匹配；B 类（调用型）在去注释去字符串后的文本上匹配，
//   以降低「注释/字符串里出现 eval(」这类误报，同时不破坏 require('child_process') 的识别。
// - 显式舍弃：裸 `.exec(`、裸 `process.env`、裸 `fs.`、混淆启发式（误报率高）。
// - 纯函数、零依赖（仅用正则文本处理，不引入 AST 解析器）。
// - **扫不到 ≠ 安全**：本模块结果只是启发式提示，不构成安全保证。
import { ENTRY_EXTENSIONS } from './utils.js'

export type ScanLevel = 'high' | 'medium' | 'low'

/** 结构化命中（仅随安装响应返回，不落库） */
export interface ScanFinding {
  rule: string
  level: ScanLevel
  file: string
  line: number
  snippet: string
  risk: string
  suggestion: string
}

/** 扫描摘要（落库 + 随响应返回） */
export interface ScanSummary {
  /** 人类可读警告（自包含：`[rule] file:line 描述 —— 风险；建议：…`），落库 ≤20 条 */
  warnings: string[]
  /** 扫描时间（ISO） */
  scannedAt: string
  /** 实际扫描的文件相对路径 */
  scannedFiles: string[]
  /** 因超限被截断扫描的文件 */
  truncatedFiles: string[]
  /** 是否存在被截断扫描的文件 */
  truncated: boolean
}

export interface ScanResult extends ScanSummary {
  findings: ScanFinding[]
}

export interface ScanFile {
  relPath: string
  data: Buffer
}

/** 单文件扫描上限（超出截断扫描，文件计入 truncatedFiles） */
export const SCAN_FILE_MAX_BYTES = 256 * 1024
/** 每文件每规则最多命中条数 */
export const SCAN_MAX_PER_RULE_PER_FILE = 3
/** findings 总数上限（响应可见） */
export const SCAN_MAX_FINDINGS = 50
/** 落库 warnings 上限（超出追加「另有 N 条未展示」说明） */
export const SCAN_MAX_WARNINGS = 20
/** 单条警告文本上限 */
export const SCAN_WARNING_MAX = 200
/** 单条 snippet 上限 */
export const SCAN_SNIPPET_MAX = 80
/** tamper-manifest 的「写入调用」邻域半径（字符） */
const TAMPER_NEIGHBORHOOD = 120

interface ScanRule {
  id: string
  level: ScanLevel
  /** 命中描述（警告文本用） */
  label: string
  risk: string
  suggestion: string
  /** A 遍：原文匹配（模块名/字面量型） */
  raw?: RegExp
  /** B 遍：去注释去字符串文本匹配（调用型） */
  code?: RegExp
  /** 需要计次/邻域判断的规则自实现 */
  custom?: (raw: string, code: string) => { index: number }[]
}

/** 规则表（单一数据源：文档/UI/测试共用） */
export const SCAN_RULES: readonly ScanRule[] = [
  {
    id: 'child-process',
    level: 'high',
    label: '使用 child_process',
    risk: '可执行任意系统命令、启动子进程，等价于把宿主机 shell 交给插件',
    suggestion: '若确需外部命令，命令与参数写死白名单、绝不拼接外部输入',
    raw: /\b(?:require\s*\(\s*|from\s*|import\s*\(\s*)['"](?:node:)?child_process['"]/g,
  },
  {
    id: 'shell-exec',
    level: 'high',
    label: '调用进程执行 API',
    risk: '执行外部命令；同步版会阻塞事件循环',
    suggestion: '命令白名单、勿拼接外部输入；异步版避免 shell: true',
    code: /\.(?:execSync|spawnSync|execFileSync|execFile|spawn|fork)\s*\(/g,
  },
  {
    id: 'eval',
    level: 'high',
    label: '使用 eval',
    risk: '动态执行字符串代码，可绕过一切静态检查；若为混淆代码请人工评审',
    suggestion: '移除 eval，用映射表/显式分支替代',
    code: /(?<![.\w$])eval\s*\(/g,
  },
  {
    id: 'new-function',
    level: 'high',
    label: '动态构造函数（Function 构造器）',
    risk: '与 eval 等价的构造器动态执行（含构造器链逃逸）',
    suggestion: '移除动态构造，改为静态函数/映射表',
    raw: /Function\s*\(\s*['"]/g,
    code: /new\s+Function\s*\(/g,
  },
  {
    id: 'fs-destructive',
    level: 'medium',
    label: '调用文件删除 API',
    risk: '删除宿主机文件/目录（配合 {recursive:true} 可清空目录）',
    suggestion: '仅操作自身包目录内路径，并先用 isWithinDir 校验',
    code: /(?:fs|fsp|fsPromises|promises)\s*\.\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/g,
  },
  {
    id: 'net-server',
    level: 'medium',
    label: '引入网络/套接字模块',
    risk: '打开网络端口/原始 socket/自建 HTTP 服务 → 数据外泄或后门入口',
    suggestion: '说明用途；出站请求限定白名单域名',
    raw: /['"](?:node:)?(?:http|https|net|dgram|tls)['"]/g,
  },
  {
    id: 'process-exit',
    level: 'medium',
    label: '调用 process.exit',
    risk: '可直接终止宿主 i-kit 进程（拒绝服务）',
    suggestion: '改为抛错/返回，由主程序决定退出',
    code: /\bprocess\.exit\s*\(/g,
  },
  {
    id: 'dynamic-import',
    level: 'medium',
    label: '动态 import()',
    risk: '运行期拼接路径加载代码 → 可加载远端/隐藏载荷',
    suggestion: '改为静态字面量 import（打包器可静态分析）',
    code: /\bimport\s*\(\s*(?![)\s'"`])|\bimport\s*\([^)]*\+/g,
  },
  {
    id: 'env-enum',
    level: 'low',
    label: '批量读取环境变量',
    risk: '批量读取 process.env → 可能外泄密钥（如 LLM key）',
    suggestion: '只读自身所需键；在 plugin.json 声明用途',
    code: /Object\.(?:keys|entries|values)\s*\(\s*process\.env|JSON\.stringify\s*\(\s*process\.env|process\.env\s*\[/g,
    custom: (raw, code) => {
      // 同一文件静态读取 ≥5 个不同 process.env.X
      const re = /\bprocess\.env\.([A-Za-z_$][\w$]*)/g
      const keys = new Set<string>()
      let first = -1
      let m: RegExpExecArray | null
      while ((m = re.exec(code))) {
        if (first < 0) first = m.index
        keys.add(m[1])
      }
      return keys.size >= 5 && first >= 0 ? [{ index: first }] : []
    },
  },
  {
    id: 'tamper-manifest',
    level: 'medium',
    label: '疑似篡改宿主清单/写入启动脚本',
    risk: '篡改宿主依赖清单或写开机启动脚本（持久化）',
    suggestion: '移除；插件自身配置写入自己的包目录',
    raw: /['"][^'"\n]{0,80}?\.(?:ps1|bat|cmd|sh|service|desktop|plist)['"]/g,
    custom: (raw, code) => {
      const re = /['"]package\.json['"]/g
      const writeRe = /(?:writeFile|appendFile|createWriteStream|outputFile)/
      const out: { index: number }[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(raw))) {
        const from = Math.max(0, m.index - TAMPER_NEIGHBORHOOD)
        const to = Math.min(code.length, m.index + m[0].length + TAMPER_NEIGHBORHOOD)
        if (writeRe.test(code.slice(from, to))) out.push({ index: m.index })
      }
      return out
    },
  },
  {
    id: 'sandbox-primitive',
    level: 'medium',
    label: '使用沙箱/底层逃逸原语',
    risk: '使用 vm/binding/dlopen/Worker 等底层原语，意图不透明',
    suggestion: '明确说明并评审；一般插件不需要',
    raw: /['"](?:node:)?vm['"]/g,
    code: /\bprocess\.binding\s*\(|\bprocess\.dlopen\s*\(|\bnew\s+Worker\s*\(/g,
  },
]

const RULE_LABEL = new Map(SCAN_RULES.map((r) => [r.id, r.label]))

/** 去注释与字符串（保留换行与长度，保证行号/下标与原文对齐） */
export function stripCommentsAndStrings(src: string): string {
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'
  let st: State = 'code'
  const out: string[] = new Array(src.length)
  const blank = (c: string) => (c === '\n' || c === '\r' ? c : ' ')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = i + 1 < src.length ? src[i + 1] : ''
    if (st === 'code') {
      if (c === '/' && c2 === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        st = 'line'
        continue
      }
      if (c === '/' && c2 === '*') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        st = 'block'
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        out[i] = ' '
        i++
        st = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl'
        continue
      }
      out[i] = c
      i++
      continue
    }
    if (st === 'line') {
      out[i] = blank(c)
      if (c === '\n') st = 'code'
      i++
      continue
    }
    if (st === 'block') {
      if (c === '*' && c2 === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        st = 'code'
        continue
      }
      out[i] = blank(c)
      i++
      continue
    }
    // 字符串/模板字面量内部
    if (c === '\\') {
      out[i] = ' '
      if (i + 1 < src.length) {
        out[i + 1] = blank(src[i + 1])
        i += 2
      } else {
        i++
      }
      continue
    }
    const closes = (st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')
    if (closes) {
      out[i] = ' '
      i++
      st = 'code'
      continue
    }
    if ((st === 'sq' || st === 'dq') && c === '\n') {
      // 未闭合的单/双引号字符串：按行结束处理，避免污染后续代码
      out[i] = '\n'
      i++
      st = 'code'
      continue
    }
    out[i] = blank(c)
    i++
  }
  return out.join('')
}

/** 行号定位（前缀换行偏移 + 二分） */
class LineIndex {
  private starts: number[] = [0]

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') this.starts.push(i + 1)
    }
  }

  lineAt(index: number): number {
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

function collect(re: RegExp, text: string, limit: number): number[] {
  const out: number[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push(m.index)
    if (out.length >= limit) break
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

function snippetAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1
  let end = text.indexOf('\n', index)
  if (end < 0) end = text.length
  return text
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SCAN_SNIPPET_MAX)
}

/** 目标文件：manifest.entry 指向的文件 + 包内全部 js/cjs/mjs/ts */
function pickTargets(files: ScanFile[], entry: string): ScanFile[] {
  const wantEntry = String(entry || 'index.js')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  const out: ScanFile[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (f.relPath === wantEntry && !seen.has(f.relPath)) {
      seen.add(f.relPath)
      out.push(f)
    }
  }
  for (const f of files) {
    if (seen.has(f.relPath)) continue
    const dot = f.relPath.lastIndexOf('.')
    const ext = dot >= 0 ? f.relPath.slice(dot).toLowerCase() : ''
    if (!ENTRY_EXTENSIONS.has(ext)) continue
    seen.add(f.relPath)
    out.push(f)
  }
  return out
}

function warningLine(f: ScanFinding): string {
  const label = RULE_LABEL.get(f.rule) ?? f.rule
  const line = `[${f.rule}] ${f.file}:${f.line} ${label} —— ${f.risk}；建议：${f.suggestion}`
  return line.length > SCAN_WARNING_MAX ? `${line.slice(0, SCAN_WARNING_MAX - 1)}…` : line
}

/**
 * 扫描插件包代码（同步、纯函数）。
 * 命中不阻断安装：本函数只产出 findings/warnings。
 */
export function scanPackageCode(files: ScanFile[], entry: string): ScanResult {
  const targets = pickTargets(files, entry)
  const findings: ScanFinding[] = []
  const scannedFiles: string[] = []
  const truncatedFiles: string[] = []
  const scannedAt = new Date().toISOString()

  outer: for (const f of targets) {
    const truncated = f.data.length > SCAN_FILE_MAX_BYTES
    const buf = truncated ? f.data.subarray(0, SCAN_FILE_MAX_BYTES) : f.data
    const raw = buf.toString('utf-8')
    if (raw.includes('\0')) continue // 二进制/含空字符：跳过
    if (truncated) truncatedFiles.push(f.relPath)
    scannedFiles.push(f.relPath)
    const code = stripCommentsAndStrings(raw)
    const lines = new LineIndex(raw)

    for (const rule of SCAN_RULES) {
      if (findings.length >= SCAN_MAX_FINDINGS) break outer
      const hits: number[] = []
      if (rule.raw) hits.push(...collect(rule.raw, raw, SCAN_MAX_PER_RULE_PER_FILE))
      if (rule.code) hits.push(...collect(rule.code, code, SCAN_MAX_PER_RULE_PER_FILE))
      if (rule.custom) hits.push(...rule.custom(raw, code).map((h) => h.index))
      const uniq = [...new Set(hits)].sort((a, b) => a - b).slice(0, SCAN_MAX_PER_RULE_PER_FILE)
      for (const idx of uniq) {
        if (findings.length >= SCAN_MAX_FINDINGS) break outer
        findings.push({
          rule: rule.id,
          level: rule.level,
          file: f.relPath,
          line: lines.lineAt(idx),
          snippet: snippetAt(raw, idx),
          risk: rule.risk,
          suggestion: rule.suggestion,
        })
      }
    }
  }

  const warnings = findings.slice(0, SCAN_MAX_WARNINGS).map(warningLine)
  if (findings.length > SCAN_MAX_WARNINGS) {
    warnings.push(`另有 ${findings.length - SCAN_MAX_WARNINGS} 条警告未展示，详见安装响应`)
  }
  if (truncatedFiles.length) {
    warnings.push(`（大文件已截断扫描：${truncatedFiles.join('、')}）`)
  }
  return {
    warnings,
    scannedAt,
    scannedFiles,
    truncatedFiles,
    truncated: truncatedFiles.length > 0,
    findings,
  }
}
