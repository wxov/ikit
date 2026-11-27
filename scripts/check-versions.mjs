#!/usr/bin/env node
// 版本号一致性校验（P2-12，2026-11-28）
//
// 项目版本号分散在 7 处，发版时手改易漏。本脚本以「根 package.json 的 version」为唯一权威，
// 校验其余位置是否一致；不一致则退出码 1（供 CI / 发版前检查使用）。
//
// 覆盖位置：
//   1. packages/server/package.json            version
//   2. apps/web/package.json                   version
//   3. apps/web/src-tauri/Cargo.toml           [package] version
//   4. apps/web/src-tauri/Cargo.lock           name = "ikit" 的 version
//   5. apps/web/src-tauri/tauri.conf.json      version
//   6. apps/web/android/app/build.gradle       versionName + versionCode
//
// versionCode 规则（与现有发布一致）：major*10000 + minor*100 + patch（0.2.13 → 213）。

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(root, p), 'utf-8')

const pkg = JSON.parse(read('package.json'))
const version = String(pkg.version ?? '').trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`✗ 根 package.json version 非法：${JSON.stringify(pkg.version)}`)
  process.exit(1)
}
const [major, minor, patch] = version.split('.').map(Number)
const expectedCode = major * 10000 + minor * 100 + patch

const problems = []
const ok = []
const expect = (label, actual, want) => {
  if (String(actual) === String(want)) ok.push(label)
  else problems.push(`${label}：期望 ${want}，实际 ${actual}`)
}

// 1/2. 子包 package.json
for (const p of ['packages/server/package.json', 'apps/web/package.json']) {
  const j = JSON.parse(read(p))
  expect(`${p} version`, j.version, version)
}

// 3. Cargo.toml（取 [package] 段内的 version）
const cargo = read('apps/web/src-tauri/Cargo.toml')
const cargoPkg = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? ''
const cargoVer = /^version\s*=\s*"([^"]+)"/m.exec(cargoPkg)?.[1]
expect('apps/web/src-tauri/Cargo.toml [package] version', cargoVer, version)

// 4. Cargo.lock 中 name = "ikit" 的版本
const lock = read('apps/web/src-tauri/Cargo.lock')
const lockEntry = /name\s*=\s*"ikit"\s*\nversion\s*=\s*"([^"]+)"/.exec(lock)?.[1]
expect('apps/web/src-tauri/Cargo.lock (ikit) version', lockEntry, version)

// 5. tauri.conf.json
const tauri = JSON.parse(read('apps/web/src-tauri/tauri.conf.json'))
expect('apps/web/src-tauri/tauri.conf.json version', tauri.version, version)

// 6. Android build.gradle
const gradle = read('apps/web/android/app/build.gradle')
const gradleName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1]
const gradleCode = /versionCode\s+(\d+)/.exec(gradle)?.[1]
expect('apps/web/android/app/build.gradle versionName', gradleName, version)
expect('apps/web/android/app/build.gradle versionCode', gradleCode, expectedCode)

if (problems.length) {
  console.error(`✗ 版本号不一致（权威值 ${version}）：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`✓ 版本号一致：${version}（校验 ${ok.length} 处；versionCode=${expectedCode}）`)
