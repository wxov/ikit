#!/usr/bin/env node
// 插件包签名 / 独立验签 / 树哈希复算（完善⑥，零新依赖：node:crypto + adm-zip）
//
// 用法：
//   # 签名（目录或已导出 zip 二选一；--zip 推荐，与服务器同一份字节）
//   node scripts/sign-plugin.mjs --dir plugins/hello --out tmp/hello-signed.zip --registry-entry \
//        [--name hello] [--title "Hello"] [--version 1.0.0] [--package-url https://…/hello-1.0.0.zip]
//   node scripts/sign-plugin.mjs --zip tmp/hello.zip --out tmp/hello-signed.zip \
//        [--key-file .keys/plugin-signing.key.pem | --key-env PLUGIN_SIGNING_KEY]
//
//   # 只打印树哈希（供与 plugins.json / registry.json 的 sha256 对拍，AC-5；--dir / --zip 同一口径）
//   node scripts/sign-plugin.mjs --zip tmp/hello-signed.zip --print-hash
//   node scripts/sign-plugin.mjs --dir plugins/hello --print-hash
//
//   # 独立验签（**无需私钥**，第三方/CI 复核；AC-6）
//   node scripts/sign-plugin.mjs --verify tmp/hello-signed.zip --pub .keys/plugin-signing.pub.pem
//   node scripts/sign-plugin.mjs --verify --zip tmp/hello-signed.zip --pub .keys/plugin-signing.pub.pem
//   # 目录没有 zip comment 载体 → 信封从参数读（把 --registry-entry / registry.json 条目字段粘进来）：
//   node scripts/sign-plugin.mjs --verify --dir plugins/hello --pub .keys/plugin-signing.pub.pem \
//        --signature <86 字符 base64url> --key-id <ikit-…> --signed-hash <64 位 hex>
//
// ---- --verify 退出码（CI 可断言；stdout 的 `status:` 行是权威结论）----
//   0 = verified（提供 --pub 且验签通过）/ unsigned（无签名信封）/ unverified（未提供 --pub，仅解析信封）
//   1 = invalid（信封字段非法 / 公钥派生 keyId 与信封不符 / signedHash 与内容不符 / crypto.verify 失败）
//   2 = 用法或文件错误（缺参数、--dir 与 --zip 同时给、目标/私钥文件不存在或不可解析）
//   ※ unsigned 保持 exit 0（与 --zip 行为一致）；CI 若要求「必须已签名」，请断言 stdout 含 `status: verified`。
//
// ---- 被签名字节定义（必须与 packages/plugins/plugin-registry/src/signing.ts 一致）----
//   payload    = UTF-8 的 <signedHash> 字符串（64 个小写 hex 字符）
//   signedHash = sha256OfFileTree(files)（与 src/utils.ts 逐字节同构：按 relPath 升序哈希 `<relPath>\0<content>`）
//   signature  = ed25519_sign(privateKey, payload) → base64url（86 字符）
// 语义已冻结：该定义变更必须 bump 信封 schema。
import AdmZip from 'adm-zip'
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SIG_PREFIX = 'ikit-plugin-signature:'
const SIG_SCHEMA = 1
const SIG_ALG = 'ed25519'
// ---- 以下 4 个常量与 packages/plugins/plugin-registry/src/signing.ts 保持一致（改一处必须两处同步）----
const SIG_COMMENT_MAX_BYTES = 4096 // 服务器把超限 comment 视为 invalid（不静默降级）
const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
// 与 packaging.ts 的 EXPORT_EXCLUDE_DIRS 保持一致
const EXPORT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'data', '.staging', '.backup'])

// 退出码（--verify）：0=verified/unsigned/unverified，1=invalid，2=用法或文件错误
const EXIT_OK = 0
const EXIT_INVALID = 1
const EXIT_USAGE = 2

const argv = process.argv.slice(2)

function argValue(flag, fallback) {
  const i = argv.indexOf(flag)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}
function hasFlag(flag) {
  return argv.includes(flag)
}
/** 用法/文件错误：stderr 以 ✗ 开头 + exit 2（与「验签结论 invalid(1)」区分开，供 CI 判定） */
function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(EXIT_USAGE)
}

if (hasFlag('--help') || hasFlag('-h') || argv.length === 0) {
  console.log(`用法:
  node scripts/sign-plugin.mjs --dir <包目录> [--out <zip>] [--registry-entry] [签名/命名参数]
  node scripts/sign-plugin.mjs --zip <zip>   [--out <zip>] [--registry-entry] [签名/命名参数]
  node scripts/sign-plugin.mjs --zip <zip> --print-hash
  node scripts/sign-plugin.mjs --dir <包目录> --print-hash
  node scripts/sign-plugin.mjs --verify <zip> --pub <pem 文件 | base64 SPKI>
  node scripts/sign-plugin.mjs --verify --zip <zip> --pub <pem 文件 | base64 SPKI>
  node scripts/sign-plugin.mjs --verify --dir <包目录> --pub <…> --signature <b64url> --key-id <ikit-…> --signed-hash <64hex>

签名参数:
  --key-file <pem>    私钥文件（默认 .keys/plugin-signing.key.pem）
  --key-env <NAME>    从环境变量读私钥（值支持字面 \\n，便于 CI Secret）
  --registry-entry    打印可粘贴进 registry.json 的条目片段
  --name/--title/--version/--package-url   覆盖 registry 条目字段（缺省从包内 plugin.json 读取）

验签（--verify）退出码: 0=verified/unsigned/unverified  1=invalid  2=用法或文件错误
安全: 私钥内容永不打印、永不写入 zip/日志。`)
  process.exit(EXIT_OK)
}

// ---- 树哈希：与 src/utils.ts 的 sha256OfFileTree 逐字节同构（12 行实现，改一处必须两处同步）----
function sha256OfFileTree(files) {
  const h = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  for (const f of sorted) {
    h.update(f.relPath)
    h.update('\0')
    h.update(f.data)
  }
  return h.digest('hex')
}

/** 从 zip 读取文件树（与 validateZipBuffer 的条目口径一致：非目录条目 + POSIX 相对路径） */
function filesFromZip(zipPath) {
  let buf
  try {
    buf = readFileSync(zipPath)
  } catch {
    throw new Error(`zip 文件不存在或不可读：${path.resolve(zipPath)}`)
  }
  let zip
  try {
    zip = new AdmZip(buf)
  } catch (e) {
    throw new Error(`zip 解析失败：${path.resolve(zipPath)}（${e instanceof Error ? e.message : String(e)}）`)
  }
  const files = []
  for (const e of zip.getEntries()) {
    if (e.isDirectory || e.entryName.endsWith('/')) continue
    const relPath = e.entryName.replace(/\\/g, '/')
    if (relPath.startsWith('/') || relPath.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      throw new Error(`非法条目路径: ${e.entryName}`)
    }
    files.push({ relPath, data: e.getData() })
  }
  return { zip, files }
}

/** 从目录读取文件树（排除规则与 packaging.ts 的 exportPackageToZip 一致：同名目录 + *.log，跳过非普通文件） */
function filesFromDir(dir) {
  const root = path.resolve(dir)
  let st
  try {
    st = statSync(root)
  } catch {
    throw new Error(`包目录不存在：${root}`)
  }
  if (!st.isDirectory()) throw new Error(`--dir 指向的不是目录：${root}`)
  const files = []
  const walk = (cur) => {
    // withFileTypes: true → 拿到 Dirent（it.name / it.isDirectory()）；缺它会让 it 变成字符串 ── AC-4 崩溃根因
    for (const it of readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, it.name)
      if (it.isDirectory()) {
        if (EXPORT_EXCLUDE_DIRS.has(it.name)) continue
        walk(abs)
        continue
      }
      if (!it.isFile()) continue // 符号链接 / socket 等一律跳过（与 packaging.ts 口径一致）
      if (it.name.endsWith('.log')) continue
      const relPath = path.relative(root, abs).split(path.sep).join('/')
      files.push({ relPath, data: readFileSync(abs) })
    }
  }
  walk(root)
  return files
}

/** 解析并校验信封字段（与 src/signing.ts 的 validateEnvelope 同构；返回错误说明，null = 合法） */
function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return '签名信封缺失'
  if (Number(env.schema) !== SIG_SCHEMA) {
    return `签名信封 schema 不受支持（${String(env.schema)}，仅支持 ${SIG_SCHEMA}）`
  }
  if (env.alg !== SIG_ALG) return `签名算法不受支持（${String(env.alg)}，仅支持 ${SIG_ALG}）`
  if (typeof env.keyId !== 'string' || !KEY_ID_RE.test(env.keyId)) {
    return `keyId 非法（${env.keyId ? env.keyId : '空'}）`
  }
  if (typeof env.signedHash !== 'string' || !SHA256_HEX_RE.test(env.signedHash)) {
    return 'signedHash 非法（应为 64 位小写十六进制）'
  }
  if (typeof env.signature !== 'string' || !SIGNATURE_RE.test(env.signature)) {
    return `signature 非法（应为 86 字符 base64url，当前长度 ${env.signature?.length ?? 0}）`
  }
  return null
}

/** 平铺参数（--signature/--key-id/--signed-hash/--signed-at）→ 信封：目录模式的签名载体 */
function envelopeFromArgs() {
  const signature = argValue('--signature', '')
  const keyId = argValue('--key-id', argValue('--keyId', ''))
  const signedHash = argValue('--signed-hash', '').toLowerCase()
  const signedAt = argValue('--signed-at', '')
  // signedAt 单独出现不算「有签名」（纯信息性字段，与签名服务端 parseSignatureInput 一致）
  if (!signature && !keyId && !signedHash) return {}
  const env = { schema: SIG_SCHEMA, alg: SIG_ALG, keyId, signedHash, signature, ...(signedAt ? { signedAt } : {}) }
  const error = validateEnvelope(env)
  return error ? { error } : { envelope: env }
}

/** 独立验签结论输出（--verify --zip 与 --verify --dir 共用，保证三态文案与退出码完全一致） */
function reportVerify({ kind, target, treeSha256, envelope, envelopeError, pubSpec }) {
  console.log(`${kind}: ${target}`)
  console.log(`treeSha256: ${treeSha256}`)
  if (envelopeError) {
    console.log('status: invalid')
    console.log(`error: ${envelopeError}`)
    return EXIT_INVALID
  }
  if (!envelope) {
    const why =
      kind === 'zip'
        ? `zip archive comment 无 ${SIG_PREFIX} 前缀`
        : '目录无签名载体，且未提供 --signature/--key-id/--signed-hash 信封参数'
    console.log(`status: unsigned（${why}）`)
    return EXIT_OK
  }
  console.log(`keyId: ${envelope.keyId}`)
  console.log(`signedHash: ${envelope.signedHash}`)
  if (!pubSpec) {
    console.log('status: unverified（未提供 --pub，仅解析出信封）')
    return EXIT_OK
  }
  let pub
  try {
    pub = loadPublicKey(pubSpec)
  } catch (e) {
    fail(`--pub 公钥无法解析（${pubSpec}）：${e instanceof Error ? e.message : String(e)}`)
  }
  const derived = normalizeKeyId(pub)
  if (derived !== envelope.keyId) {
    console.log('status: invalid')
    console.log(`error: 公钥派生 keyId=${derived} 与信封 keyId=${envelope.keyId} 不一致`)
    return EXIT_INVALID
  }
  if (envelope.signedHash !== treeSha256) {
    console.log('status: invalid')
    console.log(`error: signedHash 与包内容不一致（signedHash=${envelope.signedHash} 实际=${treeSha256}）`)
    return EXIT_INVALID
  }
  const ok = cryptoVerify(null, Buffer.from(envelope.signedHash, 'utf8'), pub, Buffer.from(envelope.signature, 'base64url'))
  console.log(`status: ${ok ? 'verified' : 'invalid'}`)
  if (!ok) console.log('error: crypto.verify 失败（签名与内容/公钥不匹配）')
  return ok ? EXIT_OK : EXIT_INVALID
}

function normalizeKeyId(pubKey) {
  return `ikit-${createHash('sha256').update(pubKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)}`
}

/** 解析公钥：PEM 文件路径 / PEM 字符串 / base64 SPKI */
function loadPublicKey(spec) {
  let raw = String(spec ?? '').trim()
  if (!raw) throw new Error('缺少公钥（--pub）')
  if (!raw.includes('-----BEGIN') && !raw.includes('\\n')) {
    try {
      raw = readFileSync(raw, 'utf-8')
    } catch {
      /* 不是文件 → 当作 base64 处理 */
    }
  }
  const restored = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
  if (restored.includes('-----BEGIN')) return createPublicKey(restored)
  return createPublicKey({ key: Buffer.from(restored.trim(), 'base64'), format: 'der', type: 'spki' })
}

function loadPrivateKey() {
  const envName = argValue('--key-env', '')
  if (envName) {
    const v = process.env[envName]
    if (!v || !v.trim()) fail(`环境变量 ${envName} 为空（私钥未注入）`)
    try {
      return createPrivateKey(v.includes('\\n') ? v.replace(/\\n/g, '\n') : v)
    } catch (e) {
      fail(`环境变量 ${envName} 不是合法的私钥 PEM/PKCS8（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
  const file = argValue('--key-file', path.join('.keys', 'plugin-signing.key.pem'))
  if (!existsSync(file)) {
    fail(`私钥文件不存在：${file}\n  · 生成：node scripts/gen-plugin-key.mjs [--out <目录>]\n  · 或用 --key-file <pem> / --key-env <NAME> 指定`)
  }
  try {
    return createPrivateKey(readFileSync(file, 'utf-8'))
  } catch (e) {
    fail(`私钥文件无法读取或解析：${file}（${e instanceof Error ? e.message : String(e)}）`)
  }
}

/** 读 zip comment 中的签名信封（前缀不匹配 = unsigned；超长/JSON 非法/字段非法 = invalid，与服务器同构） */
function parseEnvelopeFromZip(zip) {
  const comment = zip.getZipComment() || ''
  if (!comment.trim() || !comment.startsWith(SIG_PREFIX)) return { comment, status: 'unsigned' }
  if (Buffer.byteLength(comment, 'utf8') > SIG_COMMENT_MAX_BYTES) {
    return { comment, error: `zip 签名 comment 超过 ${SIG_COMMENT_MAX_BYTES} 字节上限` }
  }
  let env
  try {
    env = JSON.parse(comment.slice(SIG_PREFIX.length).trim())
  } catch (e) {
    return { comment, error: `zip 签名 comment 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!env || typeof env !== 'object') return { comment, error: 'zip 签名 comment 结构非法（应为 JSON 对象）' }
  const fmtErr = validateEnvelope(env)
  return fmtErr ? { comment, error: fmtErr } : { comment, envelope: env }
}

// ================= --print-hash =================
if (hasFlag('--print-hash')) {
  const zipPath = argValue('--zip', '')
  const dirPath = argValue('--dir', '')
  if (zipPath && dirPath) fail('--dir 与 --zip 只能二选一')
  if (!zipPath && !dirPath) fail('--print-hash 需要 --zip 或 --dir')
  let files
  try {
    files = zipPath ? filesFromZip(zipPath).files : filesFromDir(dirPath)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
  process.stdout.write(sha256OfFileTree(files) + '\n')
  process.exit(EXIT_OK)
}

// ================= --verify（无需私钥）=================
// 支持三种写法：--verify <zip>（自动识别目录/zip）/ --verify --zip <zip> / --verify --dir <包目录>
if (hasFlag('--verify')) {
  const pubSpec = argValue('--pub', '')
  const dirArg = argValue('--dir', '')
  const zipArg = argValue('--zip', '')
  if (dirArg && zipArg) fail('--dir 与 --zip 只能二选一')
  const inline = argValue('--verify', '')
  let kind
  let target
  if (dirArg) {
    kind = 'dir'
    target = dirArg
  } else if (zipArg) {
    kind = 'zip'
    target = zipArg
  } else if (inline) {
    target = inline
    let st
    try {
      st = statSync(path.resolve(inline))
    } catch {
      fail(`--verify 目标不存在：${inline}`)
    }
    kind = st.isDirectory() ? 'dir' : 'zip'
  } else {
    fail('--verify 需要目标：--verify <zip> | --verify --zip <zip> | --verify --dir <包目录>')
  }

  let treeSha256
  let envelope
  let envelopeError
  try {
    if (kind === 'zip') {
      const parsed = filesFromZip(target)
      treeSha256 = sha256OfFileTree(parsed.files)
      const p = parseEnvelopeFromZip(parsed.zip)
      envelope = p.envelope
      envelopeError = p.error
    } else {
      treeSha256 = sha256OfFileTree(filesFromDir(target))
      const p = envelopeFromArgs()
      envelope = p.envelope
      envelopeError = p.error
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
  process.exit(reportVerify({ kind, target, treeSha256, envelope, envelopeError, pubSpec }))
}

// ================= 签名 =================
const dirPath = argValue('--dir', '')
const zipPath = argValue('--zip', '')
if (!dirPath && !zipPath) {
  fail('需要 --dir 或 --zip（签名），或 --verify / --print-hash')
}
if (dirPath && zipPath) {
  fail('--dir 与 --zip 只能二选一')
}

const inputPath = zipPath || dirPath
const defaultOut = zipPath
  ? zipPath.replace(/\.zip$/i, '') + '-signed.zip'
  : path.resolve(dirPath.replace(/[\\/]+$/, '')) + '-signed.zip'
const outPath = path.resolve(argValue('--out', defaultOut))

let files
let zip
try {
  if (zipPath) {
    const parsed = filesFromZip(zipPath)
    zip = parsed.zip
    files = parsed.files
  } else {
    files = filesFromDir(dirPath)
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
}
const treeSha256 = sha256OfFileTree(files)

const manifestFile = files.find((f) => f.relPath === 'plugin.json')
let manifest = {}
if (manifestFile) {
  try {
    manifest = JSON.parse(manifestFile.data.toString('utf-8'))
  } catch (e) {
    manifest = {}
    console.error(`⚠️ plugin.json 不是合法 JSON（条目字段将退化为参数/目录名）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!manifest || typeof manifest !== 'object') manifest = {}
}

const priv = loadPrivateKey()
const pubFromPriv = createPublicKey(priv)
const keyId = normalizeKeyId(pubFromPriv)
const signedAt = new Date().toISOString()
const signature = cryptoSign(null, Buffer.from(treeSha256, 'utf8'), priv).toString('base64url')

const envelope = { schema: SIG_SCHEMA, alg: SIG_ALG, keyId, signedHash: treeSha256, signature, signedAt }
const comment = SIG_PREFIX + JSON.stringify(envelope)

if (zipPath) {
  zip.addZipComment(comment)
} else {
  zip = new AdmZip()
  for (const f of files) zip.addFile(f.relPath, f.data)
  zip.addZipComment(comment)
}
mkdirSync(path.dirname(outPath), { recursive: true })
writeFileSync(outPath, zip.toBuffer())

// 自检：写出后重新读回并独立验签（防止「写出的 comment 读不回来」）
const check = filesFromZip(outPath)
const checkParsed = parseEnvelopeFromZip(check.zip)
const selfOk =
  !!checkParsed.envelope &&
  sha256OfFileTree(check.files) === treeSha256 &&
  cryptoVerify(
    null,
    Buffer.from(treeSha256, 'utf8'),
    pubFromPriv,
    Buffer.from(checkParsed.envelope.signature, 'base64url'),
  )

console.log(`✅ 已签名并写出: ${outPath}`)
console.log(`   keyId      : ${keyId}`)
console.log(`   treeSha256 : ${treeSha256}`)
console.log(`   signature  : ${signature}`)
console.log(`   signedAt   : ${signedAt}`)
console.log(`   自检(读回复验): ${selfOk ? 'verified ✅' : 'FAILED ✗'}`)
console.log(`   树哈希未漂移: ${sha256OfFileTree(check.files) === treeSha256 ? '是 ✅（comment 不进入树哈希）' : '否 ✗'}`)
console.log(`   zip 条目数  : 写出前 ${files.length} / 读回 ${check.files.length}`)
if (!selfOk) process.exit(1)

if (hasFlag('--registry-entry')) {
  // 目录/zip 输入都取「包名基线」：去掉扩展名与 -signed 后缀（manifest.name 优先）
  const inputBase = path
    .basename(path.resolve(inputPath))
    .replace(/\.zip$/i, '')
    .replace(/-signed$/i, '')
  const entryVersion = argValue('--version', manifest.version || '')
  if (!entryVersion) {
    console.error(
      '⚠️ 未能确定 version（包内 plugin.json 无 version 且未传 --version）：版本为空的 registry 条目会在安装时被拒（PLUGIN_STORE_VERSION_MISMATCH），请补 --version。',
    )
  }
  const entry = {
    name: argValue('--name', manifest.name || inputBase),
    title: argValue('--title', manifest.title || manifest.name || ''),
    version: entryVersion,
    packageUrl: argValue('--package-url', '<必填：包的下载 URL>'),
    sha256: treeSha256,
    signedHash: treeSha256,
    signature,
    keyId,
    signedAt,
  }
  console.log('')
  console.log('---- 粘贴进 registry.json 的条目片段（务必整段粘进远端 registry.json，否则 enforce 下下载前即被拒装）----')
  console.log(JSON.stringify(entry, null, 2))
}
