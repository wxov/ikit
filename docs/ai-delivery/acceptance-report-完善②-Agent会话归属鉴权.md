# i-kit 验收报告 · 完善② Agent 会话归属 + 鉴权

> 角色：测试验收工程师（独立验收）
> 方案依据：`docs/ai-delivery/完善②-Agent会话归属鉴权-方案.md`（9 项决策默认已采纳）
> 现状基准：`docs/需求功能总览.md` 模块 ⑤
> 日期：2026-09-04

## 一、基线构建

- 命令：`pnpm -r --if-present build`
- 结果：**PASS（exit code 0）**
- Scope 11/12；tsc 全通过（含 `agent`、`api`、`core`），`@ikit/web` vite build 通过（159 modules，仅 chunk 体积常规警告）。tsc strict 通过即证明 `AgentService` 签名变更（会话/消息方法加 `ownerId` 首参）的消费方 `routes.ts` 已同步，无残留旧签名调用。

## 二、改动清单核验表

| 文件 | 声称改动 | 结果 | 证据 |
|---|---|---|---|
| `agent/src/types.ts` | AgentSession.ownerId? 容错；会话/消息方法加 ownerId 首参；appendMessage 返回 `AgentMessage\|undefined`；新增 getSession/migrateLegacySessions | PASS | `ownerId?: string`(:38-39)；`listSessions(ownerId)`/`createSession(ownerId,…)`/`renameSession(ownerId,id,…)`/`deleteSession(ownerId,id)`/`listMessages(ownerId,sessionId)`(:110-114)、`appendMessage(...): Promise<AgentMessage\|undefined>`(:115)、`getSession(ownerId,id)`(:117)、`migrateLegacySessions()`(:121)。 |
| `agent/src/index.ts` | inject 改 dict（account 可选）；migrateLegacySessions lazy+幂等；无 admin→清空+warn；loadDb 包装先迁移；CRUD 按 owner 过滤 | PASS | `inject = { llm:{required:true}, knowledge:{required:true}, account:{required:false} }`(:13-17)；`migrated` 标志(:252-255)；admin=首 account(:262-263)、无 admin 清空+warn(:271-275)；`loadDb` = `await migrateLegacySessions(); return store.load()`(:278-281)；list/get/create/rename/delete/messages 均带 `ownerId` 过滤(:283-366)。 |
| `api/src/routes.ts` | sessions*/messages 全 requireUser+getSession 404；chat-stream 归属校验在 writeHead 前；通用 chat-stream requireUser；heartbeat/unregister/listPendingTasks/getTask/run/complete 补 requireUser+归属 | PASS | 见「鉴权链路实证」。 |
| `apps/web/src/components/AgentPanel.vue` | 未登录提示 + loggedIn 守卫 + authHeaders 补全 | PASS | 见「桌面/Web 链路」。 |
| `apps/web/src/lib/agentNode.ts` | heartbeatOnce 补 headers；其余端点已带 | PASS | 见「桌面/Web 链路」。 |
| 文档 | 总览模块⑤ D→已实施、第六节第2项✅、README Agent 段标注 | PASS | 见「文档核验」。 |
| 未做项 | nodeId 绑定 / knowledge_search 透传 / GET nodes+tools 仍公开 | PASS（越界/决策一致） | `AgentSession` 无 nodeId；`knowledge_search` 仍 `ctx.knowledge.search(query)` 不传 viewer(`agent/index.ts:77`)；`GET /api/agent/tools`(:699-701)、`GET /api/agent/nodes`(:750-757) 无 requireUser。 |

## 三、鉴权链路实证（routes.ts agent 段）

| 端点 | 鉴权/归属 | 证据 |
|---|---|---|
| `GET/POST /api/agent/sessions` | requireUser | :713-715 / :716-722（`listSessions(user.id)`/`createSession(user.id,…)`） |
| `PATCH/DELETE /api/agent/sessions/:id` | requireUser + getSession 404 | :723-731 / :732-739（`!session → 404「会话不存在」`） |
| `GET /api/agent/sessions/:id/messages` | requireUser + getSession 404 | :740-747 |
| `POST /api/agent/sessions/:id/chat-stream` | requireUser + getSession 404 **在 writeHead 之前** | :874-915；归属校验 :882-883 → `raw.writeHead(200,…)` :891（顺序正确，越权不先写 SSE 头） |
| `POST /api/agent/chat-stream` | requireUser | :918-942 |
| `POST /api/agent/nodes/:id/heartbeat` | requireUser + 归属（server 无 ownerId 放开） | :771-781（`!node \|\| (node.ownerId && node.ownerId!==user.id) → 404`） |
| `DELETE /api/agent/nodes/:id` | requireUser + 归属 | :782-791 |
| `GET /api/agent/nodes/:id/tasks` | requireUser + 归属 | :815-824 |
| `GET /api/agent/tasks/:id` | requireUser + `task.ownerId===user.id` 否则 `{task:null}` | :825-832 |
| `POST /api/agent/tasks/:id/run`、`/complete` | requireUser + `task.ownerId===user.id` 否则 404 | :833-860 / :861-871 |

- **401/404 语义**：`requireUser` 无 token → 401（`routes.ts:98-106` 保留）；他人会话/节点/任务 → 404「不存在/无权」（不泄露存在性）。符合方案默认（决策 3：404）。
- **越权不泄露存在性**：会话/节点/任务归属失败统一 404；`getTask` 例外返回 `{task:null}`（与旧行为一致、同样不泄露）。

## 四、归属隔离实证（service 层纵深防御）

- `listSessions` 过滤 `s.ownerId === ownerId`（:283-289）。
- `getSession` 按 `id && ownerId`（:291-294）。
- `rename/delete` 仅命中 `ownerId` 匹配的会话（:311-331）。
- `listMessages` 会话不归属返回 `[]`（:333-340）。
- `appendMessage` 会话不归属返回 `undefined` 不写（:342-366）。
- `historyOf` 复用 `listMessages(ownerId,…)`（:368-371）。

## 五、迁移幂等实证

- `migrateLegacySessions`（:251-276）：`if (migrated) return` + 提前置 `migrated=true` → 懒触发、幂等。
- 仅处理 `!s.ownerId` 的会话（:257）；admin = `listUsers().find(role==='admin')` 首账号（:262-263）。
- account 未注入/无 admin：`account?.listUsers()` 返回 undefined → `?? []` → 走清空分支 `sessions.filter(s=>s.ownerId)` + 消息孤儿清理 + `console.warn`（:271-275）。
- `loadDb` 每次读前先迁移（:278-281）→ 旧 `agent.json` 缺 ownerId 的会话在首个请求到达时即被迁移，**不会崩溃**。

## 六、桌面 / Web 链路

- **AgentPanel.vue**：`currentUser` inject + `loggedIn`（:31-32）；未登录提示 `⚠ 请先登录后使用 AI Agent`（:294-296，入口保留）；守卫 `loadSessions/newSession/send` 内 `if(!loggedIn) return`（:119/:153/:205）及模板 `v-if="loggedIn"`（:336/:359/:390）；authHeaders 补全：loadSessions(:121)/loadMessages(:133)/newSession(:158)/deleteSession(:175)/renameSession(:193)/send chat-stream(:219)/pollTaskResult(:104)/sendTask(:86)。
- **agentNode.ts**：`heartbeatOnce` 已补 `headers: authHeaders()`（:62）；其余端点均带 token——register(:51)、runServerTool(:142)、llmChat(:170)、任务轮询/回传(:244/:250/:264)；且 `registerOnce/heartbeatOnce` 以 `getToken()` 为守卫、未登录静默跳过（:47/:60）。

## 七、公开端点回归

- `GET /api/agent/tools`（:699-701）、`GET /api/agent/nodes`（:750-757）无 requireUser，保持公开（决策 9，节点「三端可见」+ 工具元数据）。

## 八、文档核验

| 文件 | 要求 | 结果 | 证据 |
|---|---|---|---|
| 总览模块⑤ | D→已实施 2026-09 + knowledge_search 越权记待立项 | PASS | `需求功能总览.md:256`「已实施 2026-09（完善②：会话归属 + 鉴权）…」；`:257`「已知缺口（已记录待立项）：knowledge_search 工具未按可见性过滤…」。 |
| 总览第六节第2项 | ✅ 已完成 | PASS | `:370`「2. ✅ Agent 会话归属 + 鉴权（已完成 2026-09）…附注 nodeId 仍不做、knowledge_search 另行立项」。 |
| README API Agent 段 + 多会话描述 | 登录/归属标注 | PASS | `README.md:165`「会话按 ownerId 账号隔离，未登录 401、他人会话 404」；`:283-298` sessions/messages/chat-stream/heartbeat/unregister/tasks 读取端点均标「登录」或「登录/归属」；`:290/:281` nodes/tools 保持无标注（公开）。 |

## 九、结论

**PASS。**

会话归属 + 鉴权链路（数据模型、服务层、路由层、前端、桌面节点）全部正确落地，构建通过，文档同步一致，旧数据迁移幂等不崩溃，越权 404 不泄露存在性，公开端点按决策保留。

**次要观察（非 FAIL，可选后续）**：
1. `AgentSession.ownerId` 实现为**可选**（`ownerId?`，容错旧数据），与方案 §5.1「必填」表述略有出入——但更防御，且运行时由 `migrateLegacySessions`（lazy）+ service 过滤保证「迁移后必有 ownerId」不变量，coordinator 声称亦为可选，无实际风险。
2. `GET /api/agent/tasks/:id` 对非本人任务返回 `{task:null}`（而非 404/403）——与其它端点 404 约定略不一致，但沿用旧行为且同样不泄露存在性，可接受（可选统一为 404）。
3. `migrateLegacySessions` 的 `migrated` 标志在成功前置 `true`（:255）——若 `store.load()` 抛错则重试不重跑；JSON 存储 `load` 有兜底（读失败回退默认）不抛，实际风险极低（可选改为成功后置标志）。

*（本报告仅新增 `docs/ai-delivery/acceptance-report-完善②-Agent会话归属鉴权.md`；未改动任何代码/数据文件，未执行 git 操作。）*
