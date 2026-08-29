import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const base = 'http://localhost:3000'

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

const files = walk('tmp-md')
console.log(`发现 ${files.length} 个 md 文件：`)
const entries = files.map((p) => {
  const content = readFileSync(p, 'utf-8')
  const { title, content: body } = parse(p, content)
  const rel = relative('tmp-md', p).replace(/\\/g, '/')
  const topDir = rel.includes('/') ? rel.split('/')[0] : ''
  console.log(`  - ${p} → 标题「${title}」，tag「${topDir || '-'}」`)
  return { title, content: body, tags: topDir ? [topDir] : [] }
})

const res = await fetch(`${base}/api/knowledge/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ entries }),
})
const r = await res.json()
console.log(`\n导入结果：created = ${r.created}`)
console.log('导入的条目：', r.entries.map((e) => e.title).join('、'))

const list = await (await fetch(`${base}/api/knowledge/entries`)).json()
console.log(`\n当前知识库共 ${list.entries.length} 条：`)
for (const e of list.entries) {
  console.log(`  - ${e.title}  [${e.tags.join(', ')}]`)
}
