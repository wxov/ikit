# i-kit

机器人 + Web 服务 + AI Agent 成套项目脚手架，基于 **Cordis** 插件架构（自研、只借 Cordis 这一层）。

已跑通的完整链路：**Cordis 核心服务 → fastify API（REST + WebSocket + SSE）→ Web 前端（三端可复用）**，包括功能完整的知识库插件与支持流式输出的 AI Agent 运行时。

## 技术栈

| 层 | 技术 |
|---|---|
| 插件核心 | [Cordis](https://github.com/cordiverse/cordis) 3.x（Koishi 4 同款） |
| API 服务 | Fastify 5 + `@fastify/websocket` + `@fastify/cors` + SSE 流式 |
| 前端 | Vue 3 + Vite 7（响应式三栏布局） |
| LLM | OpenAI 兼容接口（默认 DeepSeek，原生 `fetch`，无 SDK 依赖） |
| Embedding | OpenAI 兼容 `/embeddings`（默认 SiliconFlow `BAAI/bge-m3`） |
| 搜索 | Fuse.js 模糊 + 关键词子串 + 向量余弦（混合检索） |
| Markdown | markdown-it + highlight.js（按需注册语言，语法高亮） |
| 运行/构建 | pnpm workspace + tsx + TypeScript |

## 目录结构

```
i-kit/
├── packages/
│   ├── core/                  # Cordis 核心：创建 Context、注册内置插件、服务类型声明
│   ├── api/                   # fastify API：REST 路由 + WebSocket/SSE 桥接
│   ├── server/                # 入口：组装 core + api，启动服务
│   └── plugins/
│       ├── demo/              # 最小插件示例：服务注入 + 事件总线
│       ├── llm/               # LLM 服务：chat（含 tools）/ chatStream（流式）/ embed（向量）
│       ├── knowledge/         # 知识库插件：CRUD + 混合检索 + 分类树 + 回收站 + 批量归类
│       └── agent/             # Agent 运行时：function-calling 循环 + 工具注册 + RAG + 流式
├── apps/
│   └── web/                   # Web 控制台（Vue3 + Vite，响应式，三端共用）
│       ├── src-tauri/         # Tauri 2 桌面端（Rust 壳）
│       └── capacitor.config.ts # Capacitor 移动端配置
├── docs/
│   ├── desktop-mobile.md      # 三端互联构建指南
│   └── server-deploy.md       # 服务器部署指南（Docker）
├── scripts/
│   ├── e2e.mjs                # 基础端到端验证
│   ├── agent-e2e.mjs          # Agent/RAG 验证
│   ├── import-test.mjs        # 导入验证
│   ├── category-test.mjs      # 分类验证
│   ├── deploy.ps1             # Windows 本地一键部署
│   ├── deploy.sh              # Linux/macOS 本地一键部署
│   └── deploy-server.sh       # 服务器一键部署（Docker）
├── Dockerfile                 # Docker 多阶段构建
├── docker-compose.yml         # Docker Compose 编排
├── .env.example               # 环境变量模板
└── tsconfig.base.json
```

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置 LLM API Key（可选，不配置则 Agent 无法调用模型）
#    Windows PowerShell:
$env:LLM_API_KEY = "你的 DeepSeek/OpenAI 兼容 key"
#    也支持 LLM_API_BASE（默认 https://api.deepseek.com）、LLM_MODEL（默认 deepseek-chat）

# 2b. 配置 Embedding API Key（可选，启用知识库向量检索）
#     DeepSeek 不支持 embedding，默认指向 SiliconFlow（BAAI/bge-m3，注册送免费额度）
$env:EMBEDDING_API_KEY = "你的 SiliconFlow/OpenAI 兼容 key"
#    也支持 EMBEDDING_API_BASE（默认 https://api.siliconflow.cn/v1）、EMBEDDING_MODEL（默认 BAAI/bge-m3）

# 2c. 切换知识库存储为 SQLite（可选，数据量大时；默认 JSON）
$env:KB_STORAGE = "sqlite"
#    首次启动会自动从 JSON 迁移已有数据到 SQLite

# 3. 启动后端核心服务（http://localhost:3000）
pnpm dev

# 4. 另开终端启动 Web 前端（http://localhost:5173，自动代理到 3000）
pnpm dev:web
```

打开 http://localhost:5173 即可看到控制台：系统状态、AI Agent 对话（流式）、知识库管理。

### 生产模式（同源部署）

```bash
# 构建前端 + 启动后端（后端托管 Web dist，访问 http://localhost:3000）
pnpm build:prod
```

生产模式下后端通过 `@fastify/static` 托管前端构建产物（`apps/web/dist`），前后端同源，无需单独启动 Vite。前端构建产物缺失时自动退回纯 API 模式（可用 `WEB_DIST` 指定静态目录）。

### 服务器部署（Docker）

```bash
# 服务器上一键部署（Docker 多阶段构建 + 数据卷持久化 + 自动重启）
./scripts/deploy-server.sh
# 或手动：docker compose up -d --build
```

部署后访问 `http://<服务器IP>:3000`。详细说明（含 HTTPS 反向代理、备份）见 [docs/server-deploy.md](docs/server-deploy.md)。

> LLM 默认指向 DeepSeek（`https://api.deepseek.com`，模型 `deepseek-chat`），任何 OpenAI 兼容接口均可通过 `LLM_API_BASE` / `LLM_MODEL` 切换。

## 核心设计

### Cordis 插件机制

每个插件是一个对象，导出 `name` / `Config`（Schema）/ `apply`，通过 `ctx.set()` 注册服务、`inject` 声明依赖、`ctx.emit()` 广播事件：

```ts
// packages/plugins/demo/src/index.ts（最小示例）
import { Schema } from 'cordis'
import type { Context } from 'cordis'

export const name = 'demo'
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello from i-kit'),
})

export function apply(ctx: Context, config: Config) {
  ctx.set('demo', { hello: (name) => `${config.greeting}, ${name}!` })
}
```

### 知识库插件（RAG 数据源）

`packages/plugins/knowledge` 提供 `ctx.knowledge` 服务，功能完整：

- **条目管理**：CRUD + 批量导入（单个/多个 md 文件 + 文件夹，子目录自动映射为分类）
- **混合检索**：Fuse.js 模糊搜索 + 停用词过滤的关键词子串匹配 +（配置 embedding 时的）向量余弦相似度，三者去重融合排序
- **树状分类**：路径式层级（如 `技术/前端`），增删改（重命名含子分类级联）、父级自动补全、计数
- **批量归类**：勾选多篇 → 设置分类
- **回收站**：软删除 → 恢复 / 彻底删除 / 清空
- **置顶/收藏**：`pinned` 标记 + 排序置顶优先
- **导出**：单篇导出为 `.md`
- **持久化**：JSON（默认）/ SQLite（`node:sqlite` 零依赖，数据量大时切换，自动迁移）
- **事件广播**：`knowledge:changed` → WebSocket 实时同步多端

### LLM 服务插件

`packages/plugins/llm` 提供 `ctx.llm` 服务，零第三方 SDK 依赖：

- `chat()`：非流式 `/chat/completions`（含 `tools` 参数）
- `chatStream()`：流式（`stream: true`，逐 token 产出 + tool_calls 参数累积）
- `embed()`：`/embeddings` 文本向量化（默认 SiliconFlow `BAAI/bge-m3`）

### Agent 运行时插件

`packages/plugins/agent` 提供 `ctx.agent` 服务，通过 `inject: ['llm', 'knowledge']` 声明依赖，实现：

- **function-calling 循环**：用户消息 → LLM → 工具调用 → 执行 → 结果回填 → LLM → … 直到产出最终回答
- **工具注册**：`ctx.agent.registerTool({ name, description, parameters, handler })`
- **内置工具**：`knowledge_search`（知识库 RAG 检索）、`current_time`
- **流式输出**：`runStream()` 逐 token 产出，工具调用与回答交替推送（SSE）

新增一个 Agent 工具只需注册一个对象，后续机器人适配器、业务能力都可以照此扩展。

### Web 控制台

- **响应式三栏**：≥1200px 三栏 / 768–1200px 双栏+抽屉 / <768px 单栏+抽屉；≥1600px 宽屏自适应
- **Markdown 阅读**：markdown-it 渲染 + highlight.js 语法高亮（20+ 语言按需注册）+ 目录 TOC 跳转
- **编辑体验**：左编辑/右预览分屏、草稿自动保存、快捷键（`/` 搜索、`N` 新建、`Ctrl+S` 保存）
- **Agent 对话**：流式逐字输出 + Markdown 实时渲染 + 工具调用轨迹 + 停止生成
- **多端同步**：REST 操作 + WebSocket 订阅变更，三端实时联动

### 三端互联（Web / 桌面 / 移动）

复用同一套 Vue 前端 + REST/WS 后端，通过 `VITE_API_BASE` 环境变量区分 API 地址：

- **Web 端**：相对路径（dev 走 Vite proxy，生产同源部署）
- **桌面端（Tauri 2）**：`apps/web/src-tauri`，构建时注入 `VITE_API_BASE=http://localhost:3000`
- **移动端（Capacitor）**：`capacitor.config.ts`，构建时注入局域网 IP

WebSocket 实时同步让三端联动（任一端的变更，其他端自动刷新）。详细构建步骤见 [docs/desktop-mobile.md](docs/desktop-mobile.md)。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/system/info` | 应用与插件信息 |
| GET | `/api/demo/hello?name=` | 调用 demo 插件服务 |
| GET | `/api/agent/tools` | 列出 Agent 可用工具 |
| POST | `/api/agent/chat` | Agent 对话（`{ message, history? }`） |
| POST | `/api/agent/chat-stream` | Agent 流式对话（SSE） |
| GET | `/api/knowledge/entries?limit=&offset=` | 知识库列表（分页） |
| POST | `/api/knowledge/entries` | 创建条目 |
| POST | `/api/knowledge/import` | 批量导入（`{ entries: [] }`） |
| GET | `/api/knowledge/entries/:id` | 查询条目 |
| PATCH | `/api/knowledge/entries/:id` | 更新条目 |
| DELETE | `/api/knowledge/entries/:id` | 删除条目（软删除 → 回收站） |
| POST | `/api/knowledge/entries/:id/toggle-pin` | 置顶/取消置顶 |
| GET | `/api/knowledge/search?q=` | 搜索条目（混合检索） |
| GET | `/api/knowledge/categories` | 分类树 |
| POST | `/api/knowledge/categories` | 添加分类（`{ path }`） |
| DELETE | `/api/knowledge/categories?path=` | 删除分类（含子分类） |
| POST | `/api/knowledge/category-rename` | 重命名分类（`{ oldPath, newPath }`） |
| POST | `/api/knowledge/batch-category` | 批量归类（`{ ids, category }`） |
| GET | `/api/knowledge/trash` | 回收站列表 |
| POST | `/api/knowledge/trash/:id/restore` | 恢复条目 |
| DELETE | `/api/knowledge/trash/:id` | 彻底删除 |
| DELETE | `/api/knowledge/trash` | 清空回收站 |
| WS | `/ws` | WebSocket 实时事件流 |

## 端到端验证

```bash
# 启动 server 后
node scripts/e2e.mjs          # 基础链路（REST + WS）
node scripts/agent-e2e.mjs    # Agent function-calling + RAG
node scripts/import-test.mjs  # md 导入
node scripts/category-test.mjs # 分类树

# Agent 流式对话测试（需先配置 LLM_API_KEY）
curl -N -X POST http://localhost:3000/api/agent/chat-stream \
  -H "Content-Type: application/json" \
  -d '{"message":"现在几点了？"}'
```

## 后续规划

- [ ] 机器人平台适配器插件（QQ / 微信 / 飞书）
- [x] AI Agent 运行时插件（LLM 编排 + 工具调用 + RAG）
- [x] 流式输出（SSE）+ Markdown 实时渲染 + 停止生成
- [x] 知识库向量检索（embedding 可选接入，余弦相似度 + 关键词融合）
- [x] 树状分类 + 批量归类 + 回收站 + 置顶 + 导出
- [x] 响应式布局（三栏/双栏/单栏抽屉 + 宽屏适配）
- [x] 数据量大时迁移 SQLite（JSON/SQLite 双后端，`node:sqlite` 零依赖，自动迁移）
- [x] 桌面端（Tauri）与移动端（Capacitor），复用同一套 API + WS 实现三端互联
- [x] 生产构建（`@fastify/static` 托管 Web dist，同源部署）
