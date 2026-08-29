// 分类功能验证：添加/树结构/计数/删除
const base = 'http://localhost:3000'
const post = (m, b) =>
  fetch(base + m, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b ?? {}),
  }).then((r) => r.json())

const print = (nodes, indent = '') => {
  for (const n of nodes) {
    console.log(`  ${indent}${n.name} (${n.count} 篇)`)
    print(n.children, indent + '  ')
  }
}

async function main() {
  console.log('== 1. 添加分类 ==')
  await post('/api/knowledge/categories', { path: '技术/前端' })
  await post('/api/knowledge/categories', { path: '技术/后端' })
  await post('/api/knowledge/categories', { path: '笔记' })

  let tree = await (await fetch(base + '/api/knowledge/categories')).json()
  console.log('分类树：')
  print(tree.categories)

  console.log('\n== 2. 创建带分类的条目 ==')
  await post('/api/knowledge/entries', {
    title: 'Vue3 教程',
    content: 'Vue3 组合式 API 入门。',
    tags: ['vue'],
    category: '技术/前端',
  })
  await post('/api/knowledge/entries', {
    title: 'Fastify 笔记',
    content: 'Fastify 插件系统。',
    tags: [],
    category: '技术/后端',
  })

  tree = await (await fetch(base + '/api/knowledge/categories')).json()
  console.log('分类树（含计数）：')
  print(tree.categories)

  console.log('\n== 3. 删除 技术/后端 及其子分类 ==')
  await fetch(base + '/api/knowledge/categories?path=' + encodeURIComponent('技术/后端'), {
    method: 'DELETE',
  })
  tree = await (await fetch(base + '/api/knowledge/categories')).json()
  print(tree.categories)
  console.log('\n✅ 分类功能验证完成')
}

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
