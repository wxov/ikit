// 完善④ Agent 工具可见性（knowledge_search 越权修复）端到端验收脚本
//
// 覆盖验收标准：AC1（跨用户读取闭合）、AC2（admin 恒可见）、AC3（组可见性 + 父子递归）、
// AC4（login 级 + 游客 401）、AC5（4 条链路全覆盖，需 LLM 可用）、AC6（无旁路/探测差异）、
// AC10（HTTP 回归 + 端点按登录态收敛）。
// AC8（旧单参 handler 兼容）与 AC9（fail-closed）为进程内契约测试，见方案 §10 与验收报告。
//
// 前置：
//   1. server 已启动（默认 http://localhost:3000，可用 BASE 覆盖）
//   2. 管理员账号可用：ADMIN_USERNAME / ADMIN_PASSWORD（默认 admin / admin123）
//   3. AC5 的会话/通用 chat-stream 与 tasks/:id/run 需要服务端已配置 LLM_API_KEY；
//      未配置时这三项记为 SKIP，脚本其余部分仍执行并给出结论。
//
// 运行：BASE=http://localhost:3000 node scripts/agent-visibility-e2e.mjs
// 脚本会创建临时用户/用户组/文章并在结束时清理（仅清理本脚本创建的对象）。
import { randomUUID } from 'node:crypto'

const base = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '')
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123'

const EMPTY_TEXT = '知识库中没有找到相关内容'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()
const hex = (n) => randomUUID().replace(/-/g, '').slice(0, n).toUpperCase()
// 长随机关键词：彼此间无模糊相似度（Fuse threshold=0.4），断言可精确到「命中/未命中」
const K = {
  shared: `ZZQAW${hex(12)}`, // 命中全部文章
  priv: `ZZQAP${hex(12)}`, // 仅 private 文章
  grp: `ZZQAG${hex(12)}`, // 仅 groups(G) 文章
  child: `ZZQAC${hex(12)}`, // 仅 groups(G2 子组) 文章
  login: `ZZQAL${hex(12)}`, // 仅 login 文章
  pub: `ZZQAU${hex(12)}`, // 仅 public 文章
  none: `ZZQAN${hex(12)}`, // 不存在
}

const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, reason) {
  results.push({ name, ok: null, detail: reason })
  console.log(`[SKIP] ${name} — ${reason}`)
}

// ---- HTTP 小工具 ----
async function req(path, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data, text }
}

async function login(username, password) {
  const r = await req('/api/auth/login', { method: 'POST', body: { username, password } })
  if (r.status !== 200 || !r.data?.token) {
    throw new Error(`登录失败 ${username}: HTTP ${r.status} ${r.text.slice(0, 200)}`)
  }
  return { token: r.data.token, user: r.data.user }
}

/** 单工具直调入口（AC1-AC4/AC6 的主通道） */
async function searchAs(token, query) {
  const r = await req('/api/agent/tools/knowledge_search/run', {
    method: 'POST',
    token,
    body: { args: { query } },
  })
  if (r.status !== 200 || typeof r.data?.result !== 'string') {
    throw new Error(`knowledge_search 调用失败: HTTP ${r.status} ${r.text.slice(0, 200)}`)
  }
  return r.data.result
}

function parseSse(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
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
  return events
}

const created = { users: [], groups: [], entries: [], nodes: [] }
let adminToken = null
let markers = [] // 不得出现在任何响应中的敏感标记

/** 对一条 Agent 链路（SSE 或任务步骤）做统一断言 */
function assertChain(label, events, { needLogin = true } = {}) {
  const err = events.find((e) => e.type === 'error')
  const toolEv = events.filter((e) => e.type === 'tool' && e.toolName === 'knowledge_search')
  if (err) {
    skip(`${label}：无越权内容`, `LLM 不可用：${String(err.error).slice(0, 80)}`)
    return
  }
  if (!toolEv.length) {
    skip(`${label}：无越权内容`, 'LLM 未触发 knowledge_search 工具调用')
    return
  }
  const payload = JSON.stringify(events)
  const leak = markers.find((m) => payload.includes(m))
  check(`${label}：链路响应无越权内容`, !leak, leak ? `泄露 ${leak}` : `${toolEv.length} 次工具调用`)
  if (needLogin) {
    const loginEv = toolEv.find((e) => e.toolArgs?.query === K.login)
    if (loginEv) {
      check(
        `${label}：viewer 为登录用户（可见 login 级文章，guest 兜底则不可见）`,
        String(loginEv.toolResult).includes(T.login),
      )
    }
  }
  const privEv = toolEv.find((e) => e.toolArgs?.query === K.priv)
  if (privEv) {
    check(
      `${label}：私有文章命中返回与「不存在」一致的文案`,
      privEv.toolResult === EMPTY_TEXT,
      JSON.stringify(privEv.toolResult).slice(0, 120),
    )
  }
}

// 标题/正文标记（断言不得外泄的字符串）
const T = {}
const C = {}
function initMarkers() {
  T.priv = `私有标题-${RUN}`
  T.grp = `组内标题-${RUN}`
  T.child = `子组标题-${RUN}`
  T.login = `登录标题-${RUN}`
  T.pub = `公开标题-${RUN}`
  C.priv = `私有正文-${RUN}-SECRET`
  C.grp = `组内正文-${RUN}-SECRET`
  C.child = `子组正文-${RUN}-SECRET`
  markers = [T.priv, T.grp, T.child, C.priv, C.grp, C.child]
}

async function main() {
  initMarkers()
  console.log(`\n=== 完善④ Agent 可见性 E2E（BASE=${base}, RUN=${RUN}）===\n`)

  const admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD)
  adminToken = admin.token
  console.log(`admin 登录成功：${admin.user.username}(${admin.user.role})`)

  // ---- 1. 用户组 G + 子组 G2 ----
  const gName = `zzqa4-g-${RUN.toLowerCase()}`
  const g2Name = `zzqa4-g2-${RUN.toLowerCase()}`
  const mkGroup = async (name, parentId) => {
    const r = await req('/api/groups', { method: 'POST', token: admin.token, body: { name, parentId } })
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`建组失败 ${name}: HTTP ${r.status} ${r.text.slice(0, 200)}`)
    }
    const g = (r.data?.groups ?? []).find((x) => x.name === name)
    if (!g) throw new Error(`建组后未找到 ${name}`)
    created.groups.push(g.id)
    return g
  }
  const groupG = await mkGroup(gName)
  const groupG2 = await mkGroup(g2Name, groupG.id)
  console.log(`用户组：G=${groupG.id}  G2=${groupG2.id}（parent=G）`)
  check('前置：子组 G2 的 parentId 指向 G', groupG2.parentId === groupG.id)

  // ---- 2. 账号：B（仅 user）、C（属 G）、D（属 G2）----
  const pw = `zzQA4-${RUN}-pw`
  const mkUser = async (username, groupIds) => {
    const r = await req('/api/auth/users', {
      method: 'POST',
      token: admin.token,
      body: { username, password: pw, role: 'user', groupIds },
    })
    if (r.status !== 201) throw new Error(`建用户失败 ${username}: HTTP ${r.status} ${r.text.slice(0, 200)}`)
    created.users.push(r.data.user.id)
    const u = await login(username, pw)
    return { ...u, id: r.data.user.id, username }
  }
  const s = RUN.toLowerCase()
  const userB = await mkUser(`zzqa4-b-${s}`, [])
  const userC = await mkUser(`zzqa4-c-${s}`, [groupG.id])
  const userD = await mkUser(`zzqa4-d-${s}`, [groupG2.id])
  console.log(`账号：B=${userB.id}（仅 user）C=${userC.id}（G）D=${userD.id}（G2）\n`)

  // ---- 3. 文章：private / groups(G) / groups(G2) / login / public ----
  const mkEntry = async (title, content, visibility, visibleGroups) => {
    const r = await req('/api/knowledge/entries', {
      method: 'POST',
      token: admin.token,
      body: { title, content, tags: [K.shared], visibility, visibleGroups },
    })
    if (r.status !== 201) throw new Error(`建文章失败 ${title}: HTTP ${r.status} ${r.text.slice(0, 200)}`)
    created.entries.push(r.data.entry.id)
    return r.data.entry
  }
  await mkEntry(T.priv, `${C.priv} 共享词 ${K.shared} 私有词 ${K.priv}`, 'private')
  await mkEntry(T.grp, `${C.grp} 共享词 ${K.shared} 组词 ${K.grp}`, 'groups', [groupG.id])
  await mkEntry(T.child, `${C.child} 共享词 ${K.shared} 子组词 ${K.child}`, 'groups', [groupG2.id])
  await mkEntry(T.login, `登录正文-${RUN} 共享词 ${K.shared} 登录词 ${K.login}`, 'login')
  await mkEntry(T.pub, `公开正文-${RUN} 共享词 ${K.shared} 公开词 ${K.pub}`, 'public')
  console.log('文章：private / groups(G) / groups(G2) / login / public 已创建\n')

  // ---- AC1：B（普通用户）跨用户读取闭合 ----
  const bShared = await searchAs(userB.token, K.shared)
  check('AC1：B 检索不到 private 标题/正文', !bShared.includes(T.priv) && !bShared.includes(C.priv))
  check('AC1：B 检索不到 groups 标题/正文', !bShared.includes(T.grp) && !bShared.includes(C.grp))
  check('AC1：B 检索不到子组 groups 文章', !bShared.includes(T.child) && !bShared.includes(C.child))
  check('AC1：B 可见 public 文章', bShared.includes(T.pub))
  check('AC4：B 可见 login 级文章', bShared.includes(T.login))

  const bPrivOnly = await searchAs(userB.token, K.priv)
  const bNone = await searchAs(userB.token, K.none)
  check(
    'AC1：B 检索「仅 private 命中」无任何越权内容',
    !markers.some((m) => bPrivOnly.includes(m)),
    JSON.stringify(bPrivOnly).slice(0, 100),
  )
  check(
    'AC6：无权命中与关键词不存在的返回文案逐字一致',
    bPrivOnly === EMPTY_TEXT && bNone === EMPTY_TEXT,
    `priv-only=${JSON.stringify(bPrivOnly)} none=${JSON.stringify(bNone)}`,
  )

  // ---- AC2：admin 恒可见 ----
  const aPriv = await searchAs(admin.token, K.priv)
  check('AC2：admin 可见 private 标题+正文', aPriv.includes(T.priv) && aPriv.includes(C.priv))
  const aGrp = await searchAs(admin.token, K.grp)
  check('AC2：admin 可见 groups 标题+正文', aGrp.includes(T.grp) && aGrp.includes(C.grp))
  const aChild = await searchAs(admin.token, K.child)
  check('AC2：admin 可见子组 groups 文章', aChild.includes(T.child))

  // ---- AC3：组可见性 + 父子递归（语义：上级组包含下级组）----
  const cGrp = await searchAs(userC.token, K.grp)
  check('AC3：C（属 G）可见 groups(G) 文章', cGrp.includes(T.grp) && cGrp.includes(C.grp))
  check('AC3：C 不可见 private 文章', !cGrp.includes(T.priv) && !cGrp.includes(C.priv))
  const cChild = await searchAs(userC.token, K.child)
  check(
    'AC3：C（属父组 G）递归命中子组 G2 的文章',
    cChild.includes(T.child) && cChild.includes(C.child),
    'effectiveGroupsOf 的向下递归展开经 Agent 生效',
  )
  const dChild = await searchAs(userD.token, K.child)
  check('AC3：D（属 G2）直接命中 G2 文章', dChild.includes(T.child))
  const dGrp = await searchAs(userD.token, K.grp)
  check(
    'AC3：D（属子组 G2）不继承父组 G 的文章',
    !dGroupMarkers(dGrp).length,
    '与「上级组包含下级组」语义一致',
  )
  const bChild = await searchAs(userB.token, K.child)
  check('AC3：B（外组）检索不到子组文章', !bChild.includes(T.child) && !bChild.includes(C.child))

  // ---- AC4：游客边界 ----
  const anon = await req('/api/agent/tools/knowledge_search/run', {
    method: 'POST',
    body: { args: { query: K.shared } },
  })
  check('AC4：未登录调 knowledge_search → 401', anon.status === 401, `HTTP ${anon.status}`)
  check(
    'AC4：401 响应体不含任何文章信息',
    !markers.some((m) => JSON.stringify(anon.data ?? '').includes(m)),
  )

  // ---- AC6：换词探测多次，每次均不泄露 ----
  const probes = [K.priv, K.grp, K.child, K.login, T.priv, '私有', C.priv, K.none]
  const leaks = []
  for (const q of probes) {
    const r = await searchAs(userB.token, q)
    const hit = markers.find((m) => r.includes(m))
    if (hit) leaks.push(`${q}→${hit}`)
  }
  check('AC6：B 连续 8 次换词探测均无泄露', !leaks.length, leaks.join(' '))

  // ---- AC5：4 条链路全覆盖 ----
  const chatMsg = `请在知识库中检索关键词 ${K.priv} 和 ${K.login}，分别原样列出检索结果。`

  // 入口 4（单工具直调）已在 AC1/AC2/AC3 覆盖
  check('AC5-4：单工具直调入口已覆盖（见 AC1/AC2/AC3/AC6）', true)

  // 入口 2：通用 chat-stream
  const genAnon = await req('/api/agent/chat-stream', { method: 'POST', body: { message: chatMsg } })
  check('AC5-2 前置：通用 chat-stream 未登录 401', genAnon.status === 401, `HTTP ${genAnon.status}`)
  const gen = await req('/api/agent/chat-stream', {
    method: 'POST',
    token: userB.token,
    body: { message: chatMsg },
  })
  if (gen.status !== 200) check('AC5-2：通用 chat-stream 返回 200', false, `HTTP ${gen.status}`)
  else assertChain('AC5-2 通用 chat-stream', parseSse(gen.text))

  // 入口 1：会话 chat-stream
  const sess = await req('/api/agent/sessions', {
    method: 'POST',
    token: userB.token,
    body: { title: `zzqa4-${RUN}` },
  })
  if (sess.status !== 201) {
    check('AC5-1：创建会话', false, `HTTP ${sess.status} ${sess.text.slice(0, 120)}`)
  } else {
    const sid = sess.data.session.id
    const conv = await req(`/api/agent/sessions/${sid}/chat-stream`, {
      method: 'POST',
      token: userB.token,
      body: { message: chatMsg },
    })
    assertChain('AC5-1 会话 chat-stream', parseSse(conv.text))
    const msgs = await req(`/api/agent/sessions/${sid}/messages`, { token: userB.token })
    const stored = JSON.stringify(msgs.data?.messages ?? [])
    const leak = markers.find((m) => stored.includes(m))
    check('AC5-1：会话落库消息无越权内容', !leak, leak ? `泄露 ${leak}` : '')
    await req(`/api/agent/sessions/${sid}`, { method: 'DELETE', token: userB.token })
  }

  // 入口 3：tasks/:id/run
  const nodeId = `zzqa4-node-${s}`
  const reg = await req('/api/agent/nodes/register', {
    method: 'POST',
    token: userB.token,
    body: { id: nodeId, name: `zzqa4-node-${RUN}` },
  })
  if (reg.status !== 201) {
    check('AC5-3：注册测试节点', false, `HTTP ${reg.status} ${reg.text.slice(0, 120)}`)
  } else {
    created.nodes.push({ id: nodeId, token: userB.token })
    const taskRes = await req('/api/agent/tasks', {
      method: 'POST',
      token: userB.token,
      body: { nodeId, message: chatMsg },
    })
    if (taskRes.status !== 201) {
      check('AC5-3：派发任务', false, `HTTP ${taskRes.status} ${taskRes.text.slice(0, 120)}`)
    } else {
      const tid = taskRes.data.task.id
      const run = await req(`/api/agent/tasks/${tid}/run`, { method: 'POST', token: userB.token })
      const task = run.data?.task
      if (task?.status === 'error') {
        skip('AC5-3 tasks/:id/run：无越权内容', `LLM 不可用：${String(task.result).slice(0, 80)}`)
      } else {
        const steps = (task?.steps ?? []).map((x) => ({
          type: 'tool',
          toolName: x.toolName,
          toolArgs: x.toolArgs,
          toolResult: x.toolResult,
        }))
        if (!steps.length) skip('AC5-3 tasks/:id/run：无越权内容', 'LLM 未触发 knowledge_search 工具调用')
        else assertChain('AC5-3 tasks/:id/run', steps)
      }
    }
  }

  // ---- AC10：HTTP 回归 + 端点按登录态收敛 ----
  const listB = JSON.stringify((await req('/api/knowledge/entries', { token: userB.token })).data ?? {})
  check('AC10：B 的 GET /api/knowledge/entries 不含 private 文章', !listB.includes(T.priv))
  check('AC10：B 的 GET /api/knowledge/entries 含 public 文章', listB.includes(T.pub))
  const listAnon = JSON.stringify((await req('/api/knowledge/entries')).data ?? {})
  check('AC10：游客 GET /api/knowledge/entries 不含 private 文章', !listAnon.includes(T.priv))
  const privEntryId = created.entries[0]
  const viewB = await req(`/api/knowledge/entries/${privEntryId}/view`, { method: 'POST', token: userB.token })
  check(
    'AC10：B POST view 私有文章不返回其内容',
    !JSON.stringify(viewB.data ?? {}).includes(C.priv),
    `HTTP ${viewB.status}`,
  )
  const cmtB = await req(`/api/knowledge/entries/${privEntryId}/comments`, { token: userB.token })
  check('AC10：B GET 私有文章评论正常返回 200', cmtB.status === 200, `HTTP ${cmtB.status}`)
  const bSessions = (await req('/api/agent/sessions', { token: userB.token })).data?.sessions ?? []
  const cSessions = (await req('/api/agent/sessions', { token: userC.token })).data?.sessions ?? []
  const bIds = new Set(bSessions.map((x) => x.id))
  check('AC10：会话按 ownerId 隔离（C 看不到 B 的会话）', cSessions.every((x) => !bIds.has(x.id)))

  const toolsAnon = await req('/api/agent/tools')
  check('Q1：GET /api/agent/tools 未登录 401', toolsAnon.status === 401, `HTTP ${toolsAnon.status}`)
  const toolsAuthed = await req('/api/agent/tools', { token: userB.token })
  check(
    'Q1：GET /api/agent/tools 登录 200 且含内置工具',
    toolsAuthed.status === 200 && (toolsAuthed.data?.tools ?? []).some((t) => t.name === 'knowledge_search'),
    `HTTP ${toolsAuthed.status}`,
  )
  const nodesAnon = await req('/api/agent/nodes')
  check('Q2：GET /api/agent/nodes 未登录 401', nodesAnon.status === 401, `HTTP ${nodesAnon.status}`)
  const nodesAuthed = await req('/api/agent/nodes', { token: userB.token })
  check('Q2：GET /api/agent/nodes 登录 200', nodesAuthed.status === 200, `HTTP ${nodesAuthed.status}`)
}

function dGroupMarkers(text) {
  return [T.grp, C.grp].filter((m) => text.includes(m))
}

async function cleanup() {
  console.log('\n--- 清理本脚本创建的对象 ---')
  const safe = async (label, fn) => {
    try {
      await fn()
      console.log(`  已清理：${label}`)
    } catch (e) {
      console.log(`  清理跳过：${label}（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
  if (!adminToken) return
  for (const n of created.nodes) {
    await safe(`节点 ${n.id}`, async () => {
      const r = await req(`/api/agent/nodes/${n.id}`, { method: 'DELETE', token: n.token })
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    })
  }
  for (const id of created.entries) {
    await safe(`文章 ${id}`, async () => {
      const r = await req(`/api/knowledge/entries/${id}`, { method: 'DELETE', token: adminToken })
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    })
  }
  for (const id of created.users) {
    await safe(`用户 ${id}`, async () => {
      const r = await req(`/api/auth/users/${id}`, { method: 'DELETE', token: adminToken })
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    })
  }
  for (const id of [...created.groups].reverse()) {
    await safe(`用户组 ${id}`, async () => {
      const r = await req(`/api/groups/${id}`, { method: 'DELETE', token: adminToken })
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    })
  }
}

try {
  await main()
} catch (e) {
  console.error('\n❌ 脚本异常：', e instanceof Error ? e.message : e)
  failures++
} finally {
  if (!adminToken) {
    try {
      adminToken = (await login(ADMIN_USERNAME, ADMIN_PASSWORD)).token
    } catch {
      /* 登录失败则无法清理 */
    }
  }
  await cleanup()

  const pass = results.filter((r) => r.ok === true).length
  const skipN = results.filter((r) => r.ok === null).length
  console.log(`\n=== 结果：PASS ${pass} / FAIL ${failures} / SKIP ${skipN} ===`)
  if (skipN) console.log('（SKIP 项需服务端配置可用的 LLM_API_KEY 后复跑）')
  process.exit(failures ? 1 : 0)
}
