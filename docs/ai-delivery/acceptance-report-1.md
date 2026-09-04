# i-kit 测试验收报告（第 1 轮 · 回归 + 文档修正复核）

> 角色：测试验收工程师（dev-team QA）
> 验收对象：现有已实现功能回归验证 + 本轮「文档整理」修正准确性复核（**非功能开发验收**）
> 依据主文档：`docs/需求功能总览.md`（v1.0）

## 一、顶部信息

- **日期**：2026-09-04
- **基线构建**：`pnpm -r --if-present build` —— **PASS（exit code 0）**
  - Scope 11/12 个 workspace 项目（`@ikit/server` 无 `build` 脚本，用 tsx 运行，不参与构建；见 `packages/server/package.json:6-9`）。
  - tsc 类型检查全通过：`api / core / demo / llm / knowledge / agent / plugin-registry / account / store-data`。
  - `@ikit/web` `vite build` 通过（159 modules；dist 产出正常；仅有「chunk >500kB」常规体积警告，非错误）。
- **只读接口冒烟**：**未执行**。
  - 原因：`Test-NetConnection 127.0.0.1 -Port 3000` 返回 `False`（TCP connect failed），`curl.exe -s -m 3 http://127.0.0.1:3000/api/health` 无响应。3000 端口无在跑服务；按要求**不自行启动**会读写真实数据的服务器，故冒烟跳过，仅以构建 + 代码走查取证。
- **判定规则（四类）**：
  - `PASS`：功能/事实与总览、代码一致且可用（构建/走查有据）。
  - `DOC-GAP`：总览已如实标注的已知缺口/差异（搜索仅标题标签、Agent 会话无归属无鉴权、归档=按年月浏览、评分点赞等死字段、插件生态未实现项）——按现状记录，不视为缺陷。
  - `NOT-IN-SCOPE`：总览第五节「规划中（未实现）」项，不验收。
  - `FAIL`：真实缺陷（构建失败、总览描述与代码不符且未标注、本轮文档修正有事实错误等）。

---

## 二、逐模块验收

### 模块 ① 知识库内容管理

| 验收要点 | 状态 | 证据 |
|---|---|---|
| 站主可新建/编辑/删除文章，游客只读 | PASS | 新建 `POST /api/knowledge/entries`（`packages/api/src/routes.ts:474-492`，requireAdmin）；编辑 `PATCH :494`；软删 `DELETE :577`。 |
| 非站主点击编辑被拦截 | PASS | `apps/web/src/App.vue:215-219`（`openEditor` 判 `user.role !== 'admin'` 即 alert 返回）。 |
| 「导入文章」可用 | **FAIL** | 见「FAIL 清单」#1（`/api/knowledge/import` 已删，验收要点措辞过时）。 |
| 四级可见性在列表/搜索/卡片流/右栏/接口直读隔离（游客仅 public） | PASS | 判定核心 `isVisible`（`knowledge/service.ts:45-53`）；列表过滤 `:209`；分类树过滤 `:436-443`；接口直读传 viewer `routes.ts:461-472`。 |
| 父级设权限按 self/same/all 递归同步子文件 | PASS | `setVisibility`（`knowledge/service.ts:471-504`），`syncMode==='all'||'same'` 时 `collectDescendants` 递归；路由 `routes.ts:652-662`（`mode` 归一化 `:658-660`）。 |
| 系统面板可树形批量设可见性 | PASS | 组件存在：`SystemPanel.vue`、`ArticlePermissions.vue`、`EntryPermissionDialog.vue`（`apps/web/src/components/`）；批量接口 `POST /api/knowledge/batch-visibility`（`routes.ts:664-674`）。 |
| 评论：登录可发、作者/admin 可删、不可见文章评论不泄露 | PASS | 发评论 `POST .../comments` requireUser（`routes.ts:515-531`）；删 `DELETE /api/knowledge/comments/:id`（`routes.ts:532-543`，作者/admin 判定 `service.ts:566-578`）；不可见过滤 `listComments` `:521-531`、`listAllComments` `:556-564`。 |
| 封面上传 ≤5MB 且 `/uploads/<file>` 可访问 | PASS | `POST /api/upload`（`routes.ts:677-696`），`>5*1024*1024` 拒绝 `:684`；静态托管 `uploadsDir` 由 `server/src/index.ts:114` 注入。 |
| 回收站恢复/清空正常 | PASS | `GET /api/knowledge/trash`、`restore`、`purge`、`emptyTrash`（`routes.ts:596-624`）；软删/恢复/清空 `service.ts:276-286,350-379`。 |
| 评分/点赞/分享/摘要/版本历史确为残留（写路径已删） | PASS（按现状记录） | 字段残留 `types.ts:35-48`（rating/likes/summary/history/shareToken）；`routes.ts` 全文无 rate/like/share/summary/版本 restore 路由（与门户文档 §16 line 302 一致）。 |
| 归档确为按年月浏览视图（非「隐藏」） | PASS（按现状记录） | `ArchiveView.vue:29-38` 按 `updatedAt` 分「YYYY 年 M 月」展示全部非删除文章；`status='archived'` 无设置入口（`types.ts:34` 仅类型含该字面量）。 |

### 模块 ② 门户布局与全局导航

| 验收要点 | 状态 | 证据 |
|---|---|---|
| 三档响应式（≥1200 / 768–1199 / <768）切换正确 | PASS | `App.vue` 媒体查询：`@media(max-width:1199px)` `:885`（单栏 + 左右抽屉 transform 滑入 `:886-903`）、`@media(max-width:768px)` `:907`（顶栏 nav 隐藏 `:908`、底部 Tab 显示 `:914-925`）。 |
| Ctrl+K 聚焦搜索框 | PASS | `App.vue:342-346`（`onKeyShortcut` 监听 ctrl/meta+K → `searchInput.focus()`）。 |
| 分类/标签点击联动卡片流 + 目录，可一键清除筛选 | PASS | `PortalRight.vue:498`（`@category/@tag` → `onFilterCategory/onFilterTag`）；`ContentCardFeed.vue:154-163`（按 category/tag/query 前端过滤）；「✕ 清除」chip `:170-175` + `@clear`。 |
| 站主管理（系统/插件/商店/用户）仅 admin 可见 | PASS | `App.vue:485-492`（`SystemPanel/PluginSettings/PluginStore/UserManager` 均 `user?.role === 'admin'`）；底栏 admin nav `:505-514`。 |
| 搜索确为前端标题+标签过滤（非正文/向量） | PASS（按现状记录） | `ContentCardFeed.vue:158-162` 仅 `title.toLowerCase().includes(q) || tags.some(...)`；后端 `knowledge.search()`（`service.ts:381-429`）仅被 Agent `knowledge_search` 工具消费（`agent/index.ts:67`）。 |
| `CategoryTree.vue` 仍在用 | PASS（本轮修正项） | `CategoryTree.vue` 存在；`PortalRight.vue:4` `import CategoryTree`（右栏「分类」widget）。与门户文档 §14.2 修正后一致。 |

### 模块 ③ 用户体系与权限

| 验收要点 | 状态 | 证据 |
|---|---|---|
| 游客未登录仅见 public 文章与 guest 组插件 | PASS | `groupsOf`（`account/types.ts:54-58` 未登录 → `['guest']`）；`effectiveGroupsOf`（`service.ts:358-385`）；插件 `visibleFor`（`plugin-registry/service.ts:198-202`）。 |
| 自定义组父子包含关系生效；删除组子组上挂、组内用户回落 user | PASS | `setGroupParent` 防环 `account/service.ts:328-345`；`deleteGroup` 子组上挂 `:311-316`、用户回落 user `:317-323`。 |
| 插件可见性按组即时生效；admin 恒可访问 | PASS | `setGroups`（`plugin-registry/service.ts:234-241`）；`visibleFor` admin 短路 `:200`；`resolveRole`/`resolveViewer`（`routes.ts:109-116,275-288`）。 |
| `/api/auth/users`、`/api/groups`、`/api/plugins` 非 admin 返回 403 | PASS | `requireAdmin` 403（`routes.ts:86-95`）；`GET /api/auth/users` `:175`、`GET /api/groups` `:227`、`GET /api/plugins` 手写 403 `:291-294`。 |
| `groups/:id/parent`、`auth/profile`、`effectiveGroupsOf` 存在 | PASS | `POST /api/groups/:id/parent` `routes.ts:240-250`；`POST /api/auth/profile` `:158-172`；`effectiveGroupsOf` `account/service.ts:358-385`。 |

### 模块 ④ 插件系统

| 验收要点 | 状态 | 证据 |
|---|---|---|
| STORE_CATALOG 7 条目 | PASS | `plugin-registry/service.ts:25-110`：stats/notes/calendar/todo/weather/rss/mdclip 共 7。 |
| install/uninstall/update/rate 实现存在 | PASS | `service.ts:247-329`（rate `:247-261`、install `:291-308`、uninstall `:310-318`、update `:320-329`）；路由 `routes.ts:335-364`。 |
| 启停/排序/按组可见即时生效 | PASS | `enable` `service.ts:204-217`（联动 loader 热装/热卸）、`setOrder` `:223-232`、`setGroups` `:234-241`。 |
| `agent` 为内置默认插件不可卸载 | PASS | `plugin-registry/index.ts:35-46`（defaults 仅 agent，`builtin:true`）；`uninstall` 内置拒绝 `service.ts:314`。 |
| 第三方包加载 + `plugins/hello` 示例存在 | PASS | `loader.ts:58-143`（扫 pluginDir、动态 import、`sanitizeManifest`）；示例 `plugins/hello/plugin.json` + `plugins/hello/index.ts`（`ctx.set('hello')` + `dispose`）。 |
| 插件导出/导入、真实市场、安全扫描、拖拽预览 | DOC-GAP（已立项） | 未实现，总览模块 ④ B + 第六节 item 3 已标注；代码无对应实现。 |

### 模块 ⑤ AI Agent 多节点与三端互通

| 验收要点 | 状态 | 证据 |
|---|---|---|
| 会话/节点/任务/工具/SSE 路由存在 | PASS | `routes.ts:699-932`：工具 `:699-710`、会话 `:713-734`、节点 `:736-764`、任务 `:767-830`、会话 SSE `:833-868`、通用 SSE `:871-893`、LLM 原始流式 `:896-932`。 |
| 会话数据模型无 ownerId（与总览标注一致） | PASS（按现状记录） | `agent/types.ts:36-41`（`AgentSession` 仅 id/title/createdAt/updatedAt）；会话与 chat-stream 路由无 `requireUser`（`routes.ts:713-734,871-893`）。 |
| 多会话/节点心跳/远程任务 ownerId 校验 | PASS | 会话 CRUD `agent/index.ts:243-281`；心跳 `:350-357`；派任务仅自己名下节点 `routes.ts:767-787`（`node.ownerId !== user.id` 403 `:777-779`）。 |
| 桌面本地工具（白名单/受控文件） | PASS | 前端本地工具 `apps/web/src/lib/agentNode.ts:75-116`（文档引用）；桌面原生命令 `apps/web/src-tauri/src/lib.rs`。 |
| 接口命名偏差（heartbeat 带 :id、tools 无参） | PASS（按现状记录） | `POST /api/agent/nodes/:id/heartbeat` `routes.ts:757-760`；`GET /api/agent/tools` 无参数 `:699-701`。与总览模块 ⑤ D 标注一致。 |
| 显式计划阶段 / computer-use / 任务实时推流 | NOT-IN-SCOPE | 总览第五节 + 模块 ⑤ B 标注「未实现/暂缓」。 |

### 模块 ⑥ 数据扩展 store-data

| 验收要点 | 状态 | 证据 |
|---|---|---|
| 7 类数据接口存在 | PASS | `routes.ts:367-448`：statistics/notes/events/todos/weather/rss/md 共 7 类。 |
| 便签/日程/待办增删改（含 done 勾选） | PASS | `store-data/service.ts:40-111`（notes/events/todos + toggleEvent/toggleTodo）。 |
| 天气/RSS 第三方失败降级 | PASS | `weather` 失败返回默认对象 `service.ts:114-136`；`rss` 失败返回 `[]` `:139-156`。 |
| 统计计数（知识库条目为总数、未按可见性过滤） | PASS（按现状记录） | `statistics` `:27-38` 调 `knowledge.count()`（`knowledge/service.ts:431-434` 无 viewer 过滤）；与总览模块 ⑥ 说明一致。 |

### 模块 ⑦ 三端与桌面移动

| 验收要点 | 状态 | 证据 |
|---|---|---|
| API 基地址 VITE_API_BASE / apiUrl / wsUrl 适配三端 | PASS | `apps/web/src/lib/config.ts:5-15`（`API_BASE`/`apiUrl`/`wsUrl`）。 |
| 更新检测 → 确认 → 进度 → 应用链路 | PASS | `update.ts:23,32`（`detectPlatform`/`fetchUpdateManifest`）+ `UpdateDialog.vue` + `App.vue:244-268`；后端 `/api/update/manifest` `routes.ts:29-74`。 |
| Tauri/Capacitor 实际构建 | 未执行（环境依赖） | 见「待人工确认」。 |
| desktop-mobile.md 写 JDK 17 vs 仓库 jdk21 | DOC-GAP（待核实） | 见「待人工确认」（总览模块 ⑦ 已标注）。 |

### 模块 ⑧ 部署运维

| 验收要点 | 状态 | 证据 |
|---|---|---|
| docker-compose 端口 80:3000 | PASS | `docker-compose.yml:6`（`"80:3000"`）。 |
| 健康检查 | PASS | `docker-compose.yml:35-46`（node fetch `/api/health`，interval 30s/timeout 5s/retries 3）。 |
| 数据卷持久化 | PASS | `docker-compose.yml:32-33`（`ikit-data:/app/packages/server/data`）。 |
| SQLite 切换 + 首次迁移 | PASS | `server/src/index.ts:64`（`KB_STORAGE==='sqlite'`）；迁移 `knowledge/index.ts:57-100`（文档引用）。 |
| `.env.example` 键与 `server/src/index.ts` 实际读取一致 | PASS（本轮修正项） | 见「文档修正复核」#5。 |

---

## 三、文档修正复核

| # | 修正处 | 状态 | 证据 |
|---|---|---|---|
| 1 | README 目录结构含 7 插件 | PASS | `README.md:29-35`（demo/llm/knowledge/agent/account/plugin-registry/store-data）；第三方包目录 `:36`；与 `core/src/index.ts:59-68` 装配 7 插件一致。 |
| 2 | README API 表与 routes.ts 一致（抽查 5 条） | PASS | `POST /api/auth/profile`（README:209 ↔ routes:158）；`POST /api/groups/:id/parent`（README:222 ↔ routes:240）；`GET /api/knowledge/comments?limit=`（README:262 ↔ routes:545）；`POST /api/plugins-data/events/:id/toggle`（README:246 ↔ routes:398）；`POST /api/agent/tasks/:id/complete`（README:298 ↔ routes:824）。 |
| 3 | server-deploy.md 端口统一为 80 | PASS | `docs/server-deploy.md:48`（「访问 `http://<服务器IP>`（默认 80 端口，映射 `80:3000`）」）；反代/健康检查沿用 80（`:77,:91,:95`）。 |
| 4 | 门户文档 §14.2 CategoryTree 误述修正 | PASS | `docs/门户布局与功能改造需求文档.md:274`（「`CategoryTree.vue` **仍在用**（右栏分类 widget，`PortalRight.vue` 第 4 行 import）」）；代码 `PortalRight.vue:4` 佐证。 |
| 5 | `.env.example` 变量透传补齐 | PASS | `.env.example` 已含 `ADMIN_USERNAME/ADMIN_PASSWORD`(:23-24)、`APP_URL`(:25)、`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`(:28-33)、`PLUGIN_DIR`(:36)、`UPDATE_KIND/UPDATE_INSTALLER_URL(_TAURI/_ANDROID/_WEB)`(:39-43)；均被 `server/src/index.ts:49-97` 或 `routes.ts:49-59` 读取，键名一一对应。 |
| 6 | docker-compose 变量透传补齐 | PASS | `docker-compose.yml:10-31` 透传 LLM/Embedding/Update/Admin/SMTP/PLUGIN_DIR/WEB_DIST 全部变量。 |
| 7 | `apps/web/package.json` build:desktop 为占位符（无真实 IP） | PASS | `apps/web/package.json:9`（`VITE_API_BASE=https://<your-domain>`）；`build:mobile` `:10` 用局域网示例 `192.168.1.100`（非真实生产 IP）。 |
| 8 | 根 package.json description 乱码修正 | PASS | 根 `package.json:7`（「机器人 + Web 服务 + AI Agent 成套项目，基于自研 Cordis 插件架构；知识库、AI Agent、插件商店，三端同源。」，无乱码）。 |
| 9 | README §端到端验证「已删除旧路由」举例准确性 | **FAIL** | 见「FAIL 清单」#2（`/api/knowledge/categories` 的 GET/POST 仍存活，仅 DELETE 已删）。 |

---

## 四、FAIL 清单

1. **【低危·文档措辞】总览模块 ① 验收要点「站主可新建/编辑/删除/导入文章」的「导入」与代码不符且未标注。**
   - 出处：`docs/需求功能总览.md:134`；对照 `packages/api/src/routes.ts`（全文无 `/api/knowledge/import` 路由）、`apps/web/src`（无「导入」UI）、门户文档 §16（`门户布局与功能改造需求文档.md:302` 明确「import」列入「删除 18 条死路由」）。
   - 建议：删除「导入」措辞，或在验收要点标注「单篇导入已下线」。

2. **【低危·文档措辞】README §端到端验证将 `/api/knowledge/categories` 列为「已删除的旧路由」不准确。**
   - 出处：`README.md:318`（「…调用已删除的旧路由（`/api/knowledge/import`、`/api/knowledge/categories`、`/api/knowledge/search` 等）」）。
   - 事实：`GET /api/knowledge/categories`（`routes.ts:627`）与 `POST`（`routes.ts:631`）**仍存活**；仅 `DELETE /api/knowledge/categories`（`category-test.mjs:46` 调用）已删。`import`、`search` 两项表述正确。
   - 建议：将该例改为「`DELETE /api/knowledge/categories`」或直接删除该例，避免误判。

> 结论：无构建/功能级 FAIL；均为低危文档措辞漂移，不影响功能可用性。

---

## 五、待人工确认 / 无法验证

- **接口冒烟未执行**：3000 端口无在跑服务（`Test-NetConnection` False），按要求不自行启动读写真实数据的服务器。建议在本地开发实例存活时补跑：`/api/health`、`/api/system/info`、`/api/knowledge/entries?limit=3`、`/api/knowledge/categories`、`/api/plugins/visible`、`/api/agent/tools`、`/api/update/manifest`、`/api/plugins-data/statistics`。
- **Tauri/Capacitor 三端实际构建未执行**：本轮仅构建 Web 产物（vite build）。桌面/移动构建需 JDK/Android Studio 环境（`desktop-mobile.md`），不在本轮验收范围。
- **desktop-mobile.md 仍写「JDK 17」**：`docs/desktop-mobile.md:78`；仓库实际带 `jdk21/jdk-21.0.12.1+1/` 目录。总览模块 ⑦ 已标注「待核实（默认修正项由另一子代理处理）」，本轮未改 → 仍待确认/回改。
- **总览 v1.0 未回写已落地的修正**：模块 ②「CategoryTree D 项」、模块 ⑧「`.env.example` 缺键 D 项」、第六节 item 6「默认修正项落地」仍为「待落地/已批准」表述，而本轮修正已实际落地。按总览 §七「验收完成后结论回写本文」，建议后续同步这三处标注为「已落地」。
- **行号/措辞轻微漂移（非事实错误）**：总览模块 ⑧ docker-compose 健康检查行号引用 `:22-33`，实际为 `:35-46`（本轮补变量透传致行号后移）；README:172「768–1200px 双栏+抽屉」与总览模块 ②「768–1199 单栏+左右抽屉」措辞不一致（均指向 `App.vue` 同一 `@media 1199/768` 实现，以代码为准）。

---

*（本报告仅新增 `docs/ai-delivery/acceptance-report-1.md`，未改动任何代码/数据文件，未执行 git 操作，未读取 .env 真实密钥。）*

---

## 第 2 轮复验（文档修订复核 · 2026-09-04）

> 本轮为纯文档修订（未动代码），故未重跑全量构建（协调者明示「无需重跑」）。以下逐项对照代码/文件重新取证。

| # | 待复验项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 总览模块① 验收要点移除「导入」残留 | PASS | `需求功能总览.md:134` 现为「站主可新建/编辑/删除文章，游客只读；非站主点击编辑被拦截（App.vue:216-218）。（批量导入 /api/knowledge/import 已下线，见第四节）」。主句无「导入」能力表述；「批量导入」措辞准确（`scripts/import-test.mjs:34-38` 原为 `POST {entries:[]}` 批量导入多 md）；`/api/knowledge/import` 确已删（`routes.ts` 全文无此路由，门户文档 §16 `:302` 列入 18 条死路由）。 |
| 2 | README 端到端验证注释路由列举 | PASS | `README.md:318` 现为「…如 /api/knowledge/import、DELETE /api/knowledge/categories、/api/knowledge/category-rename、/api/knowledge/search 等」。与代码一致：import 删、`DELETE categories` 删（GET/POST 仍存 `routes.ts:627/631`）、category-rename 删、search 删；GET/POST categories 不再被误列为已删。 |
| 3a | 总览版本行 + 页脚 → v1.1 | PASS | `需求功能总览.md:5`「v1.1（第 1 轮验收回写）」；`:384` 页脚「现状事实基准 v1.1」。 |
| 3b | CategoryTree D 标注尾部回写 | PASS | `需求功能总览.md:163` 尾部新增「门户文档 §14.2 原文已于 2026-09 按代码改正。」 |
| 3c | 模块⑧ .env.example D 标注回写 | PASS | `需求功能总览.md:317` 改为「D（已修正 2026-09）：…已补齐 .env.example（16 键）并在 docker-compose.yml 透传。」（16 键 = 本轮新增的 ADMIN_*/SMTP_*/APP_URL/PLUGIN_DIR/UPDATE_* 共 16 个键，与 `.env.example` 实读一致）。 |
| 3d | 第六节第 6 项标 ✅ 已完成 | PASS | `需求功能总览.md:371`「6. ✅ 默认修正项落地（已完成 2026-09）：…」。 |
| 3e | 模块⑧ docker-compose 去掉漂移行号 | PASS | `需求功能总览.md:313` 改为结构性描述「docker-compose.yml（端口映射 "80:3000"，含 healthcheck: 段）」——已无 `:6`/`:22-33` 具体行号引用。 |
| 4 | README 响应式措辞 | PASS | `README.md:172`「≥1200px 三栏；<1200px 单栏 + 左右侧栏收为抽屉（顶栏 ☰/◫ 开关）；<768px 移动端底部 Tab」。与 `App.vue:885`（@media 1199px 单栏+抽屉 `:886-903`）、`:907`（@media 768px 底部 Tab `:914-925`）、总览模块② `:153` 一致。 |
| 5 | desktop-mobile.md JDK 前提 | PASS | `desktop-mobile.md:78`「JDK 17+（仓库根附带本地工具链 `jdk21/` 可直接使用）」。仓库确含 `jdk21/jdk-21.0.12.1+1/`。 |

## 第 2 轮结论

- **FAIL 清零**：第 1 轮 2 项 FAIL（「导入」措辞、README categories 列举）均已修正并通过复验。
- **5 项待复验全部 PASS**（含总览 5 处回写、README 2 处、desktop-mobile 1 处）。
- **次要观察（不影响验收，可后续微调）**：
  1. 总览 `:134` 的「见第四节」为宽松交叉引用——第四节表内（`:329-334`）为 6 条死字段，无「批量导入」独立行；该路由删除明细在门户文档 §16（`门户布局与功能改造需求文档.md:302`）与第四节前言（`:325`）体现。如需更精确，可改「见门户文档 §16」。
  2. 总览 `:45` README 定位表仍标「待修正（目录结构与 API 表过时…）」、`:297` 模块⑦ 仍标 desktop-mobile JDK「待核实（默认修正项由另一子代理处理）」——这两处标注在本轮修正（README 已重写、JDK 已改 JDK 17+）落地后已过时，属文档同步残留（非事实错误），建议后续一并回写。
- **验收结论：通过**。构建 PASS（第 1 轮已跑，exit 0）；只读冒烟因 3000 端口无在跑服务未执行（待本地实例存活补跑）；代码走查全模块通过；文档修正全部落地且复验通过、FAIL 清零。遗留仅为「接口冒烟未执行」与上述 2 处可选微调。
