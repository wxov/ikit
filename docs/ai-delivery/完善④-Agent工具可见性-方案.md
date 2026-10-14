# 完善④：Agent 工具 `knowledge_search` 越权检索 — 技术方案

> 状态：**已实施（2026-10-13）并验收通过**（功能/安全 PASS；验收报告：`docs/ai-delivery/acceptance-report-完善④-Agent工具可见性.md`）
> 分支：`develop`
> 前置：完善②「Agent 会话归属 + 鉴权」已落地（`docs/ai-delivery/完善②-Agent会话归属鉴权-方案.md`）
> 来源：完善② 风险项 **R5**、`docs/需求功能总览.md` 模块⑤一致性状态（`:259`）与第六节第 2 项附注（`:372`）
> 行号基准：方案产出时的 `develop` 工作区（HEAD `d401630`）。**实施后行号可能漂移，一律以代码为准**。

---

## 0. 结论速览（TL;DR）

| 项 | 结论 |
|---|---|
| 缺口本质 | 工具 handler 拿不到「调用者」，`ctx.knowledge.search(query)` **不传 viewer** → `knowledge/service.ts:414` 走「不传 viewer 就不过滤」分支 → 任何登录用户可经 Agent 读到 `private` / `groups` 文章全文 |
| 推荐传递链 | **方案 A：显式参数透传**。`AgentService.runStream(msg, history?, call?)` / `runTool(name, args, call?)`；`AgentTool.handler(args, call?)`。`call = { viewer, userId? }` |
| 过滤实现 | **不在工具层重写 `isVisible`**：只把 `viewer` 交给 `ctx.knowledge.search(query, viewer)`，复用 `knowledge/service.ts:45-53 / 413-415` 单一事实源（与 HTTP API 侧 `viewerOf` 语义完全一致） |
| 缺省语义 | **fail-closed**：未传 `viewer` 时按 `{ groups: ['guest'], isAdmin: false }` → 仅 `public`（而非当前的「全可见」） |
| 改动面 | 代码 3 个文件（`agent/types.ts`、`agent/index.ts`、`api/routes.ts`）+ 可选同批收紧 2 个端点（`GET /api/agent/tools`、`GET /api/agent/nodes`）与 3 处前端补 `Authorization`；**无数据模型改动、无存储迁移、无新增配置项** |
| 桌面节点 | 天然覆盖：`runServerTool` 已带 `Authorization`（`agentNode.ts:139-146`），viewer 由该请求解析；未登录时不轮询（`:259`），手动调用返回 401 而非数据 |
| 附带发现 | `web_fetch` 存在 **SSRF**（`agent/index.ts:96-133`，与越权读取不同源，建议另立 P2）；`GET /api/agent/tools`（`:747`）与 `GET /api/agent/nodes`（`:798`）**无鉴权**（低危信息泄露） |
| 待确认 | **9 条**，见 §12（每条附推荐默认值） |

---

## 1. 目标与非目标

### 1.1 目标

- **G1（主目标）**：`knowledge_search` 工具的结果集按**调用者**可见性过滤，与知识库 HTTP 接口（`/api/knowledge/entries`、`view`、`comments` 等）语义**完全一致**：admin 恒可见（含 `private`）、登录用户 = `public` + `login` + 自身有效组命中的 `groups`、游客仅 `public`。
- **G2**：覆盖 Agent 的**全部执行入口**，不留旁路：
  1. `POST /api/agent/sessions/:id/chat-stream`（会话流式）
  2. `POST /api/agent/chat-stream`（无会话通用流式）
  3. `POST /api/agent/tasks/:id/run`（服务端执行远程任务）
  4. `POST /api/agent/tools/:name/run`（单工具直调，桌面节点复用服务端工具）
- **G3**：**零越权内容外泄**——被过滤条目不得以任何形式（标题、正文、片段、命中数量、错误文案差异）出现在工具返回给 LLM 的文本中。
- **G4**：**契约向后兼容**——`ctx.agent.registerTool` 的第三方插件旧 handler（`(args) => ...`）不改一行仍可注册与执行；`runStream` 现有两参调用不破坏。
- **G5**：**桌面节点场景等价收敛**——桌面本地 agent 循环经 `/api/agent/tools/:name/run` 执行服务端工具时，viewer 由该请求的登录态解析；未登录不得获得任何知识内容。

### 1.2 非目标（本期不做）

- 不改 Agent 的会话归属模型（完善②已定稿），不做 `nodeId` 节点与会话绑定。
- 不改 `KnowledgeEntry` 数据模型、不做存储迁移、不新增 `.env` / 插件 `Config` 项。
- 不给 `web_fetch` 加 SSRF 防护（另立 P2，见 §7 与 §12-Q6）。
- 不改 `knowledge_add` 的启用策略与写权限模型（默认关闭，维持现状；见 §7 与 §12-Q5）。
- 不改知识库文章可见性本身的语义（四级 + self/same/all 递归同步）。
- 不重构 `knowledge.search()` 的检索算法（不做「可见性下推」，见 §4.4）。
- 不做「历史会话中已落库的工具结果」回溯清理（见 §11-R4）。

---

## 2. 现状盘点（缺口事实与代码行号）

### 2.1 越权链路（4 个入口，全部缺 viewer）

| # | 入口 | 鉴权（已就位） | 调用点 | viewer 现状 |
|---|---|---|---|---|
| 1 | `POST /api/agent/sessions/:id/chat-stream` | `requireUser` + `getSession(user.id,id)` 归属校验（`routes.ts:922-931`） | `routes.ts:948` `ctx.agent.runStream(body.message, priorHistory)` | ❌ 未传 |
| 2 | `POST /api/agent/chat-stream` | `requireUser`（`routes.ts:966-967`，回调签名 `async () =>`，**连 user 都没取**） | `routes.ts:980` `ctx.agent.runStream(body.message, body.history ?? [])` | ❌ 未传 |
| 3 | `POST /api/agent/tasks/:id/run` | `requireUser` + `task.ownerId === user.id`（`routes.ts:881-885`） | `routes.ts:890` `ctx.agent.runStream(task.message, [])` | ❌ 未传 |
| 4 | `POST /api/agent/tools/:name/run` | `requireUser`（`routes.ts:752-753`，回调 `async () =>`，未取 user） | `routes.ts:756` `ctx.agent.runTool(name, body?.args ?? {})` | ❌ 未传 |

链路末端（**缺口根因**）：

```
agent/index.ts:74   handler: async (args) => {          // 只有 args，没有调用者
agent/index.ts:77     const results = await ctx.knowledge.search(query)   // ← 无 viewer
knowledge/service.ts:413-415
                     const visible = viewer ? out.filter(r => isVisible(r.entry, viewer)) : out
                     // viewer === undefined → 不过滤 → private/groups 文章一并返回
agent/index.ts:79-82 const top = results.slice(0, knowledgeTopK ?? 3)
                     return top.map(r => `[i] ${r.entry.title}\n${r.entry.content}`)  // 全文正文
```

**结论**：`requireUser` 已关闭「游客匿名」口子（完善②），但**跨用户读取口子完全敞开**——与 完善② R5 描述一致。

### 2.2 `knowledge.search` 的 viewer 语义（已有，未被使用）

- `knowledge/types.ts:4-10` `Viewer { groups: string[]; isAdmin: boolean }`——「由 API 层解析后传入」的既有约定。
- `knowledge/service.ts:45-53` `isVisible(entry, viewer)`：
  - `viewer.isAdmin` → 恒 `true`（含 `private`）；
  - `entry.visibility ?? 'public'`：`public` 全员；`private` 仅 admin；`login` 要求 `!viewer.groups.includes('guest')`；`groups` 要求 `(entry.visibleGroups ?? []).some(g => viewer.groups.includes(g))`。
- `knowledge/service.ts:368-416` `search(query, viewer?)`：**先全量候选（Fuse 模糊 + 分词 + 向量），最后一行做 viewer 过滤**（`:413-415`）。
- `knowledge/types.ts:108`：`search(query: string, viewer?: Viewer)`——viewer 参数**已存在**。
- **事实核对**：全仓库 `knowledge.search(` 的调用者**只有** `agent/index.ts:77` 一处（HTTP 层无 `/api/knowledge/search` 路由，门户搜索是前端本地过滤）——即 `search` 的 `viewer` 形参目前是**死参数**，修好工具即闭合唯一检索路径。

### 2.3 调用者身份与 viewer 解析现状（API 层已具备）

- `routes.ts:83-84` `tokenOf(req)` 取 `Authorization: Bearer`。
- `routes.ts:98-106` `requireUser(req, reply, fn(user))`：`ctx.account.me(token)` → `user`（`PublicUser`，含 `role` / `groupIds`，见 `account/service.ts:25-34`）；未登录 → 401。
- `routes.ts:109-112` `viewerOf(user)`：`groups = await ctx.account.effectiveGroupsOf(user)`，`isAdmin = user.role === 'admin'`。
- `routes.ts:114-116` `resolveViewer(req)`：`viewerOf(await ctx.account.me(tokenOf(req)))`——**匿名可用**（游客 `['guest']`）。
- `account/service.ts:358-385` `effectiveGroupsOf(user)`：admin → `['admin']`；登录用户 → `['user', ...groupIds]` + 沿 `Group.parentId` **递归展开子组**；无 user → `['guest']`。
  - 关键：登录用户的有效组**从不包含 `guest`** → `login` 级文章对登录用户恒可见 ✅；`groups` 命中的是**含递归子组**的并集 ✅。

> 即：**API 层已经算好了 viewer，只是没有往 Agent 内部传**。本方案的核心就是把这条已有的 `viewer` 值透传下去。

### 2.4 Agent 工具注册与调用的两处执行点

- `agent/types.ts:3-8` `AgentTool.handler: (args: Record<string, unknown>) => Promise<string> | string`（**单参**）。
- `agent/index.ts:55-60` `tools: Map<string, AgentTool>` + `registerTool(tool)`。
- 执行点 1：`agent/index.ts:163-171` `runTool(name, args)` → `:167` `String(await tool.handler(args))`。
- 执行点 2：`agent/index.ts:217-237` `runStream` 内工具调用循环 → `:233` `toolResult = String(await tool.handler(toolArgs))`。
- 对外服务对象：`agent/index.ts:468-496`（`:477` `runTool,`、`:478` `runStream,`）。
- 服务契约类型：`agent/types.ts:104-132`（`:107` `runTool`、`:108` `runStream`）；Cordis 服务类型增强：`core/src/index.ts:35-45`（`agent: AgentService`）。

### 2.5 桌面节点本地循环现状

- `agentNode.ts:148-156` `fetchServerTools()` → `GET /api/agent/tools`，**未带 `Authorization`**（该路由当前也不需要）。
- `agentNode.ts:139-146` `runServerTool()` → `POST /api/agent/tools/:name/run`，**带 `authHeaders()`**（`lib/auth.ts:32-35` 从 `localStorage['ikit-token']` 取 token，键定义见 `:22`）。
- `agentNode.ts:205-237` `runTaskLocally()`：本地工具走 Tauri invoke；非本地工具走 `runServerTool`。
- `agentNode.ts:258-274` `pollAndRunTasks()`：`if (polling || !getToken()) return` → **未登录不轮询任务**。
- `apps/web/src/lib/api.ts:48-63`：`api()` **不会自动注入 `Authorization`**，全靠调用方显式 `authHeaders()`（这一事实决定 §5.4 的联动改动）。
- `AgentPanel.vue:59-66` `loadTools()` → `GET /api/agent/tools` **未带 auth**；`:68-77` `loadNodes()` → `GET /api/agent/nodes` **未带 auth**。

### 2.6 事实核对清单（已逐条查证）

| 结论 | 证据 |
|---|---|
| `search()` 不传 viewer 即不过滤 | `knowledge/service.ts:413-415`；全仓 `knowledge.search(` 仅 `agent/index.ts:77` 一处 |
| 工具 handler 拿不到任何调用者信息 | `agent/types.ts:3-8`、`agent/index.ts:74`、`:167`、`:233` |
| `runStream` 无 viewer 形参 | `agent/index.ts:184-186`；`agent/types.ts:108` |
| 4 个入口均已有 `requireUser`（user 对象在手） | `routes.ts:922-931`、`:966-967`、`:881-885`、`:752-753` |
| `GET /api/agent/tools` 无鉴权 | `routes.ts:747-749`（无 `requireUser`）；全仓无 fastify `onRequest`/`preHandler` 全局钩子 |
| `GET /api/agent/nodes` 无鉴权 | `routes.ts:798-805`（返回含 `ownerId`） |
| 桌面 run 路径带 token / 工具清单未带 | `agentNode.ts:139-146` vs `:148-156` |
| 无 `agent-e2e` 可复用登录态验证 | `scripts/agent-e2e.mjs:6` 调用的 `POST /api/agent/chat` **已不存在**（已在完善② §181 记录为过时脚本） |

---

## 3. viewer 传递链选型

### 3.1 方案 A（**推荐**）：显式参数透传

`Viewer` 由 routes 解析（已有 `viewerOf`），作为一项显式调用上下文一路传给工具 handler。

**契约（`agent/types.ts`）**

```ts
import type { Viewer } from '@ikit/plugin-knowledge'

/** Agent 调用上下文：由 API 层按「调用者」解析后传入 */
export interface AgentCallContext {
  /** 可见性判定上下文；缺省时内置检索工具按 guest（仅 public）处理（fail-closed） */
  viewer?: Viewer
  /** 调用者用户 id（可选；供工具做归属判定/审计，本期仅铺路） */
  userId?: string
}

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 第二参可选：旧签名 (args) => ... 仍然合法 */
  handler: (args: Record<string, unknown>, call?: AgentCallContext) => Promise<string> | string
}

export interface AgentService {
  // ...
  runTool(name: string, args: Record<string, unknown>, call?: AgentCallContext): Promise<string>
  runStream(userMessage: string, history?: ChatMessage[], call?: AgentCallContext): AsyncIterable<AgentStreamEvent>
}
```

**实现（`agent/index.ts`）**

```ts
const GUEST_VIEWER: Viewer = { groups: ['guest'], isAdmin: false }
const viewerOf = (call?: AgentCallContext): Viewer => call?.viewer ?? GUEST_VIEWER

// knowledge_search（:74-83）
handler: async (args, call) => {
  const query = String(args.query ?? '').trim()
  if (!query) return '检索关键词为空'
  const results = await ctx.knowledge.search(query, viewerOf(call))   // ← 唯一实质改动
  // ...以下 slice/map 不变
}

// runTool（:163-171）： tool.handler(args, call)
// runStream（:184-186, :217-237）： 形参加 call，循环内 tool.handler(toolArgs, call)
```

**routes（`api/routes.ts`）**：4 个入口把已有的 `user` 变成 `call`：

```ts
const call = { viewer: await viewerOf(user), userId: user.id }
```

> 注意入口 2（`/api/agent/chat-stream`）当前回调是 `async () =>`，需改成 `async (user) =>`（这是本方案唯一的「签名扩张」改动，行为不变）。

**优点**

- **显式即安全**：授权关键值出现在函数签名与调用点上，可静态检索（`grep runStream(` 即得全部调用方），评审/审计友好。
- **与既有约定同构**：知识库侧本来就是「`viewerOf(user)` → 服务方法第二参」，Agent 只是继续沿用同一模式，不引入第二套身份机制。
- 对 **4 个入口 + 桌面 run 路径** 一视同仁；`runStream` 的两种调用（SSE 会话 / 任务）都自然覆盖。
- 纯函数式透传，**可单测**（直接 `runTool('knowledge_search', {...}, { viewer })`）。

**成本 / 风险**

- 需要改 2 处服务签名 + 4 处调用点（含 1 处回调签名），**TS 破坏性为零**（新增参数全部可选）。
- 遗漏调用点时会**静默降级为 guest（fail-closed）**——表现为「检索不到私密文章」而非泄露，属安全方向的失败模式。

### 3.2 方案 B（备选）：AsyncLocalStorage / 请求作用域注入

在 `packages/api` 建一个 `AsyncLocalStorage<{ viewer, userId }>`，在路由处理函数里 `run({ viewer }, () => ctx.agent.runStream(...))`；agent 插件通过一个共享访问器（或新建 `@ikit/core` 导出）读取。

**评估**

- 可行但**不推荐**：① 依赖方向反转——`plugin-agent` 需要 import 来自 `api`（或新共享包）的 ALS 句柄，插件不再自洽、可测试性变差；② SSE 是长生命周期的 async generator，跨 `writeHead` / `for await` 的上下文传播虽成立，但一旦将来加入 `setTimeout`/队列/事件回调就会静默丢上下文 → **丢上下文 = 越权（fail-open）**，恰是最坏失败模式；③ 授权值变成隐式全局，`grep` 看不到谁传了 viewer；④ 对 `POST /api/agent/tools/:name/run` 这类单工具直调并不比显式参数省事。
- 可作为「将来工具数量爆炸、逐个透传太啰嗦」时的重构方向，**不作为本期方案**。

### 3.3 方案 C（**否决**）：工具 handler 内部从全局/会话 ownerId 反查用户

- `runStream` 内部**根本没有 session id**（`agent/index.ts:184-186` 只有 message/history），会话归属只存在于 routes 与 store 层；要反查得先把 sessionId 也传进来——绕了一圈等于方案 A 的子集。
- 「模块级 currentUser」在并发请求交错（Node 单线程 + 大量 `await`）下**必然串号**：A 用户 await LLM 期间 B 用户请求进来改写全局变量 → A 的检索用了 B 的权限（或反之），是**任意越权**，比现状更危险。
- 桌面 `runTool` 路径没有会话，反查无从谈起。
- **明确否决**：不得以任何形式引入进程级「当前用户」可变状态。

### 3.4 对比与推荐

| 维度 | A 显式参数 | B ALS | C 反查 |
|---|---|---|---|
| 覆盖 4 入口 + 桌面 | ✅ | ✅（脆弱） | ❌ |
| 失败模式 | fail-closed（安全） | 丢上下文 → fail-open（危险） | 串号（最危险） |
| 可审计/可 grep | ✅ | ❌ | ❌ |
| 第三方插件兼容 | ✅ 可选参数 | 需改插件契约 | ❌ |
| 依赖方向 | 不变 | 反转 | 不变 |
| 改动量 | 小（3 文件） | 中（+共享包） | 中（仍需传 sessionId） |

**推荐：方案 A**，并以 §4.6 的 fail-closed 缺省值兜住「将来新增调用点忘记传 viewer」的情况。

---

## 4. 过滤语义

### 4.1 过滤位置：**保持单点**（`knowledge.service.search` 的 viewer 参数）

- 工具层**不重新实现** `isVisible`，只传 viewer。理由：可见性语义（四级 + admin 恒可见 + 组递归）已在服务层单点实现，工具层复制一份必然漂移（例如将来新增 `visibility` 级别时漏改）；且 API 与 Agent 两条读路径必须同源。
- 工具层**不得**在过滤前拼接任何文本（现状 `:79-82` 是「先 slice 后 map」，只要 `results` 已过滤即安全）。

### 4.2 四级可见性在 Agent 侧的目标行为

| 调用者 | `public` | `login` | `groups`（命中） | `groups`（未命中） | `private` |
|---|---|---|---|---|---|
| admin | ✅ | ✅ | ✅ | ✅ | ✅ |
| 登录用户（仅 `user` 组） | ✅ | ✅ | ❌* | ❌ | ❌ |
| 登录用户（属组 G，含子组） | ✅ | ✅ | ✅ | ❌ | ❌ |
| 游客 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 无 viewer（内部调用，fail-closed） | ✅ | ❌ | ❌ | ❌ | ❌ |

\* 逻辑上；`create()` 默认继承父级可见性（`knowledge/service.ts:170-179`），实际数据中「父 private、子 public」不会出现，除非显式改单篇。

### 4.3 父子递归与 `visibility` 继承（避免实施者误判）

- 文章可见性是**条目自身字段**：`create` 时未显式指定则继承父级（`service.ts:170-179`），后续由 `setVisibility(id, vis, groups, syncMode)` 按 `self | same | all` 决定是否同步子文档（`service.ts:458-491`）。
- 因此**检索侧只按条目自身 `visibility` 判定即可，不需要沿 `parentId` 递归**。这也是 HTTP 列表接口的既有行为，Agent 侧保持一致（否则会出现「同一篇文章在列表页不可见、在 Agent 里可见」的矛盾）。
- ⚠️ 已知语义（非本方案引入）：`syncMode='self'` 下父级改动不影响子文档，子文档可保持更宽松的可见性。这与模块① 一致，本方案**不改**，仅在文档中说明。

### 4.4 「先取后过滤」vs「传入 visibleGroups 下推」

**推荐：保持先取后过滤（零改动）。**

理由：

1. `knowledge.service.search` 已经是后置过滤（`:413-415`），修好工具即完成，**无需改检索算法**。
2. 候选集来源为 Fuse 集合 + `db.entries` 全量扫描；Fuse 的逐项得分与集合无关，且数据量级为「JSON/SQLite 全量装载」，过滤成本是 O(N) 的几次字符串比较，可忽略。
3. 「下推」需要改 `search` 签名、并把 `refreshFuse` 的集合变成「按 viewer 分片」的缓存——**引入缓存失效与漏过滤风险**，收益却接近零。
4. 后置过滤天然是**白名单语义**（先把所有可疑项取出再剔除可见的），配合 §4.6 的 fail-closed 缺省，任何新可见性级别只要 `isVisible` 返回 `false` 即安全。

**可选（非本期）**：若未来数据量增大，再加 `search(query, viewer, { prefilter?: (e: KnowledgeEntry) => boolean })` 做向量/扫描前置剪枝，语义不变。

### 4.5 摘要 / 片段 / 命中数量的返回约束

- **内容范围**：仅返回**整体通过 `isVisible`** 的条目的 `title` + `content`。不得「标题可见、正文另判」；不得在过滤前生成摘要/片段/关键词高亮。
- **命中数量**：过滤后为空时返回固定文案（现状 `:78` `'知识库中没有找到相关内容'`）——**不区分「不存在」与「无权访问」**，避免存在性探测（LLM 多轮换词试探同样只能得到同一文案）。
- **Top-K 语义**：`slice(0, knowledgeTopK)` 发生在过滤**之后**（现状即为如此）→ 展示的是「可见结果的前 K 条」，不会因过滤而把可见内容挤掉。
- **全文长度**：现状返回完整 `content`（`:81`）。过滤后与用户在 UI 中可读范围一致，**无越权**；是否为了 token 预算改为截断属产品优化（见 §12-Q4），与安全无关。

### 4.6 缺省失败模式：**fail-closed**

- 工具内缺省 `GUEST_VIEWER = { groups: ['guest'], isAdmin: false }` → 「没传 viewer」等价于「只给 public」，而非现状的「全给」。
- 影响面：仓库内**当前没有任何未传 viewer 的内部调用**（唯一调用者是 routes 的 4 个入口，本方案全部改齐）；未来第三方/内部新增 `ctx.agent.runStream(msg)` 的调用会**安全降级**。
- 若确有需要「全库检索」的内部用法，显式传 `{ viewer: { groups: [], isAdmin: true } }`——**显式即可审计**。

---

## 5. 逐文件改动清单

> 全部为**方案描述**，本轮不落代码。行号为现状行号。

### 5.1 `packages/plugins/agent/src/types.ts`

| 位置 | 现状 | 改动 |
|---|---|---|
| `:1` | `import type { ChatMessage } from '@ikit/plugin-llm'` | 追加 `import type { Viewer } from '@ikit/plugin-knowledge'`（该包已是本包 `devDependencies`，且现有 `KnowledgeService` 已从它导入，纯类型导入不新增运行时依赖） |
| `:3-8` | `AgentTool.handler: (args) => ...`（单参） | 新增可选第二参：`handler: (args: Record<string, unknown>, call?: AgentCallContext) => Promise<string> \| string` |
| `:8` 后 | — | 新增 `export interface AgentCallContext { viewer?: Viewer; userId?: string }`（带注释说明缺省 = guest 且由 API 层 `viewerOf(user)` 产出） |
| `:107` | `runTool(name, args): Promise<string>` | 追加 `call?: AgentCallContext` |
| `:108` | `runStream(userMessage, history?: ChatMessage[])` | 追加 `call?: AgentCallContext` |

**兼容性**：三个改动均为「可选参数追加」；旧 handler `(args) => ...` 在 TS 中可赋值给带可选第二参的函数类型；旧调用方 2 参调用不受影响。

### 5.2 `packages/plugins/agent/src/index.ts`

| 位置 | 现状 | 改动 |
|---|---|---|
| `:7-9` import 区 | 只导入 `AgentService` 等类型 | 追加 `AgentCallContext` 类型导入 |
| `:55-60` 工具表 | — | 新增两行：`const GUEST_VIEWER: Viewer = { groups: ['guest'], isAdmin: false }`；`const viewerOf = (call?: AgentCallContext): Viewer => call?.viewer ?? GUEST_VIEWER` |
| `:74` | `handler: async (args) => {` | `handler: async (args, call) => {` |
| `:77` | `const results = await ctx.knowledge.search(query)` | `const results = await ctx.knowledge.search(query, viewerOf(call))` ← **本方案的核心一行** |
| `:79-82` | `slice(0, knowledgeTopK)` + `title/content` 拼接 | **不改**（已处于过滤之后） |
| `:106` `web_fetch`、`:149` `knowledge_add` handler | 单参 | 签名改为 `(args, call)` 但**暂不使用** `call`（`knowledge_add` 预留 `call.userId` 审计；`web_fetch` 保持不变）。也可完全不动，二者等价，二选一（见 §12-Q7） |
| `:163-171` `runTool` | `async function runTool(name, args)`，`:167` `tool.handler(args)` | 形参加 `call?: AgentCallContext`；`:167` → `tool.handler(args, call)` |
| `:184-186` `runStream` | `async function* runStream(userMessage, history = [])` | 追加 `call?: AgentCallContext` 形参（生成器**不会**因新增可选参数改变产出序列） |
| `:233` 工具循环 | `String(await tool.handler(toolArgs))` | `String(await tool.handler(toolArgs, call))` |
| `:468-496` 服务对象 | `runTool,` / `runStream,` | **不改**（同一函数引用，签名由 types.ts 收口） |

> `current_time`（`:87-93`）不涉及 viewer，保持不动。

### 5.3 `packages/api/src/routes.ts`

| 位置 | 现状 | 改动 |
|---|---|---|
| `:752-758` `POST /api/agent/tools/:name/run` | `requireUser(req, reply, async () => { ... ctx.agent.runTool(name, body?.args ?? {}) })` | 回调改 `async (user) =>`；`runTool(name, args, { viewer: await viewerOf(user), userId: user.id })` |
| `:881-908` `POST /api/agent/tasks/:id/run` | `:890` `ctx.agent.runStream(task.message, [])` | 组装 `const call = { viewer: await viewerOf(user), userId: user.id }`（在流开始前解析，避免 SSE 头写出后才发现问题），传第三参 |
| `:922-963` 会话 `chat-stream` | `:948` `ctx.agent.runStream(body.message, priorHistory)` | 同上，传第三参（`user` 已在闭包内） |
| `:966-990` 通用 `chat-stream` | `:967` 回调 `async () =>`；`:980` `runStream(body.message, body.history ?? [])` | 回调改 `async (user) =>`，传第三参 |
| `:109-116` `viewerOf` / `resolveViewer` | 已存在 | **不改**（复用） |

> 实现建议：把「user → call」抽成一行局部辅助（如 `const callOf = async (user: any) => ({ viewer: await viewerOf(user), userId: user.id })`）放在 `viewerOf` 旁边（`:112` 之后），4 处调用点统一，减少重复与漏改。
>
> 语义说明：**viewer 取「调用者」而不是「会话 ownerId 反查」**——两者在会话/任务路径上恒等（完善② 已对 `ownerId` 做归属校验），取调用者可避免将来引入共享/代跑场景时用错主体。

### 5.4 可选同批收紧（**建议同批，但可独立回滚**）

> 这两条不修不会放大 `knowledge_search` 越权，但同属「Agent 端点未按登录态收敛」的同类问题（§7），且改动极小、方向一致。**是否纳入本期见 §12-Q1/Q2。**

| 位置 | 现状 | 改动 | 联动 |
|---|---|---|---|
| `routes.ts:747-749` `GET /api/agent/tools` | 无鉴权，返回全部工具的 `name/description/parameters` | 包 `requireUser` | `AgentPanel.vue:61` **需补** `headers: authHeaders()`（否则登录用户也 401 → 工具列表空，且被 `catch` 静默吞掉）；`agentNode.ts:151` **需补** `headers: authHeaders()`（否则桌面本地循环取不到服务端工具 → 只能调本地工具） |
| `routes.ts:798-805` `GET /api/agent/nodes` | 无鉴权，返回全部节点（含 `ownerId`、`lastSeenAt`、`name`） | 包 `requireUser` | `AgentPanel.vue:71` **需补** `headers: authHeaders()` |

> 若不做 5.4，则必须在文档中把这两个端点记录为**已知低危信息泄露**（见 §7 与 §13）。

### 5.5 明确不改的文件

| 文件 | 为何不改 |
|---|---|
| `packages/plugins/knowledge/src/service.ts`、`types.ts` | `viewer` 形参与 `isVisible` 单点实现已满足需求（`:45-53`、`:108`、`:413-415`） |
| `packages/plugins/account/src/*` | `effectiveGroupsOf` 已含递归展开，无需改 |
| `packages/core/src/index.ts` | 服务类型增强引用 `AgentService`，签名变更自动生效；`Viewer` 已从 core 再导出（`:17-32`） |
| `apps/web/src/components/AgentPanel.vue` | 对话链路已带 `Authorization`（`:219` 等）；**仅当**采纳 §5.4 才需补 2 处 `authHeaders()` |
| `apps/web/src/lib/agentNode.ts` | 运行期无需改（`runServerTool` 已带 token）；**仅当**采纳 §5.4 才需补 1 处 |
| 存储层 / `Config` Schema | 无新字段、无迁移、无配置项 |

---

## 6. 契约变化

### 6.1 TypeScript 服务契约（`@ikit/plugin-agent`）

| 契约 | 变更 | 破坏性 |
|---|---|---|
| `AgentTool.handler` | 追加**可选**第二参 `call?: AgentCallContext` | ❌ 无（函数参数逆变：少参函数可赋值给多参类型；旧 handler 原样可用） |
| `AgentService.runTool` | 追加可选第三参 | ❌ 无 |
| `AgentService.runStream` | 追加可选第三参 | ❌ 无 |
| 新增导出 `AgentCallContext`（经 `agent/index.ts:507 export * from './types.js'` 传播到 `@ikit/core`） | 纯新增 | ❌ 无 |
| `Viewer` 类型 | 复用 `@ikit/plugin-knowledge` 的既有导出（`knowledge/src/index.ts:103 export * from './types.js'`；`core/src/index.ts:17-32` 已再导出） | ❌ 无 |

**语义变化（非类型破坏，但需记录）**：`runStream(msg, history)` / `runTool(name, args)` 省略 `call` 时，内置 `knowledge_search` 由「全库」变为「仅 public」——即**缺省值收紧**（fail-closed，见 §4.6）。

### 6.2 HTTP 契约

| 端点 | 请求 | 响应 | 变化 |
|---|---|---|---|
| `POST /api/agent/sessions/:id/chat-stream` | 不变（`{ message }` + `Authorization`） | SSE 事件不变（`delta/status/tool/done`） | **行为变化**：`tool` 事件里的 `toolResult` 不再含无权内容 |
| `POST /api/agent/chat-stream` | 不变 | 不变 | 同上 |
| `POST /api/agent/tasks/:id/run` | 不变 | `{ task: { result, steps } }` | 同上（`task.steps[].toolResult` 过滤后内容） |
| `POST /api/agent/tools/:name/run` | 不变（`{ args }`） | `{ result: string }` | 同上；未登录仍 401 |
| `GET /api/agent/tools` | 不变 | 不变 | （若采纳 §5.4）未登录 401 |
| `GET /api/agent/nodes` | 不变 | 不变 | （若采纳 §5.4）未登录 401 |

**无新增/删除路由，无请求体字段变化** → 前端无需适配（除 §5.4 的两处 header 补齐）。

### 6.3 第三方插件注册工具的兼容策略

- **策略：`ctx` 参数完全可选 + 旧 handler 零改动**。
  - 旧：`ctx.agent.registerTool({ name, description, parameters, handler: async (args) => '...' })` —— 编译通过、运行正常（`call` 被忽略）。
  - 新（可选能力）：`handler: async (args, call) => { const viewer = call?.viewer; ... }`。
- **运行时不校验参数个数**（`agent/index.ts:167` / `:233` 直接 `fn(args, call)`，JS 忽略多余实参）→ 不会因插件未升级而抛错。
- **插件的安全责任边界（需写入文档）**：Agent 只保证「把调用者身份交到工具手上」；**工具自身必须自行鉴权**。`POST /api/agent/tools/:name/run` 允许任何登录用户按名字执行任意已注册工具（含第三方工具），因此第三方工具若做特权操作须自查 `call.viewer`/`call.userId`。
- 「未传 viewer 的工具」不受影响；只有**主动读取 `call.viewer` 的工具**才获得能力。

---

## 7. 同类风险排查（其它工具与端点）

| # | 对象 | 位置 | 现状 | 风险等级 | 本期处置建议 |
|---|---|---|---|---|---|
| 1 | `knowledge_search` | `agent/index.ts:62-84` | 不传 viewer → 跨用户读取 | **高（越权读取）** | **本期修复**（§5.2/§5.3） |
| 2 | `knowledge_add` | `agent/index.ts:135-161` | 默认关闭（`enableWriteTools=false`，`:37`）；开启后任意登录用户可写入（且默认 `visibility` 继承/`public`） | 中（**越权写入**，非读取） | **不改行为**：保持默认关闭 + 文档明示；handler 加 `call` 形参预留 `userId` 审计。是否收窄为「仅 admin 可调用」见 §12-Q5 |
| 3 | `current_time` | `agent/index.ts:87-93` | 无输入、无数据 | 无 | 不改 |
| 4 | `web_fetch` | `agent/index.ts:96-133` | 服务端任意 URL 抓取：**SSRF**（可探测内网/本机端口、云元数据 `169.254.169.254`）；`fetch` 默认跟随重定向、无逐跳校验、响应体全量读入（仅返回文本截断 2000 字）；有 15s 超时 | 中高（**SSRF**，与跨用户越权不同源） | **本期只记录，另立 P2**。建议拦截清单（另案）：协议白名单 http/https；DNS 解析后拒绝 loopback/私网/链路本地/元数据地址（含 IPv6）；重定向逐跳复检；响应体上限 + `Content-Type` 白名单；可选 `AGENT_WEB_FETCH=off`。见 §12-Q6 |
| 5 | `POST /api/agent/tools/:name/run` | `routes.ts:752-758` | `requireUser` ✅，但**未解析/未传 viewer** | 高（越权通道之一） | **本期修复**（§5.3） |
| 6 | `GET /api/agent/tools` | `routes.ts:747-749` | **无鉴权**，暴露全部工具的 name/description/parameters | 低（信息泄露：暴露内部能力与参数结构，便于定向探测；无数据） | 建议同批 `requireUser` + 前端 2 处补 header（§5.4）；或仅记录。见 §12-Q1 |
| 7 | `GET /api/agent/nodes` | `routes.ts:798-805` | **无鉴权**，返回全部节点（含 `ownerId`/`lastSeenAt`/`name`） | 低（他人节点 id/ownerId 泄露；派任务仍需登录 + `ownerId` 校验，故不可直接利用） | 建议同批 `requireUser` + `AgentPanel.vue:71` 补 header。见 §12-Q2 |
| 8 | `/api/knowledge/*` 读取类 | `routes.ts:509-520/552-556/559-562/593-601/676` | 已用 `resolveViewer`/`viewerOf` 过滤 ✅ | 无 | 不改（作为 Agent 侧的**语义对齐基准**） |
| 9 | `POST /api/llm/chat-stream` | `routes.ts:993-1029` | `requireUser` ✅；可传任意 `tools` 定义，但**服务端只转发给 LLM，不执行任何工具**（工具执行发生在调用方本地/桌面） | 无越权（数据由调用方自己提供） | 不改；文档中说明「该端点不接触知识库」 |
| 10 | 会话历史 `steps` | `routes.ts:946-955`；`agent/types.ts:51` | 工具结果（含文章正文）随 assistant 消息落库并在会话中回放 | 低（**历史残留**：若文章事后被收紧可见性，历史消息仍含旧内容） | 本期不改，作为已知项记录（§11-R4） |

---

## 8. 桌面节点影响

### 8.1 现状（已查证）

- 桌面本地 agent 循环：`llmChat` → `POST /api/llm/chat-stream`（带 token，`agentNode.ts:170`）；服务端工具 → `POST /api/agent/tools/:name/run`（带 token，`:140-143`）。
- 本地工具（`exec_command` / `read_local_file` / `write_local_file`）走 Tauri 原生，**与 viewer 无关**（受 `agent-workspace` 目录与命令白名单约束，非本期范围）。
- 任务来源：`pollAndRunTasks()` 只在本机有 token 时轮询（`:259`），任务由「自己名下节点」派发（`routes.ts:842-862` 的 `ownerId` 校验）。

### 8.2 本方案后的行为（viewer = 该请求的登录用户）

| 场景 | 结果 |
|---|---|
| 桌面已登录，Agent 调用 `knowledge_search` | `runServerTool` 带 token → `requireUser` → `viewerOf(user)` → 与 Web 端**完全一致**的可见性过滤 ✅ |
| 桌面已登录，用户在浏览器端以同一账号对话 | 两端口径一致（同一 `effectiveGroupsOf` 结果）✅ |
| 桌面登录的是低权限账号，Web 派任务给该桌面节点 | 任务执行时 viewer = **执行请求的登录账号**（即桌面登录者）。因派发端 `ownerId === user.id`（`routes.ts:852`），实际为同账号 ✅ |
| 桌面未登录 | `pollAndRunTasks` 直接 return（不轮询）；若手工调用 `/api/agent/tools/:name/run` → **401**，返回错误文本（`agentNode.ts:229-231` 会包成「工具执行出错」），**不返回任何知识内容** ✅ |

### 8.3 建议（与 §12-Q3 对应）

- 维持「未登录不轮询 + 服务端 401」的现状，**不需要**在桌面新增降级逻辑；可选增强：在 `runServerTool` 捕获 401 时给出更明确的提示（如「未登录，服务端工具不可用」），属体验优化、不影响安全。
- ⚠️ **不要**为了「让未登录桌面也能用 Agent」而放宽 `:name/run` 到匿名——那会重新打开完善② 关掉的游客口子。

---

## 9. 关联影响清单（AGENTS.md 四维 + 存储）

### 9.1 依赖关系（`inject` / `ctx.set` / 事件）

| 项 | 影响 |
|---|---|
| `agent` 插件 `inject`（`agent/index.ts:13-17`：`llm` 必需、`knowledge` 必需、`account` 可选） | **不变**。注意：**不要**在 agent 插件内注入 `account` 来算 viewer（会与 core 的 `Context` 增强冲突，完善② 已为此在迁移逻辑里用局部结构面 `AccountLike` 绕开，`:41-43`、`:261`）。viewer 一律由 API 层算好传入 |
| `agent` → `knowledge` 调用 | 由 `search(query)` 变为 `search(query, viewer)`（既有形参，非新 API） |
| `ctx.set('agent', service)`（`:498`） | 服务对象方法签名变化，消费方仅 `packages/api`（已排查：`core`、`plugin-registry`、其他插件无 `ctx.agent.runStream/runTool` 调用） |
| `ctx.emit('knowledge:changed')` 订阅方（前端 WS 桥） | **不受影响**（本方案不产生新的知识库写入） |

### 9.2 共享契约

| 契约 | 影响 |
|---|---|
| `AgentTool.handler` / `AgentService.runTool` / `AgentService.runStream` | 追加可选参数（§6.1），**向后兼容** |
| `AgentStep.toolResult` / SSE `tool.toolResult` / `AgentTask.steps[].toolResult` | 载荷结构中 `toolResult` 的**内容范围**变化（不再含无权内容），类型不变 |
| `Viewer`（`@ikit/plugin-knowledge` → `@ikit/core` 再导出） | 复用，不新增类型 |
| `KnowledgeService.search(query, viewer?)` | 形参已有，不新增 |
| `AgentMessage.steps` / 会话历史 | 结构不变（已落库的旧内容不回溯，见 §11-R4） |

### 9.3 前端联动（`apps/web`）

| 页面/模块 | 是否需要改 | 说明 |
|---|---|---|
| `AgentPanel.vue` 对话/流式（`:203-260`、`:217-219`） | 否 | 已带 `Authorization`，行为自动收敛 |
| `AgentPanel.vue` 工具清单（`:59-66`）/ 节点列表（`:68-77`） | **仅当采纳 §5.4** | 需补 `headers: authHeaders()` |
| `agentNode.ts` `fetchServerTools`（`:148-156`） | **仅当采纳 §5.4** | 需补 `headers: authHeaders()` |
| `agentNode.ts` `runServerTool`（`:139-146`） | 否 | 已带 token |
| 移动端（Capacitor）/ Tauri | 否 | 与 Web 同源同一 `apps/web` 构建 |

### 9.4 配置项

- **无新增**。不引入 `Config` 字段、不加 `.env` 变量（fail-closed 内置，无需开关；见 §12-Q4）。
- 既有 `agent.Config`（`agent/index.ts:19-38`）中 `knowledgeTopK` / `enableWriteTools` 语义不变；`enableWriteTools` 的说明建议补一句「开启后任意登录用户可经 Agent 写入」。

### 9.5 存储与迁移

- **无迁移**。不新增/删除/改名任何持久化字段（`AgentSession` / `AgentMessage` / `AgentTask` / `KnowledgeEntry` 均不变）。
- 已落库的历史 `steps[].toolResult` 保持原样（§11-R4）。

---

## 10. 验收标准（可操作 AC）

> 前置：`pnpm dev`（`:3000`）已启动；准备三个账号：`admin`（站主）、`B`（普通用户，仅 `user` 组）、`C`（普通用户，属自定义组 `G`）；准备三篇文章（同一独特关键词 `ZZQA4` 便于精确断言）：`P_private`（admin 私有）、`P_group`（`visibility=groups`，`visibleGroups=['G']`）、`P_public`（公开）。

**AC1｜跨用户读取闭合（核心）**
以 B 的 token `POST /api/agent/tools/knowledge_search/run`，`args={"query":"ZZQA4"}`：
- 响应 `result` **不含** `P_private`、`P_group` 的标题与正文（`assert(!result.includes('私有标题'))`、`assert(!result.includes('组内标题'))`）；
- 若 `P_public` 命中，则必须**包含**它；
- 若三者皆不可见，则返回固定文案 `知识库中没有找到相关内容`（与「文章根本不存在」时的文案**逐字相同**）。

**AC2｜admin 恒可见**
以 admin token 调同一工具：`result` **包含** `P_private` 与 `P_group`（admin 走 `isAdmin` 短路）。

**AC3｜组可见性 + 父子递归（父组包含子组）**
- 以 C（属组 `G`）token 调同一工具：**包含** `P_group`。
- 再为 `G` 建子组 `G2`，并把一篇 `visibility=groups, visibleGroups=[G2]` 的文章 `P_g2`：C（属 `G`）**包含** `P_g2`（验证 `effectiveGroupsOf` 的递归展开对 Agent 生效，`account/service.ts:358-385`）。
- 反向断言：把用户 D 只加入子组 `G2`，检索 `P_group`（`visibleGroups=[G]`）→ **不包含**。`effectiveGroupsOf` 沿 `children` **向子组递归**展开「直接所属组 + 其递归子组」，即**父组包含子组**；子组用户**不继承**父组可见性。

**AC4｜`login` 级 + 游客边界**
- `visibility=login` 文章：B 可检索到（登录用户有效组不含 `guest`）；游客不可用 Agent（既有 401，`routes.ts:922-923/966-967`）。
- 未登录 `POST /api/agent/tools/knowledge_search/run` → **401**，响应体无任何文章内容。

**AC5｜四条链路全覆盖**
对以下 4 个入口，断言无越权内容出现在响应/SSE 事件中：
1. `POST /api/agent/sessions/:id/chat-stream`（B 的会话）→ SSE `tool` 事件的 `toolResult` 不含 `P_private`；
2. `POST /api/agent/chat-stream` → 同上；
3. `POST /api/agent/tasks/:id/run`（B 向自己桌面节点派任务、任务消息含 `ZZQA4`）→ `task.steps[].toolResult` 不含 `P_private`；
4. `POST /api/agent/tools/:name/run` → 见 AC1。

**AC6｜无旁路/探测差异**
- 用 B 的 token 连续用同义改写关键词（如 `ZZQA4`、`私有`、`private`、标题片段）调用 ≥5 次，**每次**都不得泄露被过滤条目的任何字符；
- 「无权命中」与「关键词不存在」两种情况返回文案**完全一致**（不可据此推断文章存在性）。

**AC7｜桌面节点等价受限**
在桌面端（Tauri）以 B 登录 → 通过移动/Web 向该桌面节点派任务（消息含 `ZZQA4`）：
- 桌面本地循环经 `/api/agent/tools/knowledge_search/run` 执行 → 回传的 `task.steps[].toolResult` 与 AC1 完全一致（无 `P_private`）；
- 桌面**未登录**：等待 ≥25s 无任务轮询请求（`agentNode.ts:259` 守卫）；手工构造 `:name/run` 请求 → 401 且不返回内容。

**AC8｜第三方插件旧 handler 兼容**
- `pnpm -r --if-present build` + `tsc --noEmit` 通过（旧 `(args) => ...` 签名不报错）；
- 仓库内示例插件（`plugins/hello`）或临时注册一个单参 handler 的工具，经 `/api/agent/tools/<name>/run` 执行成功（`call` 被忽略，无运行时报错）。

**AC9｜fail-closed 兜底**
新增一个不带 `call` 的临时调用（单测或脚本直接 `ctx.agent.runTool('knowledge_search', { query: 'ZZQA4' })`）：
- 结果**仅**含 `P_public`（不含 `P_private`/`P_group`），证明缺省值是 guest 而非全库。

**AC10｜构建与回归**
- `pnpm -r --if-present build` 通过；
- 知识库 HTTP 接口回归：B 的 `GET /api/knowledge/entries`、`POST /api/knowledge/entries/:id/view`、`GET /api/knowledge/entries/:id/comments` 行为与改动前**逐字节一致**（本方案不应触碰 API 侧读取语义）；
- 会话/消息/节点/任务既有鉴权回归：他人会话 404、未登录 401（完善② AC 复跑）。

**AC 验证方式建议**：新增 `scripts/agent-visibility-e2e.mjs`（登录 3 个账号 → 建 3 篇可见性文章 → 对 4 个入口断言），替代已过时的 `scripts/agent-e2e.mjs`（其调用的 `POST /api/agent/chat` 已下线，且无登录态）。见 §12-Q8。

---

## 11. 风险与回滚

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | 遗漏某个未来新增的调用点（不传 `call`） | 该路径**安全降级**为 guest（检索不到私密内容），不会泄露 | fail-closed 缺省（§4.6）+ 评审时 `grep -n "runStream(\|runTool(" packages` 核对调用清单 |
| R2 | 过滤导致 Agent 回答质量「看起来变差」（管理员账号以外检索变少） | 功能体验变化，但**这正是预期修复** | 文档与版本说明中明确「Agent 检索范围 = 当前登录用户可见范围」；如确需全库检索，以 admin 账号对话 |
| R3 | `viewerOf` 每请求多一次 `effectiveGroupsOf`（内存 + 组树 BFS） | 可忽略（`account/store` 已常驻内存） | 若将来成为热点，可加请求级 memo（非本期） |
| R4 | 历史会话 `steps[].toolResult` 中已落库的旧内容不回溯（文章事后被收紧可见性时，旧会话仍可见旧正文） | 低；用户本就曾是可见方 | 记录为已知项；如需要，另立「可见性变更时清理会话步骤」项（成本高、收益低） |
| R5 | 工具结果注入 LLM 上下文后的**提示注入**（私密文章内容诱导模型泄露给他人） | 本方案后每轮结果均属「调用者可见」，无跨用户泄露面 | 不属本期；已在 §7 记录工具链整体风险 |
| R6 | 若采纳 §5.4（收紧 `GET /api/agent/tools` / `/nodes`），前端 3 处漏补 `Authorization` → 工具清单/节点列表静默为空 | 低（功能不可见，无安全后果），易被 `catch {}` 掩盖 | 与 §5.4 同批提交；验收时用「登录用户能看到工具列表与在线节点」显式核对 |

**回滚**

- 全部改动集中在 3 个文件（+ 可选的 2 端点与 3 处前端 header），`git revert` 单个提交即可回到现状；
- 无数据迁移 → **无需数据回滚**；无配置项 → 无需环境回滚；
- 工具层可通过临时把 `viewerOf(call)` 换回「不传 viewer」快速恢复旧行为（**不推荐**，仅应急）。

---

## 12. 待确认问题（每条带推荐默认值）

| # | 问题 | 选项 | **推荐默认** |
|---|---|---|---|
| Q1 | 是否同批收紧 `GET /api/agent/tools`（现无鉴权，暴露工具清单）？ | (a) 同批 `requireUser` + `AgentPanel.vue:61`、`agentNode.ts:151` 补 `Authorization`；(b) 仅记录为已知低危 | **(a) 同批收紧**：改动 1+2 行、方向一致；但必须同批带上两处 header，否则登录用户工具列表变空 |
| Q2 | 是否同批收紧 `GET /api/agent/nodes`（现无鉴权，暴露节点 id/ownerId）？ | (a) 同批 `requireUser` + `AgentPanel.vue:71` 补 `Authorization`；(b) 仅记录 | **(a) 同批收紧**（与 Q1 一致；两者都是「Agent 端点按登录态收敛」） |
| Q3 | 桌面未登录时的行为 | (a) 维持现状（不轮询 + 服务端 401）；(b) 前端给出「未登录，服务端工具不可用」明确提示 | **(a) 维持现状**（安全已闭合），(b) 作为可选体验优化纳入同一提交 |
| Q4 | `knowledge_search` 返回正文是否截断（如每篇 500/1000 字）以省 token？ | (a) 保持返回全文；(b) 截断 + 提示「已截断」 | **(a) 保持全文**（与用户 UI 可读范围一致，安全无差异）；如需省 token 另立优化项 |
| Q5 | `knowledge_add`（写类工具）是否加权限收紧？ | (a) 保持现状（默认关闭 + handler 预留 `call.userId`）；(b) 开启时也要求 `call.viewer.isAdmin` | **(a) 保持现状**：默认关闭已足够，写入授权收紧另立（避免范围蔓延）；仅在文档明示「开启 = 任意登录用户可写」 |
| Q6 | `web_fetch` 的 SSRF | (a) 本期只记录、另立 P2（方案 §7 给拦截清单）；(b) 本期一并加私网/元数据 IP 拦截 | **(a) 只记录、另立 P2**（与「越权检索」不同源，混在本期会拉长验证面） |
| Q7 | `web_fetch` / `current_time` handler 是否也改成 `(args, call)` 形式？ | (a) 不改（保持单参，只改 `knowledge_search`）；(b) 统一改为双参（`call` 未使用） | **(a) 最小改动**：只改需要 `call` 的 handler，避免无意义 diff；`knowledge_add` 例外（改为 `(args, call)` 并在 `enableWriteTools` 日志里带 `call?.userId`，为将来审计铺路） |
| Q8 | 验收脚本 | (a) 新增 `scripts/agent-visibility-e2e.mjs`（登录 + 4 入口断言）；(b) 只写手工验收步骤；(c) 顺带修 `scripts/agent-e2e.mjs`（已过时） | **(a)** 新增脚本；(c) 顺带修 `agent-e2e.mjs` 的登录态与路由（其调用的 `/api/agent/chat` 已下线），两者可拆两个提交 |
| Q9 | 会话/任务路径的 viewer 取「调用者」还是「会话/任务 ownerId 反查」？ | (a) 调用者（当前实现就是调用者）；(b) ownerId 反查 | **(a) 调用者**：与鉴权主体一致、无需传 sessionId 到 agent 层；两者在当前鉴权下恒等 |

> 说明：Q1/Q2 若选择「仅记录」，须在 `docs/需求功能总览.md` 模块⑤ 的「已知缺口」中保留这两条（不能因为本轮修了 `knowledge_search` 就把同批发现的项丢掉）。

---

## 13. 文档同步清单（落地后执行）

| 文档 | 位置 | 更新内容 |
|---|---|---|
| `docs/需求功能总览.md` | 模块⑤ 一致性状态 `:259` | 把「**已知缺口（已记录待立项）**：`knowledge_search` 工具未按可见性过滤…」改为「**已修复（完善④）**：`knowledge_search` 按调用者 `viewer`（`viewerOf(user)`，admin 恒可见 / 登录按 `effectiveGroups` 并集 / 缺省 guest fail-closed）过滤；4 条执行入口（会话流式、通用流式、任务执行、单工具直调）全部透传」，并附一行方案链接 |
| 同上 | 第六节第 2 项附注 `:372` | 删除/改写「`knowledge_search` 可见性透传另行立项」→ 指向本文档；如采纳 Q1/Q2，补记 `GET /api/agent/tools` / `GET /api/agent/nodes` 的处置结论 |
| 同上 | 第六节新增条目 | 如采纳 §7 的「另立」建议：新增 `web_fetch` SSRF（P2）与 `knowledge_add` 写权限（P2）两条待立项 |
| 同上 | 模块⑤ 实现位置 `:250-253` | 行号漂移修正（Agent 工具与 `runStream` 行号会变） |
| `docs/ai-delivery/完善②-Agent会话归属鉴权-方案.md` | §10 风险 R5 `:284`、§11 第 6 项 `:300` | 标注「已于完善④ 关闭，见 `docs/ai-delivery/完善④-Agent工具可见性-方案.md`」（**修改历史方案文档仅在用户确认后**） |
| `AGENTS.md` | 「AI Agent（节点/任务/本地工具）」数据模型段 | 补一句契约约定：「服务端工具 handler 可选第二参 `ctx.agent` 调用上下文（`viewer`/`userId`）；工具需自行按 `viewer` 鉴权；`knowledge_search` 恒按调用者可见性过滤」 |
| 根 `README.md` | API 一览 / 功能特性（若提到 Agent 工具能力） | 如提到 `knowledge_search`，补一句「检索范围 = 当前登录用户可见范围」 |
| `docs/AI Agent 多节点与三端互通需求文档.md` | 工具章节（若存在能力描述） | 同步可见性约束（**需先确认该文档是否为有效需求源**，见 `需求功能总览` 第一节文档清单） |
| 新增 | `docs/ai-delivery/完善④-Agent工具可见性-方案.md` | 本文档 |

> 落地后按 AGENTS.md 要求执行「关联影响检查 → 展示清单 → 用户确认 → 改动 → 文档同步」；**提交/合并/发布一律需用户明确同意**。

---

## 14. 实施顺序建议（供排期参考）

1. **S1（核心修复，可独立发布）**：`agent/types.ts` + `agent/index.ts` + `routes.ts` 4 个调用点 → AC1-AC6、AC9-AC10。
2. **S2（兼容性验证）**：旧 handler 兼容（AC8）+ `scripts/agent-visibility-e2e.mjs`（Q8）。
3. **S3（可选同批）**：`GET /api/agent/tools` / `/nodes` 收紧 + 前端 3 处 header（Q1/Q2）→ AC10 回归。
4. **S4（文档同步）**：§13 清单（含把 R5 标记为已关闭）。
5. **S5（另立）**：`web_fetch` SSRF（Q6）、`knowledge_add` 写权限（Q5）→ 各自出方案。

---

*（本方案为设计依据；已按此实施（2026-10-13，代码改动见 develop 提交），行号以代码为准。）*
