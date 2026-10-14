# 完善④ Agent 工具可见性（`knowledge_search` 越权修复）— 独立验收报告

> 验收角色：测试验收工程师（独立第三方，非实施者）
> 验收时间：2026-10-13
> 仓库：`D:\Projects\i-kit`　分支：`develop`　基线：`HEAD = d401630`（改动在工作区未提交）
> 权威方案：`docs/ai-delivery/完善④-Agent工具可见性-方案.md`（用户已采纳 Q1-Q9 推荐默认）
> 验收约束遵守情况：**未修改任何项目代码、未执行任何 git 写操作**；实测使用系统临时目录 + 环境变量隔离，**未写入 `packages/server/data` 与 `plugins/`**（见 §6 证据）

---

## 0. 结论（TL;DR）

| 维度 | 结论 |
|---|---|
| 构建与类型检查 | ✅ **PASS** — `pnpm -r --if-present build` 独立重跑 2 次，均 `exit 0`，10 个含 build 脚本的包全部 Done |
| 核心修复（越权读取闭合） | ✅ **PASS** — 代码实证 + 真实 HTTP 端到端 + 进程内 harness + 变异对照四重证据一致 |
| 契约兼容性（TS 零破坏） | ✅ **PASS** — 类型层面可选参数、运行时旧单参 handler 实测可用 |
| 测试脚本 | ✅ **PASS（附 3 条次要观察）** — 语法通过；无已下线路由运行时引用；清理完整 |
| 文档同步 | ❌ **FAIL** — 4 项文档缺陷（1 项实质性 AC 错误、2 项与代码直接矛盾、1 项内部不一致） |
| **总体判定** | ❌ **FAIL（仅文档口径；功能与安全实现 PASS，无需改代码）** |

**一句话结论**：修复本身**正确、有效、可交付**——4 条执行入口全部透传调用者 `viewer`、缺省 fail-closed、越权链路经实测已闭合（变异对照下立刻复现 8 处泄露，证明测试非空转）；但**文档同步未达 AGENTS.md「文档必须与代码保持同步」的要求**：方案文档 AC3 的验收描述与实现方向相反（按方案原文验收会得到相反的结论），README API 表仍称 `GET /api/agent/nodes` 为「公开」。**建议仅做一轮文档修正，代码零改动。**

---

## 1. 改动核验表（逐项实证，不采信开发者描述）

| # | 开发者声称 | 独立核验 | 证据（文件:行） |
|---|---|---|---|
| 1 | `agent/src/types.ts` 新增 `AgentCallContext{viewer?,userId?}`；`AgentTool.handler(args, call?)`；`runTool`/`runStream` 追加可选参数 | ✅ 属实 | `types.ts:8-13`（AgentCallContext）、`:20-23`（handler 第二参 `call?`）、`:123`（runTool 第三参可选）、`:124`（runStream 第三参可选）；构建产物 `dist/types.d.ts` 同样为 `call?: AgentCallContext` |
| 2 | `agent/src/index.ts`：`GUEST_VIEWER` + `viewerOf(call)` fail-closed；`knowledge_search` 改 `(args,call)` 且传 `viewerOf(call)`（核心修复行）；`knowledge_add` 打 `call?.userId`；`runStream` 内循环变量更名 `toolCall`；`web_fetch`/`current_time` 保持单参 | ✅ 属实，逐行一致 | `index.ts:64`（`GUEST_VIEWER={groups:['guest'],isAdmin:false}`）、`:65`（`call?.viewer ?? GUEST_VIEWER`）、`:79`（`handler: async (args, call)`）、**`:83`（`ctx.knowledge.search(query, viewerOf(call))` 核心修复行）**、`:155`/`:160`（`knowledge_add` 双参 + `call?.userId` 审计日志，仍位于 `:142` 的 `enableWriteTools` 门内）、`:232`（循环变量 `toolCall`，`:231` 有显式注释说明避免遮蔽）、`:248`（`tool.handler(toolArgs, call)`）、`:112`（`web_fetch` 单参）、`:97`（`current_time` 单参） |
| 3 | `api/src/routes.ts` 新增 `callOf(user)`；4 入口透传；`tools`/`nodes` 加 `requireUser` | ✅ 属实，无遗漏 | `routes.ts:119-121`（`callOf` = `{viewer: await viewerOf(user), userId: user?.id}`）、`:764`（`tools/:name/run` → `runTool(name,args, await callOf(user))`）、`:899`+`:903`（`tasks/:id/run` → `runStream(task.message,[],call)`）、`:960`+`:962`（会话 chat-stream）、`:986`+`:995`（通用 chat-stream）、`:753`（`GET /api/agent/tools` 包 `requireUser`）、`:807`（`GET /api/agent/nodes` 包 `requireUser`） |
| 4 | 前端 3 处补 `authHeaders()` | ✅ 属实，恰好 3 处 | `AgentPanel.vue:61-63`（loadTools）、`:72-75`（loadNodes）、`agentNode.ts:152`（fetchServerTools，并附注释说明 `api()` 不自动注入 token） |
| 5 | 新增 `scripts/agent-visibility-e2e.mjs`（42 条断言，自建自清）；重写 `scripts/agent-e2e.mjs`（去掉已下线的 `/api/agent/chat`，改登录态 + `chat-stream` SSE） | ✅ 属实（断言条数与实测口径见 §3） | 两脚本 `node --check` 均 `exit 0`；`agent-e2e.mjs` 运行时仅用 `/api/agent/chat-stream`；`/api/agent/chat` 仅出现在 `agent-e2e.mjs:3-4` 的说明注释中 |
| 6 | 文档同步 5 处 | ⚠️ **部分属实**（4 项缺陷见 §5） | 总览模块⑤ `:259`、第六节 `:372`/`:377`/`:378-380`、README `:49`/`:164-165`/`:326`、AGENTS.md 数据模型段、完善② `:284`/`:300`、AI Agent 需求文档 `:40` 均已同步；**但 README API 表与方案 AC3/状态行未同步** |

**旁证 1（唯一调用点）**：全仓库 `knowledge.search(` 仅 `agent/index.ts:83` 一处（另一处 `.search(` 命中是 `knowledge/service.ts:376` 的 `fuse.search`）→ HTTP 层确无其它调用者，修好工具即闭合唯一检索路径。

**旁证 2（过滤语义未漂移）**：工具层未复制 `isVisible`，仅传 viewer；过滤仍在 `knowledge/service.ts:413-415` 单点（`viewer ? out.filter(isVisible) : out`），`isVisible` 在 `:45-53`。与 HTTP 侧同源。

**旁证 3（调用清单无旁路）**：全仓库 `runStream(`/`runTool(` 调用者仅 `routes.ts` 的 4 个入口（`:764`/`:903`/`:962`/`:995`）与 `agent` 自身定义 → 无遗漏调用点，也无「未传 call 的内部调用」。

---

## 2. 构建结果（独立重跑）

```
pnpm -r --if-present build   → EXITCODE=0   （第 1 次、第 2 次均 exit 0）
含 build 脚本的包数 = 10：
  apps/web (vite build ✓ built in 1.92s)
  packages/core, packages/api
  packages/plugins/{account, demo, llm, plugin-registry, store-data, knowledge, agent}  (tsc -p tsconfig.json)
所有包均输出 "Done"，无 error/warning 级别的类型错误。
```

- 与开发者自报「exit 0 ×2」一致；本次为独立重跑（未复用其输出）。
- `apps/web` 产物体积 `index-*.js 525.62 kB │ gzip 178.11 kB`（仅记录，非验收项）。

---

## 3. 脚本核验

### 3.1 语法与静态检查

| 项目 | 结果 |
|---|---|
| `node --check scripts/agent-visibility-e2e.mjs` | ✅ exit 0 |
| `node --check scripts/agent-e2e.mjs` | ✅ exit 0 |
| 是否引用已下线 `POST /api/agent/chat` | ✅ 无运行时引用（严格正则 `/api/agent/chat($|[^-s])` 仅命中 `agent-e2e.mjs:3` 的说明注释） |
| 是否仍调用需登录但未带 token 的接口 | ✅ 所有 Agent/知识库写接口均带 `Authorization` |

### 3.2 断言集合与方案 AC1-AC10 覆盖（对照 `agent-visibility-e2e.mjs`）

| AC | 脚本覆盖 | 本次独立实测 |
|---|---|---|
| AC1 跨用户读取闭合 | ✅ `:223-225`/`:231` | ✅ PASS（B 检索不到 private/groups/子组文章；仅 private 命中返回统一文案） |
| AC2 admin 恒可见 | ✅ `:244-248` | ✅ PASS |
| AC3 组可见性 + 父子递归 | ✅ `:252`/`:255`/`:261`/`:263`/`:269`（语义已按实现方向改写，见 §5-D2） | ✅ PASS（C∈G 可见 G 与 G2 文章；D∈G2 可见 G2 但**不可见** G 的文章） |
| AC4 login 级 + 游客边界 | ✅ `:227`/`:276-280` | ✅ PASS（B 可见 login；未登录 401 且响应体无内容） |
| AC5 四条链路全覆盖 | ⚠️ 入口 4 由 AC1/2/3/6 覆盖（`:296`）；入口 1/2/3 需真实 LLM，无 key 时 SKIP（`:114`/`:355`/`:363`） | ⚠️ 入口 4 实测 PASS（≈33 条）；入口 1/2/3 本次 **SKIP**（未配置 LLM，见 §3.3） |
| AC6 无旁路/探测差异 | ✅ `:236-240`/`:283-290`（8 次换词） | ✅ PASS |
| AC7 桌面节点等价受限 | ❌ 脚本未覆盖（需 Tauri 真机） | ⚠️ 未实测；代码侧等价路径已核验：`agentNode.ts:139-146` `runServerTool` 带 token、`:260` 未登录不轮询、`:152` 工具清单已补 header |
| AC8 旧 handler 兼容 | ❌ 脚本未覆盖（其头部 `:6` 已注明为进程内契约测试） | ✅ 由**本次独立 harness** 覆盖（见 §4） |
| AC9 fail-closed | ❌ 脚本未覆盖（同上） | ✅ 由**本次独立 harness** 覆盖（见 §4） |
| AC10 构建与回归 | ⚠️ 脚本覆盖 HTTP 回归 `:371-387`（entries/view/comments/会话隔离） | ✅ PASS；构建部分见 §2 |

> 观察：AC7/AC8/AC9 不由该脚本承担（AC8/AC9 已在脚本头部注释声明），AC7 属 Tauri 真机手工项——建议在方案 §10 或脚本头部把「AC7 为手工项」写明，避免读者误以为脚本已覆盖全部 AC。

### 3.3 脚本真实执行（隔离临时实例，非真实 LLM）

为不消耗真实 LLM 且不污染仓库数据，在**系统临时目录**用环境变量覆盖启动独立实例：

```
cwd  = C:\Users\...\Temp\ikit-accept-qa4\inst     # 使 './data' 落到临时目录
env  = PORT=3111  HOST=127.0.0.1  PLUGIN_DIR=D:\Projects\i-kit\plugins
       KB_STORAGE=json  LLM_API_KEY=''  EMBEDDING_API_KEY=''   # 显式置空以禁用 .env 中的真实 key
node <repo>\packages\server\node_modules\tsx\dist\cli.mjs <repo>\packages\server\src\index.ts
BASE=http://127.0.0.1:3111 node scripts/agent-visibility-e2e.mjs
```

结果：**PASS 33 / FAIL 0 / SKIP 3（exit 0）**

- SKIP 3 条全部是 LLM 依赖项：通用 chat-stream、会话 chat-stream、`tasks/:id/run` 的工具结果断言（服务端返回 `LLM 未配置 API Key`，脚本按设计记 SKIP，未见假 PASS）。
- 覆盖到的真实 HTTP 断言（33 条）包含：AC1×5、AC2×3、AC3×6、AC4×3、AC6×2、AC10×6、Q1×2、Q2×2、AC5-4×1、AC5-2 前置 401×1、AC5-1 会话落库×1、前置（G2.parentId）×1（合计 33）。
- **与开发者自报「42 条」的口径自洽**：本次 33 条 + 3 条链路 × 3 条断言（链路泄漏检查 + login 级可见 + 私有文案一致）= 42；即 42 是「LLM 可用」时的条数，本次因禁用 LLM 少 9 条而非少测试。
- 附带确认 R6 风险已规避：`GET /api/agent/tools` 登录态返回 200 且含 `knowledge_search`（Q1 断言），说明前端补 header 后登录用户列表不会静默变空。

### 3.4 清理逻辑可靠性（实测）

| 对象 | 清理结果（临时实例落盘核实） |
|---|---|
| 3 个临时用户 | ✅ 硬删除（`accounts.json` 仅剩 admin） |
| 2 个临时组（G、G2） | ✅ 硬删除（仅剩内置 `游客/注册用户/站主`），且逆序删除避免父子外键问题 |
| 5 篇文章 | ✅ 接口层面全部删除（`存活: 0`）；底层为**软删除**（5 条带 `deletedAt` 仍在 `knowledge.json`，属知识库既有回收站语义，非脚本缺陷） |
| 1 个测试节点 | ✅ 已注销 |
| 会话 | ✅ 内联删除 |

**失败路径**：`try/catch/finally` 结构正确——`finally` 中若 `adminToken` 为空会重新登录再清理；`created.*` 为增量登记，异常中断也能清掉已创建对象；清理本身逐项 `safe()` 包裹，单项失败不阻断其余。
**残留（次要观察）**：`AgentTask` 记录**无法清理**（无 `DELETE /api/agent/tasks/:id` 接口），实测残留 1 条 `status=error` 的任务（引用已删除的 nodeId/ownerId）；不含越权内容、无安全影响，但「自建自清」的说法在任务维度不成立。

---

## 4. 代码级独立验证（harness + 变异对照）

在不改动任何项目代码的前提下，用**真实构建产物**在进程内组装真实 `knowledge` 服务（JSON store 落临时目录）+ 真实 `agent` 插件（`dist/index.js`、`dist/store.js`），以假 LLM 驱动：

```
node <temp>\ikit-accept-qa4\harness.mjs    → 19 条断言  FAIL 0
```

覆盖与结果：

| 断言组 | 结果 |
|---|---|
| AC9 fail-closed：`runTool('knowledge_search',{query})` 不传 call → 仅 public（无 private/groups/login） | ✅ PASS |
| AC9 fail-closed：`call={}`（无 viewer）→ 等同 guest | ✅ PASS |
| AC1：普通用户（`['user']`）不可见 private/groups，可见 public | ✅ PASS |
| AC4：普通用户可见 `login` 级（有效组不含 guest） | ✅ PASS |
| AC2：admin（isAdmin 短路）可见 private/groups | ✅ PASS |
| AC3：属组用户（`['user','g1']`）可见 groups(g1)，仍不可见 private | ✅ PASS |
| AC6：「无权命中」与「关键词不存在」返回文案逐字一致 | ✅ PASS |
| AC8：旧单参 `handler:(args)=>...` 经 `runTool` 正常执行（多传 call 被忽略） | ✅ PASS |
| AC8：`dist/types.d.ts` 中 handler 第二参与 `runTool`/`runStream` 第三参均为可选 | ✅ PASS |
| Q5：`enableWriteTools` 默认不注册 `knowledge_add`；开启后注册且带 `call.userId` 审计、可写入 | ✅ PASS |
| AC5-lite：`runStream(msg, [], call)` 的工具事件无越权内容（验证 `toolCall` 更名未遮蔽 call 形参） | ✅ PASS |
| AC9：`runStream(msg)` 旧两参用法仍可用且 fail-closed | ✅ PASS |

### 变异对照（证明测试非空转，也证明漏洞真实存在）

将**构建产物的临时副本**（`...\Temp\ikit-accept-qa4\mutated\index.js`，仓库文件未动）的核心行还原为修复前写法：

```
- const results = await ctx.knowledge.search(query, viewerOf(call));
+ const results = await ctx.knowledge.search(query);
```

重跑同一 harness：**FAIL 8**（AC1×2、AC3×1、AC6×1、AC9×3、AC5-lite×1），泄露内容中直接出现 `MARK-PRIV` / `MARK-GRP` 全文 → **测试有效、修复必要**。该结果独立佐证开发者自报的「反向对照 FAIL 17」（本 harness 断言数较少，故为 8）。

> 说明：开发者自报的进程内 harness「PASS 10/FAIL 0」与 42/17 的具体数字**未由其输出原件核验**，但本次独立实现从另一路径得到同向结论；变异对照亦已独立复现。

---

## 5. 文档一致性核查

### 5.1 已同步且与代码一致（✅）

| 文档 | 位置 | 核对结论 |
|---|---|---|
| `docs/需求功能总览.md` | 模块⑤ 一致性状态 `:259` | 「已修复 2026-10（完善④）」；4 入口行号 `routes.ts:935/980/892/760` 与实际一致；`:753`/`:807` 与 `requireUser` 一致；fail-closed 表述正确 |
| 同上 | 第六节第 2 项 `:372` | 已加「`knowledge_search` 可见性透传已于完善④ 关闭」 |
| 同上 | 第六节新增第 7 项 `:377` | 已完成项 + 脚本路径 |
| 同上 | 第六节新增第 8 项 `:378-380` | `web_fetch` SSRF（P2）、`knowledge_add` 写权限（P2）均记为待立项，与代码现状（`web_fetch` 无 SSRF 拦截；`knowledge_add` 默认关闭、任意登录用户可写）**一致** |
| `README.md` | `:49` `:164-165` `:326` | 目录树含新脚本；「检索范围 = 当前登录用户可见范围」「工具需自行按 `viewer` 鉴权」「缺省 fail-closed = 仅 public」表述与代码一致 |
| `AGENTS.md` | 「AI Agent（节点/任务/本地工具）」段 | 「可选第二参 `AgentCallContext{viewer?,userId?}`」「旧单参 handler 仍兼容」「工具需自行按 viewer 鉴权」「缺省 fail-closed 按 guest = 仅 public」「4 条入口透传」全部与代码一致 |
| `docs/ai-delivery/完善②-Agent会话归属鉴权-方案.md` | `:284`（R5）、`:300`（第 6 项） | 均已标注「已于完善④ 关闭」并附方案链接 |
| `docs/AI Agent 多节点与三端互通需求文档.md` | §3.2 `:40` | 「检索范围 = 当前登录用户的可见范围……游客/未传调用上下文时 fail-closed 仅 public；空结果统一文案」与实现一致 |

### 5.2 FAIL 清单（文档口径，均**无需改代码**）

| ID | 缺陷 | 证据 | 判定 | 修正建议 |
|---|---|---|---|---|
| **D1** | **README API 表与代码矛盾**：`GET /api/agent/nodes` 标为「（公开）」，实际已 `requireUser`；`GET /api/agent/tools` 未标鉴权（现为登录） | `README.md:295`（`| GET | /api/agent/nodes | 节点列表（公开） |`）vs `routes.ts:807`（`requireUser`）；`README.md:286` vs `routes.ts:753` | **FAIL**（主动文档事实错误，且与同批 总览 `:259`、README `:164-165` 自相矛盾） | 把 `:295` 改为「节点列表（登录）」、`:286` 改为「工具列表（登录）」 |
| **D2** | **方案 AC3 的验收描述与实现方向相反**：原文要求「把用户加入子组 G2 后，该用户同样包含 `P_group`」，而实际语义是「上级组包含下级组」→ 属 G 的用户可见 G2 的文章，属 G2 的用户**不可见** G 的文章 | 方案 `:493-495` vs `account/service.ts:358-385`（仅向下递归）、`scripts/agent-visibility-e2e.mjs:254-259`（C∈G 命中 G2 文章）与 `:263-267`（D∈G2 不继承 G 的文章） | **FAIL**（AC 不可满足：按方案原文验收会得到与实现相反的结论，可能诱使后续误改代码/误判回归） | 把 AC3 后半句改写为「为 `G` 建子组 `G2` 并把用户加入 `G`：该用户**同样包含** `P_group` 的可见性来源为 G2 的文章」并明确「属 G2 的用户不继承 G 的文章（与 `parentId` 包含语义一致）」；或在 AC3 旁加注「方向：父组包含子组，非子组继承父组」 |
| **D3** | **方案文档自身状态行过期**：仍称「待评审 / 只做分析，不含代码改动」，结尾亦称「未改动任何代码」 | 方案 `:3`、`:599` | **FAIL**（作为被 总览/README 引用的权威交付文档，头部信息与实际状态相反） | 改为「状态：**已实施（2026-10）**，代码见 `packages/plugins/agent`、`packages/api`，验收见 `acceptance-report-完善④-Agent工具可见性.md`」；结尾注明「本方案已落地」 |
| **D4** | **总览内部行号不一致（声明已修行号漂移，但只修了一半）**：一致性状态 D 仍引用旧行号 | `需求功能总览.md:260` 写「`routes.ts:771-781`」（心跳实际 `:830`）、「`routes.ts:699-701`」（工具清单实际 `:753`）；模块⑤ 实现位置 `:250` 的 `:57-171`/`:198-266` 与现状有 1-2 行偏差（`runStream` 实际起于 `:197`） | **FAIL（轻）** | 把 `:260` 两个行号更新为 `:830` / `:753`；`:250` 微调为 `:97-169`（工具注册，`current_time` 起）、`:171-184`（runTool）、`:197-266`（runStream），或统一改为「见函数名」避免再漂移 |

### 5.3 次要观察（不影响交付，建议同批顺手修）

| ID | 观察 | 依据 | 建议 |
|---|---|---|---|
| O1 | **完善② 方案 Q9 未补注**：仍写「`GET /api/agent/nodes`、`GET /api/agent/tools` 是否保持公开 → **保持公开**」，与完善④ 收紧冲突且无「本项目已推翻」标注；同文件 §1.2 非目标 `:34` 亦仍写「仅记录为已知项，是否立项另议」 | `完善②…方案.md:303`、`:34`（对比 `:284`/`:300` 已补注） | 在该两处各加一句「→ 已于完善④ 改为 `requireUser`（见完善④方案 Q1/Q2）」 |
| O2 | **脚本存在 1 条恒真断言 + 1 条前置断言计入总数**：`check('AC5-4：单工具直调入口已覆盖…', true)` 永远 PASS | `agent-visibility-e2e.mjs:296`、`:182` | 建议从计数中排除或改为对 4 入口实际响应状态的真断言（如断言 4 入口均非 401/404 且有工具事件） |
| O3 | **清理的口号与任务维度不符**：`AgentTask` 无删除接口，脚本「自建自清」在任务上不成立（实测残留 1 条 error 任务）；另文章删除为软删除，落盘仍留 `deletedAt` 记录 | 临时实例落盘核实；无 `DELETE /api/agent/tasks/:id` 路由 | 脚本头部注明「任务记录无法清理，接受残留」；或后续补任务删除接口 |
| O4 | **无 LLM 时 AC5-1「会话落库消息无越权内容」为真空 PASS**（无内容生成自然无泄露） | 本次实测该断言 PASS 但 LLM 为 SKIP 状态 | 建议把该断言与链路断言绑定：仅在链路非 SKIP 时计入，避免统计口径虚高 |
| O5 | **未登录访客看到空的工具徽标行**：`loadTools()`/`loadNodes()` 在 `onMounted` 中无条件调用，401 被 `catch {}` 静默吞掉 | `AgentPanel.vue:275-277`（无 `loggedIn` 守卫）、`:290`（徽标行未按 `loggedIn` 门控）、`:59-68`/`:70-79`（catch 吞掉） | 方向与收紧一致、无安全影响；可选：`onMounted` 内加 `if (loggedIn.value)`，保持 R6 描述的「静默为空」不再发生 |

---

## 6. 旁证：`packages/server/data/plugins.json` mtime 变化的归因（非代码问题）

| 证据 | 内容 |
|---|---|
| 该文件被 git 忽略 | `git check-ignore -v` → `.gitignore:3:data/`（`packages/server/data/plugins.json`、`knowledge.db` 均命中） |
| 有 dev server 在跑 | 端口 3000 由 PID 18752（node）监听，进程启动时间 `2026/10/13 11:31:46`（本地） |
| 文件 mtime 与 dev server 启动吻合 | `plugins.json` LastWriteTimeUtc `2026-10-13T03:31:47.28Z` = 本地 `11:31:47`，即 dev server 启动后约 1 秒被 registry 重写（`plugin-registry` 在 `dataDir/plugins.json` 落盘，`plugin-registry/src/index.ts:40-41`） |
| 旁证：DB 被占用 | 同一目录 `knowledge.db` 被其它进程独占（`Get-FileHash` 报「正由另一进程使用」），进一步说明 dev server 常驻且使用 sqlite |
| **我的验收未触碰仓库 data/plugins** | 验收前后对 `packages/server/data` 与 `plugins/` 全量文件（路径+大小+mtime+SHA256）快照比对：`Compare-Object` 输出**为空**（完全一致）；临时实例的 `./data` 全部落在系统临时目录 |

**结论**：`plugins.json` 的 mtime 变化可完全由在跑的 dev server（启动/重载时重写 registry 存储）解释，**与本次代码改动无关**。

---

## 7. 范围外越界项（单独指出）

| 项 | 说明 |
|---|---|
| `apps/web/src-tauri/Cargo.toml`、`docs/ai-delivery/acceptance-report-1.md` 在工作区被修改 | 与完善④ 无关的历史遗留改动（方案 `:7` 已声明不影响引用行号），本报告未评 |
| `docs/ai-delivery/完善⑤-插件签名体系-方案.md`（本次会话期间新增的未跟踪文件） | 属并行的**完善⑤**工作，非本次验收范围 |
| `.dsh/`、`dsh-browser-shots/`、`docs/deepseek-harness AI Agent 交付团队配置.md`、`docs/ai-delivery/完善④-P2lite-方案.md` | 工作区其它未跟踪产物，未纳入本次验收 |
| `web_fetch` SSRF、`knowledge_add` 写权限 | 方案 Q5/Q6 明确「本期只记录、另立 P2」；文档 `:378-380` 已如实记录 → **合规的延后项，非本次缺陷** |
| 历史会话 `steps[].toolResult` 不回溯（方案 R4） | 方案已记录为已知项，与代码现状一致 |
| AC7（Tauri 桌面真机） | 需真机手工验收，本次未实测（代码侧等价路径已核验，见 §3.2） |

---

## 8. 验收方法与环境（可复现）

1. **构建**：`pnpm -r --if-present build`（独立重跑 2 次，`exit 0`）。
2. **代码实证**：`grep`/`read` 取行号，覆盖 `agent/src/{types,index}.ts`、`api/src/routes.ts`、`apps/web/src/{components/AgentPanel.vue,lib/agentNode.ts}`、`knowledge/src/service.ts`、`account/src/service.ts`。
3. **进程内 harness**（自建、仓库外）：真实 `knowledge` 服务 + 真实 `agent` 插件构建产物 + 假 LLM → 19 断言 FAIL 0。
4. **变异对照**（自建、仓库外）：修补构建产物临时副本还原核心行 → FAIL 8。
5. **真实 HTTP e2e**：隔离临时实例（`:3111`，临时 cwd + `PLUGIN_DIR`/`KB_STORAGE`/LLM 置空）跑仓库脚本 → PASS 33 / FAIL 0 / SKIP 3，退出码 0。
6. **隔离与还原**：验收前后仓库 `packages/server/data`、`plugins/` 快照比对为空差异；临时实例已停止（`:3111` 无监听）；临时变异目录已删除。
7. 全程**未修改仓库代码、未执行 git 写操作**（`git status --porcelain` 前后一致，仅新增本报告文件）。

---

## 9. 交付建议（给协调者）

1. **代码与功能：可交付，无需改动**（构建/类型/契约/安全过滤/4 入口覆盖均经独立实测）。
2. **本轮判定 FAIL 的唯一原因是文档**：建议派一次**纯文档修正**（D1-D4 共 4 处 + O1 可选），预计 10 分钟内完成；修正后无需重跑功能验收，只需复核文案与代码一致。
3. 建议在修正时顺带把「AC7 为 Tauri 手工项」「任务记录无法清理」两条写进方案/脚本头部（O2/O3），以免下一轮验收产生口径争议。
4. 按 AGENTS.md，**提交/合并/发布仍需用户明确同意**；本报告不代表已提交。

---

## 第 2 轮复验（文档修订复核）

> 复验时间：2026-10-13　复验范围：**仅复核第 1 轮报告中的 FAIL / 次要观察是否闭环**（协调者声明本轮为纯文档修订，未动代码）
> 复验方法：逐项重读取证（确认**新文案存在**、**旧文案已消失**、**与代码/实现一致**）；未重新执行功能验收（第 1 轮功能证据仍然有效，且本轮无代码改动）
> 复验手段：`grep`/`read` 定点取证；旧文案残留用「旧字符串全文检索」反查；涉及行号的用 `grep` 对照 `routes.ts` 实际行号
> 复验约束遵守：**未修改任何代码、未执行 git 操作**

### 1. FAIL 项闭环逐项判定

| ID | 第 1 轮要求 | 复验取证（新文案 / 行号） | 旧文案残留检查 | 与代码一致性 | 判定 |
|---|---|---|---|---|---|
| **D1/FAIL①** 方案 AC3 方向与实现相反 | 改为「父组包含子组」实际语义，含双向断言 | `完善④…方案.md:493-497`：标题改为「**AC3｜组可见性 + 父子递归（父组包含子组）**」；「C（属 `G`）**包含** `P_g2`（`visibleGroups=[G2]`）」；「反向断言：D 只加入子组 `G2`，检索 `P_group`（`visibleGroups=[G]`）→ **不包含**」；并注明「`effectiveGroupsOf` …即**父组包含子组**；子组用户**不继承**父组可见性」，引用 `account/service.ts:358-385` | ✅ 旧文案「该用户**同样包含** `P_group`」全文检索**已消失** | ✅ 与实现一致：`account/service.ts:358-385` 由 `children` 映射只向**子组**递归（父组展开出子组）；与 `scripts/agent-visibility-e2e.mjs:254-259`（C∈G 命中 G2 文章）及 `:263-267`（D∈G2 不命中 G 文章）一致；与 AGENTS.md「用户有效组 = 直接所属组 + 递归被包含的子组」一致 | **PASS（闭环）** |
| **D2/FAIL②** README API 表与代码矛盾 | `tools`/`nodes` 标注登录 | `README.md:286` → `工具列表（登录）`；`README.md:295` → `节点列表（登录）` | ✅ 旧文案「节点列表（公开）」全文检索**已消失** | ✅ 与 `routes.ts:753`/`:807` 的 `requireUser` 一致；与同文件 `:164-165`、总览 `:259` 不再自相矛盾 | **PASS（闭环）** |
| **D3/FAIL③** 方案自身状态行过期 | 状态改为「已实施」+ 验收报告链接；结尾注明已落地 | `完善④…方案.md:3` → 「状态：**已实施（2026-09-04）并验收通过**（功能/安全 PASS；验收报告：`docs/ai-delivery/acceptance-report-完善④-Agent工具可见性.md`）」；`:7` → 「行号基准：方案产出时的 `develop` 工作区（HEAD `d401630`）。**实施后行号可能漂移，一律以代码为准**」；`:600` → 「本方案为设计依据；已按此实施…行号以代码为准」 | ✅ 旧文案「待评审」「不含代码改动」全文检索**已消失**；`:7` 旧说法「本次只读取，未改动任何代码」已消失 | ✅ 状态与工作区实际一致（代码改动已落地、本轮验证通过） | **PASS（闭环；附新观察 N1 日期口径）** |
| **D4/FAIL④** 总览行号漂移未修 | `:260` 两处行号更新 | `需求功能总览.md:260` → 「`routes.ts:830`」（心跳）、「`routes.ts:753`」（工具清单） | ✅ 旧行号 `771-781`、`699-701` 全文检索**已消失** | ✅ `grep` 实测：`app.post('/api/agent/nodes/:id/heartbeat')` 在 `routes.ts:830`；`app.get('/api/agent/tools')` 在 `routes.ts:753` —— **行号准确** | **PASS（闭环）** |
| **O1** 完善② 未补注（Q9 + §1.2） | 两处各加「已于完善④ …」 | `完善②…方案.md:34` → 「**→ 已于完善④ 修复并关闭（2026-09-04），见 `…acceptance-report-完善④-Agent工具可见性.md`**」；`:303` → 「**→ 已于完善④ 改为 `requireUser`（2026-09-04，含前端 3 处补 `Authorization`）**」 | ✅ 两处原为无标注的「仅记录为已知项」「保持公开」，现已补注 | ✅ 「改为 `requireUser`」与 `routes.ts:753`/`:807` 一致；「前端 3 处补 `Authorization`」与 `AgentPanel.vue:61-63`/`:72-75`、`agentNode.ts:152` 一致（恰好 3 处） | **PASS（闭环；附新观察 N1 日期口径）** |

**结论：第 1 轮 4 项 FAIL 全部闭环，次要观察 O1 亦已闭环。**

### 2. 第 2 轮新发现的次要观察（**不构成 FAIL、不需第 3 轮功能复验**，建议顺手改）

| ID | 观察 | 证据 | 建议 |
|---|---|---|---|
| **N1** | **同一事件的日期口径不一致（本轮修订引入）**：新增标注用 `2026-09-04`，而 `总览` 与 `完善②` 同一事件原标注用 `2026-10` | `完善④…方案.md:3`/`:600`「2026-09-04」；`完善②…方案.md:34`/`:303`「2026-09-04」**但同文件** `:284`/`:300`「（2026-10）」；`总览` `:259`/`:377`「已修复 2026-10」。（`git log -1` 显示基线提交日期为 `2026-09-04`，本次验收实际日期为 `2026-10-13`） | 统一为与权威状态文档（`总览 :259/:377`）一致的「2026-10」（4 处：方案 `:3`/`:600`、完善② `:34`/`:303`），或全部改为精确日期 `2026-10-13`；避免同一文件内出现两个日期 |
| **N2** | **AC3 术语用词自相矛盾**：「只做**向上**展开『直接所属组 + 其递归子组』」中的「向上」与「递归子组」语义相反（实现是沿组树向**下**/向子组递归） | `完善④…方案.md:496`；实现见 `account/service.ts:366-383`（`children` 映射 + BFS 向子组展开） | 改为「只做**向子组**展开（沿 `children` 递归）『直接所属组 + 其递归子组』」——**注意：该句的同位定义与方向结论（父组包含子组、子组不继承父组）均正确，故仅属措辞瑕疵，不影响 AC3 判定** |

**其他复核结果（非缺陷）**：
- 方案内其余历史行号（如 AC4 的 `routes.ts:922-923/966-967`、§5 改动清单的旧行号）**未逐条更新**，但已由新增的 `:7`/`:600` 免责声明「行号以代码为准」覆盖，且该文档已标注为「设计依据」→ **不计为缺陷**。
- 残留检索命中 `完善②…方案.md:323` 的「未改动任何代码」，经核实是**完善② 文档描述自身范围的页脚**（与完善④ 无关）→ **误报，非缺陷**。
- 本轮为纯文档修订：`git status` 中代码文件（`packages/**/src/*.ts`、`apps/web/src/**`、`scripts/*.mjs`）**无新增改动**（与第 1 轮开工时一致）→ 第 1 轮的构建/HTTP e2e/harness/变异对照证据**继续有效**，无需重跑。

### 3. 未采纳的次要观察 → 确认列为「已记录待办」（**不计 FAIL**）

| 第 1 轮 ID | 内容 | 第 2 轮处置 |
|---|---|---|
| O2 | 脚本 `agent-visibility-e2e.mjs:296` 存在恒真断言（`check(..., true)`）计入总数 | ✅ 同意列为**已记录待办**（不影响本轮判定；建议后续改为对 4 入口的真断言） |
| O3 | `AgentTask` 无删除接口 → 脚本无法清理任务记录（残留 1 条），「自建自清」在任务维度不成立 | ✅ 同意列为**已记录待办**（无安全影响） |
| O4 | 无 LLM 时 `AC5-1 会话落库消息无越权内容` 为真空 PASS | ✅ 同意列为**已记录待办**（建议与链路 SKIP 状态联动） |
| O5 | 访客看到空工具徽标（`onMounted` 无 `loggedIn` 守卫 + `catch {}` 吞 401） | ✅ 同意列为**已记录待办**（方向与收紧一致，无安全影响） |
| （AC7） | Tauri 桌面真机等价性未自动覆盖（手工项） | ✅ 同意列为**已记录待办**（建议在方案 §10 / 脚本头部注明「AC7 为手工项」） |

### 4. 第 2 轮结论

> **PASS（4 项 FAIL 全部闭环；1 项次要观察 O1 亦闭环）**
> 第 2 轮无新增 FAIL。新发现 2 项**纯文案**次要观察（N1 日期口径、N2「向上展开」措辞），不影响任何 AC 判定、不阻塞交付，建议在后续任意一次文档改动中顺手修正（**无需第 3 轮复验**）。
> 代码侧自第 1 轮起未再变动，第 1 轮的功能与安全证据（构建 exit 0 ×2、HTTP e2e PASS 33/FAIL 0、进程内 harness 19/0、变异对照 FAIL 8、仓库数据零污染）**继续有效**。
> 交付结论：**完善④ 满足验收标准，可交付**；按 AGENTS.md，提交/合并/发布仍需用户明确同意。
