# 完善②：AI Agent 会话归属 + 鉴权 — 技术方案

> 角色：技术负责人（dev-team）
> 性质：**仅分析与方案设计，不实施代码、不执行 git 操作**
> 依据：`docs/需求功能总览.md` 模块⑤ + 第六节第 2 项；代码现状（`develop` 分支，2026-09）
> 关联文档：`docs/AI Agent 多节点与三端互通需求文档.md`、`docs/ai-delivery/acceptance-report-1.md`

---

## 0. 结论速览（TL;DR）

- **归属模型**：采用 **方案 A（会话必须登录：`requireUser` + `ownerId = 当前用户`，按 owner 过滤）**。
  - 理由：后端无法区分多个匿名游客（无游客设备身份），方案 B「匿名本端可见」在共享后端下不可实现；且与既有节点/任务 `ownerId` + `/api/llm/chat-stream`、`/api/agent/tools/:name/run` 已 `requireUser` 的现状完全一致。
- **存量会话**：**迁移给 admin 首账号**（零丢失；站主恒有全权限，损失最小）。无 admin 时兜底清空并告警。
- **鉴权边界**：会话 CRUD / 消息 / 会话内 `chat-stream` / 通用 `chat-stream` 全部 `requireUser` + 归属校验；`nodeId` 会话绑定**本期不做**（后续）。
- **桌面节点**：`agentNode.ts` 不创建会话，走 `/api/llm/chat-stream` + `/api/agent/tools/:name/run` + 任务轮询/回传，均已带 `authHeaders` 且未登录静默跳过 → **桌面端无需改动**。

---

## 1. 目标与非目标

### 1.1 目标

1. `AgentSession` 补 `ownerId`，会话按账号隔离（列表/消息/chat-stream 只操作自己名下会话）。
2. 会话相关路由补 `requireUser`（未登录 401）+ 归属校验（他人会话 404/403）。
3. 存量会话一次性迁移到 admin 首账号（或兜底清空），保证既有数据在收紧后仍可访问。
4. 前端 `AgentPanel` 加登录态守卫并补齐 `Authorization` 头；桌面节点功能回归不受影响。
5. 落地后同步文档（总览模块⑤、第六节第 2 项、README API 表、Agent 需求文档接口章节）。

### 1.2 非目标（本期不做）

- **`nodeId` 会话绑定**：会话目前始终由服务端 `runStream` 执行（`routes.ts:833-868`）；桌面节点走的是「任务队列」而非「会话」，二者不冲突。绑定 `nodeId` 属后续增强，不在本方案范围。
- 显式「计划」阶段 / computer-use / 任务实时推流（总览第五节已标未实现）。
- 知识库可见性透传到 Agent 工具（见 §10 风险 R5，仅记录为已知项，是否立项另议）。
- 死字段清理、插件生态等其它完善立项项（总览第六节第 1/3 项）。

---

## 2. 现状盘点（缺口事实与代码行号）

### 2.1 数据模型（`packages/plugins/agent/src/types.ts`）

| 项 | 行号 | 现状 |
|---|---|---|
| `AgentSession` | `:36-41` | 仅 `id/title/createdAt/updatedAt`，**无 `ownerId`、无 `nodeId`** |
| `AgentMessage` | `:44-51` | 仅 `sessionId`，无归属字段（经会话间接归属） |
| `AgentNode` | `:67-74` | 已有 `ownerId?`（`:71`）✅ |
| `AgentTask` | `:84-94` | 已有 `ownerId`（`:87`）✅ |
| `AgentService` | `:102-126` | 会话/消息方法**均无 `ownerId` 参数** |

### 2.2 服务实现（`packages/plugins/agent/src/index.ts`）

| 方法 | 行号 | 现状 |
|---|---|---|
| `listSessions` | `:243-248` | 返回全部会话，无过滤 |
| `createSession` | `:250-262` | 无 `ownerId` |
| `renameSession` | `:264-273` | 按 `id` 直接改，无归属 |
| `deleteSession` | `:275-281` | 按 `id` 直接删，无归属 |
| `listMessages` | `:283-288` | 按 `sessionId` 直接读 |
| `appendMessage` | `:290-311` | 按 `sessionId` 直接写 |
| `historyOf` | `:313-316` | 无归属 |

### 2.3 路由（`packages/api/src/routes.ts`）

| 路由 | 行号 | 现状 |
|---|---|---|
| `requireUser` | `:98-106` | 无 token → 401；有 token → `fn(user)`，`user` 含 `id/username/role/groupIds` ✅ |
| `requireAdmin` | `:86-95` | 非 admin → 403 ✅ |
| `GET /api/agent/sessions` | `:713-715` | **公开，无鉴权** |
| `POST /api/agent/sessions` | `:716-720` | **公开，无鉴权** |
| `PATCH /api/agent/sessions/:id` | `:721-725` | **公开** |
| `DELETE /api/agent/sessions/:id` | `:726-729` | **公开** |
| `GET /api/agent/sessions/:id/messages` | `:730-733` | **公开** |
| `POST /api/agent/sessions/:id/chat-stream` | `:833-868` | **公开，无归属校验**（先 `appendMessage` 再 `writeHead`） |
| `POST /api/agent/chat-stream` | `:871-893` | **公开**（无会话、通用流式） |
| `POST /api/llm/chat-stream` | `:896-932` | **已 `requireUser`** ✅（桌面节点本地循环用） |
| `POST /api/agent/tools/:name/run` | `:704-710` | **已 `requireUser`** ✅ |
| `POST /api/agent/nodes/register` | `:744-756` | 已 `requireUser` + `ownerId=user.id` ✅ |
| `POST /api/agent/nodes/:id/heartbeat` | `:757-760` | 公开（关联项，见 §8.2） |
| `DELETE /api/agent/nodes/:id` | `:761-764` | 公开（关联项，见 §8.2） |
| `POST /api/agent/tasks` | `:767-787` | 已 `requireUser` + `ownerId` 校验 ✅ |
| `GET /api/agent/nodes/:id/tasks` | `:788-791` | 公开（关联项） |
| `GET /api/agent/tasks/:id` | `:792-797` | 公开（前端 `pollTaskResult` 未带 token） |
| `POST /api/agent/tasks/:id/run` / `/complete` | `:798-830` | 公开（关联项） |

### 2.4 存储位置（已查证）

- **Agent 数据**：独立 JSON 文件 `./data/agent.json`（`agent/src/index.ts:24-25` 构造 `JsonAgentStore`；`server/src/index.ts:87-89` 传 `dataDir:'./data'`，文件名走 Config 默认 `agent.json`）。**Agent 无 SQLite 分支**（SQLite 仅 knowledge 有，`server/src/index.ts:64`）。
- **账号数据**：`./data/accounts.json`（`account/src/index.ts:37`），`sessions` 存 token→userId，`users` 含 `role`/`id`。
- **迁移范围**：仅 `agent.json` 的 `sessions`（补 `ownerId`）；`messages` 经 `sessionId` 间接归属，无需改字段。

### 2.5 前端现状

| 文件 | 关键点 |
|---|---|
| `apps/web/src/lib/api.ts:60-75` | `api()` 不自动带 token，调用方需手动传 `authHeaders()` |
| `apps/web/src/lib/auth.ts:24-35` | `getToken()`（localStorage `ikit-token`）、`authHeaders()` |
| `AgentPanel.vue` | 会话 CRUD（`loadSessions:110-118`、`newSession:141-155`、`deleteSession:157-169`、`renameSession:171-184`）**均未带 `authHeaders`**；`send()` 的 `chat-stream` fetch（`:200-205`）仅 `Content-Type`；`pollTaskResult:93-108` 未带 token；`sendTask:73-91` 已带 |
| `agentNode.ts` | 全程带 `authHeaders`；`registerOnce/heartbeatOnce/pollAndRunTasks` 以 `getToken()` 为守卫，未登录静默跳过（`:46-66,258-274`）。**桌面节点不创建会话** |

---

## 3. 归属模型选型（方案 A vs 方案 B）

| 维度 | 方案 A（必须登录，`ownerId=当前用户`） | 方案 B（游客匿名 `ownerId=null` 且仅本端可见） |
|---|---|---|
| 可行性 | ✅ 复用既有 `requireUser` + `User.id` | ❌ 后端无法区分多个匿名游客（无游客设备身份/令牌），「仅本端可见」在共享后端下无从判定 |
| 一致性 | ✅ 与节点/任务 `ownerId`、`/api/llm/chat-stream`、`tools/:name/run` 已 `requireUser` 一致 | 需另造游客身份机制，偏离现有模式 |
| 目标契合 | ✅ 直接兑现「同一账号续聊 / 会话归属」 | 无法兑现归属 |
| 改动量 | 小（补字段 + 加鉴权） | 大（游客身份 + 前端持久化归属） |

**推荐：方案 A**。理由：B 在「一个共享后端 + 多端」架构下不可实现（游客无身份可绑定），且与本项目既有的 `ownerId` 模式（节点/任务）与「登录鉴权」约定（llm/chat-stream、tools/run 均已 `requireUser`）天然对齐。

> 落地后语义：**未登录不可用 Agent 会话**（401）；登录后各账号仅见/仅操作自己名下会话。

---

## 4. 逐文件改动清单

### 4.1 `packages/plugins/agent/src/types.ts`

| 行号 | 改动 |
|---|---|
| `:36-41` | `AgentSession` 增加 `ownerId: string`（必填，迁移后不变量成立） |
| `:102-126` | `AgentService` 会话/消息方法签名补 `ownerId`（见 §5 契约）：<br>`listSessions(ownerId)`、`createSession(ownerId, title?)`、`renameSession(ownerId, id, title)`、`deleteSession(ownerId, id)`、`listMessages(ownerId, sessionId)`、`appendMessage(ownerId, sessionId, input): Promise<AgentMessage \| undefined>`、`historyOf(ownerId, sessionId)`；<br>新增 `getSession(ownerId, id): Promise<AgentSession \| undefined>`（供路由做 403/404 判定）与 `migrateLegacySessions(): Promise<{ migrated: number; cleared: number }>` |

### 4.2 `packages/plugins/agent/src/index.ts`

| 行号 | 改动 |
|---|---|
| `:12` | `inject` 由 `['llm', 'knowledge']` → `['llm', 'knowledge', { account: { required: false } }]`（迁移解析 admin 用，可选依赖不破坏独立运行） |
| `:35-38` | `AgentContext` 增加 `account?: import('@ikit/plugin-account').AccountService` |
| `:241` | `loadDb` 包装为「先 `store.load()` 再 `await migrateLegacySessions(db)`」，迁移幂等、懒触发（见 §7） |
| `:243-248` | `listSessions(ownerId)` 过滤 `s.ownerId === ownerId` 后排序 |
| `:250-262` | `createSession(ownerId, title?)` 写入 `ownerId` |
| `:264-273` | `renameSession(ownerId, id, title)` 仅改 `ownerId` 匹配的会话，返回 `listSessions(ownerId)` |
| `:275-281` | `deleteSession(ownerId, id)` 仅删 `ownerId` 匹配的会话及其消息 |
| `:283-288` | `listMessages(ownerId, sessionId)`：会话不归属当前 owner 时返回 `[]` |
| `:290-311` | `appendMessage(ownerId, sessionId, input)`：会话不归属时返回 `undefined`（不写） |
| `:313-316` | `historyOf(ownerId, sessionId)` 复用 `listMessages(ownerId, ...)` |
| `:413-439` | 服务对象补 `getSession`、`migrateLegacySessions`，并按新签名导出 |

> 设计原则：**归属过滤下沉到 service**（纵深防御），路由层再叠加 `requireUser` + 显式 403/404（复用节点/任务的「存储 ownerId + 路由校验」模式，但会话将过滤进一步落到 service，避免任何未来消费方漏校验）。

### 4.3 `packages/api/src/routes.ts`

| 行号 | 改动 |
|---|---|
| `:713-715` | `GET /api/agent/sessions` → `requireUser(req, reply, async (user) => ({ sessions: await ctx.agent.listSessions(user.id) }))` |
| `:716-720` | `POST /api/agent/sessions` → `requireUser`；`createSession(user.id, body?.title)` |
| `:721-725` | `PATCH /api/agent/sessions/:id` → `requireUser`；先 `getSession(user.id, id)`，不存在/不归属 → 404 |
| `:726-729` | `DELETE /api/agent/sessions/:id` → 同上（先校验归属） |
| `:730-733` | `GET /api/agent/sessions/:id/messages` → `requireUser`；先校验归属，否则 404 |
| `:833-868` | `POST /api/agent/sessions/:id/chat-stream` → `requireUser`；**在 `writeHead` 前**先 `getSession(user.id, id)` 校验，非本人/不存在 → `reply.code(404)`（勿先写 SSE 头）；`appendMessage(user.id, ...)`、`historyOf(user.id, id)` |
| `:871-893` | `POST /api/agent/chat-stream`（无会话通用）→ `requireUser`（与 `/api/llm/chat-stream` 对齐；关闭游客匿名调用 Agent 工具的口子） |

> 说明：`requireUser` 无 token 返回 401；有 token 但会话不归属返回 404（统一「不存在/无权」不泄露他人会话存在性；验收标准 403/404 均接受，本方案默认 404）。

### 4.4 关联一致项（推荐同步，可拆分为第二期，见 §8.2）

节点/任务**读取端点**目前公开、与写入端的 `ownerId` 校验不一致，建议一并收紧（工作量小）：

| 行号 | 改动 |
|---|---|
| `:757-760` | `POST /api/agent/nodes/:id/heartbeat` → `requireUser`（+ 校验 `node.ownerId === user.id`，server 节点无 ownerId 放开，与 `:777` 一致） |
| `:761-764` | `DELETE /api/agent/nodes/:id` → `requireUser` + 归属校验 |
| `:788-791` | `GET /api/agent/nodes/:id/tasks` → `requireUser` + 归属校验（仅本节点 owner 可轮询自己的任务） |
| `:792-797` | `GET /api/agent/tasks/:id` → `requireUser` + 归属校验（task.ownerId === user.id） |
| `:798-830` | `POST /api/agent/tasks/:id/run`、`/complete` → `requireUser` + 归属校验 |

> 若此项纳入，前端 `AgentPanel.vue` 的 `pollTaskResult`（`:93-108`）需补 `authHeaders()`。

---

## 5. 契约 / 请求响应变化

### 5.1 服务契约（`AgentService`，TypeScript 破坏性变更）

- 会话/消息 7 个方法新增首个参数 `ownerId`，并新增 `getSession` / `migrateLegacySessions`。
- **消费方**：全仓仅 `packages/api/src/routes.ts` 调用这些方法（`grep ctx.agent.` 确认）；`packages/core/src/index.ts:29,40` 只是类型 re-export，无代码改动。无其它 TS 消费方，破坏面可控。
- `scripts/agent-e2e.mjs:6` 调用的是已下线旧路由 `/api/agent/chat`，与本改动无关（建议顺带更新或删除，非本方案范围）。

### 5.2 HTTP 契约

| 端点 | 变化 |
|---|---|
| `GET/POST/PATCH/DELETE /api/agent/sessions*`、`GET .../messages` | 需 `Authorization: Bearer <token>`；未登录 401；他人会话 404 |
| `POST /api/agent/sessions/:id/chat-stream` | 需登录 + 归属；未登录 401、非本人 404 |
| `POST /api/agent/chat-stream` | 需登录（401） |
| 响应体 | `AgentSession` 多出 `ownerId` 字段（加法变更，前端不消费也不报错） |

> 请求体（`title` / `message`）不变，无新增查询参数。SSE 事件结构不变。

---

## 6. 数据迁移与兼容

### 6.1 迁移对象与位置

- **对象**：`./data/agent.json` 的 `sessions`（补 `ownerId`）；`messages`/`nodes`/`tasks` 不动（nodes/tasks 已有 ownerId）。
- **位置**：`agent` 插件内 `migrateLegacySessions()`，由 `loadDb` 包装在**首次加载时懒触发**，幂等（仅处理缺 `ownerId` 的会话，跑一次即置标志）。这样避免与 `account` 的 `seedAdmin`（`account/src/index.ts:43`，异步）的启动时序竞争——任何 HTTP 请求到达时 account 早已 seed 完成。

### 6.2 迁移策略（推荐）

1. 解析 `ctx.account?.listUsers()` 中第一个 `role==='admin'` 的用户，取其 `id`。
2. 对所有缺 `ownerId` 的会话：`ownerId = adminId`；若存在不归属会话的历史消息，随会话一并归属（无需改字段）。
3. 若 `account` 未注入或**无任何 admin**：清空这些遗留会话及其消息，并 `console.warn('[agent] 未找到 admin，清空 %d 个遗留会话')`。
4. 有改动才 `store.save(db)`；返回 `{ migrated, cleared }`。

**推荐：挂 admin 首账号**（零丢失；站主恒有全权限，且旧会话本就是「全局无主」，归属给站主损失最小、语义最干净）。**备选：清空**（彻底、无隐私顾虑，但丢失历史）。

| 策略 | 优点 | 风险 |
|---|---|---|
| 挂 admin（推荐） | 零丢失、简单、站主语义自然 | 旧匿名/他人历史归给 admin（因无主，本就无法区分，风险可接受） |
| 清空 | 无隐私残留 | 丢失历史，需先备份 `agent.json` |

### 6.3 三端 / 桌面 / 迁移兼容

- **三端**：共用同一前端 + 同一后端，会话隔离对 Web/桌面/移动一致生效；登录后各自看到自己名下会话。
- **桌面节点**：`agentNode.ts` 不涉及会话，节点/任务已带 `ownerId`，**无需迁移、无需改动**（见 §8.1）。
- **向后兼容**：`ownerId` 为加法字段；回滚代码后旧逻辑忽略该字段、恢复「全局可见」行为，旧数据不破坏（仅当选择「清空」策略时回滚需恢复备份）。

---

## 7. 前端配套改动点

### 7.1 `apps/web/src/components/AgentPanel.vue`

1. **登录态守卫**：注入 `currentUser`（`App.vue:303` 已 `provide('currentUser', user)`）或直接读 `getToken()`；未登录时渲染「请先登录后使用 AI Agent」空态，跳过会话加载/发送。
   - 推荐：**保留 Agent 入口**（与插件按组可见体系一致），面板内提示登录；不隐藏入口，避免与插件可见性语义打架。
2. **补 `Authorization` 头**：`loadSessions` / `newSession` / `deleteSession` / `renameSession` / `loadMessages` 各 `api()` 调用加 `headers: authHeaders()`；`send()` 的 `chat-stream` fetch（`:200-205`）加 `...authHeaders()`。
3. （若纳入 §4.4）`pollTaskResult`（`:93-108`）补 `authHeaders()`。

### 7.2 `apps/web/src/lib/agentNode.ts`

- **无需改动**。桌面本地 agent 不创建/不使用会话；其链路（`register/heartbeat/tasks 轮询/complete` + `llm/chat-stream` + `tools/:name/run`）均已带 `authHeaders` 且 `getToken()` 未登录即跳过（`startDesktopNode` 静默不注册）。
- 回答「桌面本地无登录会话怎么办」：**桌面端已复用 Web 的登录态**（localStorage `ikit-token` 同源/同存储，`auth.ts`），登录后自动带 token；未登录则节点不注册、任务不轮询——这是现状，保持即可。无需「仅存本地的匿名会话」分支。

### 7.3 其它

- `apps/web/src/lib/api.ts` 无需改（保持「显式传 header」约定，避免全局隐式带 token 影响公开接口）。

---

## 8. 桌面节点与关联影响一致性

### 8.1 桌面节点功能回归（不受影响）

- 节点注册/心跳/任务轮询/回传均为「登录后」行为，与本次会话鉴权互不影响。
- `POST /api/llm/chat-stream`、`POST /api/agent/tools/:name/run` 已是 `requireUser`，本次无变化。
- 唯一潜在联动：若采纳 §4.4 收紧任务读取端点，则 `agentNode.ts` 的 `pollAndRunTasks`/`completeTaskLocally` 已带 token，**仍无需改动**（仅前端 Web 的 `pollTaskResult` 需补）。

### 8.2 任务/节点鉴权一致性

- 写入端（`register`/`tasks` 创建）已 `requireUser` + `ownerId` 校验；读取端（`heartbeat`/`unregister`/`listPendingTasks`/`getTask`/`run`/`complete`）目前公开，存在「越权注销他人节点 / 读取他人任务」的缺口。
- **推荐**：与本方案一并收紧（对齐一致性，改动集中在 `routes.ts`，见 §4.4）；也可作为独立第二期，但建议至少将 `heartbeat`/`unregister` 随本次收口。

---

## 9. 验收标准

| # | 场景 | 预期 |
|---|---|---|
| 1 | 未登录 `GET/POST /api/agent/sessions` | 401 `{"error":"请先登录"}` |
| 2 | 未登录 `POST /api/agent/sessions/:id/chat-stream`、`POST /api/agent/chat-stream` | 401 |
| 3 | 用户 A 登录创建会话 | 201，返回 `session.ownerId === A.id` |
| 4 | 用户 A `GET /api/agent/sessions` | 只含 `ownerId === A.id` 的会话 |
| 5 | 用户 B 对 A 的会话 rename/delete/读消息/chat-stream | 404（或 403，二选一） |
| 6 | 存量会话迁移后 | admin 登录可见全部旧会话；非 admin 不可见 |
| 7 | 桌面节点回归 | 登录后注册/心跳/轮询/回传正常；未登录静默不注册（`agentNode.ts` 无改动回归） |
| 8 | 前端 | 未登录显示登录提示；登录后正常加载/续聊；发送带 token 不再 401 |
| 9 | 构建 | `pnpm -r --if-present build` + tsc 通过（含 `AgentService` 签名变更） |

---

## 10. 风险与回滚

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `AgentService` 签名破坏契约 | 消费方仅 `routes.ts`（已核对），同步改即可；core 仅 re-export 类型 |
| R2 | 存量会话挂 admin 的隐私归因 | 旧会话本无主、本就全局共享；站主恒有全权限，归因损失最小；备选清空（需备份） |
| R3 | SSE 先写 200 头再发现越权 | **必须**在 `writeHead` 前完成 `getSession` 校验，否则无法返回 404 |
| R4 | 前端漏补 token → 401 白屏 | 与后端同步改 `AgentPanel`（§7.1），验收 #8 覆盖 |
| R5 | `knowledge_search` 工具未按可见性过滤（`agent/index.ts:67` 调 `ctx.knowledge.search(query)` 不传 `viewer`，`knowledge/service.ts:427` 无 viewer 时不过滤）→ 登录用户可经 Agent 检索他人私有/组内知识 | 本方案至少**记录为已知项**；是否「透传 viewer 到 Agent 工具」另立方案。收紧 Agent 到登录后已关闭游客口子，但跨用户口子仍在 |
| R6 | 迁移并发（JSON 非多进程安全） | 单实例部署无影响；迁移幂等（仅补缺 ownerId） |

**回滚**：`git revert` 本改动即可。数据层 `ownerId` 为加法字段，回滚后旧逻辑忽略该字段恢复全局可见；若当初选「清空」策略，则需用备份的 `agent.json` 恢复。

---

## 11. 待确认问题（附推荐默认值）

| # | 问题 | 推荐默认值 |
|---|---|---|
| 1 | 未登录是否可用 Agent | **需登录**（方案 A）。游客不可用会话，前端显示登录提示 |
| 2 | 存量会话处置 | **迁移给 admin 首账号**（零丢失）；备选清空（需备份） |
| 3 | 他人会话越权返回码 | **404**（不泄露存在性）；备选 403。验收标准 403/404 均接受 |
| 4 | 是否同步收紧节点/任务读取端点鉴权（§4.4） | **一并收紧**（对齐一致性）；可拆第二期，但至少 `heartbeat`/`unregister` 随本次 |
| 5 | 是否补 `nodeId` 会话绑定 | **本期不做**（会话恒跑服务端节点；桌面走任务队列），列为后续 |
| 6 | `knowledge_search` 可见性透传 | **本期记录为已知项**；是否立项透传 `viewer` 另议 |
| 7 | 通用 `POST /api/agent/chat-stream`（无会话）是否保留 | **保留 + requireUser**（与 `/api/llm/chat-stream` 一致） |
| 8 | 前端游客处理：隐藏入口 vs 面板内登录提示 | **保留入口 + 面板内登录提示**（与插件可见性体系一致） |
| 9 | `GET /api/agent/nodes`、`GET /api/agent/tools` 是否保持公开 | **保持公开**（节点「三端可见」、工具为元数据；可选后续脱敏 `ownerId`） |

---

## 12. 文档同步清单（落地后执行）

| 文档 | 位置 | 改动 |
|---|---|---|
| `docs/需求功能总览.md` | 模块⑤ `:254` | D 标注改 A，补「会话 `ownerId` 归属 + requireUser 鉴权已落地」 |
| | 第六节 `:367` 第 2 项 | 标 ✅ 已完成（补方案/实施结论） |
| | `:247`/`:253` 实现位置 | 补会话鉴权行号说明（可选） |
| `README.md` | `:165` | 去掉/改写「会话归属/鉴权为已知缺口」 |
| | API 表 `:281-298` | sessions 各接口 + `chat-stream` 标「登录」；若 §4.4 落地，heartbeat/unregister/tasks 读取端点一并标注 |
| `docs/AI Agent 多节点与三端互通需求文档.md` | §4 `:67-74` | `AgentSession.ownerId` 由「拟定」标「已实施」 |
| | §5 `:88-93` | 接口鉴权标注：会话/chat-stream 登录 + 归属 |
| | §8 `:126` | 补「会话按账号隔离、未登录 401」验收项 |
| `AGENTS.md` | AI Agent 数据模型段 | 补「会话 `ownerId` 归属 + 会话/消息/chat-stream requireUser 鉴权」 |

---

*（本方案为技术分析，仅新增 `docs/ai-delivery/完善②-Agent会话归属鉴权-方案.md`，未改动任何代码/数据文件，未执行 git 操作。）*
