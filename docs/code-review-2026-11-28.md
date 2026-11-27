# i-kit 项目 Code Review（2026-11-28）

> **评审基线**：`develop` @ `9a2538c`（版本 `0.2.13`）
> **范围**：`packages/*`（core / api / server / plugins）、`apps/web/*`、工程配置、部署与安全
> **方法**：目录与配置审阅 + 关键实现阅读 + 全仓模式扫描（`any`/日志/密钥/危险 API/XSS/越权/测试与 CI）
> **结论**：架构与插件边界清晰、安全意识较好；**主要短板在工程质量侧——零测试、无 CI、无 lint/format**，另有若干中等级别安全问题（SSRF、登录无失败锁定、默认弱密码）。

---

## 1. 总评

| 维度 | 评价 | 说明 |
|---|---|---|
| 架构 | 🟢 良好 | Cordis 插件化（`ctx.set`/`inject`/`ctx.emit`）边界干净；`plugin-registry` + loader 支持第三方插件真加载/热卸/回滚 |
| 安全 | 🟡 中等 | 无 RCE / 无 SQL 注入 / 无硬编码密钥；但存在 SSRF、登录无失败锁定、默认弱密码、第三方插件无沙箱 |
| 工程质量 | 🔴 偏弱 | **0 个测试文件、无 CI、无 ESLint/Prettier**；巨型文件多 |
| 代码风格 | 🟢 较好 | `strict: true`、`verbatimModuleSyntax`；中文注释详实，安全/迁移类注释质量高 |
| 文档 | 🟢 优秀 | `docs/` 与 `AGENTS.md` 持续同步，需求/技术/验收文档齐全 |
| 部署 | 🟡 中等 | Docker + compose + 域名白名单 + 下载中心已成型；版本号分散、迁移常量易忘 |

---

## 2. 工程目录与模块划分

```
packages/
  core/       Cordis 装配 + Context 服务类型声明
  api/        Fastify REST + WS + SSE + 静态托管（routes.ts 单文件 1508 行）
  server/     入口（组装 core + api，加载 .env）
  plugins/    llm / knowledge / agent / account / plugin-registry / store-data / shiguang / demo
apps/web/     Vue3 + Vite7（三端同源：Web / Tauri / Capacitor）
scripts/      部署与验证脚本
docs/         需求 / 技术 / 验收文档
```

**优点**
- 分层清晰：插件（领域服务）↔ API（HTTP 层）↔ core（装配）职责分明。
- 插件边界规范：`ctx.set` 注册服务、`inject` 声明依赖、事件走 `ctx.emit/on`。
- 密钥与本地数据隔离到位：`.gitignore` 已忽略 `.env`、`.keys/`、`/plugins/`、`data/`、`update/`、`tmp/`。
- 第三方插件供应链有防护：`sha256` 校验 + ed25519 签名（`off|warn|enforce`）+ 危险 API 静态扫描（警告级）。

**问题**
- **版本号分散在 7 处**：`package.json` ×3（root / server / web）+ `Cargo.toml` + `tauri.conf.json` + `build.gradle`（versionCode + versionName）+ `Cargo.lock`。发版手改易漏（本次发版已实际踩到：需逐文件 `Bump` 校验）。
- 根目录夹带非工程目录（`tmp/`、`jdk21/`、`dsh-browser-shots/` 已忽略，但仍存在于工作区，易误提交/误引用）。
- 工作区偶有「行尾幻影」改动（`apps/web/src-tauri/Cargo.toml` 长期显示 `M`），源于 LF/CRLF 混合。

---

## 3. 代码规范

**良好**
- TypeScript 严格模式（`strict`、`forceConsistentCasingInFileNames`、`verbatimModuleSyntax`）。
- 命名一致：插件 `xxxPlugin`、服务方法动宾式、前端 `lib/` 纯函数与组件分离。
- 注释质量高：安全/迁移/降级等关键决策有「为什么」而非「做了什么」。
- 前端 `vue-tsc --noEmit` 已串入 `apps/web` 的 `build`。

**待改进**
| 项 | 现状 |
|---|---|
| Lint / Format | **无** ESLint / Prettier / Biome / Stylelint 配置 |
| 行尾规范 | 有 `.gitattributes`，但 `Cargo.toml` 等文件仍出现幻影改动 |
| 日志 | `console.log(` **40 处**（多为启动/诊断日志），无日志级别与统一 logger，生产无法一键降噪 |
| 类型逃逸 | `any` 相关标注 **146 处**、`as any` **38 处**（97 个 ts/vue 文件），集中在 Fastify `req/reply` 与 markdown-it `tokens` |
| TODO 标记 | 大写 `TODO/FIXME/XXX/HACK` **0 处**（未使用标记约定；注：早期扫描的“18 处”为大小写不敏感误报，已修正） |

> 说明：PowerShell 默认按 GBK 读取 UTF-8 文件会在控制台显示乱码，**源码文件本身编码正常**（已用 UTF-8 读取复核，`.ts/.vue` 中 0 处乱码）。写脚本时请用 `[System.IO.File]::ReadAllText/WriteAllText(..., UTF8)`。

---

## 4. 代码质量

### 4.1 巨型文件（实测行数）

| 文件 | 行数 | 建议 |
|---|---|---|
| `packages/api/src/routes.ts` | **1508** | 按域拆分：`routes/agent.ts`、`routes/knowledge.ts`、`routes/plugins.ts`、`routes/account.ts` |
| `apps/web/src/App.vue` | **1562** | 抽出布局/导航/路由分发；`tab` 渲染改为组件注册表 |
| `apps/web/src/components/DocCuratorPanel.vue` | **1322** | 拆「会话列表 / 消息流 / 模型配置 / 审批卡片」 |
| `apps/web/src/components/ArticleEditView.vue` | **1294** | 拆「字段区 / 编辑器壳 / 保存状态 / 互链选择器」 |
| `apps/web/src/components/PluginStore.vue` | **761** | 拆「列表卡片 / 详情弹窗 / 风险确认」 |
| `apps/web/src/components/DocTree.vue` | **682** | 拆「树节点 / 批量栏 / 移动选择器」 |

### 4.2 测试与 CI

- **测试文件 0 个**（`*.test.ts` / `*.spec.ts` 全仓为 0），仅 `tmp/` 下存在一次性验证脚本（未纳入版本控制）。
- **无 CI**（无 `.github/workflows`、无 GitLab CI）。
- 后果：核心纯函数（`editorBlocks`/`editorBridge`/`markdown`/`docLinks`）与后端服务（校验、迁移、权限）缺少回归保护；本次会话多次依赖 `tmp/` 临时脚本做验证，成本高且不可复用。

### 4.3 输入校验

- 大量 `(req.body ?? {}) as X` + 手动 `reply.code(400)`，**未使用 Fastify JSON Schema**；字段类型/必填/边界（如 `shiguang` 密码长度、`polish` 正文长度）靠手写判断，易漏。
- 建议：为写接口补 JSON Schema（`schema.body`），统一错误结构 `{ error, code }`。

### 4.4 存储一致性

- JSON / SQLite 双实现抽象合理。
- **原子写不一致**：`shiguang` 用 `tmp + rename`；`store-data` 仍 `fs.writeFile` 直写，进程中断有半写风险。
- `node:sqlite` 属实验性 API（Node ≥ 20），升级 Node 需关注兼容性。

---

## 5. 框架使用

| 框架 | 使用情况 | 评价 |
|---|---|---|
| **Cordis 3** | 插件 `apply/inject/Config`，服务 `ctx.set`，事件 `ctx.emit/on` | 🟢 规范；`plugin-registry` 的 dispose 兜底、唯一 URL 绕 CJS 缓存、半注册清理处理细致 |
| **Fastify 5** | REST + WS + SSE + `@fastify/static` 同源托管 | 🟡 路由集中单文件、缺 schema 校验、无统一错误处理器 |
| **Vue 3 + Vite 7** | `<script setup>` + 组合式 API，三端同源 | 🟡 组件粒度偏大，部分状态跨组件透传（`inject`/`provide`）耦合较深 |
| **Vditor** | wysiwyg + 自研块手柄/斜杠/快捷键 | 🟡 复杂度高；已通过 `editorBridge` 收敛为「Markdown 事实源」，方向正确 |
| **存储** | JSON 默认 / SQLite 可选 | 🟡 见 4.4 |

---

## 6. 隐藏风险

### 6.1 P1（建议尽快处理）

| # | 风险 | 位置 | 说明 |
|---|---|---|---|
| 1 | **SSRF（服务端请求伪造）** | `packages/plugins/agent/src/index.ts:119`（`web_fetch`）、`packages/plugins/store-data/src/service.ts`（`rss(url)`） | 仅校验 `http/https` 前缀，直接 `fetch(url)`：**无主机白名单、不拒绝 loopback/私网/链路本地/云元数据（169.254.169.254）、不限制重定向、无响应体上限**。登录用户可通过对话或 RSS 面板令服务端请求内网资源 |
| 2 | **登录无失败锁定 / 限流** | `packages/plugins/account/src/service.ts:111-116` | `login` 仅校验密码后抛错，无失败计数、无冷却、无验证码；可被在线暴力破解（对比：拾光密码有 5 次 / 60s 限流） |
| 3 | **默认弱密码** | `packages/server/src/index.ts:73` | `ADMIN_PASSWORD ?? 'admin123'`：部署未设置 env 时即为弱口令；建议首次启动强制设置或拒绝默认值启动 |
| 4 | **第三方插件无沙箱** | `plugin-registry` loader | 插件与主进程同权限（可读环境变量/文件/网络）。已通过「签名 + sha256 + 扫描 + 仅可信来源」缓解，属**已知接受风险**，需在运营文档中持续强调 |

### 6.2 P2（建议排期）

| # | 风险 | 说明 |
|---|---|---|
| 5 | Token 存 `localStorage` | `apps/web/src/lib/auth.ts:28`；一旦出现 XSS 令牌即可被窃。可评估 `httpOnly` Cookie（需处理三端同源/跨端） |
| 6 | 迁移常量易忘 | `DRAFT_PUBLISH_CUTOFF` 为数据迁移语义，发版前必须人工复核，目前无自动化校验 |
| 7 | KaTeX 渲染 | `markdown-it-katex` 输出进入 `v-html`；需确认 KaTeX `trust` 保持 `false`（默认安全，切勿开启） |
| 8 | 无审计日志 | 站主/写操作（发布、删除、插件安装）无统一审计流水，事后追溯困难 |

### 6.3 已确认安全（避免误报）

- ✅ **无 RCE**：后端无 `child_process` 实际调用；`exec(` 命中均为 `RegExp.exec` 与 SQLite `db.exec` DDL。
- ✅ **无 SQL 注入**：`ALTER TABLE ... ADD COLUMN ${name}` 的列名来自硬编码白名单（`packages/plugins/knowledge/src/store.ts:87-94`）。
- ✅ **Markdown XSS 已缓解**：`markdown.ts:68` 设置 `html: false`（原始 HTML 被转义）；`DocTree.vue:98` 的 `highlight` 仅做 HTML 转义（不使用 `v-html` 注入未转义内容）。
- ✅ **无硬编码密钥 / IP**：全仓扫描 `sk-*`、`apiKey=` 无真实凭据；`.env` 等已忽略。
- ✅ **拾光密码设计良好**：scrypt + 随机盐只存哈希、解锁令牌仅存服务端内存（30 分钟）、连错 5 次锁 60 秒、改密失效旧令牌、支持站主重置。

---

## 7. 改进建议（按优先级）

### P1
1. **SSRF 加固**：`web_fetch` 与 `rss` 统一走安全抓取函数——协议白名单、DNS 解析后拒绝私网/loopback/链路本地/云元数据、重定向逐跳复检、响应体上限（如 2MB）、可选开关。
2. **登录失败限流**：账号 + IP 双维度计数与冷却（如 5 次 / 15 分钟），并记录失败审计。
3. **移除弱默认**：`ADMIN_PASSWORD` 未设置时拒绝启动或生成随机密码并打印一次。
4. **补 CI + 最小测试**：`pnpm -r build` + `vue-tsc` + 核心纯函数单测（`editorBlocks`/`markdown`/`docLinks`/服务校验），PR 必过。

### P2
5. **引入 ESLint + Prettier**（含 Vue 规则），并统一 `LF` 行尾（`.gitattributes` 覆盖全部源码）。
6. **拆分巨型文件**：`routes.ts`/`App.vue`/`DocCuratorPanel.vue`/`ArticleEditView.vue` 按域拆分。
7. **Fastify JSON Schema 校验 + 统一错误处理**，减少手写 400 分支。
8. **统一版本源**：脚本从单一 `version` 派生到 7 个位置并校验一致性；补 `CHANGELOG.md`。
9. **日志规范化**：抽 `logger`（级别 + 结构化字段），生产默认 `info`，去掉调试 `console.log`。
10. **存储原子写统一**：`store-data` 改为 `tmp + rename`。
11. **审计日志**：写操作（发布/删除/插件安装/权限变更）落审计表。

---

## 8. 附录：复核方法与数据

- 目录/配置：`pnpm-workspace.yaml`、`tsconfig.base.json`、`.gitignore`、根 `package.json`、`Dockerfile`/`docker-compose.yml`。
- 模式扫描（97 个 `.ts/.vue` 源文件，排除 `node_modules/dist`）：

| 指标 | 结果 |
|---|---|
| `any` 标注（`: any` / `<any>` / `any[]`） | **146** 处 |
| `as any` | **38** 处 |
| `console.log(` | **40** 处 |
| `TODO/FIXME/XXX/HACK`（大写） | **0** 处 |
| 原生 `window.confirm` | **0** 处（2026-11-28 已统一为应用内 `ConfirmDialog`） |
| 硬编码密钥 / 生产 IP | **0** 处 |
| 测试文件 | **0** 个 |
| CI 配置 | **0** 个 |
| Lint/Format 配置 | **0** 个 |

- 已核对实现：`markdown.ts`（`html:false`）、`knowledge/src/store.ts`（列白名单）、`account/src/service.ts`（登录校验）、`agent/src/index.ts`（`web_fetch`）、`store-data/src/service.ts`（`rss`）、`plugin-registry/src/{loader,service}.ts`（启停/卸载/回滚）。

---

---

## 9. 修复进展（逐项）

> 约定：每完成一项在此追加记录（日期 / 改动 / 验证 / 残余风险），并在上方对应条目标注 ✅。

### ✅ P1-1 SSRF 加固（2026-11-28）
- **新增** `packages/shared`（`@ikit/shared`）→ `safeFetchText()`：
  - 协议白名单（仅 http/https）；
  - DNS 解析后拒绝 loopback / 私网（10/8、172.16/12、192.168/16）/ 链路本地（169.254/16，含云元数据）/ CGNAT（100.64/10）/ 保留与多播段；IPv4-mapped IPv6 同样处理；
  - 重定向**手动逐跳**跟随（默认 3 跳），每跳重新做协议 + 地址校验；
  - 响应体流式读取上限（默认 1MB，可配）、超时（默认 15s）。
- **接入**：`agent` 的 `web_fetch`（1MB/15s）、`store-data` 的 `rss`（512KB/10s）。
- **验证**：`tmp/verify-ssrf.mjs` **21/21 PASS**（含 `file://`/`ftp://` 拒绝、127.0.0.1/169.254.169.254/localhost/10.x 拦截、公网 `example.com` 正常抓取、端到端 agent 工具与 RSS 均拦截内网）。
- **残余**：DNS 重绑定（TOCTOU）未彻底消除（需「按解析 IP 连接」）；`GET /api/plugins-data/rss` 仍是**公开接口**（无登录），建议后续加 `requireUser`。

### ✅ P1-2 登录失败限流（2026-11-28）
- **账号维度**（`account/src/service.ts`）：同账号 5 次失败 → 第 5 次即返回 `429 E_LOGIN_LOCKED`，锁 5 分钟；失败响应统一加 300ms 延迟（削弱枚举时序）；成功登录重置计数。
- **IP 维度**（`api` 登录路由）：同 IP 20 次失败 → 锁 10 分钟（429）；成功重置。
- **错误响应**：带 `code` 字段（`E_BAD_CREDENTIALS` / `E_USER_DISABLED` / `E_LOGIN_LOCKED`）。
- **验证**：`tmp/verify-auth-hardening.mjs` **13/13 PASS**（前 4 次 401、第 5 次 429、锁定期内正确密码也 429、其他账号不受影响、IP 限流、成功重置后可再失败 4 次）。
- **残余**：进程内计数，重启清零；多实例部署需外部存储（Redis）。

### ✅ P1-3 去除弱默认密码（2026-11-28）
- 未设置 `ADMIN_PASSWORD` → **随机生成**（`crypto.randomBytes(9).base64url`）并在启动日志打印一次；仅在「管理员不存在、首次 seed」时生效，不影响已有安装。
- 显式配置 `admin123` → 保留但打印**弱密码告警**（避免意外改写用户配置）。
- **验证**：`tmp/verify-auth-hardening.mjs` 中 P1-3 用例全部通过（随机密码可登录、admin123 被拒、显式弱密码告警且可用）。

### ✅ P1-4 CI + 最小测试（2026-11-28，覆盖仍待扩充）
- **测试**：`pnpm test`（Node 内置 `node:test` + `tsx`，零新增运行时依赖）。4 个测试文件、**28 个用例**：
  - `packages/shared/src/http.test.ts`（SSRF 地址判定与拦截）
  - `apps/web/src/lib/docLinks.test.ts`（链接分类/目标解析/草稿可见性）
  - `apps/web/src/lib/editorBlocks.test.ts`（分块/类型识别/转换/往返一致）
  - `packages/plugins/shiguang/src/service.test.ts`（密码/令牌/限流/条目 CRUD/无明文）
- **CI**：`.github/workflows/ci.yml`（pnpm install → `pnpm -r build` → `pnpm test`）。

### 🟡 P2-5 Token 存储：评估结论 + 缓解（2026-11-28）
- **结论：暂不改为 httpOnly Cookie**。原因：三端（Web/Tauri/Capacitor）共用同一套 `Authorization` 头与 WS 鉴权；改 Cookie 需同时引入 CSRF 防护、WS 握手鉴权改造与跨端登录态同步，收益/风险比不佳。**保留 localStorage**，改为「降低 XSS 影响面」：
- **已实现**（`packages/api/src/index.ts` 全局 `onSend`）：
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: same-origin`
  - `X-Frame-Options: SAMEORIGIN`
  - `Permissions-Policy: geolocation=(), camera=(), microphone=()`
- **已验证**：`curl -I /api/health` 返回上述四项。
- **待办**：CSP 需按前端实际资源（Vditor/KaTeX/内联样式/图片源）单独评估后以 Report-Only 起步；`httpOnly` 迁移列入后续架构议题。

### ✅ P2-6 迁移截止时间可配置 + 校验（2026-11-28）
- `migrate.ts` 新增 `resolveDraftCutoff(raw)`：支持 `KB_DRAFT_PUBLISH_CUTOFF` 覆盖（**发版不必改代码**）、规范化为 ISO；非法值**回退常量**并标记 `invalid-fallback`。
- 启动日志区分来源：env 覆盖打印实际值；非法值打印告警（含回退后的常量）。
- 测试 `migrate.test.ts`：常量可解析、**不得晚于当前时间**（防误设未来时间）、env 覆盖与非法回退。
- `.env.example` 补 `KB_DRAFT_PUBLISH_CUTOFF` 说明（含“修改等价于数据迁移变更，需评审”）。

### ✅ P2-7 KaTeX `trust` 显式固定（2026-11-28）
- `markdown.ts`：`md.use(markdownItKatex, { trust: false, throwOnError: false, strict: 'ignore' })`——markdown-it-katex 会把该对象**原样传给** `katex.renderToString`，显式固定可防未来升级/误改默认值引入 `\href`/`\htmlData` 注入面；同步修正 `env.d.ts` 的插件类型签名（支持第二参）。

### ✅ P2-14 `store-data` 原子写（2026-11-28）
- `store.ts` 改为 `tmp + rename`（与 `shiguang` 一致）；测试覆盖：保存可读回、无 `.tmp` 残留、损坏文件回退为空数据。

### ✅ P2-12 版本号一致性校验（2026-11-28）
- 新增 `scripts/check-versions.mjs` + `pnpm check:versions`：以**根 `package.json` version 为唯一权威**，校验 7 处（3×`package.json`、`Cargo.toml [package]`、`Cargo.lock`(ikit)、`tauri.conf.json`、Android `versionName` + `versionCode`）。
- `versionCode` 规则固定为 `major*10000 + minor*100 + patch`（0.2.13 → 213），脚本自动推导校验。
- 已接入 CI（`pnpm check:versions` 位于 build 之后、test 之前）；本地实测 `✓ 版本号一致：0.2.13（校验 7 处；versionCode=213）`。

### ✅ P2-11 Fastify JSON Schema 校验 + 统一错误处理（2026-11-28）
- `packages/api/src/index.ts` 新增 `setErrorHandler`：校验失败 → **400 + `code: 'E_VALIDATION'` + 可读 details**；其余错误保留 `statusCode`（5xx 记录日志、不泄露堆栈）。
- 已加 schema 的路由（6 个）：`POST /api/auth/login`、`PUT /api/shiguang/passcode`、`POST /api/shiguang/unlock`、`POST/PATCH /api/shiguang/entries`（复用 `shiguangEntrySchema`，type 用 enum）、`POST /api/agent/tools/:name/run`、`POST /api/plugin-store/install`（`anyOf` 兼容字符串/对象入参）。
- **验证**：`tmp/verify-schema.mjs` **10/10 PASS**（缺字段/短密码/缺 content/非法 type 均 400 `E_VALIDATION`；合法请求不受影响）。
- 待办：其余写接口逐步补 schema（按模块推进）。

### ✅ P2-13 日志规范化（2026-11-28）
- `@ikit/shared` 新增 `createLogger(scope)`：输出 `[ISO时间] [级别] [模块] 消息`；支持 `LOG_LEVEL=debug|info|warn|error|silent`（默认 info），非法值回退 info。
- **迁移 16 个文件、78 处 `console.*` → `log.info/warn/error`**（packages 服务端源码中除 logger 自身外已无 `console.*`）；新增 `@ikit/shared` 依赖：plugin-registry / knowledge / llm / account / shiguang / demo / server / api。
- 新增 4 个测试（阈值过滤、silent、非法值回退、输出格式）。
- **验证**：`LOG_LEVEL=warn` 启动临时实例 → **info 行 0 条、warn 行正常输出**；`pnpm test` 39/39。

### ✅ P2-8 写操作审计日志（2026-11-28）
- `@ikit/shared` 新增 `createAuditLog()`：**JSON Lines**（每行一条），默认 `./data/audit.jsonl`；`AUDIT_LOG_FILE` 覆盖、`AUDIT_LOG=off` 关闭；写入串行化（Promise 链）、失败只告警不影响请求、字段长度裁剪。
- API 挂载（`ApiMeta.audit`）：
  - `auth.login`（成功/失败，含 IP 与错误码）
  - `user.create` / `user.delete`
  - `knowledge.delete`（软删除）
  - `plugin.install`（成功/失败）/ `plugin.uninstall`
  - `shiguang.passcode.set` / `shiguang.passcode.reset`
- 记录字段：`ts / action / ok / user / ip / target / detail`。
- **验证**：`tmp/verify-audit.mjs` **14/14 PASS**（7 类动作均落盘，记录含时间/用户/IP/目标）。
- 待补：回收站彻底删除/清空、批量删除/移动、发布/撤回、权限与用户组变更、插件 update/import。

### 🟡 P2-10 拆分巨型文件（进行中：routes.ts 已完成第一步，2026-11-28）
- `packages/api/src/routes.ts`：**1648 → 1240 行**；抽出：
  - `routes/deps.ts`（`ApiRouteDeps`：requireUser/requireAdmin/tokenOf/audit/ipOf/actorOf 注入契约）
  - `routes/plugin-store.ts`（225 行：插件商店 + 商店插件数据，9 个 `/api/plugin-store*`）
  - `routes/shiguang.ts`（204 行：拾光 + AI 润色，10 个 `/api/shiguang*`）
  - 两个模块由 `routes.ts` 以 `registerXxxRoutes(app, ctx, deps)` 注册，**行为不变**（代码原样搬运）。
- **验证**：拆分后回归冒烟 **16/16 PASS**（插件商店 5 项、商店数据 3 项、拾光 8 项）；`routes.ts` 中旧路径引用为 0；`pnpm -r build` 通过；`pnpm test` 42/42。
- 后续：`App.vue`（1562）、`DocCuratorPanel.vue`（1322）、`ArticleEditView.vue`（1294）与 `routes.ts` 其余域（knowledge/agent/account）继续拆分。

### 待处理
- P2-9 ESLint/Prettier（依赖离线不可得，待网络可用时引入）；
- P2-10 其余巨型文件（前端组件 + routes.ts 其余域）；
- P2-11 其余写接口补 schema；
- P2-5 CSP（Report-Only）与 httpOnly 迁移评估；
- P2-8 其余写操作补审计。

---

*本文档为 2026-11-28 一次性评审记录；修复对应项后请更新本文件并标注处理结论。*
