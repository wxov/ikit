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
│   ├── api/                   # fastify API：REST 路由 + WebSocket/SSE 桥接 + 静态托管
│   ├── server/                # 入口：组装 core + api，加载 .env，启动服务
│   └── plugins/
│       ├── demo/              # 最小插件示例：服务注入 + 事件总线
│       ├── llm/               # LLM 服务：chat（含 tools）/ chatStream（流式）/ embed（向量）
│       ├── knowledge/         # 知识库：CRUD + 混合检索 + 分类 + 评论 + 可见性 + 文档树 + 回收站
│       ├── agent/             # Agent 运行时：function-calling + 工具 + RAG + 流式 + 会话/节点/任务
│       ├── account/           # 账号体系：登录/找回/会话/用户管理/用户组
│       ├── plugin-registry/   # 插件注册表：内置插件 + 第三方插件包加载 + 插件商店
│       └── store-data/        # 商店插件真实数据：统计/便签/日历/待办/天气/RSS/MD 剪贴板
├── plugins/                   # 第三方插件包目录（plugin.json + entry 模块，PLUGIN_DIR 可配；示例 plugins/hello）
├── apps/
│   └── web/                   # Web 控制台（Vue3 + Vite，响应式，三端共用）
│       ├── src-tauri/         # Tauri 2 桌面端（Rust 壳）
│       └── capacitor.config.ts # Capacitor 移动端配置
├── docs/
│   ├── 需求功能总览.md        # 需求/功能主文档（现状事实基准 + 总索引）
│   ├── desktop-mobile.md      # 三端互联构建指南
│   ├── server-deploy.md       # 服务器部署指南（Docker）
│   └── …（PRD 与各需求文档）
├── scripts/
│   ├── e2e.mjs                # 基础端到端验证（过时，调用已删路由，修复列入完善阶段）
│   ├── agent-e2e.mjs          # Agent/RAG 验证（登录态 + chat-stream）
│   ├── agent-visibility-e2e.mjs # Agent 工具可见性验收（knowledge_search 越权，完善④）
│   ├── import-test.mjs        # 批量导入验证（登录态调用 /api/knowledge/import，需先准备 tmp-md/；可选 PARENT_ID 指定挂载父档）
│   ├── category-test.mjs      # 分类验证（过时，调用已删路由）
│   ├── deploy.ps1             # Windows 本地一键部署
│   ├── deploy.sh              # Linux/macOS 本地一键部署
│   ├── deploy-server.sh       # 服务器一键部署（Docker）
│   ├── update-server.ps1      # Windows 一键更新服务器
│   ├── update-server.sh       # Linux/macOS 一键更新服务器
│   └── build-web-update.mjs   # 热更新分发包生成
├── Dockerfile                 # Docker 多阶段构建
├── docker-compose.yml         # Docker Compose 编排（映射 80:3000）
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

# 2d. 草稿可见性（可选；完善⑦，默认 admin-only = 草稿仅站主可见）
$env:KB_DRAFT_VISIBILITY = "admin-only"   # admin-only | everyone
#    everyone = 回滚为「草稿全员可见」（历史行为），一句话逃生门

# 2e. 存量草稿迁移（可选；完善⑦，默认 publish）
$env:KB_MIGRATE_DRAFT_STATUS = "publish"  # publish | off
#    publish = 启动时把「本功能上线前创建的历史 draft」一次性改判为 published
#              （幂等：标记写在存储的 meta.draftPublishV1；写前自动备份 <存储文件>.bak-<时间戳>）
#    off     = 跳过迁移（不写标记、不备份），便于日后手动开启

# 2f. 插件签名（可选；完善⑥，默认 warn = 验签但不拒装）
$env:PLUGIN_SIGNATURE_MODE = "warn"        # off | warn | enforce
#    off     = 不验签、不写签名字段（完全等价本功能上线前）
#    warn    = 验签 + 状态/日志/徽标，不拒装（默认）
#    enforce = 未签名 / 密钥未受信任 / 验签失败一律拒装（HTTP 400 + PLUGIN_SIGNATURE_*）
$env:PLUGIN_SIGNING_PUBKEY_FILE = "./.keys/plugin-signing.pub.pem"  # 信任公钥（文件形态）
#    也可用 PLUGIN_SIGNING_PUBKEY（PEM 单行 / base64 SPKI）或 PLUGIN_SIGNING_KEYS（JSON 多密钥/轮换）
#    keyId 由公钥派生（ikit- + sha256(SPKI DER)[:16]），无需手工填；私钥放 .keys/（gitignored，绝不入库）
#    完整流程见 docs/plugin-signing.md

# 3. 启动后端核心服务（http://localhost:3000）
pnpm dev

# 4. 另开终端启动 Web 前端（http://localhost:5173，自动代理到 3000）
pnpm dev:web
```

> 提示（完善⑦）：编辑器 Vditor 的运行时资源已本地化在 `apps/web/public/vditor/dist/**`（≈5.27 MB，入库），
> 由 `scripts/sync-vditor-assets.mjs` 幂等同步、并在 `apps/web` 构建前（`prebuild`）自动执行；
> 升级 `vditor` 版本后执行 `pnpm --filter @ikit/web sync:vditor` 重新同步即可。
> 前端类型检查：`pnpm --filter @ikit/web typecheck`（`vue-tsc --noEmit`，已串入 web 的 `build`）。

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

部署后访问 `http://<服务器IP>`（默认 80 端口，`docker-compose.yml` 映射 `80:3000`）。详细说明（含 HTTPS 反向代理、备份）见 [docs/server-deploy.md](docs/server-deploy.md)。

> LLM 默认指向 DeepSeek（`https://api.deepseek.com`，模型 `deepseek-chat`），任何 OpenAI 兼容接口均可通过 `LLM_API_BASE` / `LLM_MODEL` 切换。

> **⚠️ 发布前必做（完善⑦）**：把 `packages/plugins/knowledge/src/migrate.ts` 的 `DRAFT_PUBLISH_CUTOFF` 校正为**真实上线时刻**。
> 该常量是存量草稿迁移的截止时间护栏（只把 `createdAt < cutoff` 的历史 `draft` 改判为 `published`）；若仍为默认值
> `2026-10-20T00:00:00.000Z`（晚于实施日），**窗口期内新建的真实草稿会在下次启动被自动发布**（游客可见）。
> 改动该常量视为**数据迁移变更，需评审**；发布说明中请记录校正后的实际值与执行时间。

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

- **条目管理**：创建 / 列表（分页 + 可见性过滤）/ 更新
- **批量导入**：`importMany()`（站主）——一次写入多条（≤500），与 `create()` 同一构造逻辑（分类补全 / sortOrder / 向量化 / `knowledge:changed`），末尾单次落盘；前端支持选文件或整个文件夹导入（子目录 → 分类，顶层目录 → 标签），并可**选择 / 新建挂载父文档**（`POST /api/knowledge/import` 的 body 顶层 `parentId`，条目自带 `parentId` 优先）。挂载语义：子项挂到父档下、同级 `sortOrder` 追加末尾；条目未显式指定可见性时**继承父档可见性**；条目无分类时**继承父档 `category`**（仅导入路径填充）；父档不存在 / 已软删除 → `400 parent not found` 且**零写入**（校验先于写入）
- **混合检索**：Fuse.js 模糊搜索 + 停用词过滤的关键词子串匹配 +（配置 embedding 时的）向量余弦相似度，三者去重融合排序
- **文档树**：`parentId`/`sortOrder` 层级 + 拖拽排序/移动（moveDoc / reorder）+ 置顶（`pinned`）
- **分类**：路径式层级（如 `技术/前端`），从条目派生；添加分类（父级自动补全）+ 批量归类 + 计数
- **回收站**：软删除 → 恢复 / 彻底删除 / 清空
- **评论**：单条评论/回复 + 全站最新评论（列表过滤不可见文章）
- **可见性**：`visibility`（公开/仅登录/指定组/仅站主）+ `visibleGroups`，支持父子递归同步与批量设置
- **浏览计数**：`view()` 访问 +1（不可见文章不计数）
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
- **内置工具**：`knowledge_search`（RAG 检索，**检索范围 = 当前登录用户可见范围**：admin 可见全部含 `private`，登录用户为 `public`+`login`+自身有效组命中的 `groups`，游客/缺省仅 `public`）、`current_time`、`web_fetch`（网页抓取）；可选 `knowledge_add`（写库，需 `enableWriteTools`）
- **工具上下文**：工具 handler 可选第二参 `AgentCallContext { viewer?, userId? }`（由 API 层按调用者解析）：Agent 只负责把调用者身份交给工具，**工具需自行按 `viewer` 鉴权**；内置 `knowledge_search` 恒按调用者可见性过滤（缺省 fail-closed = 仅 `public`）
- **流式输出**：`runStream()` 逐 token 产出，工具调用与回答交替推送（SSE）
- **多会话**：会话创建/重命名/删除 + 消息持久化（三端共享；会话按 `ownerId` 账号隔离，会话/消息/chat-stream 均需登录，未登录 401、他人会话 404，见 [docs/需求功能总览.md](docs/需求功能总览.md) 模块⑤）
- **节点与任务**：桌面节点注册/心跳/在线判定 + 远程任务派发/轮询执行/回传（仅限自己名下节点）

新增一个 Agent 工具只需注册一个对象，后续机器人适配器、业务能力都可以照此扩展。

### Web 控制台

- **响应式三栏**：≥1200px 三栏；<1200px 单栏 + 左右侧栏收为抽屉（顶栏 ☰/◫ 开关）；<768px 移动端底部 Tab；≥1600px 宽屏自适应
- **Markdown 阅读**：markdown-it 渲染 + highlight.js 语法高亮（20+ 语言按需注册）+ 目录 TOC 跳转
- **编辑体验**：详情页内**就地可视化编辑**（Vditor IR 即时渲染：标题/正文/分类/标签/封面全字段，**无弹窗**）；「新建文章」与目录树「＋ 新建子文档」进入详情页草稿态，**首次自动保存即创建**；编辑过程**自动保存草稿**（防抖 2s + 最大等待 10s、失焦/切标签页/离开前落盘、失败退避重试、状态可见），手动「发布 / 撤回」双向；**草稿仅站主可见**；快捷键：`Ctrl+K` / `/` 搜索、`N` 新建（站主）、`Ctrl+S` 立即保存（编辑态）
- **Agent 对话**：流式逐字输出 + Markdown 实时渲染 + 工具调用轨迹 + 停止生成
- **多端同步**：REST 操作 + WebSocket 订阅变更，三端实时联动

### 三端互联（Web / 桌面 / 移动）

复用同一套 Vue 前端 + REST/WS 后端，通过 `VITE_API_BASE` 环境变量区分 API 地址：

- **Web 端**：相对路径（dev 走 Vite proxy，生产同源部署）
- **桌面端（Tauri 2）**：`apps/web/src-tauri`，构建时注入 `VITE_API_BASE=http://localhost:3000`
- **移动端（Capacitor）**：`capacitor.config.ts`，构建时注入局域网 IP

WebSocket 实时同步让三端联动（任一端的变更，其他端自动刷新）。详细构建步骤见 [docs/desktop-mobile.md](docs/desktop-mobile.md)。

## API 一览

> 鉴权：`Authorization: Bearer <token>`。标注「站主」= `requireAdmin`；「登录」= `requireUser`；未标注为公开或按可见性过滤。

### 通用
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/system/info` | 应用与插件信息 |
| GET | `/api/update/manifest` | 热更新清单（`?client=&platform=tauri/capacitor/web`） |
| GET | `/api/demo/hello?name=` | demo 插件服务 |
| GET | `/api/demo/status` | demo 计数 |

### 账号（auth）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录（`{username,password}`） |
| POST | `/api/auth/request-reset` | 请求重置密码（`{username}`） |
| POST | `/api/auth/reset-password` | 重置密码（`{resetToken,password}`） |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/logout` | 退出登录 |
| POST | `/api/auth/profile` | 修改资料（登录） |
| GET | `/api/auth/users` | 用户列表（站主） |
| POST | `/api/auth/users` | 创建用户（站主） |
| POST | `/api/auth/users/:id/disable` | 启用/禁用（站主） |
| DELETE | `/api/auth/users/:id` | 删除用户（站主） |
| POST | `/api/auth/users/:id/role` | 设置角色（站主） |
| POST | `/api/auth/users/:id/groups` | 设置所属组（站主） |

### 用户组（站主）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/groups` | 组列表 |
| POST | `/api/groups` | 创建组 |
| POST | `/api/groups/:id/parent` | 设置父组（组包含关系） |
| PATCH | `/api/groups/:id` | 重命名组 |
| DELETE | `/api/groups/:id` | 删除组 |

### 插件与商店
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins/visible` | 当前用户可见插件 |
| GET | `/api/plugins` | 全部插件（站主） |
| POST | `/api/plugins/:name/enable` | 启用/禁用（站主） |
| POST | `/api/plugins/order` | 排序（站主） |
| POST | `/api/plugins/:name/visibility` | 按组可见性（站主） |
| GET | `/api/plugin-store` | 商店列表（缺 sha256 的远端条目返回 `installable:false` + `blockedReason`；已装包附带 `scanWarnings`/`scannedAt`）。**签名**：顶层含 `signatureMode`（`off`/`warn`/`enforce`）与 `trustedKeyIds`；条目可选 `signatureStatus`（`unsigned`/`unverified`/`verified`/`invalid`/`unknown-key`，catalog/builtin 恒为 `undefined`）/`signerKeyId`/`signatureVerifiedAt`/`signatureError`/`signedAt`；`enforce` 下不可验签的条目返回 `installable:false` + `blockedReason` |
| GET | `/api/plugin-store/categories` | 商店分类 |
| POST | `/api/plugin-store/rate` | 评分/评论 |
| POST | `/api/plugin-store/install` | 安装（站主；`{name}` 沿用商店条目，或 `{name, packageUrl, sha256}` 直接远端安装；可选 `signature/keyId/signedHash/signedAt` 覆盖包内签名）。**远端来源必须携带 sha256**（缺失/格式非法下载前拒装、内容不匹配拒装；registry 来源还须 `version` 与包内 `plugin.json` 一致），失败响应含 `code`：`PLUGIN_SHA256_REQUIRED` / `PLUGIN_SHA256_INVALID` / `PLUGIN_SHA256_MISMATCH` / `PLUGIN_STORE_VERSION_MISMATCH` / `PLUGIN_SIGNATURE_REQUIRED` / `PLUGIN_SIGNATURE_MALFORMED` / `PLUGIN_SIGNATURE_KEY_UNKNOWN` / `PLUGIN_SIGNATURE_INVALID`；成功响应含 `scan` 与 `signature`（`{status,keyId,signedAt,verifiedAt?,error?,warning?}`） |
| GET | `/api/plugin-store/:name/export` | 导出第三方插件包 zip（站主；库中保存的签名会写回 zip archive comment，**不新增 zip 条目**） |
| POST | `/api/plugin-store/import` | 导入插件包 zip base64（站主，`{data, sha256?, signature?, keyId?, signedHash?, signedAt?}`）。本地导入**保持 sha256 可选**（管理员本机人工动作，缺省只 warn 放行、不做完整性校验）；请求体签名字段优先于 zip comment；响应含 `scan` 与 `signature` |
| POST | `/api/plugin-store/refresh` | 手动刷新远端市场目录源（站主） |
| POST | `/api/plugin-store/:name/update` | 更新（站主；远端来源与 install 同一把关点：必须 sha256 + 版本一致 + 签名策略一致），响应含 `scan` 与 `signature` |
| DELETE | `/api/plugin-store/:name` | 卸载（站主） |

> 排序交互：插件管理页（站主）支持拖拽排序，**拖动中即时预览**（列表与顶部功能 nav / 移动端 tabbar 同步变化），松手后提交、失败回滚；触控端可用条目上的 ⬆/⬇ 按钮排序。
>
> 安全扫描说明：`scanWarnings` 为**启发式提示，扫不到 ≠ 安全**，不构成安全保证；主责防线是「远端强制 sha256 + 仅站主可安装 + 二次确认」。
>
> 插件签名说明（ed25519）：签名对象是**文件树规范序哈希**（`sha256OfFileTree`），验签在**落盘前**完成；`PLUGIN_SIGNATURE_MODE=warn`（默认）只提示不拒装，`enforce` 才拒装（HTTP 400 + `PLUGIN_SIGNATURE_*`）。完整运维流程见 [`docs/plugin-signing.md`](docs/plugin-signing.md)。

### 插件签名快速上手（ed25519）
```bash
# 1) 生成密钥（私钥写入 gitignored 的 .keys/，**绝不入库/入日志**；stdout 只打印 keyId / .env 行 / 信任表片段）
node scripts/gen-plugin-key.mjs

# 2) 按 .env 行配置公钥（仅公钥，安全；私钥也可以走 CI Secret + --key-env）
#    PLUGIN_SIGNATURE_MODE=warn
#    PLUGIN_SIGNING_PUBKEY_FILE=./.keys/plugin-signing.pub.pem

# 3) 签名发包（回写 zip comment 并打印可粘贴进 registry.json 的条目片段；--dir 亦可，--zip 与服务器字节一致更推荐）
node scripts/sign-plugin.mjs --dir plugins/hello --out tmp/hello-signed.zip --registry-entry --version 1.0.0

# 4) 独立核验（无需私钥，第三方/CI 可复核）+ 与服务器树哈希对拍
node scripts/sign-plugin.mjs --verify tmp/hello-signed.zip --pub .keys/plugin-signing.pub.pem
node scripts/sign-plugin.mjs --zip tmp/hello-signed.zip --print-hash
```

> ⚠️ **发布者必读**：远端签名包的 **`registry.json` 条目必须携带 `signature/keyId/signedHash`**——
> 把第 3 步 `--registry-entry` 打印的整段字段粘进 `registry.json`（签名只写在 zip archive comment 里，
> 而**商店列表页只读 `registry.json`、读不到 zip comment**）。条目缺这几个字段时：列表按「**未签名**」
> 标注，且 `PLUGIN_SIGNATURE_MODE=enforce` 下安装请求在**下载之前**就被拒（HTTP 400
> `PLUGIN_SIGNATURE_REQUIRED`）。包已签名 + 条目已粘字段，两者缺一不可。`--verify` 退出码：
> `0`=verified/unsigned/unverified，`1`=invalid，`2`=用法或文件错误（详见
> [`docs/plugin-signing.md`](docs/plugin-signing.md) §4.4）。

### 商店数据（plugins-data）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins-data/statistics` | 统计 |
| GET/POST | `/api/plugins-data/notes`、`DELETE /api/plugins-data/notes/:id` | 便签（写=登录） |
| GET/POST | `/api/plugins-data/events`、`DELETE /api/plugins-data/events/:id`、`POST /api/plugins-data/events/:id/toggle` | 日程（写=登录） |
| GET/POST | `/api/plugins-data/todos`、`POST /api/plugins-data/todos/:id/toggle`、`DELETE /api/plugins-data/todos/:id` | 待办（写=登录） |
| GET | `/api/plugins-data/weather?city=` | 天气 |
| GET | `/api/plugins-data/rss?url=` | RSS |
| GET/POST | `/api/plugins-data/md`、`DELETE /api/plugins-data/md/:id` | MD 剪贴板（写=登录） |

### 知识库（knowledge）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/knowledge/entries?limit=&offset=` | 列表（分页，按可见性；**非 admin 不含草稿**） |
| POST | `/api/knowledge/entries` | 创建（站主）。`title` 与 `content` **不可同时为空**（空标题回落「未命名草稿」）；body 可选 `status:'draft'\|'published'`（缺省 `draft`）；草稿仅站主可见；**`status:'published'` 时标题与正文均需非空白，否则 400「发布前需填写标题与正文」（与 PATCH 一致）** |
| POST | `/api/knowledge/import` | 批量导入（站主，`{entries:[{title,content,tags?,category?}],parentId?}`，≤500 条，单次请求 bodyLimit 20MB）。**导入条目默认 `status:'published'`（导入即可见）**。`parentId` 为统一挂载父档（条目自带 `parentId` 优先）；父档不存在/已软删除 → `400 parent not found` 且零写入；有父档时条目空分类继承父档 `category`，可见性继承由 `importMany`/`buildEntry` 负责 |
| PATCH | `/api/knowledge/entries/:id` | 更新（站主）。body 可选 `status:'draft'\|'published'`（**发布 / 撤回**；`'archived'` 或非法值 → 400；`status:'published'` 时合并后的 title/content 均需非空，否则 400）；body 可选 `autosave:true` → **跳过 embedding 向量化**（自动保存路径）；空 `title` 回落原值 |
| POST | `/api/knowledge/entries/:id/view` | 浏览计数 +1 |
| GET | `/api/knowledge/entries/:id/comments` | 评论列表 |
| POST | `/api/knowledge/entries/:id/comments` | 发评论（登录） |
| DELETE | `/api/knowledge/comments/:id` | 删评论（作者/站主） |
| GET | `/api/knowledge/comments?limit=` | 全站最新评论 |
| POST | `/api/knowledge/entries/:id/move` | 移动文档（站主） |
| POST | `/api/knowledge/reorder` | 同级排序（站主） |
| DELETE | `/api/knowledge/entries/:id` | 软删除 → 回收站（站主） |
| POST | `/api/knowledge/entries/:id/toggle-pin` | 置顶（站主） |
| GET | `/api/knowledge/trash` | 回收站（站主） |
| POST | `/api/knowledge/trash/:id/restore` | 恢复（站主） |
| DELETE | `/api/knowledge/trash/:id` | 彻底删除（站主） |
| DELETE | `/api/knowledge/trash` | 清空（站主） |
| GET | `/api/knowledge/categories` | 分类树 |
| POST | `/api/knowledge/categories` | 添加分类（站主，父级自动补全） |
| POST | `/api/knowledge/batch-category` | 批量归类（站主） |
| PATCH | `/api/knowledge/entries/:id/visibility` | 可见性（站主） |
| POST | `/api/knowledge/batch-visibility` | 批量可见性（站主） |
| POST | `/api/upload` | 图片上传（站主，base64 ≤5MB）→ `/uploads/<file>` |

### Agent
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent/tools` | 工具列表（登录） |
| POST | `/api/agent/tools/:name/run` | 执行服务端工具（登录） |
| GET | `/api/agent/sessions` | 会话列表（登录，仅自己） |
| POST | `/api/agent/sessions` | 创建会话（登录） |
| PATCH | `/api/agent/sessions/:id` | 重命名会话（登录/归属） |
| DELETE | `/api/agent/sessions/:id` | 删除会话（登录/归属） |
| GET | `/api/agent/sessions/:id/messages` | 会话消息（登录/归属） |
| POST | `/api/agent/sessions/:id/chat-stream` | 会话内流式对话（SSE，登录/归属） |
| POST | `/api/agent/chat-stream` | 流式对话（SSE，登录） |
| GET | `/api/agent/nodes` | 节点列表（登录） |
| POST | `/api/agent/nodes/register` | 注册节点（登录） |
| POST | `/api/agent/nodes/:id/heartbeat` | 心跳（登录/归属） |
| DELETE | `/api/agent/nodes/:id` | 注销节点（登录/归属） |
| POST | `/api/agent/tasks` | 派发任务（登录，仅自己名下节点） |
| GET | `/api/agent/nodes/:id/tasks` | 节点待办任务（登录/归属） |
| GET | `/api/agent/tasks/:id` | 查询任务（登录/归属） |
| POST | `/api/agent/tasks/:id/run` | 执行任务（登录/归属） |
| POST | `/api/agent/tasks/:id/complete` | 回传结果（登录/归属） |

### LLM / 实时
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/llm/chat-stream` | 原始 LLM 流式（登录，SSE） |
| WS | `/ws` | WebSocket 实时事件流（`knowledge:changed`、`demo:greeted`） |

### 静态托管（生产同源）
| 前缀 | 说明 |
|---|---|
| `GET /` | 前端 dist + SPA 回退（非 `/api`、`/ws`） |
| `GET /uploads/<file>` | 上传文件 |
| `GET /update/<version>/<bundle>` | 热更新分发包 |

## 端到端验证

```bash
# 启动 server 后
# ⚠️ 过时脚本：scripts/e2e.mjs、category-test.mjs 仍调用已删除的旧路由
#   （如 DELETE /api/knowledge/categories、/api/knowledge/category-rename、/api/knowledge/search 等），
#   脚本修复已列入完善阶段，暂勿运行。
node scripts/agent-e2e.mjs              # Agent function-calling + RAG（需 LLM_API_KEY；默认用 admin/admin123 登录）
node scripts/agent-visibility-e2e.mjs   # Agent 工具可见性验收：knowledge_search 越权（完善④）
node scripts/import-test.mjs            # 批量导入验证：登录 → 扫描 tmp-md/ → POST /api/knowledge/import（可选 PARENT_ID=<父文档id> 挂到父档，缺省 = 顶层）
#   可用 BASE / ADMIN_USERNAME / ADMIN_PASSWORD 覆盖默认值；会自动创建并清理临时账号、用户组与文章；
#   涉及 LLM 的链路（会话/通用 chat-stream、tasks/:id/run）未配置 LLM_API_KEY 时记为 SKIP。

# Agent 流式对话测试（需先配置 LLM_API_KEY，且需登录态：POST /api/agent/chat-stream 要求 Authorization）
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"admin123"}' | jq -r .token)
curl -N -X POST http://localhost:3000/api/agent/chat-stream \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"现在几点了？"}'
```

## 后续规划

- [ ] 机器人平台适配器插件（QQ / 微信 / 飞书）
- [x] AI Agent 运行时插件（LLM 编排 + 工具调用 + RAG）
- [x] 流式输出（SSE）+ Markdown 实时渲染 + 停止生成
- [x] 知识库向量检索（embedding 可选接入，余弦相似度 + 关键词融合）
- [x] 树状分类 + 批量归类 + 回收站 + 置顶（单篇导出已随 18 条死路由移除）
- [x] 响应式布局（三栏/双栏/单栏抽屉 + 宽屏适配）
- [x] 数据量大时迁移 SQLite（JSON/SQLite 双后端，`node:sqlite` 零依赖，自动迁移）
- [x] 桌面端（Tauri）与移动端（Capacitor），复用同一套 API + WS 实现三端互联
- [x] 生产构建（`@fastify/static` 托管 Web dist，同源部署）
