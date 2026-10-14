# 验收报告 · 完善⑦「详情页可视化编辑（Vditor）+ 全字段就地编辑 + 新建进详情页草稿流 + 自动保存/手动发布 + 草稿仅站主可见 + 存量迁移」

> **角色**：测试验收工程师（独立验收，**未改任何代码、未做任何 git 操作**）
> **验收对象**：`develop` 工作区现状（`HEAD = d401630` + 未提交改动）
> **权威依据**：`docs/ai-delivery/完善⑦-详情页可视化编辑-方案.md`（§0.1 已确认决策、§8 AC 列表、§12 阶段划分、文末实施记录 D1–D9）
> **验收时间**：2026-10-13
> **验收环境**：Windows / Node v24.15.0 / pnpm 10.33.2；临时实例 cwd 与数据目录均在 `%TEMP%\ikit-qa7\**`（**未触碰 `packages/server/data`、`plugins/`、`.env`**）
> **结论（第 1 轮）**：**FAIL（需修正后复验；功能主体已通过）** —— 自动化用例 **154/154 全绿**，但存在 **2 项必须修**（AC-24 未闭合、Vditor 资源被 `.gitignore` 排除且 2 处文档声称「入库」与事实不符）+ 1 项发布前硬性数据校正（`DRAFT_PUBLISH_CUTOFF`）。
> **结论（第 2 轮复验）**：**PASS** —— 6 项修正（N1/N2/N3/N4/D4/D7）全部独立复核通过，无阻塞项。详见文末「## 第 2 轮复验」。
> **结论（第 3 轮复验，聚焦 R2-1~R2-4）**：**PASS** —— 4 项全部闭环，无阻塞项。详见文末「## 第 3 轮复验」。
> **最终状态**：**PASS**（第 3 轮为准；第 1 轮 FAIL 仅作历史记录）。唯一遗留为与代码无关的发布流程项：校正 `DRAFT_PUBLISH_CUTOFF`（`README.md:129`）。

---

## 0. 结论摘要

| 维度 | 结果 |
|---|---|
| 全量构建 `pnpm -r --if-present build` | **exit 0**（11/12 workspace 项目含 build 脚本，全部通过；`@ikit/web` 含 `vue-tsc`） |
| `pnpm --filter @ikit/web typecheck` | **exit 0** |
| 服务层单测（dist 产物，桩计数） | **25 / 25 PASS** |
| 临时实例迁移（JSON 4 场景 + SQLite + 开关 + meta 透传） | **43 / 43 PASS** |
| 临时实例 HTTP 语义（JSON + SQLite 各一轮） | **86 / 86 PASS** |
| 静态核验（死代码 / 单点过滤 / 懒加载 / 更新入口） | 全部符合，**1 项新问题**（`.gitignore` 排除 Vditor 资源） |
| 前端可达性与 CSS 隔离 | 通过（`--check` exit 0；Vditor CSS chunk 裸元素选择器 **0**；反向隔离规则在 `style.css`） |
| 文档一致性 | 9 份文档均已同步，且与代码语义一致；**但 2 处断言 Vditor 资源「入库」与事实不符（N1）** |
| 偏差 D1–D9 判定 | 可接受 **7**（D1/D2/D3/D5/D6/D8/D9）/ 需修正 **2**（D4 低危、**D7 发布前必须校正**） |
| **新增问题（实施记录未列）** | **N1**：Vditor 资源被 `.gitignore` 排除（违背 Q4「入库」决策 + 2 处文档失真）；**N2**：AC-24「他端修改提示条」完全未实现 |

### 必须修 / 建议修 / 可忽略

**必须修（3）**
1. **N2 · AC-24 多端冲突提示条未实现**（方案 §4.8 + AC-24 明确要求；全仓 grep 0 命中）——AC 未闭合，实施记录却把 AC-24 列为「仅代码核验」，属结论失真。
2. **N1 · Vditor 资源实际未入库**：`.gitignore:2` 的 `dist/` 规则命中 `apps/web/public/vditor/dist/**`（`git ls-files apps/web/public` = 0），与已确认决策 Q4（入库）相悖，且 `README.md:101`、`docs/需求功能总览.md:133` 断言「入库」（`docs/门户布局与功能改造需求文档.md:321` 只陈述资源路径与同步方式，措辞本身没错，但同受「未入库」这一事实影响）。**二选一**：加 `!apps/web/public/vditor/dist/` 白名单（推荐，回到 Q4 决策），或明确改为「不入库、由 `prebuild` 生成」并同步修正相关文档。
3. **D7 · `DRAFT_PUBLISH_CUTOFF = 2026-10-20T00:00:00.000Z` 晚于实施日**：发布前必须由发布者校正为真实上线时刻，否则 2026-10-13 至 10-20 之间产生的**真实草稿会在下次启动被自动发布**（R10 窗口，方案自身要求发布前校正）。另见 §3-S1c 复现证据。

**建议修（4）**
4. **N3 · `POST` 携带 `status:'published'` 可绕过「发布前需填写标题与正文」**：实测空正文 / 纯空白正文 / 缺标题（回落「未命名草稿」）三种请求均返回 **201 且游客立即可见**（§3-S7）。注意：`ImportDocsDialog` 的父容器正是靠此路径以 `content:' '` + `status:'published'` 创建，闭合时需同时照顾客器场景。
5. **N4 · AC-10「恢复网络后自动重试」只覆盖退避窗口内**：`autosave.ts` 4 次重试（1/2/5/10s）用尽后进入 `error` 且**不再自动重试**，需用户点击状态条或产生新输入/失焦才会重试；长时间断网后的「自动回到已保存」未实现。
6. **D6 · `getCategories` 树结构未过滤（AC-21② 未闭合）**：实测游客仍能看到草稿独有分类**路径**（count=0，无内容泄露），见 §3-S5。方案 §5.2 明确「不改」，且已在 3 份文档记为已知偏差 → 可保留，但建议补一句「路径名可见」或改为按可见路径裁剪。
7. **D4 · `.env.example` 未写入两个新 env 键**：已按偏差说明写入 `README.md:85/89` 与 `AGENTS.md:151/153`，但 `.env.example` 仍是运维首查位置，建议并行改动落地后补上。

**可忽略（3）**
8. **D1/D2/D3**：资源目录 `public/vditor/dist`（`cdn='/vditor'` 派生路径决定，实测 7 个关键资源经 `:3000` 均 **200**）、白名单补 Lute 等 3 项（Lute 3.74 MB 为运行时必需，方案白名单本身有误）、版本标记 + `--check`（实测 exit 0 且不拷贝）——均为合理必要的偏差，且增强可审计性。
9. **无操作迁移也写备份/标记**：空库 / `drafts=0` 时仍会生成 `.bak-<ts>` 并写 `draftPublishV1`（实测 S1c 生成第 3 个备份）。无功能危害，仅多一个备份文件。
10. **服务层 `viewer` 可选导致 fail-open**：`list/search/view/getCategories/listComments` 在 `viewer === undefined` 时跳过过滤；但自查全仓调用点，非 admin 可达的 HTTP 路径**全部**传入 viewer，唯一无参调用 `routes.ts:579` 位于 `requireAdmin` 内（导入父档校验）→ 当前不可利用；建议后续把默认改成 fail-closed。

---

## 1. 构建（独立重跑）

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm -r --if-present build`（仓库根） | **exit 0** | 11/12 workspace 项目执行构建：`@ikit/core`、`@ikit/api`、`@ikit/plugin-{account,agent,demo,knowledge,llm,plugin-registry,store-data}` 的 `tsc -p tsconfig.json` 全通过；`@ikit/web` 通过（含 `vue-tsc`）；根 `i-kit` 与 `@ikit/server` 无 build 脚本 |
| `pnpm --filter @ikit/web typecheck` | **exit 0** | `> vue-tsc --noEmit -p tsconfig.json` |
| 构建日志关键行 | — | `apps/web build$ vue-tsc --noEmit -p tsconfig.json && vite build`（**证明 vue-tsc 已串入 build**，D8 属实）；`[sync-vditor] vditor@4.0.0 -> apps/web/public/vditor`；`copied=0 skipped=49 total=49 bytes=5530040 (5.27 MB)`（幂等）；`✓ 173 modules transformed` / `✓ built in 2.28s` |
| 产物体积 | — | `dist/assets/index-Cf_Qhege.css 110.91 kB`（门户主 CSS，首屏）、`dist/assets/index-DPKgrRxC.css 38.39 kB`（**Vditor CSS，懒加载 chunk**）、`index-BFxmVud7.js 298.52 kB`、`index-Dad_1X5I.js 555.78 kB` |

**AC-27 判定**：`apps/web/dist/vditor/dist/**` 存在，**49 文件 / 5,530,040 B**（与 `public/vditor/dist` 完全一致），但**体积 5.27 MB ≠ 方案估 ≈2 MB**（偏差 D2 已如实记录，原因 = 方案白名单漏了 3.74 MB 的 Lute）→ **通过（带已记录的体积偏差）**。

---

## 2. 静态核验

### 2.1 死代码（AC-28）
```
grep -rn "ArticleEditor|editorOpen|editingEntry|editingParentId|editor-overlay" apps/web/src  → 0 命中
Test-Path apps/web/src/components/ArticleEditor.vue                                            → False
```
全仓其它命中仅出现在**文档**中（描述「已删除」的历史），无源码残留。**通过**。

### 2.2 Vditor 集成
| 检查 | 结果 | 证据 |
|---|---|---|
| 懒加载（AC-1） | **通过** | 全仓仅 `lib/vditor.ts` 引用 vditor（`import('vditor/dist/index.css')` + `import('vditor')`，均为动态）；`dist/index.html` 只引用主 JS + 主 CSS，**未引用 Vditor CSS chunk** |
| `cdn='/vditor'` | **通过** | `lib/vditor.ts:16` `VDITOR_CDN = '/vditor'`；`VditorEditor.vue:93` `cdn: VDITOR_CDN` |
| `upload.handler` | **通过** | `VditorEditor.vue:120` `handler: uploadHandler`；handler 自行校验 `image/*` + ≤5MB、调用 `/api/upload`、**自行 `insertValue()`**（`:73`），返回字符串 = 错误提示，符合 Vditor 源码语义 |
| input 回调不 `getValue()`（性能红线） | **通过** | `VditorEditor.vue:125` `input: () => emit('input')`（只发信号）；正文只在 `readValue()`（`:178`）被调用，即保存时读一次；快照节流 500ms（`ArticleEditView.vue:97-113`） |
| 加载失败降级（AC-19） | **通过（静态）** | `failed` 分支渲染 textarea + 「点击重试」（`:192-204`），降级路径同样 `emit('ready')` 建立保存基线；`readValue/setValue` 走 fallback |
| 主题联动（AC-4） | **通过（静态）** | `App.vue:435 provide('theme', theme)`；`VditorEditor.vue:160-171 watch(theme) → setTheme` |
| 内建 cache 关闭 | **通过** | `cache: { enable: false }`（`:102`） |

### 2.3 自动保存（`lib/autosave.ts`）
| 要求 | 结果 | 证据 |
|---|---|---|
| 严格串行（单 in-flight） | **通过** | `chain = chain.then(...)`（`:93`）——所有保存排队；`flush()` 亦入队（`:140-143`） |
| rev 丢弃过期响应 | **通过** | 保存期间有新输入 → `rev > myRev` → `setState('dirty', {stale:true})`（`:111-113`）；且 `save()` 回调**从不回写编辑器内容**（`ArticleEditView.vue:118-161` 只同步 `status/emit`）→ 旧响应不可能覆盖正在输入的内容 |
| 4xx 不重试 | **通过** | `isRetryable()`：`ApiError.status >= 500 || === 429`（`:46-49`）；`ApiError` 携带 status（`lib/api.ts:51-58`，D9） |
| 退避重试 | 通过 | `retryDelays = [1000,2000,5000,10000]`，`maxRetries = 4`（`:54-55`） |
| unchanged 短路 | 通过 | `fp === lastFp → setState('saved')`（`:97-100`）+ 指纹排除 `updatedAt`（`ArticleEditView.vue:117`） |
| flush 触发点 | 通过 | `blur`（`VditorEditor:126`→`ArticleEditView:205`）、`visibilitychange`（`:411-416`）、`beforeunload`（`:418-425`）、`Ctrl+S`（`App.vue:492-498`）、离开编辑态/跳转（`App.vue:222-227` 的 `flushCurrent`）、发布前 flush（`:289`） |
| AC-10「失败后自动重试」 | **部分通过** | 重试只在一次 `attempt` 的退避窗口内；4 次用尽后无定时重试（见「建议修 N4」） |

### 2.4 `makeIsVisible` 单点改造覆盖（逐处证据）
| 读路径 | 位置 | 说明 |
|---|---|---|
| list | `service.ts:265` | `active.filter(e => isVisible(e, viewer))` |
| search（**Agent `knowledge_search` 同一入口**） | `service.ts:483`；调用方 `agent/src/index.ts:83` `ctx.knowledge.search(query, viewerOf(call))` | Agent 恒传 viewer → 过滤生效 |
| 分类计数 | `service.ts:495-497` | entries 先按 `isVisible` 过滤，再交给 `buildCategoryTree` 计数 |
| 详情 | `service.ts:394` | 不可见 → 返回 `undefined` |
| 浏览计数 | `service.ts:390-399` | 与详情同一处（不可见即不计数） |
| 评论列表 / 发表 / 全量评论 | `service.ts:581` / `:593` / `:617` | 均经 `isVisible` |
| **单点定义** | `service.ts:57-69` `makeIsVisible(draftVisibility)`；`:143` 注入；`:52-54` `isPublished = (status ?? 'published') === 'published'` | 与方案 §4.6.1 语义一致（fail-closed，`archived` 一并视为未发布） |

### 2.5 其它更新入口
| 检查 | 结果 | 证据 |
|---|---|---|
| 前端 7 处 GET 补 `authHeaders()` | **通过（实测 9 处）** | `App.vue:99`（categories）、`DocTree.vue:109`、`ContentCardFeed.vue:117`（view 计数）`:148`、`ArchiveView.vue:21`、`PortalRight.vue:35/50/64`、`CommentSection.vue:24` |
| DocTree 孤儿根节点（F6） | **通过** | `DocTree.vue:60-63` `roots = visible.filter(e => !e.parentId \|\| !byId.has(e.parentId))` |
| `ImportDocsDialog` 父容器 `published` | **通过** | `ImportDocsDialog.vue:157` `status: 'published'` |
| 草稿徽标（Q10） | **通过** | `ArticleDetail.vue:18/34/42`（徽标 + 快捷发布，仅 admin）、`ContentCardFeed.vue:255`、`ArchiveView.vue:66` |
| App 状态机 / new→edit 不重挂载 | **通过** | `App.vue:186-219` `detailMode`；`:658 :key="editKey"`，`onDraftCreated`（`:307-311`）**不 bump editKey** → 首次创建后组件不重挂载，正在输入的内容不丢 |
| 快捷键 | **通过** | `App.vue:484-522`：`Ctrl+K`、`Ctrl/Cmd+S`（仅编辑态，拦截浏览器保存）、`Escape`（只关下拉）、`/`、`N`（仅站主且非编辑态且焦点不在输入控件） |
| `createUser` 第 4 参（D8 行为修复） | **通过** | `lib/auth.ts:64-76` 传 `groupIds`；实测 `POST /api/auth/users {groupIds:['user']}` → 登录用户 `groupIds: ["user"]` |

---

## 3. 临时实例语义验收（真实进程 + 真实 HTTP）

**隔离方式**：每个场景独立目录 `%TEMP%\ikit-qa7\<scenario>\`，`cwd = <scenario>`（数据落 `<scenario>\data`）、`PLUGIN_DIR=<scenario>\plugins`、`PORT=3401…3407`、`ADMIN_PASSWORD=qa7-admin-pass`；`WEB_DIST` 未设置；启动方式 = `node <repo>/packages/server/node_modules/tsx/dist/cli.mjs <repo>/packages/server/src/index.ts`（**未使用** `pnpm dev`，避免 `process.cwd()=packages/server` 污染真实 data）。真实 `packages/server/data` 与 `plugins/` **零改动**。

### 3.0 总表
| 套件 | 脚本 | 结果 |
|---|---|---|
| 服务层单测（构建产物 `packages/plugins/knowledge/dist`，桩计数 embedding） | `unit.mjs` | **PASS 25 / FAIL 0** |
| 迁移（JSON + SQLite + 幂等 + cutoff 护栏 + 开关 + meta 透传） | `migration.mjs` | **PASS 43 / FAIL 0** |
| HTTP 语义（JSON 一轮 + SQLite 一轮） | `semantics.mjs` | **PASS 86 / FAIL 0** |
| 边角探针（POST 发布不变式绕过） | `probe.mjs` | 4 项**预期外**（见 N3，全部 201） |
| 产物合计 | — | **154 PASS / 0 FAIL**（+ 探针） |

### 3.1 迁移（S1 JSON / S2 off 开关 / S3 SQLite / S4 meta 透传）
种子：`L1 draft@2026-09-01`（目标）、`L2 无 status`、`L3 draft@2026-11-15`（cutoff 之后）、`L4 draft 已删除`、`L5 published`、`L6 archived`。

| # | 用例 | 结果 | 实测证据 |
|---|---|---|---|
| S1-1 | 迁移日志 + 数量 | PASS | `[knowledge] draft-publish migration: drafts=1 published=1 skipped=0 backup=…\knowledge.json.bak-20261013T073113 v1` |
| S1-2 | 写前备份内容 = 迁移前 | PASS | 备份文件内 `L1` 仍为 `draft` |
| S1-3 | `L1 draft→published` | PASS | published |
| S1-4 | `L2`（status 缺失）不变 | PASS | `<null>`（未写字段） |
| S1-5 | `L3` cutoff 之后保持 draft | PASS | draft |
| S1-6 | `L4` 已删除不动 | PASS | draft（`deletedAt` 保留） |
| S1-7 | `L5`/`L6` 不变 | PASS | published / archived |
| S1-8 | 标记写入 `db.meta.draftPublishV1` | PASS | `{"draftPublishV1":"2026-10-13T07:31:13.325Z"}` |
| S1b | 二次启动幂等：无 migration 行、无重复备份、**数据逐字节不变** | PASS | 备份仍为 1 个；`JSON.stringify` 前=后 |
| S1c | 删标记后重跑 → **cutoff 护栏** | PASS | `drafts=0`，`L3` 仍 draft、`L1` 无回退 |
| S2 | `KB_MIGRATE_DRAFT_STATUS=off`：不迁移 / **不写标记** / 不备份 / 日志 `migratedDrafts = off` | PASS | `L1` 仍 draft，JSON 无 `meta` |
| S3 | SQLite：迁移日志 + 新增备份 + 各状态断言 + `meta` 表写入标记 | PASS | `meta` 行 `draftPublishV1=2026-10-13T07:31:18.891Z` |
| S3b | SQLite 二次启动幂等 | PASS | 无 migration 行、备份数不变 |
| S4 | **JSON→SQLite `meta` 透传**：JSON 侧带标记 + 历史 draft，切 sqlite 空库启动 | PASS | 日志 `已从 JSON 迁移 1 条到 SQLite`；**无** migration 行；`M1` 仍 `draft`；`meta` 表标记值透传一致 |

> **S1c 复现的风险窗口（对应必须修 #3）**：证明「删标记重跑也不会发布 cutoff 之后的草稿」这一护栏成立，同时反证——**只要草稿的 `createdAt` 早于 `DRAFT_PUBLISH_CUTOFF`，重启即被自动发布**。当前 cutoff = `2026-10-20`（晚于实施日 2026-10-13）→ 该窗口内新建的真实草稿会被误发布。

### 3.2 草稿过滤 / 发布撤回 / POST 放宽 / 导入默认 / 回滚（S5 = JSON，S6 = SQLite，各 43 项）
| 分组 | 用例（JSON 与 SQLite 结果一致） |
|---|---|
| 读路径过滤 | 游客列表只含 `P1`；站主（带 token）含 `P1,D1,D2`；**登录非站主**（真实 `qa7user`，`user` 组）只含 `P1` |
| 分类计数 | 游客：`验收专区/已发布` count=1、`验收专区/草稿专属` count=0；**但树中仍出现该草稿独有路径**（D6 证据，无内容泄露）；站主：草稿分类 count=1 |
| 详情 / 评论 / 浏览 | 游客 `POST /D1/view` → `entry` 缺失（不计数）；游客 `GET /D1/comments` → `[]`；站主访问正常计数 |
| 越权 | 游客 `PATCH /D1` → **403**；游客 `POST /entries` → **403** |
| 非法 status | `PATCH {status:'archived'}` → **400** `status must be 'draft' or 'published'`；`{status:'weird'}` → **400**；`POST {status:'archived'}` → **400** |
| POST 放宽 | 空标题 + 有正文 → **201**、`title='未命名草稿'`、`status='draft'`、对该新建草稿游客不可见；双空 → **400** |
| 发布 / 撤回 | `PATCH published` → 200 + 游客立即可见；`PATCH draft` → 200 + 游客立即不可见 |
| 发布校验 | 空正文发布 → **400** `发布前需填写标题与正文` |
| autosave | `PATCH {content:…, title:'', autosave:true}` → 200，内容更新、**原标题保留**、status 不变 |
| 导入 | `POST /import` 2 条 → `created=2`、两条均 `published`、**游客立即可见** |
| 回滚开关 | 重启加 `KB_DRAFT_VISIBILITY=everyone` → 日志 `draftVisibility = everyone`、游客列表含 `D1`、草稿分类 count=1 |

### 3.3 服务层单测（`dist` 产物，25 项）
- `isPublished`：`{}`/`undefined` → true，`draft`/`archived` → false，`published` → true。
- 默认发布态：`create()` → `draft`；`importMany()` → 全部 `published`。
- **autosave 跳过 embedding（桩计数）**：`create` → 1 次；`update(skipEmbedding:true)` → **仍为 1**（未调用）；普通 `update` → 2；仅改 `status` → 2；非 autosave 的普通保存 → 3。
- 单点过滤（admin-only）：游客 list / search / view / listComments / listAllComments / categories 计数**全部**排除草稿；站主 list / search 含草稿；已发布条目游客可见。
- 回滚（everyone）：游客 list / search 含草稿。
- 反证：把一条未迁移的存量 `draft` 直接塞进存储 → 游客列表中消失（**证明迁移的必要性**）。

### 3.4 边角探针（S7）
| 请求 | 期望（依据 §4.5.3「服务端权威」） | 实测 |
|---|---|---|
| `POST {title:'有标题无正文', content:'', status:'published'}` | 400 | **201**（`status: published`，游客可见，`content: ""`） |
| `POST {title:…, content:'   ', status:'published'}` | 400 | **201**（`content: "   "`） |
| `POST {content:'有正文无标题', status:'published'}` | 400 | **201**（`title: "未命名草稿"`） |

→ 结论：`PATCH` 有发布不变式，`POST` 没有（方案 §4.5.3 的 POST 行确实未要求，属设计不对称，非方案违规）→ **建议修 N3**。

---

## 4. 前端可达性与隔离

| 检查 | 结果 | 证据 |
|---|---|---|
| 关键资源存在 | **通过** | `public/vditor/dist`：**49 文件 / 5,530,040 B**；`dist/vditor/dist` 同；含 `js/lute/lute.min.js`(3.74 MB)、`js/icons/ant.js`、`js/i18n/zh_CN.js`、`js/katex/{katex.min.js,katex.min.css,mhchem.min.js}`、`js/highlight.js/{highlight.min.js,third-languages.js,styles/github*.min.css}`、`css/content-theme/{light,dark}.css`、`images/emoji/*` |
| `node scripts/sync-vditor-assets.mjs --check` | **exit 0** | `copied=0 skipped=49 total=49 bytes=5530040`（`--check` 不拷贝，失配才 exit 1）；标记文件 `.vditor-version` = `4.0.0` |
| 运行时可服务性（真实 `:3000` dev 实例，只读 HEAD/GET） | **通过** | `/vditor/dist/js/lute/lute.min.js` **200 / 3,743,299 B**；`icons/ant.js` 200/42,983；`i18n/zh_CN.js` 200/2,564；`katex/katex.min.js` 200/277,038；`katex/mhchem.min.js` 200/33,730；`highlight.js/third-languages.js` 200/21,007；`css/content-theme/dark.css` 200/3,363 |
| Vditor CSS chunk 裸元素选择器 | **0** | 解析 `dist/assets/index-DPKgrRxC.css`（38.39 kB，懒加载）：唯一选择器 **411**，**全部含 `vditor`**，裸元素选择器 **0** |
| 门户主 CSS 是否被污染 | 否 | `index-Cf_Qhege.css`（首屏）：1242 唯一选择器，含 `vditor` 的仅 **6** 个 = 我们自己的反向隔离规则；14 个裸元素选择器为既有门户样式（`body/html/input/textarea/select/main/pre code.hljs/code.hljs`），非 Vditor 引入 |
| `.style.css` 反向隔离 | **通过** | `style.css:471-480`：`.vditor input, .vditor textarea, .vditor select { background/color/border-color: revert }` + `[data-theme='dark'] .md-editor .vditor-reset` |
| **资源入库（Q4）** | **失败** | `git check-ignore -v apps/web/public/vditor/dist/js/lute/lute.min.js` → `.gitignore:2:dist/`；`git ls-files apps/web/public` → **0**；`git status --ignored` → `!! apps/web/public/vditor/dist/`（仅 `.vditor-version` 可被提交）→ 见 **N1** |

---

## 5. 文档一致性

| 文档 | 抽查点 | 结论 |
|---|---|---|
| `README.md` | `:192` 编辑体验行已按实际实现改写（Vditor IR / 就地编辑 / 自动保存 / 发布撤回 / 快捷键）；`:281-283` API 表（POST 放宽 + status、import 默认 published、PATCH status/autosave）；`:85/:89` 两个新 env 键；`:101` 本地资源说明 | 与代码一致；**唯 `:101` 的「入库」失实（N1）** |
| `AGENTS.md` | `:143` `status` 语义（缺省/NULL=published）、`:147` `meta`/`draftPublishV1`、`:151` 开关、`:152` 写入默认态（create=draft / import=published / Agent 写入即草稿）、`:153` 迁移与备份、`:154` 回滚三步 | 与代码一致 |
| `docs/需求功能总览.md` | 模块① `:122-126`（就地编辑 / 新建草稿流 / 自动保存发布 / 草稿仅站主可见 / 导入默认 published）、`:131-133` 实现位置与本地资源、`:135-139` 一致性状态 + **D6 已知偏差**、模块② `:162/:171/:180`、第六节 `:401` 立项条目、`:279` Agent 检索约束 | 一致；`:133` 的「入库」失实（N1） |
| `docs/门户布局与功能改造需求文档.md` | §14.1 `:255-258`、§14.2、§15 `:291-292`、§17 `:317-331`（编辑器/双态/草稿流/自动保存/发布撤回/可见性与默认状态/存量迁移/补授权/快捷键/构建/已知偏差） | 一致且信息完整；§17 `:321` 未提「入库」措辞但列出了本地资源路径（与 N1 相关） |
| `docs/个人知识库系统 产品需求文档（PRD）.md` | `:156` 阅读/编辑二合一、`:186` 实现说明（自动保存 + 手动发布取代「点击保存」） | 一致 |
| `docs/用户组与内容可见性权限需求文档.md` | `:93-105` status 与 visibility 正交、谓词代码、单点位置、开关、迁移 | 一致 |
| `docs/AI Agent 多节点与三端互通需求文档.md` | `:41-42` `knowledge_search` 不召回草稿 + Agent 写入即草稿 | 一致 |
| `docs/desktop-mobile.md` | `:74-78` `apps/web/dist` 含 `vditor/dist/**` 离线资源 + `prebuild` | 一致（此处表述为「dist 包含」，无「入库」失实问题） |
| `.env.example` | 仅 `KB_STORAGE=sqlite`，**无**两个新 env 键 | 与偏差 D4 说明一致（D4 判定见 §6） |

**文档-代码一致性结论**：9 份文档全部同步且语义与代码相符 → **通过**；唯一硬伤是「Vditor 资源入库」这一**事实性断言**在 2 份文档（`README.md:101`、`需求功能总览.md:133`）与事实不符（N1）。

---

## 6. 开发者自报偏差 D1–D9 判定

| # | 偏差 | 独立核验结果 | 判定 |
|---|---|---|---|
| **D1** | 资源目录实为 `public/vditor/dist/**`（非 `public/vditor/**`） | 属实且**必要**：`cdn='/vditor'` + Vditor 请求 `${cdn}/dist/js/...` → 落到 `public/vditor/dist/` 才命中；实测 `/vditor/dist/**` 经 `:3000` 全部 200 | **可接受偏差**（建议在方案 §4.1.3 补一句勘误） |
| **D2** | 白名单补 `js/lute/lute.min.js`、`highlight.js/third-languages.js`、`katex/mhchem.min.js` | 属实且**必要**：Lute 3.74 MB 是唯一 Markdown 引擎，缺失则编辑器无法初始化；合计 49 文件 5.27 MB（方案估 2 MB 系白名单漏项所致） | **可接受偏差**（方案原文有误，实施者修正正确） |
| **D3** | 新增 `.vditor-version` 标记 + `--check` | 属实：`--check` **exit 0** 且 `copied=0`（不拷贝、失配时 exit 1）；标记 `4.0.0`，版本升级强制重同步 | **可接受偏差（增强）** |
| **D4** | `.env.example` 未改，两个 env 键写入 README/AGENTS | 属实：`.env.example` 仅 `KB_STORAGE`；`README.md:85/89`、`AGENTS.md:151/153` 已写明（含回滚） | **需修正（低危）**：`.env.example` 是运维首查位置，建议并行改动落地后补两行 |
| **D5** | `KB_MIGRATE_DRAFT_STATUS=off` 时不写标记 | 属实且实测：S2 用例 `L1` 仍 draft、无 `meta`、无备份、日志 `migratedDrafts = off` | **可接受偏差**（与方案 §4.7.1 一致） |
| **D6** | `getCategories` 未改 → 非 admin 仍见草稿独有分类**路径** | 属实且实测：S5/S6 游客分类树含 `验收专区/草稿专属`，`count=0`（**无内容泄露，仅路径名**）；已在 3 份文档记为已知偏差 | **可接受偏差（已文档化）+ AC-21② 应改判**；建议后续按可见路径裁剪（列入建议修） |
| **D7** | `DRAFT_PUBLISH_CUTOFF=2026-10-20` 晚于实施日 | 属实且风险可复现（S1c 证明 cutoff 语义有效 → 窗口内新草稿会被自动发布） | **需修正（发布前必须校正）**——方案 §4.7.1/R10 自身要求 `变更视为数据迁移变更，需评审` |
| **D8** | `vue-tsc` 串入 build + 顺带修 4 处存量类型问题（含 `createUser` 第 4 参 `groupIds` = **行为修复**） | 属实：构建日志确为 `vue-tsc --noEmit && vite build`；`typecheck` exit 0；`auth.ts:64-76` 已传 `groupIds`，实测创建用户 `groupIds: ["user"]` 生效（此前被静默丢弃）；另 3 处为纯类型修复（`deletedAt`、`StorePluginPanel` 泛型、`DocTreeItem` slot） | **可接受偏差**（顺带行为修复已如实披露，属改善） |
| **D9** | 新增 `ApiError` 携带 HTTP `status` | 属实：`api.ts:51-58`；被 `autosave.isRetryable` 用于「4xx 不重试 / 5xx+429 重试」；`message` 仍为响应原文，兼容既有调用方 | **可接受偏差** |

---

## 7. FAIL 清单（阻塞项与证据）

| ID | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| **F1 = N2** | **必须修（AC 未闭合）** | **AC-24 后半段未实现**：方案 §4.8 与 AC-24 要求「编辑态收到他端 `update/remove`（同 id、非自己保存）→ 顶部黄条『该文章已在其它端被修改 · 重新载入』，点重新载入才替换内容」。实施记录把 AC-24 归入「仅代码核验」，但全仓无任何实现：`grep -rn "其它端\|重新载入\|knowledge:changed\|conflict" apps/web/src` → **0 命中**；`App.vue:442-446` 的 WS 回调仅 `events.unshift(msg)`（供 SystemPanel 展示），编辑态无 WS 消费、无提示条。（AC-24 的前半句「输入不被覆盖」**成立**：编辑态永不因 WS 重载 + `save()` 从不回写编辑器） | 若要闭合 AC-24：在 `ArticleEditView` 订阅 `knowledge:changed`，按 §4.8 的「自更新识别（比较自己最后保存的 `updatedAt`）」判定后渲染非弹窗黄条 + 「重新载入」按钮；或与需求方确认把 AC-24 后半段降级为后续项并修订 AC |
| **F2 = N1** | **必须修（决策未落地 + 文档失真）** | **Vditor 资源实际未入库**：`.gitignore:2` 的 `dist/` 规则命中 `apps/web/public/vditor/dist/**`（`git check-ignore -v` 证实；`git ls-files apps/web/public` = 0；只有 `.vditor-version` 可提交）。这与已确认决策 Q4（**入库**，用户已采纳方案全部推荐默认）不符，且 `README.md:101`、`docs/需求功能总览.md:133` 断言「入库」。当前实际形态等价于 Q4 里的**备选**方案（忽略 + 依赖 `prebuild`） | 方案 A（推荐，回归 Q4）：在 `.gitignore` 追加 `!apps/web/public/vditor/dist/` 与 `!apps/web/public/vditor/dist/**`，提交前确认 `git status` 出现 49 个文件；方案 B：改正 2 处文档为「构建期由 `prebuild` 生成、不入库」，并在 `desktop-mobile.md` 同步说明离线构建依赖 `pnpm install` |
| **F3 = D7** | **必须修（发布前硬性）** | `DRAFT_PUBLISH_CUTOFF = 2026-10-20T00:00:00.000Z` 晚于实施日：2026-10-13～10-20 之间新建的真实草稿，会在下次启动被迁移为 `published`（游客可见） | S1c 复现 cutoff 语义；单测证明未迁移的存量 draft 会从游客列表消失（即反向也成立：被误判的 draft 会被发布） | 发布前把常量改为真实上线时刻（并在发布说明中记录「数据迁移变更」），必要时先在预演库核对 `createdAt` 分布 |

---

## 8. 未在本轮独立复核的项（人工 UI 验收，需在 `pnpm dev` + `pnpm dev:web` 上手验）

以下 AC 属交互/视觉/性能/离线类，无法在无头环境独立复现，本轮仅做**代码级静态核验**（结论：「实现存在且路径正确，未运行时确认」）：

AC-2 离线资源（断外网后图标/中文/代码主题/内容主题/公式）、AC-3 IR 编辑能力（加粗/标题/列表/任务/引用/代码块/表格/公式/粘贴上传不产生 base64 内联）、AC-4 主题联动目视、AC-5 样式隔离目视（Admin 面板与三栏）、AC-6/AC-7 无弹窗就地编辑与新建、AC-8 首次保存即创建（Network 观感）、AC-9 自动保存节奏（连续输入 10s ≤6 次 PATCH）、AC-11/AC-12 退出与刷新不丢内容（快照恢复条）、AC-13 `Ctrl+S`、AC-14/AC-15 隐身窗口可见性翻转、AC-16 客户端内联提示、AC-17 两引擎差异抽查（原始 HTML 转义）、AC-18 大文档性能、AC-19 重命名 `public/vditor` 后的降级与重试、AC-22 Agent 问答不召回草稿（服务层已证 `search(viewer)` 过滤，端到端需 LLM）、AC-23 导入弹窗「＋新建父文档」后游客目录树可见容器、AC-24 双窗口并发（见 F1）、AC-25/AC-26 站主侧读路径与孤儿根（静态已证）、AC-30 回归基线（评论/回收站/批量分类/可见性四级/封面上传/Ctrl+K/明暗/三档响应式）。

---

## 9. 复现命令（证据留存）

```powershell
# 0) 工作区状态（只读）
git -C D:\Projects\i-kit branch --show-current          # develop
git -C D:\Projects\i-kit status --porcelain             # 65 项（含新增未跟踪文件）

# 1) 构建 + 类型检查
cd D:\Projects\i-kit; pnpm -r --if-present build        # exit 0（11/12 项目）
pnpm --filter @ikit/web typecheck                       # exit 0

# 2) 静态核验
#   grep ArticleEditor|editorOpen|editingEntry|editingParentId|editor-overlay apps/web/src → 0
#   git check-ignore -v apps/web/public/vditor/dist/js/lute/lute.min.js  → .gitignore:2:dist/
node scripts/sync-vditor-assets.mjs --check             # exit 0

# 3) 临时实例（隔离在 %TEMP%，不触碰真实 data/plugins）
cd C:\Users\wxov1\AppData\Local\Temp\ikit-qa7
node unit.mjs        # PASS 25 / FAIL 0
node migration.mjs   # PASS 43 / FAIL 0（S1 JSON / S2 off / S3 SQLite / S4 meta 透传）
node semantics.mjs   # PASS 86 / FAIL 0（S5 JSON / S6 SQLite）
node probe.mjs       # POST+publish 不变式绕过（N3 证据）
node css.mjs         # Vditor chunk 裸元素选择器 0

# 4) 资源可达性（真实 :3000 dev 实例，只读）
#   node -e "fetch('http://127.0.0.1:3000/vditor/dist/js/lute/lute.min.js').then(r=>r.arrayBuffer()).then(b=>console.log(r?.status,b.byteLength))"
#   → 200 / 3743299
```

**隔离声明**：全部临时实例数据位于 `%TEMP%\ikit-qa7\**`；验收过程**未修改任何项目源码**，**未执行任何 git 写操作**（仅 `git status/log/ls-files/check-ignore` 只读命令）；真实 `packages/server/data`、`plugins/`、`.env` 未被触碰（`.env` 甚至未被加载——临时 cwd 不在仓库内）。

---

*报告生成：测试验收工程师（独立验收）。所有结论均来自本轮真实执行的命令输出；未采信开发者自报证据。*

---
---

# 第 2 轮复验（追加，2026-10-13）

> **背景**：开发者按第 1 轮报告完成 6 项修正（**未做 git 操作**）。本轮为**独立复验**：重新构建 + 逐项文件级实证 + 关键分支真实实例实测 + 代码路径复核。
> **隔离声明（同上轮）**：临时实例位于 `%TEMP%\ikit-qa7\r2-*\**`（独立 cwd / data / `PLUGIN_DIR` / `PORT=3408`）；**未修改任何项目代码**、**未执行任何 git 写操作**（仅只读 `status` / `ls-files` / `check-ignore`）；真实 `packages/server/data`、`plugins/`、`.env` 未被触碰。
> **第 2 轮结论**：**PASS** —— 6 项修正（N1 / N2 / N3 / N4 / D4 / D7）**全部独立复核通过，无阻塞项**；另有 **2 项非阻塞建议**与 2 项观察项（见 2-7）。

## 2-0. 第 2 轮结果总表

| 修正项 | 判定 | 本轮独立证据 |
|---|---|---|
| **N1** Vditor 资源入库 | **PASS** | `.gitignore:3-5` 否定规则；`git status --porcelain -uall -- apps/web/public` = **50**（全 `??`）；`git check-ignore -q .../lute.min.js` **exit 1**（未被忽略）；`git ls-files --others --exclude-standard` 含 **49 资源 + `.vditor-version`**；`apps/web/dist`、`packages/*/dist` 仍 **exit 0（被忽略）**；全仓未跟踪文件中「非 vditor 的 dist 路径」= **0**（无越界解除） |
| **N2** AC-24 后半段（他端修改提示条） | **PASS** | 新增 `apps/web/src/lib/wsConflict.ts`（纯逻辑、零依赖）→ 独立用例 **13/13**；`App.vue` 接线（gate / WS / `@writing` / 模板）代码级核验通过；**穷举 grep 证明不存在 WS→编辑器回写路径** |
| **N3** POST 发布校验 | **PASS** | 真实临时实例 **23/23**：空正文 / 纯空白正文 / 缺标题 + `status:'published'` → **全 400**「发布前需填写标题与正文」；正常 → 201 且游客立即可见；`draft` 流不受影响；**导入弹窗父容器链路 created=2 + 游客可见**；PATCH 对称性未破坏；第 1 轮 `probe.mjs` 的 S7a/b/c 由 201 → **400** |
| **N4** 自动保存失败后自动恢复 | **PASS** | 以 esbuild 打包**真实 `autosave.ts`**（含 `api.ts`/`config.ts`，共享同一 `ApiError` 类标识）驱动 → **27/27**；「4xx 不重试」「4xx 不武装定时器」保持；低频自动重试 / 成功撤销 / 脏判定守卫 / 串行 / unchanged / rev 全部实测通过 |
| **D4** `.env.example` | **PASS** | `.env.example:16-25` 两键 + 回滚三步注释；键名与默认值（`admin-only` / `publish`）与 `index.ts:55-56` 的 Config 默认值、`:66-75` 的 env 读取逐字一致 |
| **D7** cutoff 发布前校正 | **PASS**（按用户决定**不改常量**） | 常量仍为 `2026-10-20T00:00:00.000Z`（`migrate.ts:28`）；`README.md:129`、`需求功能总览.md:126`、方案实施记录行 + 文档同步清单行均含「**发布前必做：校正 `DRAFT_PUBLISH_CUTOFF` 为真实上线时刻**」 |
| **D6** `getCategories` | **按用户决定保持不动，不计 FAIL** | `service.ts` 的 `getCategories` 未改（仍 `buildCategoryTree(db.categories, entries)`，仅 count 按可见性统计）；已知偏差仍记录于 `需求功能总览.md:141`、`门户布局与功能改造需求文档.md:331` |

## 2-1. 构建与回归（第 2 轮重跑）

| 项 | 结果 | 证据 |
|---|---|---|
| `pnpm -r --if-present build` | **exit 0** | 11/12 项目；`apps/web build$ vue-tsc --noEmit -p tsconfig.json && vite build`；`✓ 174 modules transformed`（第 1 轮 173 → +1 = `wsConflict.ts`）`/ ✓ built in 2.38s` |
| `prebuild` 资源同步 | 幂等 | `[sync-vditor] copied=0 skipped=49 total=49 bytes=5530040 (5.27 MB)` |
| 回归 `unit.mjs`（服务层） | **25 / 25 PASS** | 与第 1 轮一致 |
| 回归 `migration.mjs`（JSON+SQLite 迁移） | **43 / 43 PASS** | 与第 1 轮一致 |
| 回归 `semantics.mjs`（HTTP 语义 JSON+SQLite） | **86 / 86 PASS** | 与第 1 轮一致 |
| 回归 `probe.mjs`（POST 绕过探针） | **4 / 5**（S7d 为观察项） | S7a/b/c 已由 201 → **400**；S7d 是「恒 FAIL 用于打印游客可见列表」的探针行，本轮输出 `[]` = 无泄漏，符合预期 |

第 2 轮新增套件：`r2-wsconflict.mjs` **13/13**、`r2-post.mjs` **23/23**、`r2-autosave.mjs` **27/27**（日志：`%TEMP%\ikit-qa7\r2-{wsconflict,post,autosave,semantics,migration}.txt`）。

## 2-2. N1 逐条实证（含「未意外解除其它 dist」的反向验证）

```powershell
git status --porcelain -uall -- apps/web/public | Measure-Object -Line   # 50（全部 ??，49 资源 + .vditor-version）
git check-ignore -q apps/web/public/vditor/dist/js/lute/lute.min.js      # exit 1 → 未被忽略
git check-ignore -q apps/web/public/vditor/dist                          # exit 1
git check-ignore -q apps/web/dist/index.html                             # exit 0 → 仍被忽略
git check-ignore -q packages/api/dist/routes.js                          # exit 0 → 仍被忽略
git ls-files --others --exclude-standard                                 # 73 个未跟踪(非忽略)文件
#   其中 apps/web/public/vditor/** = 50；.../vditor/dist/** = 49；.vditor-version = 1
#   其中「其它任何 dist 路径」= 0            ← 关键：无越界解除
```

- `.gitignore` 实际内容为第 2 行 `dist/` 之后追加 `!apps/web/public/vditor/dist/` 与 `!apps/web/public/vditor/dist/**`（`:3-5`，带中文注释），位置正确（否定规则必须在 `dist/` 之后）。
- **注意 `-v` 的退出码陷阱**：`git check-ignore -v <path>` 在命中**否定**规则时会打印 `.gitignore:5:!apps/web/public/vditor/dist/**` 并返回 **0**，容易被误读为「仍被忽略」；判定应以 `-q`（exit 1）或 `--exclude-standard` / `status -uall` 为准——本轮三种方式结论一致（开发者自报用的是 `-q`，结论正确）。
- 判定：**Q4「入库」决策已落地**，且未影响 `apps/web/dist`、`packages/*/dist` 等构建产物的忽略状态。

## 2-3. N2 代码路径复核（含「无 WS→编辑器回写路径」证明）

**① 判定逻辑独立实测（`lib/wsConflict.ts`，零依赖纯逻辑 → 直接加载真实源码，13/13 PASS）**

| 用例 | 期望 | 实测 |
|---|---|---|
| N2-1 他端修改的是**别的**文章 | 不提示 | PASS |
| N2-2 非 `knowledge:changed` / `comment` / `remove` | 不判定 | PASS |
| N2-3 `currentId=null`（新建虚拟草稿，无 id） | 不提示 | PASS |
| N2-4 他端修改且本端无写入在途 | **立即提示**（不漏报） | PASS（state=`{A,TX}`） |
| N2-5 指纹相同（HTTP 响应已回写 = 自己的回声） | 静默 | PASS |
| **N2-6 WS 帧先于 HTTP 响应到达**（`noteLocalWrite()` 后立刻收到广播） | 先推迟、响应落地后复检为自身回声 → **不误报** | PASS（deferred=true，最终 state=null） |
| **N2-7 他端写入落在本端保护窗内** | 推迟但复检后**仍提示**（不因窗口漏报） | PASS（最终 state=`{A,TX}`） |
| N2-8 / 8b `noteLocalSaved` 兜底 | 指纹相同 → 撤回提示条；不同 → 保留 | PASS / PASS |
| N2-9 / 9b `clear()` / `dispose()` | 清状态；dispose 后到期复检不再提示 | PASS / PASS |
| N2-10 / 10b 重复广播 | 状态仍正确、`clear()` 归零；**值相同的重复广播会重复回调**（观察项，见 2-7） | PASS / 已记录 |

> 设计审视结论：**未发现误报/漏报的结构性缺陷**。两道闸的分工正确——①`updatedAt` 指纹消自身回声；②3s 写入在途保护窗解决「服务端 `emit` 在 HTTP 回包之前」的时序问题（推迟到窗口结束再复检①，因此他端写入只会**延迟 ≤3s**、不会丢失）。唯一代价是极端慢写入（>3s 未回包）时可能对自己的那次写入短暂弹条，随后由 `noteLocalSaved()` 指纹撤回。

**② 接线（代码级核验，无头环境不渲染 UI）**

| 环节 | 位置 | 结论 |
|---|---|---|
| gate 创建（`currentId`/`currentUpdatedAt` 取 `article`） | `App.vue:225-230` | 正确；`article` 仅由本端 HTTP 响应/用户操作赋值 |
| 提示条（非弹窗，复用 `.app-banner` 样式） | `App.vue:676-693`；样式 `App.vue:901-915/958-972` | 阅读态 = 「重新载入」+「×」；**编辑态仅有「继续编辑」，无「重新载入」按钮** → 编辑态无法被 WS 覆盖 |
| 「重新载入」= 显式拉取列表并按 id 取最新 | `App.vue:253-274` | 用户点击才执行；文章已被撤回/删除 → toast + 回列表 |
| WS 接线 | `App.vue:507-514` | `knowledge:changed` 仍 `events.unshift`（SystemPanel 不受影响）+ 转 `onKnowledgeChanged`；`bus.ts:24-25` 广播载荷确为 `{type:'knowledge:changed', payload:{action,entry}}` → 字段路径与 gate 一致 |
| 本端写入打点 | `ArticleEditView.vue:37/123/306` → `App.vue:752 @writing="onLocalWrite"` | 自动保存（含每次重试）与发布/撤回前均刷新保护窗 |
| 本端写入成功回写 | `App.vue:238-241`（`syncLocalEntry` → `noteLocalSaved`），被 `:369/376/380/410` 调用 | 指纹撤回兜底生效 |
| 离开文章/退出编辑 | `App.vue:289/301/370/388/399` → `clearWsConflict()` | 状态不跨文章残留 |

**③ 「WS 从不回写编辑器」——穷举证明**：
`grep -rn "setValue\(" apps/web/src` 全仓仅 **4 处**：`VditorEditor.vue:133`（初始化传入 value）、`VditorEditor.vue:181`（对外暴露的 `setValue`）、`ArticleEditView.vue:270`（用户点「恢复」本地快照）、`ArticleEditView.vue:386`（用户二次确认「取消」回滚）。**没有任何 WS 分支调用 `setValue`**；且 `:value="entry?.content ?? ''"` 只在 Vditor 初始化时读取一次，`editKey` 在 new→edit 时不 bump（组件不重挂载）→ 即使 `article` 被并发改写也不会灌回编辑器。**AC-24 前半句（输入不被覆盖）成立，后半句（提示条 + 显式重新载入）现已实现**。

## 2-4. N3 实测矩阵（真实临时实例 `:3408`，JSON 存储，23/23 PASS）

| 分组 | 用例 | 实测 |
|---|---|---|
| published 残缺输入（第 1 轮为 201，现应 400） | `{title, content:''}` / `{title, content:'   '}` / `{content}`（缺标题）+ `status:'published'` | **400**「发布前需填写标题与正文」×3 |
| 双空优先 | `{status:'published'}`（title/content 均空） | **400** `title and content cannot both be empty`（原校验优先，语义合理） |
| draft 流不受影响 | 空标题 + 有正文（无 status） | **201**、`title='未命名草稿'`、`status='draft'`、游客不可见 |
| | `{title, content:'', status:'draft'}` | **201**（草稿允许空正文） |
| | `{}`（无 status） | **400** |
| published 合法输入 | `{title, content, status:'published'}` | **201** `published`，**游客立即可见** |
| **导入弹窗父容器链路**（`ImportDocsDialog.vue:153-159` 改为 `content: \`# ${parentTitle}\``） | 父容器 `{title:'导入父容器', content:'# 导入父容器', status:'published'}` | **201**（不再依赖「单空格占位」绕过校验） |
| | `POST /import {parentId, entries:2}` | `created=2`、两条均 `published`、`parentId` 正确、**游客可见父容器 + 2 子项**（F6 链路未被 N3 修复破坏） |
| PATCH 对称性 | 空正文 `status:'published'` | **400** 同文案 |
| | 补齐正文后发布 | **200** `published` |
| | `status:'archived'` | **400** |
| autosave 未误伤 | `{content, title:'', autosave:true}` | **200**，原标题保留 |

> 注：`ImportDocsDialog` 的父容器改动是**必要联动**（原实现用 `content:' '` 单空格占位，在新增 POST 校验下会 400）——实施者已同步修改并注释说明，属正确处置。

## 2-5. N4 实测矩阵（真实 `autosave.ts` 经 esbuild 打包驱动，27/27 PASS）

> 方法：`esbuild` 以 `stdin + resolveDir=<repo>/apps/web/src/lib` 打包**真实源码** `autosave.ts` + `api.ts`（同一 bundle → `ApiError` 类标识一致，`instanceof` 判定有效），`import.meta.env` 由 `define` 指向可注入全局对象。断言改为「轮询等待状态收敛」，规避 Windows ~15ms 定时器分辨率。

| 分组 | 用例 | 实测 |
|---|---|---|
| 4xx 保证（**未被削弱**） | 400 → `attempt` 内不重试（save 仅 1 次） | PASS（calls=1） |
| | 4xx → `retryFailed()` 拒绝发起 | PASS |
| | 4xx → 低频定时器**不武装**（`retryInterval=60ms` 等待 250ms 无新请求） | PASS |
| | 源码守卫：`if (lastErrorRetryable) armRetryTimer(); else clearRetryTimer()` | PASS |
| 退避与恢复 | 5xx+网络错误退避用尽 → save 次数 = 1+maxRetries = **5** | PASS |
| | 用尽后 `state='error'` 且内容仍脏 | PASS |
| | `retryFailed()` → 发起并恢复 `saved`；恢复后再调用返回 `false` | PASS |
| | 成功后撤销定时器（300ms 内无多余请求） | PASS |
| | **低频定时器自动重试（无任何用户操作）** | PASS（5 → 6） |
| 脏判定守卫 | 内容回到「最近一次已保存」 → `isDirty()=false`、`retryFailed()` 拒绝、无新请求 | PASS |
| 回归 | 4xx 后用户再次输入仍能保存成功（calls=2, saved） | PASS |
| | 严格串行 `maxConcurrent=1` | PASS |
| | 保存期间有新输入 → `stale/dirty`（不误报 saved） | PASS |
| | unchanged 短路（同内容 flush 不发请求） | PASS |
| 接线（代码级） | `visibilitychange` 分「hidden→flush」「回到前台→`retryFailed()`」两支 + 注册/注销 | PASS |
| | `window focus → retryFailed()` + 卸载时移除监听 | PASS |
| 源码常量 | 默认 `retryInterval = 30000ms`；守卫含 `state!=='error'`/`!lastErrorRetryable`/`!isDirty` | PASS |

## 2-6. D4 逐条实证

- `.env.example:16-19`：`KB_DRAFT_VISIBILITY=admin-only` + 两行注释（默认语义 + `everyone` 回滚）。
- `.env.example:21-25`：`KB_MIGRATE_DRAFT_STATUS=publish` + 注释（默认语义、`off` 不写标记、**回滚三步**）。
- 与代码一致：`index.ts:55-56` Config Schema 默认 `'admin-only'` / `'publish'`；`:66-75` env 优先且仅接受 `everyone|admin-only` 与 `off|publish`（非法值回落 Config 默认）→ **键名、取值域、默认值三者一致**。
- 第 1 轮 D4 判定「需修正（低危）」**已闭合**。

## 2-7. 第 2 轮遗留（**非阻塞**）

| # | 级别 | 内容 | 证据 / 建议 |
|---|---|---|---|
| R2-1 | **建议修（文档同步，低危）** | 第 2 轮改动未同步到全部文档：`docs/门户布局与功能改造需求文档.md` §17（`:317-331`，与第 1 轮逐行一致，未补 AC-24 多端提示条 / POST 发布校验 / 自动恢复重试）；`README.md:286` 的 POST 行未补「`status:'published'` 时标题与正文均需非空，否则 400」（PATCH 行 `:288` 有写）。已同步的部分：`需求功能总览.md:126/134/141/146/150`、`.env.example`、方案实施记录与文档清单 | 按 `AGENTS.md` 第 3 条补两处文案即可（不改代码） |
| R2-2 | **建议修（需产品决策，低危）** | **阅读态（含游客）也会弹「该文章已在其它端被修改」黄条，且站主编辑期间每条自动保存广播都会重新弹**：gate 与角色无关（`App.vue:226-230` 无条件创建，`onKnowledgeChanged` 对所有客户端生效），游客点「×」后下一次 autosave（约 2s）会再次出现 | 三个可选口径：①仅站主/文章属主显示；②阅读态改为静默（只在编辑态提示，符合多数 CMS 习惯）；③按 `updatedAt` 去重/限频（记已提示过的版本，避免反复弹）。**不影响 AC-24 达成，也不影响数据正确性** |
| R2-3 | 观察项 | `wsConflict.handleMessage` 只处理 `update`/`create`，**不处理 `remove`**（他端删除/进回收站时本端阅读态无提示） | 方案 §4.8 表格曾提 `update/'remove'`；如需覆盖可在 action 分支加 `remove` 并复用同一提示条（低优先） |
| R2-4 | 观察项 | 值相同的重复广播会**重复回调** `onConflict`（对象每次新建，`setConflict` 仅对 `null→null` 去重）→ 一次冗余渲染，无功能影响 | 如追求幂等，可在 `setConflict` 内按 `id+updatedAt` 值比较；无需阻塞 |
| R2-5 | 确认（不计 FAIL） | **D6**：`getCategories` 树结构未过滤 → 非 admin 仍可见草稿独有分类**路径**（count=0，无内容泄露）；**D7**：`DRAFT_PUBLISH_CUTOFF` 常量按用户决定保持 `2026-10-20T00:00:00.000Z` | 已按用户决定保持不变，且**仍是已记录状态**（`需求功能总览.md:141`、`门户…文档.md:331`、`README.md:129`、`需求功能总览.md:126`、方案实施记录）；**发布前必做项仍待发布者执行** |

## 2-8. 最终结论

**PASS**（第 2 轮）

- 第 1 轮的 **3 项必须修全部闭环**：N2（AC-24 后半段已实现，独立 13/13 + 接线与「无回写路径」穷举证明）、N1（资源入库已落地，未越界影响其它 `dist/`）、D7（三处「发布前必做」文案齐备，常量按决定不动）。
- 第 1 轮的 **4 项建议修中 2 项已闭环**：N3（POST 发布不变式，独立 23/23 + 父容器链路实测）、N4（自动恢复重试，真实源码 27/27 且「4xx 不重试」未被削弱）；**D4 已闭环**（`.env.example` 与代码一致）；**D6 按用户决定保持不动**，仍处于「已记录」状态，不计 FAIL。
- **无新的阻塞项**；回归无退化（构建 exit 0；unit 25/25、migration 43/43、semantics 86/86 原地重跑全绿）。
- 发布前仍需人工执行的两件事（与代码无关）：①按 `README.md:129` 校正 `DRAFT_PUBLISH_CUTOFF` 为真实上线时刻；②接受或处置 R2-2（阅读态提示条口径）与 R2-1（文档两处补齐）。

*第 2 轮复验完成。所有结论均来自本轮独立执行的命令/进程输出，未采信开发者自报证据。*

---
---

# 第 3 轮复验（聚焦复核 R2-1 ~ R2-4，追加 2026-10-13）

> **范围**：**仅**复核第 2 轮遗留的 4 项（R2-1 文档同步 / R2-2 提示条口径与去重 / R2-3 `remove` 提示 / R2-4 重复回调幂等）。用户已定策略：**R2-2 = 仅站主（admin）显示 + 同一 `updatedAt` 只提示一次**；R2-1 / R2-3 一并修。
> **隔离声明**：临时实例位于 `%TEMP%\ikit-qa7\r3-ws\**`（独立 cwd / data / `PLUGIN_DIR` / `PORT=3409`）；**未修改任何项目代码**、**未执行任何 git 写操作**；真实 `packages/server/data`、`plugins/`、`.env` 未被触碰。
> **第 3 轮结论**：**PASS** —— 4 项全部闭环，无阻塞项；新增 1 项观察建议（`canPrompt` 选项默认值偏宽松）与 1 项如实记录（第 2 轮 `r2-wsconflict.mjs` 的 N2-10b 期望已被 R2-4 有意取代）。

## 3-0. 结果总表

| 项 | 判定 | 本轮独立证据 |
|---|---|---|
| **R2-2** 仅 admin + 同 `updatedAt` 只弹一次 | **PASS** | `wsConflict.ts` 新增 `canPrompt`（`evaluate()` **首行**短路，`:122`）+ `prompted` 版本记录（`:86/98-107/139-147`）+ `dismiss()` 保留记录 / `clear()` 重置（`:172-180`）；`App.vue:230` `canPrompt: () => user.value?.role === 'admin'`。独立用例 **32/32**：非 admin **不弹条 / 不回调 / 不排定时器**（含保护窗内）、同版本重复帧只回调 1 次、新版本再弹、dismiss 后同版本不复弹而新版本仍弹、clear 后同版本可再弹 |
| **R2-3** `remove` 提示 | **PASS** | `PROMPTABLE_ACTIONS` 含 `remove`（`:77`）、`kind:'remove'`（`:142`）；`App.vue:712-728` 删除态渲染「该文章已被删除或移入回收站」+「返回列表」（`wsBackToList`，`:272-279`），编辑态追加「继续编辑」；`ArticleEditView.vue:403` DELETE 前 `emit('writing')` → `App.vue:419-425` `onDeleted → clearWsConflict()`。独立用例覆盖 remove 类型/同版本去重/kind 参与去重/**自删不误弹**（本端 DELETE 的 remove 广播被推迟，随后 `clear()` 撤销待复检定时器 → 0 次提示） |
| **R2-4** 重复回调幂等 | **PASS** | `sameState(id+updatedAt+kind)` 值比较（`:98-107`）+ `prompted` 记录双重防护：同版本帧连发 3 次 → `onConflict` **仅 1 次**；新版本重复帧仍只 1 次 |
| **R2-1** 文档同步 | **PASS** | `README.md:286`（POST 行补「`status:'published'` 时标题与正文均需非空白，否则 400」）；`docs/需求功能总览.md:134/:150`（admin-only 口径 + 同版本只弹一次 + remove）；`docs/门户布局与功能改造需求文档.md:324-327`（自动保存恢复 / POST 发布校验 / 多端提示条口径 / remove 四条）；方案 `L66-82`「第 2 轮复验收尾（R2 收尾修正）」表 + `L781` 正文口径注——**逐条与代码一致**（见 3-3） |

## 3-1. 构建与回归

| 项 | 结果 | 证据 |
|---|---|---|
| `pnpm -r --if-present build` | **exit 0** | 11/12 项目；`apps/web build$ vue-tsc --noEmit -p tsconfig.json && vite build`；`✓ 174 modules transformed` / `✓ built in 2.38s`；`prebuild` 仍幂等（`copied=0 skipped=49`） |
| 回归 `semantics.mjs`（后端 HTTP 语义，JSON+SQLite） | **86 / 86 PASS** | 第 3 轮改动全在前端/文档，后端零退化 |
| 回归 `r2-autosave.mjs`（真实 `autosave.ts`） | **27 / 27 PASS** | N4 自动恢复未被本轮改动影响 |
| `grep -rn "setValue(" apps/web/src` | **仍为 4 处** | `VditorEditor.vue:133/181`（初始化 / 对外暴露）、`ArticleEditView.vue:270/386`（用户点「恢复」/ 二次确认「取消」）→ **无任何 WS 分支**，第 2 轮「WS 从不回写编辑器」结论不变 |

> 说明：第 2 轮套件 `r2-wsconflict.mjs` **不再作为回归基线**——其中 `N2-10b`（「值相同的重复广播会重复回调」）正是 R2-4 有意消除的行为，期望值已过时；已被本轮 `r3-wsconflict.mjs`（32 项，含回声抑制 E 组与边界 F 组）取代。

## 3-2. 独立用例明细

**① `r3-wsconflict.mjs`（直接加载真实 `lib/wsConflict.ts`，32/32 PASS）**

| 组 | 用例（摘要） | 结果 |
|---|---|---|
| A：仅站主（R2-2） | 非 admin：不弹条/0 回调/**不排定时器**；非 admin+保护窗内仍不排定时器；同一帧 admin 弹而 guest 不弹；未登录不弹 → 登录 admin 后同版本可正常提示 | 5/5 PASS |
| B：同版本去重（R2-2/R2-4） | 同 `updatedAt` 连发 3 帧 → 回调 **1** 次；新 `updatedAt` → 再弹；新版本重复帧仍 1 次 | 3/3 PASS |
| C：dismiss / clear 语义 | `dismiss()` 收条但保留记录 → 同版本不复弹、新版本仍弹；`clear()` 重置 → 同版本可再弹 | 5/5 PASS |
| D：`remove`（R2-3） | `kind='remove'` 且带 `updatedAt`；同 remove 帧去重；update→remove 因 kind 参与去重仍提示；**自删抑制**（writing 打点→推迟→`clear()` 撤销→0 次）；remove 同样遵守 dismiss 记录 | 5/5 PASS |
| E：回声抑制（第 2 轮保证，未被削弱） | ①指纹相同静默；②WS 先于 HTTP 响应→推迟后不误报；②他端写入落保护窗→推迟后仍提示（不漏报）；`noteLocalSaved` 撤回兜底 | 4/4 PASS |
| F：既有边界 | 非当前文章 / 非 `knowledge:changed` / `comment` 不判定；`currentId=null` 不判定；`dispose()` 后不判定 | 3/3 PASS |
| G：源码与接线 | `evaluate()` 首行 `canPrompt` 短路；`PROMPTABLE_ACTIONS` 含 remove；`App.vue` 传 admin 谓词；`dismiss`/`clear` 分别接线；remove 分支有「返回列表」、update 编辑态无「重新载入」；DELETE 前 `emit('writing')`；`onDeleted → clearWsConflict()` | 7/7 PASS |

**② `r3-ws-e2e.mjs`（真实临时实例 `:3409` + Node 内置 WebSocket 客户端，10/10 PASS）** —— 独立验证去重设计所依赖的**真实数据前提**：

| 用例 | 实测 |
|---|---|
| 浏览计数 `POST /view` 是否广播 | 是，2 次 view → 2 帧 `knowledge:changed`/`update` |
| **这些帧的 `updatedAt` 是否变化** | **不变**（唯一值 `2026-10-14T02:27:22.323Z`）→ 若无 R2-2 去重，admin 阅读端每被浏览一次就会重弹黄条；**去重确实必要且有效** |
| 真实 `PATCH` 帧 | 携带**新的** `updatedAt`（`…23.191Z`）→ 新版本仍会提示（不漏报） |
| `DELETE` 帧 | `action='remove'` 且 `updatedAt` 严格更新（`…23.601Z`）→ 可作版本去重键 |
| `DELETE` 响应体 | `{ok:true}`（**不含 entry**）→ 说明「自删抑制」只能依赖 `writing` 打点 + `onDeleted→clear()`，而实现正是如此（设计前提与代码一致） |

## 3-3. 文档 4 处与代码一致性（逐条对照）

| 文档 | 关键行 | 与代码一致 |
|---|---|---|
| `README.md` | `:286` POST 行末尾补「**`status:'published'` 时标题与正文均需非空白，否则 400「发布前需填写标题与正文」（与 PATCH 一致）**」 | ✅ 对应 `routes.ts:545-550` |
| `docs/需求功能总览.md` | `:134` 多端联动「**仅站主（admin）可见**（游客/登录非站主不提示）；**同一 `updatedAt` 只提示一次**（…切换文章/离开详情/删除时重置，用户收起则保留）；他端**删除**（`remove`）提示…」；`:150` AC-24 重写为「**同账号站主**两窗口…同一 `updatedAt` 只弹一次…游客与登录非站主不弹…B 删除该文章 → A 提示…」 | ✅ 对应 `wsConflict.ts:51/86/98-107/172-180`、`App.vue:230/712-728` |
| `docs/门户布局与功能改造需求文档.md` | `:324` 自动保存补「回到前台/窗口获焦/30s 低频定时再试，成功后撤销定时器，4xx 不重试」；`:325` 发布校验补 POST 同款不变式 + 父容器 `content:'# <标题>'`；`:326` 多端提示条（admin-only + 同版本一次 + dismiss/clear 语义 + 无 WS→编辑器回写路径）；`:327` 他端删除「返回列表 / 继续编辑」 | ✅ 对应 `autosave.ts:98-116/149-158`、`routes.ts:545-550`、`ImportDocsDialog.vue:158`、`wsConflict.ts` + `App.vue` |
| 方案实施记录 | `L66-82` 新增「第 2 轮复验收尾（R2 收尾修正）」表（R2-1~R2-4 逐行 + 自报证据 + 隔离声明）；`L781` 正文「提示条」行补口径收敛说明 | ✅ 与代码及本报告 2-7 一一对应 |

## 3-4. 本轮观察（**非阻塞**）

| # | 内容 | 建议 |
|---|---|---|
| R3-1 | `canPrompt` 选项的**默认值是宽松的**（`opts.canPrompt?.() ?? true`，`:122`），注释说明是为纯逻辑单测方便；生产唯一调用点 `App.vue:230` 已正确传 `() => user?.role === 'admin'`，因此当前行为完全符合用户策略 | 若追求防御性，可把默认改为 `false`（并让单测显式传 `true`）——一行改动；不阻塞 |
| R3-2 | `noteLocalSaved()` 的撤回/清记录仅在 `current` 非空时生效（`:157`）：若提示条已被用户 dismiss（`current===null`），本端自己的写入响应不会清掉 `prompted` 中那条同版本记录 | 影响极小（该版本此后不再提示，而它本就是本端写入）；如要更严可在 `:157` 去掉 `current &&` 前置判断 |
| R3-3 | 如实记录：第 2 轮 `r2-wsconflict.mjs` 的 `N2-10b` 期望与 R2-4 冲突，**该套件不再作回归基线**，由 `r3-wsconflict.mjs` 取代 | 无需动作（仅证据口径说明） |
| R3-4 | **发布前必做项仍待执行**：`DRAFT_PUBLISH_CUTOFF` 需由发布者校正为真实上线时刻（`README.md:129`）；**D6**（分类树路径可见）按用户决定保持不动且仍记录在 `需求功能总览.md:141` / `门户…文档.md:333` | 与代码无关，属发布流程项 |

## 3-5. 最终结论

**PASS**（第 3 轮）

- **R2-2 / R2-3 / R2-4 全部闭环**：独立纯逻辑用例 **32/32**、真实实例 + 真实 WS 用例 **10/10**；策略（仅站主显示 + 同一 `updatedAt` 只提示一次）在代码、单测、真实广播数据三个层面一致成立；`remove` 分支与「返回列表」动作齐备，且**自删不误弹**（前提是 DELETE 前 `emit('writing')` + `onDeleted→clear()`，代码与真实响应体形状吻合）。
- **R2-1 文档闭环**：4 处文档（README / 总览 / 门户 / 方案实施记录）逐条与代码一致。
- **无阻塞项，无回归**：构建 exit 0（含 `vue-tsc`，174 modules）；`semantics` 86/86、`r2-autosave` 27/27 原地重跑全绿；`setValue(` 恒为 4 处且无 WS 分支 → 第 2 轮「WS 从不回写编辑器」结论保持。
- 与发布流程相关的两件事（与代码无关）：①校正 `DRAFT_PUBLISH_CUTOFF`；②按需考虑 R3-1 的默认值收敛。

*第 3 轮复验完成。所有结论均来自本轮独立执行的命令/进程输出，未采信开发者自报证据。*
