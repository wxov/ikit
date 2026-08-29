// Agent 端到端验证：function-calling + 知识库 RAG
// 运行：node scripts/agent-e2e.mjs（需先启动 server 并配置 LLM_API_KEY）
const base = 'http://localhost:3000'

async function chat(message, history = []) {
  const res = await fetch(`${base}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`agent chat ${res.status}: ${text}`)
  }
  return res.json()
}

async function main() {
  // 1. 清理旧数据并写入知识库测试条目
  const existing = await (await fetch(`${base}/api/knowledge/entries`)).json()
  for (const e of existing.entries) {
    await fetch(`${base}/api/knowledge/entries/${e.id}`, { method: 'DELETE' })
  }

  const seed = [
    {
      title: 'Cordis 插件框架',
      content:
        'Cordis 是 Koishi 团队开发的 TypeScript 插件框架，提供依赖注入、服务、生命周期管理与事件总线，是 Koishi 聊天机器人的核心底座。',
      tags: ['cordis', '插件', '框架'],
    },
    {
      title: 'i-kit 项目',
      content:
        'i-kit 是一个机器人 + Web 服务 + AI Agent 的成套项目脚手架，基于 Cordis 插件架构，支持知识库 RAG 与多端互联。',
      tags: ['i-kit', 'agent'],
    },
  ]
  for (const s of seed) {
    await fetch(`${base}/api/knowledge/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    })
  }
  console.log('✅ 已写入知识库测试条目 2 条\n')

  // 2. RAG 验证：问题需要检索知识库
  console.log('━━━ 提问：Cordis 是什么？请结合知识库回答。 ━━━')
  const r1 = await chat('Cordis 是什么？请结合知识库回答。')
  console.log('工具调用轨迹：')
  for (const s of r1.steps) {
    if (s.type === 'tool') {
      console.log(`  🔧 ${s.toolName}(${JSON.stringify(s.toolArgs)})`)
      console.log(`     结果片段：${(s.toolResult ?? '').slice(0, 80)}...`)
    }
  }
  console.log(`\n最终回答：\n${r1.answer}\n`)

  // 3. 简单工具验证：问题需要调用 current_time
  console.log('━━━ 提问：现在几点了？ ━━━')
  const r2 = await chat('现在几点了？')
  for (const s of r2.steps) {
    if (s.type === 'tool') console.log(`  🔧 ${s.toolName}`)
  }
  console.log(`\n最终回答：\n${r2.answer}\n`)

  console.log('✅ Agent 端到端验证完成')
}

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
