// 端到端验证脚本：REST + WebSocket 完整链路
// 运行：node scripts/e2e.mjs（需先启动 server）
const base = 'http://localhost:3000'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('== 1. health ==')
  const health = await (await fetch(`${base}/api/health`)).json()
  console.log('   ', JSON.stringify(health))

  console.log('== 2. demo/hello（中文） ==')
  const hello = await (
    await fetch(`${base}/api/demo/hello?name=${encodeURIComponent('世界')}`)
  ).json()
  console.log('   ', hello.message)

  console.log('== 3. WebSocket 连接 ==')
  const ws = new WebSocket('ws://localhost:3000/ws')
  const received = []
  ws.onmessage = (e) => received.push(JSON.parse(e.data))
  await new Promise((r) => (ws.onopen = r))
  console.log('    connected')

  // 清理历史数据
  const existing = await (await fetch(`${base}/api/knowledge/entries`)).json()
  for (const e of existing.entries) {
    await fetch(`${base}/api/knowledge/entries/${e.id}`, { method: 'DELETE' })
  }
  console.log(`    清理旧数据 ${existing.entries.length} 条`)
  await sleep(200)

  console.log('== 4. knowledge create（中文） ==')
  const created = await (
    await fetch(`${base}/api/knowledge/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Cordis 插件框架',
        content: 'TypeScript 插件框架，提供依赖注入、生命周期与事件总线。',
        tags: ['cordis', '插件', '框架'],
      }),
    })
  ).json()
  console.log('   ', created.entry.title)
  await sleep(300)

  console.log('== 5. search "cordis" ==')
  const search = await (
    await fetch(`${base}/api/knowledge/search?q=${encodeURIComponent('cordis')}`)
  ).json()
  console.log('    results:', search.results.length, '| top:', search.results[0]?.entry.title, '| score:', search.results[0]?.score.toFixed(3))

  console.log('== 6. update ==')
  const updated = await (
    await fetch(`${base}/api/knowledge/entries/${created.entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cordis 插件框架（已更新）' }),
    })
  ).json()
  console.log('   ', updated.entry.title)
  await sleep(300)

  console.log('== 7. delete ==')
  await fetch(`${base}/api/knowledge/entries/${created.entry.id}`, { method: 'DELETE' })
  console.log('    deleted')
  await sleep(300)

  console.log('== 8. WebSocket 事件汇总 ==')
  for (const m of received) {
    if (m.type === 'connected' || m.type === 'pong') continue
    console.log(`    [${m.type}]`, JSON.stringify(m.payload))
  }

  ws.close()
  console.log('\n✅ 端到端链路验证完成')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
