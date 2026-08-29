# AGENTS.md — i-kit 项目开发规范

本文档是 i-kit 项目的开发规范，**所有 AI 编码助手（及开发者）必须遵循**。

## 项目概述

i-kit 是一个「机器人 + Web 服务 + AI Agent」成套项目，基于 Cordis 插件架构：

- **后端**：Cordis 3.x 插件（llm / knowledge / agent / demo）+ fastify API（REST + WebSocket + SSE）
- **前端**：Vue 3 + Vite（响应式三栏，三端共用）
- **存储**：JSON（默认）/ SQLite（`node:sqlite`，数据量大时切换）
- **部署**：Docker + docker-compose（服务器 80 端口）

## 分支规范（重要，必须遵守）

| 分支 | 用途 | 规则 |
|---|---|---|
| `master` | 生产分支（当前服务器部署此分支） | **禁止直接提交**，只接受 release 的合并 |
| `release` | 打包发布分支 | **只做打包、发布、修复发布问题**，不接受日常功能开发 |
| `develop` | 开发分支 | **所有功能开发、bug 修复都在这里进行** |

### 开发流程

```
develop（日常开发）→ 功能完成/测试通过 → release（打包发布）→ 验证通过 → master（生产部署）
```

1. **开发**：始终在 `develop` 分支开发新功能、修复 bug
2. **发布**：develop 稳定后，合并到 `release` 分支进行打包、版本号更新、发布准备
3. **部署**：release 验证通过后，合并到 `master`，触发服务器更新

### 禁止事项

- ❌ 不要在 `master` 上直接开发或提交
- ❌ 不要在 `release` 上开发新功能（只做发布相关改动）
- ❌ 不要提交 `.env`、API key、私钥、服务器 IP 等隐私数据

## 技术栈

- 包管理：pnpm workspace（monorepo）
- 语言：TypeScript（strict），tsx 运行、tsc 构建
- 插件核心：Cordis 3.x（`ctx.set` 注册服务、`inject` 声明依赖、`ctx.emit` 广播事件）
- API：Fastify 5（`@fastify/websocket`、`@fastify/cors`、`@fastify/static`、SSE）
- 前端：Vue 3 + Vite 7，markdown-it + highlight.js
- LLM：OpenAI 兼容接口（默认 DeepSeek），原生 fetch，无 SDK

## 目录结构

```
packages/
  core/       # Cordis 核心装配 + 服务类型声明
  api/        # fastify API（REST + WS + SSE + 静态托管）
  server/     # 入口（组装 core + api，.env 加载）
  plugins/
    llm/      # LLM 服务（chat / chatStream / embed）
    knowledge/# 知识库（CRUD + 混合检索 + 分类 + 回收站 + 双存储）
    agent/    # Agent 运行时（function-calling + 工具 + RAG + 流式）
    demo/     # 最小插件示例
apps/web/     # Vue 前端（三端共用，Tauri/Capacitor 配置）
scripts/      # 部署/验证脚本
docs/         # 文档
```

## 常用命令

```bash
pnpm install                    # 安装依赖
pnpm dev                        # 开发后端（:3000）
pnpm dev:web                    # 开发前端（:5173）
pnpm -r --if-present build      # 全量构建 + 类型检查
pnpm build:prod                 # 生产构建（后端托管前端 dist）
./scripts/update-server.ps1     # 一键更新服务器（-Server 参数必填）
```

## 插件开发规范

新增一个插件遵循 Cordis 惯例：

```ts
// packages/plugins/xxx/src/index.ts
import { Schema } from 'cordis'
import type { Context } from 'cordis'

export const name = 'xxx'
export const inject = ['llm']  // 依赖的服务（可选）

export interface Config { /* 可选字段，带默认值 */ }
export const Config: Schema<Config> = Schema.object({
  // Schema 声明，字段用 .default() 提供默认值
})

export function apply(ctx: Context, config: Config) {
  ctx.set('xxx', service)          // 注册服务
  ctx.on('dispose', cleanup)       // 清理
}

export default { name, inject, apply, Config }
```

要点：
- 服务用 `ctx.set()`（`provide` 已弃用）
- 依赖用 `inject` 声明（可选依赖 `{ llm: { required: false } }`）
- 跨插件通信用 `ctx.emit()` / `ctx.on()`（共享 root lifecycle）
- 自定义事件类型在插件内 `declare module 'cordis' { interface Events {...} }`

## 注意事项

1. **隐私安全**：绝不提交 `.env`、`sk-` key、私钥、真实服务器 IP、密码。用环境变量/占位符替代
2. **类型检查**：提交前跑 `pnpm -r --if-present build` 确保 tsc 通过
3. **中文乱码**：PowerShell 脚本（.ps1）用英文输出，避免 GBK 编码问题
4. **SSH 传输引号**：多层 SSH 传输 JSON 时用 base64 编码，避免引号转义丢失
5. **Docker 端口**：服务器部署用 80 端口（标准 HTTP），本地用 3000

## 数据模型

知识库条目（`KnowledgeEntry`）：
- `id` / `title` / `content` / `tags[]` / `category?` / `pinned?` / `deletedAt?` / `embedding?`
- 分类用路径字符串（`技术/前端`），`/` 分隔层级
- 软删除用 `deletedAt`，回收站可恢复
