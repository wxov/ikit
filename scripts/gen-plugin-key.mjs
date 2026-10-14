#!/usr/bin/env node
// 生成 ed25519 插件签名密钥对（完善⑥）
//
// 用法：
//   node scripts/gen-plugin-key.mjs [--out .keys] [--force] [--name official]
//
// 产物（**私钥绝不入库**）：
//   <out>/plugin-signing.key.pem   PKCS8 PEM，mode 0600，flag 'wx'（已存在即报错，除 --force）
//   <out>/plugin-signing.pub.pem   SPKI PEM（公钥可随配置/镜像分发）
//
// stdout 只打印：keyId、可粘贴的 .env 行、可粘贴进 src/trusted-keys.ts 的片段、gitignore 检查结果。
// **绝不打印私钥内容**（AC-1/AC-28）；CI 场景请自行把私钥文件内容存为 Secret，配合
// `node scripts/sign-plugin.mjs --key-env <NAME>` 使用。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`用法: node scripts/gen-plugin-key.mjs [--out .keys] [--force] [--name official]

  --out <dir>   输出目录（相对项目根，默认 .keys）
  --force       覆盖已存在的密钥文件（默认拒绝覆盖，防误抹旧密钥）
  --name <name> 密钥用途备注（写入 .env 片段注释，默认 official）`)
  process.exit(0)
}

const cwd = process.cwd()
const outArg = argValue('--out', '.keys')
const force = hasFlag('--force')
const keyName = argValue('--name', 'official')

const outDir = path.resolve(cwd, outArg)
// 仅允许项目根内的相对路径（避免误写系统目录）
const relOut = path.relative(cwd, outDir)
if (relOut.startsWith('..') || path.isAbsolute(relOut)) {
  console.error(`✗ --out 必须是项目根内的相对路径（当前: ${outArg}）`)
  process.exit(1)
}

const privPath = path.join(outDir, 'plugin-signing.key.pem')
const pubPath = path.join(outDir, 'plugin-signing.pub.pem')

// ---- 生成 ed25519 密钥对 ----
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const pubDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

// keyId 由公钥派生：'ikit-' + sha256(SPKI DER)[:16]（必须与 src/signing.ts deriveKeyId 一致）
const keyId = `ikit-${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)}`

// 自检：密钥对确实匹配（避免写出错配文件）
const probe = Buffer.from('ikit-plugin-signing-selfcheck', 'utf8')
if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) {
  console.error('✗ 密钥对自检失败（生成结果异常），未写入任何文件')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

// 预检：两个文件都不存在（或显式 --force）才继续，避免「私钥已写、公钥冲突」的半状态
if (!force) {
  for (const [file, label] of [
    [privPath, '私钥'],
    [pubPath, '公钥'],
  ]) {
    if (existsSync(file)) {
      console.error(`✗ ${label}已存在，拒绝覆盖：${file}`)
      console.error('  确认要更换密钥（旧密钥将无法再签新包，已发布包仍可验证）时，请加 --force，或先手工备份并删除这两个文件。')
      process.exit(1)
    }
  }
}

function writeKey(file, content, mode, label) {
  try {
    writeFileSync(file, content, { flag: force ? 'w' : 'wx', mode })
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      console.error(`✗ ${label}已存在，拒绝覆盖：${file}`)
      console.error('  确认要更换密钥（旧密钥将无法再签新包，已发布包仍可验证）时，请加 --force 或先手工备份并删除该文件。')
      process.exit(1)
    }
    throw e
  }
}

writeKey(privPath, privPem, 0o600, '私钥')
writeKey(pubPath, pubPem, 0o644, '公钥')

// ---- gitignore 检查（不擅自改文件，只醒目提示）----
function inGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function gitIgnored(absPath) {
  try {
    const rel = path.relative(cwd, absPath).split(path.sep).join('/')
    execFileSync('git', ['check-ignore', '--quiet', rel], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const isRepo = inGitRepo()
const privIgnored = gitIgnored(privPath)
const pubIgnored = gitIgnored(pubPath)

const relPriv = './' + path.relative(cwd, privPath).split(path.sep).join('/')
const relPub = './' + path.relative(cwd, pubPath).split(path.sep).join('/')

console.log(`✅ 已生成 ed25519 插件签名密钥对（keyName=${keyName}；私钥未打印，仅落盘）`)
console.log('')
console.log(`keyId（由公钥派生，不可人为指定）: ${keyId}`)
console.log(`私钥: ${privPath}   ← 请立即离线备份；切勿提交 / 外发 / 贴进 .env`)
console.log(`公钥: ${pubPath}`)
console.log('')
console.log('---- 追加到 .env（仅公钥，安全）----')
console.log(`PLUGIN_SIGNATURE_MODE=warn`)
console.log(`PLUGIN_SIGNING_PUBKEY_FILE=${relPub}`)
console.log('')
console.log('---- 官方发布构建可选：登记进 packages/plugins/plugin-registry/src/trusted-keys.ts ----')
console.log(`export const BUILTIN_TRUSTED_KEYS: TrustedKeyTable = {`)
console.log(`  '${keyId}': { publicKey: '${pubDerB64}', status: 'active' },`)
console.log(`}`)
console.log('')
console.log('---- 提示 ----')
if (!isRepo) {
  console.log(`* 当前目录不是 git 仓库（跳过 gitignore 检查）；请确认 \`${outArg}/\` 在真实仓库中已被忽略`)
} else {
  console.log(
    privIgnored
      ? `* gitignore：私钥已被忽略 ✅`
      : `* ⚠️ 私钥未被 gitignore 忽略！请把 \`${outArg}/\` 或 \`${relPriv}\` 加入 .gitignore 后再继续（否则可能被提交）。`,
  )
  console.log(
    pubIgnored
      ? `* gitignore：公钥同样被忽略（.keys/ 整体忽略，简化运维；公钥本身是公开信息）`
      : `* 公钥未被忽略（可提交；如需随版本分发，请把上面的 trusted-keys 片段写进代码）`,
  )
}
console.log(`* CI Secret：把私钥文件内容存为 Secret，签名时用 \`--key-env <NAME>\`（本脚本不打印私钥）`)
console.log(`* 吊销/轮换：新密钥追加为 active，旧的改 status:'retired'；吊销 = 从信任表删除该项`)
