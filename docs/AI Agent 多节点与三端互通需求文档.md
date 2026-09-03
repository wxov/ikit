# AI Agent 多节点与三端互通需求文档

> 版本：v0.5（阶段一~三完成；阶段四「远程派任务 + 桌面本地工具执行」已实施）
> 日期：2026-09
> 状态：阶段一~三完成；阶段四「远程派任务」（任务队列+派发+结果回传）与「桌面本地工具执行」（命令白名单 + 文件读写受控目录 + 节点本地循环）已实施；「桌面操控（computer-use：截屏 + 键鼠注入）」暂缓，作为独立大特性后置
> 参考：DeepSeek Harness（目标/子任务、浏览器与桌面操控、工具调用、会话持久化等能力）

---

## 1. 背景与现状

现有 `agent` 插件（`packages/plugins/agent`）为服务端单次问答型：
- function-calling 多步循环（maxSteps 10）
- 内置工具仅 `knowledge_search`（知识库检索）与 `current_time`
- SSE 流式输出；前端 `AgentPanel.vue` 单聊窗口
- **无会话持久化、无多会话、无跨端状态、无本地 agent**

目标：升级为「可持久化多会话 + 多步任务 + 丰富工具 + 三端互通」的 agent，支持服务端与桌面端双节点运行，移动端/Web 可远程操控。

## 2. 核心概念

- **Agent 节点（Node）**：一个可被连接的 agent 运行实例。
  - `server`：默认节点，运行在服务端（Docker），三端共享。
  - `desktop`：桌面 App（Tauri）内嵌本地 agent，可访问本机浏览器/文件/应用。
  - （`mobile` 本地节点暂缓，受移动端资源与权限限制。）
- **会话（Session）**：一轮或多轮对话的持久化记录，可跨端续聊。
- **远程派任务**：移动端/Web 选择目标节点，向它发起任务并实时观察执行过程。

## 3. 功能需求

### 3.1 会话层（多会话 + 持久化 + 三端共享）

- 多会话管理：新建/删除/重命名/切换会话列表。
- 历史持久化：以服务端为同步中心；桌面节点会话可同步回服务端。
- 同一账号登录后，Web / 桌面 / 移动端看到同一会话列表与历史，可接着聊。

### 3.2 工具层（参考 DSH）

- 保留 `knowledge_search`；新增 `knowledge_add`（写入知识库，站主/授权）。
- 新增通用工具（服务端节点）：浏览器控制（抓取/读取网页）、文件读写（受控目录）、命令执行（白名单/受限）、天气、当前时间等。
- 桌面节点额外工具（已实施）：`exec_command`（白名单命令，无 shell）、`read_local_file` / `write_local_file`（仅限 app-data 下 `agent-workspace` 目录，越界/绝对路径拒绝）。
- 桌面节点额外工具（暂缓）：操作本地应用（computer-use 风格，最高难度，后置）。

### 3.3 多步规划与过程可视化

- 每轮 agent 展示「计划 → 工具调用 → 工具结果 → 最终回答」全过程。
- 可选：长任务目标 + 子任务 todo（参考 DSH goal/todo），支持中断续跑。

### 3.4 三端互通 / 远程派任务

- 节点注册/发现/心跳：桌面节点上线后注册到服务端，三端可看到「可用节点」。
- 会话可绑定到指定节点；移动端可把任务派发给「桌面节点」或「服务端节点」。
- 执行过程通过 SSE/WebSocket 实时推流；桌面节点经服务端中转或局域网直连。

## 4. 数据模型（拟定）

```ts
AgentNode {
  id: string           // 节点唯一 id
  type: 'server' | 'desktop'
  name: string         // 显示名（如「我的电脑」）
  ownerId?: string     // 归属用户
  online: boolean
  lastSeenAt: string
}

AgentSession {
  id: string
  ownerId?: string      // 归属用户（可空=匿名）
  nodeId?: string       // 绑定的节点
  title: string
  createdAt: string
  updatedAt: string
}

AgentMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  steps?: { toolName, toolArgs, toolResult }[]
  createdAt: string
}
```

## 5. 接口（拟定）

- 会话：`GET/POST/DELETE /api/agent/sessions`、`GET /api/agent/sessions/:id/messages`
- 对话：`POST /api/agent/sessions/:id/chat-stream`（SSE，支持绑定 nodeId）
- 节点：`GET /api/agent/nodes`、`POST /api/agent/nodes/heartbeat`
- 工具：`GET /api/agent/tools?nodeId=`、`POST /api/agent/tools/:name/run`（登录鉴权，执行服务端工具，供节点本地循环复用）
- 任务：`POST /api/agent/tasks`（登录鉴权，仅能向自己名下节点派发）、`GET /api/agent/nodes/:id/tasks`、`GET/POST /api/agent/tasks/:id`、`POST /api/agent/tasks/:id/complete`
- 节点本地循环：`POST /api/llm/chat-stream`（登录鉴权，原始 LLM 流式，供桌面节点自行驱动 function-calling）

## 6. 关联影响清单

1. `agent` 插件：服务注册、会话/消息存储、工具注册机制（多节点）。
2. `api` 路由：会话/节点/流式接口，鉴权与多端一致。
3. 存储：新增 `agent_sessions` / `agent_messages`（JSON 默认，SQLite 兼容）。
4. 前端 `AgentPanel`：改为多会话 UI + 节点选择 + 过程可视化；三端复用。
5. 桌面端（Tauri）：内嵌本地 agent 运行时 + 本地工具 + 节点注册；需原生能力。
6. 权限：会话归属、工具执行权限（命令/文件/浏览器需白名单与授权）。
7. WebSocket/SSE：跨端实时推流与节点中转。

## 7. 实施阶段

```
阶段一（地基）✅ 会话持久化 + 多会话管理 + 三端共享历史（服务端存储 + 前端多会话 UI）
阶段二（工具）✅ 工具扩展（web_fetch 抓取网页、knowledge_add 写知识库[可开关]）+ 多步规划可视化（思考中/调用工具状态流）
阶段三（节点）✅ 桌面本地 agent 节点（前端节点客户端注册+心跳）+ 节点注册/发现/心跳接口 + 三端节点展示
阶段四（远程）✅ 移动端/Web 远程派任务到桌面节点（任务队列+派发+结果回传）+ 桌面本地工具执行（命令白名单 + 文件读写受控目录 + 节点本地循环）；桌面操控（computer-use）后置
```

每阶段完成即构建 + 类型检查 + 接口冒烟，并同步更新文档；完成前不自动提交/部署。

## 7.1 桌面本地工具执行（已实施）设计要点

- 节点客户端（`apps/web/src/lib/agentNode.ts`）轮询到任务后在**本地**跑 agent 循环：LLM 经 `POST /api/llm/chat-stream` 流式调用，工具分两类执行——本地工具走 Tauri 原生命令，服务端工具走 `POST /api/agent/tools/:name/run`。
- 本地工具（`apps/web/src-tauri/src/lib.rs`）：
  - `exec_command`：白名单命令（`ipconfig`/`whoami`/`systeminfo`/`tasklist`/`ping` 等），无 shell、按空白分词，禁止链式注入。
  - `read_local_file` / `write_local_file`：仅限 app-data 下 `agent-workspace` 目录，绝对路径与 `../` 越界一律拒绝；读取限 2MB。
- 安全：任务派发仅允许向自己名下的节点（`ownerId` 校验）；`/api/llm/chat-stream` 与 `/api/agent/tools/:name/run` 均需登录。

## 8. 验收标准

- [x] 多会话可新建/切换/删除，历史持久化，三端登录后看到同一会话并续聊。
- [x] agent 展示工具调用/结果/回答全过程（思考中/调用工具状态 + 工具步骤 + 最终回答）；显式「计划」阶段留作后续增强。
- [x] 工具扩展生效（浏览器/文件/命令/知识库读写，受限执行）——服务端 web_fetch/knowledge_add + 桌面 exec_command/read_local_file/write_local_file（受控目录）。
- [x] 桌面端可作为 agent 节点注册上线，三端可见；移动端可向桌面节点派任务并查看结果（过程实时推流留作后续增强）。
- [x] 权限与安全：命令/文件/浏览器工具白名单+授权，越权被拒（命令白名单 + 文件受控目录 + 任务归属校验）。
- [x] 构建 + 类型检查通过（`pnpm -r build` + `cargo check` 均通过）。
- [ ] 桌面操控（computer-use：截屏 + 键鼠注入）——经用户确认暂缓，独立后置，不在本目标范围。
