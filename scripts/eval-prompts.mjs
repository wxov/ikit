#!/usr/bin/env node
// 金标评测脚本（2026-11-28，M2）
//
// 默认离线：不调用模型，校验「prompt 拼接 / 解析 / 降级 / 技能索引」是否符合预期（可进 CI）。
// --live：额外用真实模型跑拾光润色与提示词改写，打印输出与基础指标（需 LLM_API_BASE/KEY/MODEL）。
//
// 用法：
//   pnpm eval:prompts
//   pnpm eval:prompts --live
//   pnpm eval:prompts --live --api-base https://api.deepseek.com --model deepseek-chat
//
// 退出码：离线检查有失败 → 1；--live 只打印结果，不因质量主观判断失败（网络错误会失败）。
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPolishPrompt } from '../packages/api/src/routes/shiguang-polish.js'
import { buildPromptPolishMessages, parsePromptPolishOutput } from '../packages/api/src/routes/prompt-polish.js'
import { SKILLS, skillIndexText } from '../packages/plugins/agent/src/skills.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cases = JSON.parse(readFileSync(resolve(root, 'docs/eval/prompt-cases.json'), 'utf-8'))

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

let pass = 0
let fail = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS ${name}${detail ? ' | ' + detail : ''}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' | ' + detail : ''}`)
    console.log(`  FAIL ${name}${detail ? ' | ' + detail : ''}`)
  }
}

console.log('=== 1) 拾光润色 prompt（离线）===')
for (const c of cases.shiguang ?? []) {
  const p = buildPolishPrompt(c.type, c.intensity, c.style, c.mode ?? 'full')
  const missing = (c.expect ?? []).filter((k) => !p.system.includes(k))
  check(
    c.name,
    missing.length === 0,
    missing.length ? `缺少关键词：${missing.join('、')}` : `temp=${p.temperature} maxTokens=${p.maxTokens}`,
  )
}

console.log('\n=== 2) 小知提示词改写解析（离线）===')
for (const c of cases.promptPolish ?? []) {
  const msgs = buildPromptPolishMessages(c.text, '评测用例')
  check(`${c.name} · 消息含原文`, msgs.some((m) => m.content.includes(c.text)))
  const r = parsePromptPolishOutput(c.modelOutput, c.text)
  check(`${c.name} · intent=${c.expectIntent}`, r.intent === c.expectIntent, `实际 ${r.intent}`)
  check(`${c.name} · degraded=${c.expectDegraded}`, r.degraded === c.expectDegraded, `实际 ${r.degraded}`)
  check(`${c.name} · prompt 含「${c.promptContains}」`, r.prompt.includes(c.promptContains), r.prompt.slice(0, 40))
}

console.log('\n=== 3) 技能索引（离线）===')
for (const name of cases.skills?.expectSkills ?? []) {
  check(`技能存在：${name}`, SKILLS.some((s) => s.name === name))
}
const idx = skillIndexText()
for (const k of cases.skills?.indexContains ?? []) {
  check(`索引含「${k}」`, idx.includes(k))
}
check('技能正文不进入索引', !idx.includes('步骤：'))
check(
  '技能 body ≤1500 字',
  SKILLS.every((s) => s.body.length <= 1500),
  SKILLS.map((s) => `${s.name}:${s.body.length}`).join(' '),
)

if (live) {
  const apiBase = (argOf('--api-base') ?? process.env.LLM_API_BASE ?? '').replace(/\/+$/, '')
  const apiKey = argOf('--api-key') ?? process.env.LLM_API_KEY ?? ''
  const model = argOf('--model') ?? process.env.LLM_MODEL ?? ''
  if (!apiBase || !apiKey || !model) {
    console.error('\n[--live] 缺少 LLM_API_BASE / LLM_API_KEY / LLM_MODEL（或 --api-base/--api-key/--model）')
    process.exit(1)
  }
  const chat = async (messages, opts = {}) => {
    const res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.6, max_tokens: opts.maxTokens ?? 1200 }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    return String(j?.choices?.[0]?.message?.content ?? '')
  }

  console.log('\n=== 4) 真实模型输出（--live）===')
  for (const c of cases.shiguang ?? []) {
    const p = buildPolishPrompt(c.type, c.intensity, c.style, c.mode ?? 'full')
    const out = await chat(
      [
        { role: 'system', content: p.system },
        { role: 'user', content: `【类型】${c.type === 'diary' ? '日记' : '感悟'}\n【原文】\n${c.content}` },
      ],
      { temperature: p.temperature, maxTokens: p.maxTokens },
    )
    const ratio = (out.length / Math.max(1, c.content.length)).toFixed(2)
    const hits = (c.expect ?? []).filter((k) => out.includes(k)).length
    console.log(`\n- ${c.name}（长度比 ${ratio}，清单关键词字面命中 ${hits}/${(c.expect ?? []).length}）\n${out.slice(0, 300)}`)
  }
  for (const c of cases.promptPolish ?? []) {
    const out = await chat(buildPromptPolishMessages(c.text, '评测用例'), { temperature: 0.2, maxTokens: 400 })
    const r = parsePromptPolishOutput(out, c.text)
    console.log(`\n- ${c.name} → intent=${r.intent} degraded=${r.degraded}\n${r.prompt.slice(0, 200)}`)
  }
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(' -', f)
  process.exitCode = 1
}
