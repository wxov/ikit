#!/usr/bin/env node
// 完善⑥ 插件签名工具链冒烟：`--dir` 四条路径（签名 / --print-hash / --verify / --registry-entry）+ `--zip` 全流程回归
//
// 运行：node scripts/sign-plugin-smoke.mjs        （exit 0 = 全绿）
// 由来：验收报告「完善⑥」必须修 #1（AC-4：`--dir` 恒定崩溃，原冒烟只覆盖 `--zip`）→ 本脚本把 `--dir` 纳入回归。
//
// 隔离声明：
//   · 所有产物写入系统临时目录（mkdtempSync），**不在仓库内生成 `.keys/`**、不写 `tmp/`；
//   · 密钥由本脚本用 node:crypto 现场生成到 `<tmp>/.keys/`，结束时整目录删除；
//   · 私钥仅以文件路径/环境变量形式传给子进程，脚本与子进程输出都不得含 `PRIVATE KEY`（末尾断言）。
import AdmZip from 'adm-zip'
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const signScript = path.join(repoRoot, 'scripts', 'sign-plugin.mjs')
const SIG_PREFIX = 'ikit-plugin-signature:'

let passed = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failures.push(detail ? `${name} — ${detail}` : name)
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}
/** 跑 sign-plugin.mjs，返回 {code,out,err}（stdout/stderr 全量留存，供私钥泄漏断言） */
const rawOutputs = []
function run(args, env) {
  const r = spawnSync(process.execPath, [signScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  })
  const out = r.stdout || ''
  const err = r.stderr || ''
  rawOutputs.push(out, err)
  return { code: r.status, out, err }
}
const STATUS_RE = /^status:\s*(verified|unsigned|unverified|invalid)\b/m
const statusOf = (out) => (out.match(STATUS_RE) || [, ''])[1]
const hashOf = (out) => (out.trim().match(/^[0-9a-f]{64}$/) ? out.trim() : '')
/** 取 `--registry-entry` 打印的 JSON 条目 */
function entryOf(out) {
  const marker = '---- 粘贴进 registry.json 的条目片段'
  const i = out.indexOf(marker)
  if (i === -1) return null
  const body = out.slice(out.indexOf('\n', i) + 1)
  const start = body.indexOf('{')
  try {
    return JSON.parse(body.slice(start))
  } catch {
    return null
  }
}
function commentOf(zipPath) {
  return new AdmZip(readFileSync(zipPath)).getZipComment() || ''
}

const hadKeysDir = existsSync(path.join(repoRoot, '.keys'))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ikit-sign-smoke-'))
let exitCode = 0
try {
  console.log(`临时目录: ${tmp}`)
  console.log(`签名脚本: ${signScript}`)

  // ---------------- 夹具：临时密钥 + 包目录 ----------------
  const keysDir = path.join(tmp, '.keys')
  mkdirSync(keysDir, { recursive: true })
  const privPath = path.join(keysDir, 'plugin-signing.key.pem')
  const pubPath = path.join(keysDir, 'plugin-signing.pub.pem')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  writeFileSync(privPath, privPem, { mode: 0o600 })
  writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }).toString())
  const keyId = `ikit-${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)}`

  const pkgDir = path.join(tmp, 'pkg')
  mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(
    path.join(pkgDir, 'plugin.json'),
    JSON.stringify({ name: 'smoke-pkg', title: 'Smoke 包', version: '1.2.3', entry: 'index.ts' }, null, 2),
  )
  writeFileSync(path.join(pkgDir, 'index.ts'), 'export const name = "smoke-pkg"\n')
  writeFileSync(path.join(pkgDir, 'lib', 'util.ts'), 'export const v = 1\n')
  // 干扰项（须与 packaging.ts 同规则排除/跳过）
  mkdirSync(path.join(pkgDir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(path.join(pkgDir, 'node_modules', 'x', 'index.js'), 'module.exports = 1\n')
  mkdirSync(path.join(pkgDir, 'data'), { recursive: true })
  writeFileSync(path.join(pkgDir, 'data', 'db.json'), '{}\n')
  writeFileSync(path.join(pkgDir, 'debug.log'), 'noise\n')

  // ---------------- ① --dir 签名 + --registry-entry ----------------
  section('① --dir 签名 + --registry-entry（AC-4 原崩溃点）')
  const dirOut = path.join(tmp, 'dir-signed.zip')
  const r1 = run(['--dir', pkgDir, '--out', dirOut, '--key-file', privPath, '--registry-entry'])
  check('exit 0', r1.code === 0, `code=${r1.code} err=${r1.err.trim().split('\n')[0] || ''}`)
  check('无 TypeError / ERR_INVALID_ARG_TYPE', !/TypeError|ERR_INVALID_ARG_TYPE/.test(r1.out + r1.err))
  check('写出后自检 verified', /自检\(读回复验\): verified/.test(r1.out))
  check('树哈希零漂移', /树哈希未漂移: 是/.test(r1.out))
  check('zip 已生成', existsSync(dirOut))
  check('zip 条目数 3/3（排除 node_modules·data·*.log）', /zip 条目数\s*: 写出前 3 \/ 读回 3/.test(r1.out), r1.out.match(/zip 条目数[^\n]*/)?.[0] || '')
  check('comment 前缀正确', commentOf(dirOut).startsWith(SIG_PREFIX))
  const entryDir = entryOf(r1.out)
  check('registry 条目可解析', !!entryDir)
  check('条目 keyId == 公钥派生 keyId', entryDir?.keyId === keyId, `${entryDir?.keyId} vs ${keyId}`)
  check('条目 sha256 为 64 位小写 hex', /^[0-9a-f]{64}$/.test(entryDir?.sha256 || ''))
  check('条目 signature 为 86 字符 base64url', /^[A-Za-z0-9_-]{86}$/.test(entryDir?.signature || ''))
  check('条目 signedHash == sha256', entryDir?.signedHash === entryDir?.sha256)
  check('条目 version 取自 plugin.json', entryDir?.version === '1.2.3', entryDir?.version)
  check('条目 name 取自 plugin.json', entryDir?.name === 'smoke-pkg', entryDir?.name)

  // ---------------- ② --print-hash --dir / --zip 同口径 ----------------
  section('② --print-hash（--dir 与 --zip 树哈希同口径 + 排除规则对拍）')
  const phDir = run(['--dir', pkgDir, '--print-hash'])
  const phDirHash = hashOf(phDir.out)
  check('--print-hash --dir exit 0', phDir.code === 0, `code=${phDir.code} err=${phDir.err.trim()}`)
  check('--print-hash --dir == registry 条目 sha256', phDirHash && phDirHash === entryDir?.sha256, `${phDirHash} vs ${entryDir?.sha256}`)
  const phZip = run(['--zip', dirOut, '--print-hash'])
  check('--print-hash --zip（已签名 zip）== --dir 哈希（comment 不进树哈希）', hashOf(phZip.out) === phDirHash, `${hashOf(phZip.out)} vs ${phDirHash}`)

  // 独立造一份「未签名 zip」（等同服务器 exportPackageToZip 的条目口径）用于对拍
  const unsignedZip = path.join(tmp, 'unsigned.zip')
  {
    const zip = new AdmZip()
    for (const rel of ['index.ts', 'lib/util.ts', 'plugin.json']) zip.addFile(rel, readFileSync(path.join(pkgDir, rel)))
    writeFileSync(unsignedZip, zip.toBuffer())
  }
  const phUnsigned = run(['--zip', unsignedZip, '--print-hash'])
  check('--dir 哈希 == 同内容未签名 zip 哈希（口径一致）', hashOf(phUnsigned.out) === phDirHash, `${hashOf(phUnsigned.out)} vs ${phDirHash}`)

  // ---------------- ③ --verify 三态 × 两种输入形态 ----------------
  section('③ --verify：verified / unsigned / invalid × zip|dir + 退出码')
  const vZip = run(['--verify', dirOut, '--pub', pubPath])
  check('zip 内联目标 → verified', statusOf(vZip.out) === 'verified', vZip.out.trim())
  check('verified 退出码 0', vZip.code === 0, `code=${vZip.code}`)
  const vZipFlag = run(['--verify', '--zip', dirOut, '--pub', pubPath])
  check('--verify --zip → verified（显式形态）', statusOf(vZipFlag.out) === 'verified' && vZipFlag.code === 0)
  const vDir = run([
    '--verify', '--dir', pkgDir, '--pub', pubPath,
    '--signature', entryDir.signature, '--key-id', entryDir.keyId, '--signed-hash', entryDir.signedHash,
  ])
  check('--verify --dir + registry 条目字段 → verified', statusOf(vDir.out) === 'verified', vDir.out.trim())
  check('--verify --dir 退出码 0', vDir.code === 0, `code=${vDir.code}`)
  check('--verify --dir 输出 treeSha256 与 --dir 一致', vDir.out.includes(phDirHash), vDir.out.trim())
  check('两种输入 status 文案集合一致（均含 treeSha256/status 行）', /treeSha256:/.test(vDir.out) && /treeSha256:/.test(vZip.out))

  const vDirNoEnv = run(['--verify', '--dir', pkgDir, '--pub', pubPath])
  check('--verify --dir 不给信封参数 → unsigned', statusOf(vDirNoEnv.out) === 'unsigned')
  check('unsigned 退出码 0', vDirNoEnv.code === 0, `code=${vDirNoEnv.code}`)
  const vUnsigned = run(['--verify', unsignedZip, '--pub', pubPath])
  check('未签名 zip → unsigned', statusOf(vUnsigned.out) === 'unsigned' && vUnsigned.code === 0)
  const vNoPub = run(['--verify', dirOut])
  check('有信封但未给 --pub → unverified', statusOf(vNoPub.out) === 'unverified' && vNoPub.code === 0, vNoPub.out.trim())

  // 篡改：保留原 comment，改一个字节
  const tamperedZip = path.join(tmp, 'tampered.zip')
  {
    const zip = new AdmZip(readFileSync(dirOut))
    zip.updateFile('index.ts', Buffer.from('export const name = "smoke-pkg-TAMPERED"\n'))
    writeFileSync(tamperedZip, zip.toBuffer())
  }
  const vTampered = run(['--verify', tamperedZip, '--pub', pubPath])
  check('篡改内容（保留 comment）→ invalid', statusOf(vTampered.out) === 'invalid', vTampered.out.trim())
  check('invalid 退出码 1', vTampered.code === 1, `code=${vTampered.code}`)

  const tamperedDir = path.join(tmp, 'pkg-tampered')
  mkdirSync(path.join(tamperedDir, 'lib'), { recursive: true })
  for (const rel of ['index.ts', 'lib/util.ts', 'plugin.json']) writeFileSync(path.join(tamperedDir, rel), readFileSync(path.join(pkgDir, rel)))
  writeFileSync(path.join(tamperedDir, 'index.ts'), 'export const name = "TAMPERED"\n')
  const vTamperedDir = run([
    '--verify', '--dir', tamperedDir, '--pub', pubPath,
    '--signature', entryDir.signature, '--key-id', entryDir.keyId, '--signed-hash', entryDir.signedHash,
  ])
  check('--verify --dir 篡改 + 原条目 signedHash → invalid', statusOf(vTamperedDir.out) === 'invalid', vTamperedDir.out.trim())
  check('--verify --dir invalid 退出码 1', vTamperedDir.code === 1, `code=${vTamperedDir.code}`)

  const vBadField = run(['--verify', '--dir', pkgDir, '--pub', pubPath, '--signature', 'abc', '--key-id', keyId, '--signed-hash', phDirHash])
  check('信封字段非法（signature=abc）→ invalid(1)', statusOf(vBadField.out) === 'invalid' && vBadField.code === 1, vBadField.out.trim())
  const vWrongKey = run(['--verify', '--dir', pkgDir, '--pub', pubPath, '--signature', entryDir.signature, '--key-id', 'ikit-0000000000000000', '--signed-hash', phDirHash])
  check('keyId 与公钥不符 → invalid(1)', statusOf(vWrongKey.out) === 'invalid' && vWrongKey.code === 1)

  // comment > 4KB 分支（与服务器 SIG_COMMENT_MAX_BYTES=4096 对齐）
  const bigCommentZip = path.join(tmp, 'big-comment.zip')
  {
    const zip = new AdmZip(readFileSync(dirOut))
    zip.addZipComment(SIG_PREFIX + JSON.stringify({ schema: 1, alg: 'ed25519', keyId, signedHash: phDirHash, signature: entryDir.signature, pad: 'x'.repeat(4300) }))
    writeFileSync(bigCommentZip, zip.toBuffer())
  }
  const vBig = run(['--verify', bigCommentZip, '--pub', pubPath])
  check('comment > 4096 字节 → invalid + 明确原因', statusOf(vBig.out) === 'invalid' && /4096 字节上限/.test(vBig.out), vBig.out.trim())
  check('comment > 4KB 退出码 1', vBig.code === 1, `code=${vBig.code}`)

  // 公钥错误：signing.ts 的 alg/schema 语义（脚本须与服务器同构，不静默 verified）
  const wrongAlgZip = path.join(tmp, 'wrong-alg.zip')
  {
    const zip = new AdmZip(readFileSync(dirOut))
    zip.addZipComment(SIG_PREFIX + JSON.stringify({ schema: 2, alg: 'rsa', keyId, signedHash: phDirHash, signature: entryDir.signature }))
    writeFileSync(wrongAlgZip, zip.toBuffer())
  }
  const vAlg = run(['--verify', wrongAlgZip, '--pub', pubPath])
  check('schema/alg 非法（服务器判 MALFORMED）→ invalid(1)', statusOf(vAlg.out) === 'invalid' && vAlg.code === 1, vAlg.out.trim())

  // ---------------- ④ --zip 全流程（不回归） ----------------
  section('④ --zip 全流程（不回归：写后读回、comment 前缀、树哈希零漂移、重复签名不叠加）')
  const zipOut = path.join(tmp, 'zip-signed.zip')
  const r4 = run(['--zip', unsignedZip, '--out', zipOut, '--key-file', privPath, '--registry-entry'])
  check('--zip 签名 exit 0', r4.code === 0, `code=${r4.code} err=${r4.err.trim().split('\n')[0] || ''}`)
  check('--zip 自检 verified', /自检\(读回复验\): verified/.test(r4.out))
  check('--zip 树哈希零漂移', /树哈希未漂移: 是/.test(r4.out))
  check('--zip comment 前缀正确', commentOf(zipOut).startsWith(SIG_PREFIX))
  const entryZip = entryOf(r4.out)
  check('--zip 条目 sha256 == --dir 树哈希（两路同口径）', entryZip?.sha256 === phDirHash, `${entryZip?.sha256} vs ${phDirHash}`)
  check('--zip 条目 version 取自 plugin.json', entryZip?.version === '1.2.3')
  const vZipOut = run(['--verify', zipOut, '--pub', pubPath])
  check('--zip 产物独立验签 verified', statusOf(vZipOut.out) === 'verified' && vZipOut.code === 0)

  const reSignOut = path.join(tmp, 're-signed.zip')
  const r5 = run(['--zip', dirOut, '--out', reSignOut, '--key-file', privPath])
  const reComment = commentOf(reSignOut)
  check('对已签名 zip 再签名 exit 0', r5.code === 0, `code=${r5.code}`)
  check('comment 为替换而非叠加（前缀只出现 1 次）', reComment.split(SIG_PREFIX).length - 1 === 1, `出现 ${reComment.split(SIG_PREFIX).length - 1} 次`)
  check('再签名后仍 verified', statusOf(run(['--verify', reSignOut, '--pub', pubPath]).out) === 'verified')

  // ---------------- ⑤ --key-env / 参数与文件错误分支 ----------------
  section('⑤ --key-env 与错误分支（友好报错 + 退出码 2，无裸栈）')
  const envOut = path.join(tmp, 'env-signed.zip')
  const rEnv = run(['--dir', pkgDir, '--out', envOut, '--key-env', 'SMOKE_PLUGIN_KEY'], { SMOKE_PLUGIN_KEY: privPem })
  check('--key-env（多行 PEM）签名 exit 0', rEnv.code === 0, `code=${rEnv.code} err=${rEnv.err.trim().split('\n')[0] || ''}`)
  check('--key-env 与 --key-file 同 keyId', rEnv.out.includes(keyId))
  check('--key-env 产物 verified', statusOf(run(['--verify', envOut, '--pub', pubPath]).out) === 'verified')

  const rNoKey = run(['--dir', pkgDir, '--out', path.join(tmp, 'x.zip'), '--key-file', path.join(tmp, 'nope.pem')])
  check('--key-file 不存在 → exit 2 + ✗ 友好提示', rNoKey.code === 2 && rNoKey.err.includes('私钥文件不存在'), `code=${rNoKey.code} err=${rNoKey.err.trim().split('\n')[0] || ''}`)
  check('--key-file 不存在不打印裸栈', !/at Object|ERR_INVALID_ARG_TYPE/.test(rNoKey.err))

  const rNoSuchDir = run(['--dir', path.join(tmp, 'no-such-dir'), '--out', path.join(tmp, 'y.zip'), '--key-file', privPath])
  check('--dir 目录不存在 → exit 2 + 明确原因', rNoSuchDir.code === 2 && rNoSuchDir.err.includes('包目录不存在'), `code=${rNoSuchDir.code} err=${rNoSuchDir.err.trim()}`)
  const rVerifyNothing = run(['--verify'])
  check('--verify 缺目标 → exit 2（不误入签名分支）', rVerifyNothing.code === 2 && rVerifyNothing.err.includes('--verify 需要目标'), `code=${rVerifyNothing.code} err=${rVerifyNothing.err.trim()}`)
  const rBoth = run(['--dir', pkgDir, '--zip', unsignedZip, '--key-file', privPath])
  check('--dir 与 --zip 同时给 → exit 2', rBoth.code === 2 && rBoth.err.includes('只能二选一'), `code=${rBoth.code}`)
  const rPhBoth = run(['--print-hash', '--dir', pkgDir, '--zip', unsignedZip])
  check('--print-hash 双输入 → exit 2', rPhBoth.code === 2)
  const rUsage = run([])
  check('无参数 → 打印用法 exit 0', rUsage.code === 0 && rUsage.out.includes('用法:'))

  // ---------------- ⑥ 私钥零泄漏 / 仓库零污染 ----------------
  section('⑥ 私钥零泄漏与隔离')
  const allOutput = rawOutputs.join('\n')
  check('全部子进程输出无 PRIVATE KEY', !/PRIVATE KEY/.test(allOutput))
  check('全部子进程输出无私钥 base64 片段（PEM body）', !allOutput.includes(privPem.split('\n')[1]?.trim() || '###'))
  check('仓库根未生成 .keys/', existsSync(path.join(repoRoot, '.keys')) === hadKeysDir)
  check('全部产物都在临时目录内', [dirOut, unsignedZip, zipOut, tamperedZip, bigCommentZip, wrongAlgZip, envOut, reSignOut].every((p) => p.startsWith(tmp)))
} catch (e) {
  failures.push(`冒烟脚本自身异常：${e instanceof Error ? e.stack || e.message : String(e)}`)
  exitCode = 1
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch (e) {
    failures.push(`临时目录清理失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

console.log(`\n===== 结果：PASS ${passed} / FAIL ${failures.length} =====`)
if (failures.length) {
  for (const f of failures) console.log(`  ❌ ${f}`)
  exitCode = 1
}
console.log(`临时目录已删除: ${!existsSync(tmp)}（${tmp}）`)
process.exit(exitCode)
