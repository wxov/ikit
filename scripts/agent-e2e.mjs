// Agent 端到端验证：function-calling + 知识库 RAG
// 运行：node scripts/agent-e2e.mjs（需先启动 server 并配置 LLM_API_KEY）
// 说明（完善④）：原脚本调用的 POST /api/agent/chat 已随完善② 下线；现改为
//   POST /api/agent/chat-stream（SSE）+ 登录态（知识库写入/删除与 Agent 接口均需登录）。
const base = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '')
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123'

let token = ''

async function login() {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`login ${res.status}: ${text}`)
  }
  const data = await res.json()
  if (!data?.token) throw new Error('login 未返回 token')
  return data.token
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

/** 流式对话：聚合 SSE 事件为 { answer, steps } */
async function chat(message, history = []) {
  const res = await fetch(`${base}/api/agent/chat-stream`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, history }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`agent chat-stream ${res.status}: ${text}`)
  }
  const events = []
  const raw = await res.text()
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload) continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }
  const error = events.find((e) => e.type === 'error')
  if (error) throw new Error(`agent 流式错误：${error.error}`)
  const answer = events
    .filter((e) => e.type === 'delta')
    .map((e) => e.content)
    .join('')
  const steps = events
    .filter((e) => e.type === 'tool')
    .map((e) => ({ type: 'tool', toolName: e.toolName, toolArgs: e.toolArgs, toolResult: e.toolResult }))
  return { answer, steps }
}

async function main() {
  token = await login()
  console.log(`✅ 已登录 ${ADMIN_USERNAME}\n`)

  // 1. 清理旧数据并写入知识库测试条目（知识库写接口需站主权限）
  const existing = await (
    await fetch(`${base}/api/knowledge/entries`, { headers: authHeaders() })
  ).json()
  for (const e of existing.entries ?? []) {
    await fetch(`${base}/api/knowledge/entries/${e.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
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
    const res = await fetch(`${base}/api/knowledge/entries`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(s),
    })
    if (!res.ok) throw new Error(`写入知识条目失败 ${res.status}: ${await res.text()}`)
  }
  console.log('✅ 已写入知识库测试条目 2 条\n')

  // 2. RAG 验证：问题需要检索知识库（admin 调用，可见全部条目）
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
