// 批量导入端到端验证：扫描 tmp-md/ 下的 .md 文件 → POST /api/knowledge/import（站主）
//
// 使用前提：先在仓库根准备好待导入的 Markdown 目录，例如
//   tmp-md/
//     顶层目录即标签（tags），子目录即分类路径（category）
//     技术/前端/vue.md  →  tags: ['技术'], category: '技术/前端'
//   （目录不存在时脚本会报错提示）
//
// 运行：node scripts/import-test.mjs
//   可用环境变量覆盖默认值：BASE / ADMIN_USERNAME / ADMIN_PASSWORD / PARENT_ID
//   PARENT_ID：可选，指定统一挂载的父文档 id（缺省 = 顶层，行为不变）
//   需服务已启动（默认 http://localhost:3000）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

const base = process.env.BASE ?? 'http://localhost:3000'
const username = process.env.ADMIN_USERNAME ?? 'admin'
const password = process.env.ADMIN_PASSWORD ?? 'admin123'
const parentId = (process.env.PARENT_ID ?? '').trim()

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(md|markdown)$/i.test(name)) out.push(p)
  }
  return out
}

function parse(filename, content) {
  const lines = content.split(/\r?\n/)
  const heading = lines[0]?.trim().match(/^#\s+(.+)$/)
  if (heading) return { title: heading[1].trim(), content: lines.slice(1).join('\n').trim() }
  return { title: filename.replace(/\.(md|markdown)$/i, ''), content: content.trim() }
}

// ---- 1. 登录拿 token（导入接口为站主专属，必须带 Authorization）----
const loginRes = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
if (!loginRes.ok) {
  console.error(`登录失败（HTTP ${loginRes.status}）：请检查 ADMIN_USERNAME / ADMIN_PASSWORD`)
  process.exit(1)
}
const { token } = await loginRes.json()
const authHeaders = { Authorization: `Bearer ${token}` }

let files
try {
  files = walk('tmp-md')
} catch {
  console.error('未找到 tmp-md/ 目录：请先在当前目录准备好待导入的 Markdown 文件')
  process.exit(1)
}

console.log(`发现 ${files.length} 个 md 文件：`)
const entries = files.map((p) => {
  const content = readFileSync(p, 'utf-8')
  const { title, content: body } = parse(basename(p), content)
  const rel = relative('tmp-md', p).replace(/\\/g, '/')
  const topDir = rel.includes('/') ? rel.split('/')[0] : ''
  console.log(`  - ${p} → 标题「${title}」，tag「${topDir || '-'}」`)
  return { title, content: body, tags: topDir ? [topDir] : [] }
})

// ---- 2. 批量导入（站主鉴权；PARENT_ID 存在时挂载到该父文档下）----
const res = await fetch(`${base}/api/knowledge/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify(parentId ? { entries, parentId } : { entries }),
})
const r = await res.json()
if (!res.ok) {
  console.error(`导入失败（HTTP ${res.status}）：`, r?.error ?? r)
  process.exit(1)
}
console.log(`\n挂载目标：${parentId ? `父文档 ${parentId}` : '顶层（无父文档）'}`)
console.log(`导入结果：created = ${r.created}`)
console.log('导入的条目：', r.entries.map((e) => e.title).join('、'))

// ---- 3. 复核列表（含挂载层级与分类继承）----
const list = await (await fetch(`${base}/api/knowledge/entries`, { headers: authHeaders })).json()
const titleOf = (id) => list.entries.find((e) => e.id === id)?.title ?? id
if (parentId) {
  const target = list.entries.find((e) => e.id === parentId)
  console.log(`\n挂载目标标题：${target ? `「${target.title}」` : `（未在列表中查证到 ${parentId}）`}`)
}
console.log(`\n当前知识库共 ${list.entries.length} 条：`)
for (const e of list.entries) {
  const parent = e.parentId ? ` ↳ 父：${titleOf(e.parentId)}` : ''
  const cat = e.category ? ` 分类：${e.category}` : ''
  const vis = e.visibility ? ` 可见性：${e.visibility}` : ''
  console.log(`  - ${e.title}  [${e.tags.join(', ')}]${cat}${vis}${parent}`)
}
