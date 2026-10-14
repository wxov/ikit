# 完善⑤ · P2-lite 三项（远端 sha256 必校验 / 危险 API 启发式扫描 / 插件拖拽排序实时预览）· 技术方案

> **角色**：技术负责人
> **状态**：方案（仅分析与方案文档，**不改代码、不 git 操作**）
> **分支**：develop
> **依据**：`docs/ai-delivery/完善③-插件生态评估.md`（§五 P2、§六 D1-D7 决策）、`docs/ai-delivery/acceptance-report-完善③P1-插件导出导入.md`（§九 观察①「缺 sha256 仍 warn 放行」）、`docs/需求功能总览.md`（模块 ④、`:226`/`:228`/`:373`）

---

## 0. 结论速览

| 项 | 一句话方案 | 新增文件 | 无新依赖 |
|---|---|---|---|
| ① 远端缺 sha256 → 拒装 | `installRemote` 把「warn 放行」改为「**下载前**前置校验 + 下载后强比对」；`store()` 对缺 sha256 的远端条目输出 `installable:false` + `blockedReason`；**本地 import 保持 warn 放行**（理由见 §3.2） | `src/errors.ts` | ✅ |
| ② 危险 API 启发式扫描 | 新增纯函数 `scanner.ts`（11 条规则、两遍匹配降低误报），在 `installFilesAtomically` **落盘前**扫描；结果写入 `PluginRecord.scanWarnings/scannedAt`，随 `store()`/`/api/plugins` 返回，安装/导入响应新增顶层 `scan`；**警告级、不阻断** | `src/scanner.ts` | ✅（零依赖、纯正则） |
| ③ 拖拽排序 + 实时预览 | 前端原生 DnD + 拖动中乐观 splice（即时预览）+ `provide` 回调让 App.vue 顶部 nav / 移动端 tabbar 同步；提交点 `dragend`、失败回滚；触控用 ⬆/⬇ 按钮兜底；**不引入拖拽库**；后端仅补 `setOrder` 写盘失败回滚 | — | ✅ |

- **总计**：后端 3 个包 4 个文件（新增 2 + 改 2），前端 3 个文件，文档 2-3 处。
- **契约变化**：全部为**可选字段/加法**（`PluginRecord`/`PluginStoreItem`/`PluginPackageInfo` 新字段、install/update/import 响应新增 `scan`、错误响应新增 `code`），旧数据与旧前端不崩。
- **破坏性变更**：仅 1 处**内部**服务签名（`install/update/importPackage` 返回 `PluginInstallResult`），唯一消费方是 `packages/api/src/routes.ts`（3 处），tsc 全量构建可兜住；备选方案见 §10-3。
- **待确认问题**：4 条，均已给推荐默认，见 §10。

---

## 1. 现状事实与关键发现（决定改法）

| # | 事实 | 证据（develop 现状） |
|---|---|---|
| 1 | 远端安装对 sha256 是「提供则强校验、未提供 warn 放行」 | `service.ts:422-426`（`installRemote`）；`service.ts:637-641`（`importPackage`） |
| 2 | 树哈希语义是「解压后文件树」而非 zip 字节 | `utils.ts:30-39` `sha256OfFileTree`（排序后 `relPath\0content`）；`packaging.ts:154` 返回 `treeSha256` |
| 3 | 远端目录条目缺 sha256 时**不会**被丢弃，只是进不来校验 | `service.ts:47-70` `sanitizeRemoteRegistry`（`sha256: typeof p.sha256 === 'string' ? p.sha256 : undefined`）；`service.ts:211-214` 透传进 store |
| 4 | **导入与远端安装共用唯一落盘点**，是插入扫描的最佳位置 | `service.ts:312-382` `installFilesAtomically`（被 `:427` 与 `:642` 调用） |
| 5 | 落盘前已完成 zip 全量校验（路径穿越/炸弹/符号链接/manifest/entry 存在性） | `packaging.ts:78-155` `validateZipBuffer` → 进入 `installFilesAtomically` 时 `files` 已可信结构 |
| 6 | 注册表写入是单点 upsert，且 loader 也走它 | `service.ts:262-309` `upsertPackage`；`index.ts:70-82`（loader 上报）→ 扫描字段必须「undefined 不清空」，否则 `loadAll` 会抹掉 |
| 7 | 已装第三方包（含 local/remote）在 `store()` 有独立分支，需同步镜像新字段 | `service.ts:221-243` |
| 8 | 安装/导入/更新路由的 catch 只回 `{error}`，无机器可读码 | `routes.ts:342-353`、`:373-384`、`:394-404` |
| 9 | 安装/导入响应已带全量 `plugins` + `store` | `routes.ts:348`、`:379`、`:399` → 警告可随记录返回，也可另加顶层 `scan` |
| 10 | **`list()`/`setOrder()` 返回的都是未按 `order` 排序的原始数组**（`config.plugins` 插入序），前端 `plugins.value = r.plugins` 会「跳回」 | `service.ts:456-458`、`:485-494`；前端 `PluginSettings.vue:21`、`:37`、`:45`、`:58` → **拖拽后刷新不保持**的隐藏 bug，③ 必须一并修 |
| 11 | 拖拽已有雏形但无预览、无回滚、无触控兜底 | `PluginSettings.vue:48-60`（`onDragStart`/`onDrop`）、`:75-83`（原生 `draggable`）、`:89`（显示 `order`） |
| 12 | 顶部功能 nav 与移动端 tabbar 顺序 = `plugins` ref 的数组顺序；`provide` 已在用 | `App.vue:63`、`:164`（`features`）、`:380-391`、`:560-591`；`provide` 见 `:299-303` |
| 13 | 插件管理页与排序接口均已 admin 门控 | `App.vue:490`（`tab === 'manager' && admin`）；`routes.ts:308-314`（403） |
| 14 | 无拖拽库 | `apps/web/package.json:20-39`（无 sortable/vuedraggable） |

---

## 2. 关联影响检查（AGENTS.md 要求）

### 2.1 依赖关系

- **服务消费方**（`ctx.set('pluginRegistry', …)`，`index.ts:63`）：
  - `packages/api/src/routes.ts`（`:283-412`，全部插件/商店路由）；
  - `packages/plugins/store-data/src/service.ts:29`（只读 `list().length`，不受本方案影响）；
  - `packages/core/src/index.ts:41`（`Context.pluginRegistry` 类型声明 → 只依赖 `PluginRegistryService` 接口，返回值改型会被 tsc 检查到）。
- **反向联动**（loader hooks，`index.ts:86-92`）：`onEnable/onDisable/onUninstall/onLoadOne/onReloadOne` → 本方案**不新增钩子**；② 的扫描在 service 层完成，不进入 loader。
- **事件/WS**：本方案**不新增/不修改** `ctx.emit` 事件与 WS 广播（插件列表变更前端仍靠显式刷新，与现状一致）。
- **新增依赖**：**无**（①③ 零依赖；② 仅用 `node:crypto` 已有的正则文本处理，不引入 AST 解析器）。

### 2.2 共享契约（需同步的重复定义）

| 契约 | 后端定义 | 前端副本（手写，必须同步） | 本方案变化 |
|---|---|---|---|
| `PluginRecord` | `plugin-registry/src/types.ts:7-46` | `apps/web/src/lib/plugins.ts:8-17` | +`scanWarnings?` +`scannedAt?` |
| `PluginStoreItem` | `plugin-registry/src/types.ts:89-121` | `apps/web/src/lib/plugins.ts:61-80` | +`installable?` +`blockedReason?` +`scanWarnings?` +`scannedAt?` |
| `PluginPackageInfo` | `plugin-registry/src/types.ts:49-63` | 无（服务内部 + loader 上报） | +`scanWarnings?` +`scannedAt?` |
| `RemoteRegistryPlugin` | `plugin-registry/src/types.ts:66-78` | 无 | 无字段变化，仅注释明确 `sha256` 必填 |
| `PluginRegistryService` | `plugin-registry/src/types.ts:167-198` | 无（前端只调 REST） | `install/update/importPackage` 返回 `PluginInstallResult`；新增 `PluginInstallResult`/`ScanSummary` 类型 |
| REST 响应 | `packages/api/src/routes.ts:327-412` | `lib/plugins.ts:82-113` | install/update/import 增 `scan?`；错误响应增 `code?` |
| 持久化结构 | `plugins.json`（`store.ts:15-34` 全量 JSON 读写、无 schema 校验） | — | 新增可选键，旧文件兼容（多余/缺失键均无害） |
| `plugin.json` manifest | `loader.ts:13-27`、`packaging.ts:138-152` | — | **不加** scan 字段（见 §4.3 非目标：不允许插件自证清白） |

### 2.3 前端联动

| 文件 | 现状行号 | 影响 |
|---|---|---|
| `apps/web/src/components/PluginStore.vue` | `:55-68`（安装）、`:70-83`（更新）、`:118-148`（导入）、`:211-246`（卡片）、`:275-332`（详情） | ① 不可安装禁用 + blockedReason；② 黄色警示条（卡片/详情/安装结果） |
| `apps/web/src/components/PluginSettings.vue` | `:1-63`（脚本）、`:65-110`（模板）、`:112-226`（样式） | ③ 拖拽预览/回滚/admin 门控/⬆⬇ 按钮；②（可选）列表小黄点 |
| `apps/web/src/App.vue` | `:102-123`（`refreshPlugins`）、`:164`（`features`）、`:299-303`（provides）、`:380-391`、`:560-591` | ③ 新增 `previewPluginOrder` 并 `provide`；nav/tabbar 顺序随之即时变化 |
| `apps/web/src/lib/plugins.ts` | `:8-17`、`:61-80`、`:88-113` | ①② 类型与返回值同步 |

### 2.4 配置项

- **默认不新增任何配置项**（① 严格拒装，无豁免开关）。
- 若采纳 §10-2 的备选（本地调试豁免），则需同步 3 处：`plugin-registry/src/index.ts`（`Config` + env）、`.env.example:40-42` 邻域、README 环境变量表。**推荐不采纳**。

### 2.5 存储与迁移

- `plugins.json` 通过 `JsonPluginStore`（`store.ts:15-34`）整体读写，**无字段映射、无迁移函数**：新增可选键对旧记录**天然兼容**（读到时为 `undefined`）。
- `ensureLoaded`（`service.ts:86-114`）的迁移范式（`:96-111`）本期**不需要新增迁移**；扫描字段按「缺失 = 未扫描」语义处理。
- 旧记录（已安装、无 `scanWarnings/scannedAt`）在前端语义：**不显示黄色警示条**，详情页显示灰色「未进行安全扫描（安装于本功能上线前）」。不做启动时全量补扫（避免启动抖动与不可预期的 CPU 占用），旧包在下次**重装/更新**时自然获得扫描结果。
- 不涉及 SQLite（插件注册表仅 JSON）。

### 2.6 文档同步（落地后执行）

| 文件 | 行号 | 改动 |
|---|---|---|
| `docs/需求功能总览.md` | `:226`（P1 行后追加 P2-lite 行） | 记录三项已完成 + 实现位置 |
| 同上 | `:228`（B 项） | 删除「危险 API 扫描 / 拖拽实时预览**未实现**」，改为「已实现（P2-lite 2026-09）」；保留 ed25519 签名未实现 |
| 同上 | `:215-221`（实现位置） | 追加 `src/scanner.ts`、`src/errors.ts` |
| 同上 | `:373`（第六节第 3 项） | P2 拆分：P2-lite 三项已完成，剩 ed25519 签名 / 自建市场 / 沙箱 |
| `README.md` | `:234-242`（API 表） | `plugin-store` 行补「缺校验值远端条目 `installable:false`」；install/update 行补「远端必须 sha256」；install/import/update 行补响应含 `scan` |

---

## 3. 项 ①：远端 registry/packageUrl 缺 sha256 → 拒装

### 3.1 目标 / 非目标

**目标**

1. 远端安装（`registry.json` 条目来源、`packageUrl` 显式来源、以及二者共用的 `update`）**必须携带 `sha256`**，缺失或格式非法**一律拒装**，错误信息明确可操作。
2. `GET /api/plugin-store`（含 `refresh` 后返回的 store）对缺 `sha256` 的**远端**条目标注「不可安装 / 缺少校验值」，前端按钮禁用并给出原因。
3. 校验时机前移：**下载前**先校验「有无 + 格式」，避免白下载；下载解压后仍做**严格内容比对**。

**非目标**

- 不引入 ed25519 签名、来源域名白名单（P2 后续独立立项，见评估 §五）。
- **不改本地 `import` 的 warn 放行语义**（差异确认见 §3.2）。
- 不要求内置 `STORE_CATALOG` 7 条（`catalog.ts:11-96`，纯元数据「假安装」，无 artifact）提供 sha256。
- 不新增本地调试豁免开关（默认；见 §10-2）。

### 3.2 差异确认：为什么「远端必须、本地 import 可缺省」

| 维度 | 远端安装（registry / packageUrl） | 本地 import（管理员上传 zip） |
|---|---|---|
| 信任来源 | 第三方托管（GitHub Releases / CDN / 任意 https 站点），**跨网络、不可控** | 管理员本机文件，**人工动作 + 本地信任**（D5：仅 admin + 二次确认 + 风险提示） |
| sha256 的作用 | 唯一的**防篡改**手段（P1 未上签名）→ 缺失即「零内容校验」，属供应链风险 | 仅「完整性自校验」；管理员本就可直接放目录，强制哈希不增加实际安全边界 |
| 现有闭环 | 无依赖，收紧即可 | `GET /:name/export` 产出的 zip 客户端并不计算哈希；`routes.ts:375` 的 `sha256` 本就是可选 → 强制会打断「导出→导入」闭环，并需同步改前端与文档 |
| 缺失时的处置（本期） | **拒装**（400 + code） | **保持 warn 放行**，并在导入二次确认文案里明示「未提供 sha256：未做完整性校验」（1 行文案增强，推荐做） |

> 结论：远端 = 「不可信来源必须有内容哈希」；本地 import = 「已确认信任的人工动作，哈希可选」。二者语义不同，**保留差异**，并在 README/总览中写明。

### 3.3 逐文件改动清单

**`packages/plugins/plugin-registry/src/errors.ts`（新增，约 20 行）**

| 内容 | 说明 |
|---|---|
| `export class PluginError extends Error { constructor(message: string, readonly code: string) }` | 运行时可抛的带码错误 |
| `export const PLUGIN_ERR = { SHA256_REQUIRED: 'PLUGIN_SHA256_REQUIRED', SHA256_INVALID: 'PLUGIN_SHA256_INVALID', SHA256_MISMATCH: 'PLUGIN_SHA256_MISMATCH' } as const` | 错误码常量（前后端/文档统一引用） |

**`packages/plugins/plugin-registry/src/utils.ts`**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:21-23` 之后 | `sha256Of` 结束 | **新增** `export const SHA256_HEX_RE = /^[0-9a-f]{64}$/` 与 `export function isSha256Hex(v: unknown): v is string`（小写规范化后判定；`assertSha256` 已是小写比对） |

**`packages/plugins/plugin-registry/src/service.ts`**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:385-405` | `installRemote` 校验 url 协议 | **新增前置校验**（协议校验之后、`fetch` 之前）：`const expected = String(input.sha256 ?? '').trim()`；空 → 抛 `PluginError('远端安装必须提供 sha256 校验值（来源：<url 的 host>）。请在目录条目（registry.json）或安装参数中携带 sha256 后重试', PLUGIN_ERR.SHA256_REQUIRED)`；非 `isSha256Hex` → 抛 `PLUGIN_ERR.SHA256_INVALID`（文案含实际长度/首 8 字符） |
| `:422-426` | `if (input.sha256 && trim) assertSha256(...) else console.warn(without sha256)` | **删 warn 分支**，改为无条件 `assertSha256(expected, treeSha256)`（`expected` 已在前面确保合法非空） |
| `:418` | `const { manifest, files, treeSha256 } = validateZipBuffer(zipBuf)` | 不变（校验链保留） |
| `:570-575` | 远端目录条目分支：`installRemote({ name, packageUrl: remote.packageUrl, sha256: remote.sha256 })` | **新增前置判断**：`if (!remote.sha256) throw new PluginError('目录条目「'+name+'」缺少 sha256 校验值，已按安全策略禁止安装（请在 registry.json 为该版本补充 sha256）', PLUGIN_ERR.SHA256_REQUIRED)`，再走 `installRemote`（错误信息比通用文案更精确） |
| `:544-546` | 显式 `packageUrl` 分支 | 不改（由 `installRemote` 前置校验拦截） |
| `:607-610` | `update` 的远端分支 | 不改调用，但 catch 包装文案为「更新失败：<原错误>」（见 §3.4） |
| `:200-220` | remote 条目 `enrich(...)`（`'remote'`） | **输出标注**：`installable: !!r.sha256`；`!r.sha256` 时 `blockedReason: '缺少 sha256 校验值，已按安全策略禁止安装'` |
| `:221-243` | 已装第三方包（local/remote）分支 | 对 `source==='remote' && !p.sha256` 的记录：`installable:false` + `blockedReason: '缺少 sha256，无法更新；卸载后从带校验值的目录源重装'`；其余条目 `installable: true` |
| `:47-70` | `sanitizeRemoteRegistry` 丢弃非法条目 | **保持**不丢弃缺 sha256 的条目（丢弃会让管理员看不到、无法排查）；在 `refreshRegistry` 成功后 `console.warn` 汇总「N 条远端条目缺少 sha256，已标记为不可安装」 |
| `:434-453` | `refreshRegistry` | 仅在成功路径追加上述 warn 汇总（不改错误降级逻辑） |

**`packages/plugins/plugin-registry/src/types.ts`**

| 行号 | 改动 |
|---|---|
| `:89-121` `PluginStoreItem` | 新增 `installable?: boolean`（`false` = 明确不可安装）、`blockedReason?: string` |
| `:66-78` `RemoteRegistryPlugin` | 注释明确：`sha256` 为**远端安装必填**（运行期强校验，缺失拒装）；字段本身保持可选（类型层允许读到缺值以生成 `blockedReason`） |

**`packages/api/src/routes.ts`**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:342-353` install | `catch → reply.code(400).send({ error })` | 改为 `send({ error: e?.message || '安装失败', code: e?.code })`（`code` 未定义时 JSON 会省略） |
| `:394-404` update | 同上 | 同上 |
| `:373-384` import | 同上 | 同上（本地 import 不会抛 sha256 错误，但保留统一结构） |
| `:327-329` / `:387-392` | 返回 `{ store }` | **不改**：`installable/blockedReason` 已随 store 元素返回（满足「列表或 refresh 时标注」） |

**`apps/web/src/lib/plugins.ts`**

| 行号 | 改动 |
|---|---|
| `:61-80` `PluginStoreItem` | 新增 `installable?: boolean`、`blockedReason?: string` |

**`apps/web/src/components/PluginStore.vue`**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:236`、`:320` 安装按钮 | `v-if="!p.installed"` → 可点 | 增 `:disabled="busy === p.name \|\| p.installable === false"`、` :title="p.blockedReason"` |
| `:230-234` 卡片 meta 区 | 作者/来源/版本 | 增：`p.installable === false` 时显示灰色标签「不可安装 · 缺校验值」（`title` 或点击详情展示 `blockedReason`） |
| `:34-37` `canUpdate` | `updateAvailable` | 增 `&& p.installable !== false`（远端缺 sha256 的条目不再显示「更新」按钮） |
| `:238`、`:323` 更新按钮 | `v-if="canUpdate(p)"` | 由 `canUpdate` 一并门控 |
| `:124` 导入二次确认 | 风险提示 | 追加一行：「本次导入未提供 sha256：未做完整性校验」（若前端后续支持填哈希则改为条件文案） |
| `:64`、`:79`、`:143` 错误展示 | `error.value = e.message` | 不变（`api()` 在 `!res.ok` 时抛 `res.text()` 原文，故 `code` 不直接可见；`error` 文案已明确可读。可选增强：`api()` 按 JSON 解析 `error` 字段——**本期不做**，避免影响所有既有接口的报错展示） |

### 3.4 契约变化（项 ①）

| 契约 | 变化 | 兼容性 |
|---|---|---|
| `GET /api/plugin-store` 元素 | 新增 `installable?: boolean`、`blockedReason?: string`（仅远端条目稳定出现；其它来源为 `true`/缺省） | 加法，旧前端忽略 |
| `POST /api/plugin-store/install`、`/import`、`/:name/update` 错误响应 | 新增 `code?: string`（`PLUGIN_SHA256_REQUIRED` / `PLUGIN_SHA256_INVALID` / `PLUGIN_SHA256_MISMATCH`），HTTP 仍为 **400** | 加法；不引入 4xx 新码，避免前端/文档连锁 |
| 成功响应 | **形状不变**（`{plugins, store}`；`scan` 由项 ② 追加） | 兼容 |
| `plugins.json` | 远端安装记录依旧写 `sha256`（原逻辑 `service.ts:374` 已写） | 兼容 |

### 3.5 边界与异常（项 ①）

| 场景 | 处置 | 文案 / 码 |
|---|---|---|
| registry 条目缺 sha256（`install {name}`） | 拒装（下载前） | `目录条目「hello」缺少 sha256 校验值，已按安全策略禁止安装（请在 registry.json 为该版本补充 sha256）` / `PLUGIN_SHA256_REQUIRED` |
| 显式 `{packageUrl}` 缺 sha256 | 拒装（下载前） | `远端安装必须提供 sha256 校验值（来源：example.com）。请在目录条目或安装参数中携带 sha256 后重试` / `PLUGIN_SHA256_REQUIRED` |
| sha256 格式非法（非 64 位 hex、含空格/大写以外的非法字符） | 拒装（下载前） | `sha256 格式非法（应为 64 位十六进制，当前长度 N）` / `PLUGIN_SHA256_INVALID`（大小写不敏感：先 `toLowerCase` 再判定） |
| 下载后内容不匹配 | 拒装 | `sha256 校验失败：期望 <前8位>…，实际 <前8位>…` / `PLUGIN_SHA256_MISMATCH`（`assertSha256` 内细化；仅扩展 message，不改签名） |
| 下载失败 / 超大 / zip 非法 | 维持现状（`下载失败: …` / `zip 超过 …`） | 400，无 `code` |
| **已安装但无 sha256 的旧远端插件**执行更新 | **同样拒装**（供应链一致） | 前端提示：`更新失败：…缺少 sha256…`；`blockedReason` 引导「卸载后从带校验值的目录源重装」 |
| 内置 7 条 catalog「假安装」 | 不受影响（`service.ts:548-569` 不走 `installRemote`） | — |
| `packageUrl` 指向 http（无 `allowHttp`） | 现状不变（协议校验在 sha256 前置校验**之前**） | 保留既有文案 |
| 前置校验失败时的磁盘状态 | **零副作用**（未 fetch、未 staging） | — |
| 校验失败时的磁盘状态 | `installFilesAtomically` 未执行 / 其 catch 清理 staging | 无 `.staging-*` 残留 |

---

## 4. 项 ②：危险 API 启发式扫描（警告级，不阻断）

### 4.1 目标 / 非目标

**目标**

1. 在**导入/远端安装解压校验通过后、落盘前**，对包内代码文件做启发式文本扫描，产出**人类可读警告列表**（含 `文件:行号` + 风险 + 建议）。
2. 结果落库：`PluginRecord.scanWarnings?: string[]`、`PluginRecord.scannedAt?: string`，随 `store()`、`/api/plugins`、`/api/plugins/visible` 返回；`POST /install`、`/import`、`/:name/update` 响应新增顶层 `scan`。
3. 前端在**插件详情**与**安装/导入结果**给出黄色警示条，**不阻断**安装。

**非目标**

- **不做沙箱/隔离**（`node:vm` 非安全边界，评估 §2.3 已论证；worker/进程边界另立项）。
- **不做运行时拦截/阻断**：扫描结果不改变安装结果（除扫描函数自身异常时降级为空警告）。
- 不扫 `node_modules`（导出已排除、导入 `MAX_FILES=200` 亦不含依赖树）、不做 AST/数据流分析、不做混淆还原。
- **不扫已安装旧包**（无 `scannedAt` 即「未扫描」，不启动时补扫）。
- **不允许插件通过 `plugin.json` 自报扫描结果**（`loader.ts` manifest 不加这两个字段），避免「自证清白」。
- 不承诺安全性：UI 与文档明示「启发式提示，**扫不到 ≠ 安全**」。

### 4.2 扫描规则表（模式 → 风险 → 建议）

> 实施口径：**两遍匹配**。*A 类（模块名型，需要字符串字面量）在**原文**上匹配；B 类（调用型）在 `stripCommentsAndStrings()` 后的文本上匹配*，以显著降低「注释/字符串里出现 `eval(`」这类误报，同时不破坏 `require('child_process')` 的识别。

| # | id | 级别 | 模式（示意正则） | 遍 | 风险说明 | 建议 |
|---|---|---|---|---|---|---|
| 1 | `child-process` | 高 | `\b(?:require\s*\(\s*\|from\s*\|import\s*\(\s*)['"](?:node:)?child_process['"]` | A | 可执行任意系统命令、启动子进程，等价于把宿主机 shell 交给插件 | 若确需外部命令，命令与参数写死白名单、绝不拼接外部输入 |
| 2 | `shell-exec` | 高 | `\.(execSync\|spawnSync\|execFileSync\|execFile\|spawn\|fork)\s*\(` | B | 同步/异步执行外部命令；同步版会阻塞事件循环 | 同上；异步版避免 `shell: true` |
| 3 | `eval` | 高 | `(?:^\|[^.\w$])eval\s*\(` | B | 动态执行字符串代码，可绕过一切静态检查 | 移除 `eval`，用映射表/显式分支替代 |
| 4 | `new-function` | 高 | `new\s+Function\s*\(` 或 `(?:^\|[^.\w$])Function\s*\(\s*['"]` | B | 与 `eval` 等价的构造器动态执行（含构造器链逃逸） | 同上 |
| 5 | `fs-destructive` | 中 | `(?:fs\|fsp\|fsPromises\|promises)\s*\.\s*(?:rm\|rmSync\|unlink\|unlinkSync\|rmdir\|rmdirSync)\s*\(` | B | 删除宿主机文件/目录（配合 `{recursive:true}` 可清空目录） | 仅操作自身包目录内路径，并先用 `isWithinDir` 校验 |
| 6 | `net-server` | 中 | `['"](?:node:)?(?:http\|https\|net\|dgram\|tls)['"]` | A | 打开网络端口/原始 socket/自建 HTTP 服务 → 数据外泄或后门入口 | 说明用途；出站请求限定白名单域名 |
| 7 | `process-exit` | 中 | `\bprocess\.exit\s*\(` | B | 可直接终止宿主 i-kit 进程（拒绝服务） | 改为抛错/返回，由主程序决定退出 |
| 8 | `dynamic-import` | 中 | `\bimport\s*\(\s*(?!['"\`])` 或 `\bimport\s*\([^)]*\+` | B | 运行期拼接路径加载代码 → 可加载远端/隐藏载荷 | 改为静态字面量 `import`（打包器可静态分析） |
| 9 | `env-enum` | 低 | `Object\.(?:keys\|entries\|values)\s*\(\s*process\.env` 或 `JSON\.stringify\s*\(\s*process\.env` 或 `process\.env\s*\[` 或同一文件静态读取 **≥5 个**不同 `process.env.X` | B | 批量读取环境变量 → 可能外泄密钥（LLM key 等） | 只读自身所需键；在 `plugin.json` 声明用途 |
| 10 | `tamper-manifest` | 中 | `['"]package\.json['"]` 出现在 `writeFile\|appendFile\|createWriteStream\|outputFile` 的 120 字符邻域；或写 `.sh\|.ps1\|.bat\|.cmd\|.service\|.desktop\|.plist` 字面量 | A+B | 篡改宿主依赖清单 / 写开机启动脚本（持久化） | 移除；插件自身配置写入自己的包目录 |
| 11 | `sandbox-primitive` | 中 | `\bprocess\.binding\s*\(\|\bprocess\.dlopen\s*\(\|\bnew\s+Worker\s*\(` 或模块 `['"](?:node:)?vm['"]` | A/B | 使用沙箱/底层逃逸原语（`vm`/`binding`/Worker），意图不透明 | 明确说明并评审；一般插件不需要 |

**为控制误报而显式舍弃的模式（取舍说明）**

- 舍弃裸 `.exec(`（`RegExp.prototype.exec` 极常见）。
- 舍弃裸 `process.env`（读 1-2 个配置键是插件正当能力）→ 仅 `env-enum` 的 4 个子条件触发。
- 舍弃裸 `fs.` / `require('fs')`（读写自身资源是插件正当能力）→ 仅 `fs-destructive` 的删除类 API 触发。
- 舍弃「base64 长串/`atob`+`eval` 组合」等混淆启发式（误报率高、收益低），仅在 `eval`/`new Function` 命中时一并提示「若为混淆代码，请人工评审」。
- 舍弃 `.exec(`、裸 `Function(` 之外的所有「字符串里出现关键字」匹配（靠 B 遍去字符串解决）。
- 每条规则的命中**不作为安装条件**（警告级），并在 UI 中明示定位。

**限额与产出**

- 目标文件：`manifest.entry` 指向的文件 + 包内全部 `.js/.cjs/.mjs/.ts`（`ENTRY_EXTENSIONS` 同源，`utils.ts:6`）；跳过含 `\0` 的二进制文件。
- 单文件文本 > 256KB → 截断到 256KB 并在结果里标 `truncated`（文件计入 `truncatedFiles`）；单条警告文本 ≤200 字符（snippet 截断到 80 字符并压平换行）。
- 每文件每规则最多 3 条；findings 总数 ≤50；**落库 warnings ≤20 条**（超出追加一条「另有 N 条警告未展示，详见安装响应」）。
- 落库 warning 格式：`[child-process] index.js:3 使用 child_process —— 可执行任意系统命令；建议：命令白名单、勿拼接外部输入`（**自包含**，前端无需二次映射规则表）。

### 4.3 逐文件改动清单（项 ②）

**`packages/plugins/plugin-registry/src/scanner.ts`（新增，约 160-200 行，纯函数、零依赖）**

| 导出 | 说明 |
|---|---|
| `interface ScanFinding { rule: string; level: 'high'\|'medium'\|'low'; file: string; line: number; snippet: string; risk: string; suggestion: string }` | 结构化命中（**仅随响应返回，不落库**） |
| `interface ScanSummary { warnings: string[]; scannedAt: string; scannedFiles: string[]; truncatedFiles: string[]; truncated: boolean }` | 落库 + 响应摘要 |
| `function scanPackageCode(files: {relPath:string; data:Buffer}[], entry: string): ScanSummary & { findings: ScanFinding[] }` | 主入口（同步；对每个文件做 A/B 两遍匹配） |
| `function stripCommentsAndStrings(src: string): string` | 去 `//`、`/* */`、`'…'`、`"…"`、`` `…` ``（保留换行以维持行号），用于 B 遍 |
| `const SCAN_RULES: ScanRule[]` | §4.2 规则表（单一数据源，文档/UI/测试共用） |

**`packages/plugins/plugin-registry/src/service.ts`**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:311-318` `installFilesAtomically` 签名 | `Promise<void>` | 改为 `Promise<ScanSummary>` |
| `:324` 之后（创建 staging 后、写文件循环 `:326` 前） | — | **新增**：`const scan = safeScan(files, manifest.entry)`（`safeScan` = try/catch 包裹 `scanPackageCode`，异常时返回 `{warnings:['安全扫描失败：<原因>（不影响安装）'], …}` 并 `console.warn`） |
| `:363-377` `upsertPackage({...})` | 传 manifest 元数据 + sha256 | **追加** `scanWarnings: scan.warnings`、`scannedAt: scan.scannedAt`；函数 `return scan`（成功路径） |
| `:262-309` `upsertPackage` | 更新既有记录 / 新记录 | 既有分支：`if (p.scanWarnings !== undefined) existing.scanWarnings = p.scanWarnings`、`if (p.scannedAt) existing.scannedAt = p.scannedAt`（**undefined 不清空**，保护 loader 上报路径）；新记录分支直接写入两字段 |
| `:173-192` `enrich()` | 组装 store 条目 | 追加 `scanWarnings: installed?.scanWarnings`、`scannedAt: installed?.scannedAt` |
| `:221-243` 已装第三方分支 | 组装 store 条目 | 同上追加两字段 |
| `:385-429` `installRemote` | `Promise<PluginRecord[]>`（隐式） | 改为 `Promise<PluginInstallResult>`：`installFilesAtomically` 的返回值作为 `scan` 一并返回（`{ plugins: config.plugins, scan }`）；**sha256 拒装逻辑见项 ①** |
| `:632-644` `importPackage` | 同上传入 `'local'` | 保持 warn 放行；返回 `{ plugins, scan }` |
| `:537-576` `install` | `Promise<PluginRecord[]>` | 返回 `PluginInstallResult`：catalog 假安装分支返回 `{ plugins }`（无 `scan`）；远端分支直接透传 |
| `:596-612` `update` | `Promise<PluginRecord[]>` | 返回 `PluginInstallResult`（catalog 分支 `{plugins}`；远端分支透传 `{plugins, scan}`） |

**`packages/plugins/plugin-registry/src/types.ts`**

| 行号 | 改动 |
|---|---|
| `:7-46` `PluginRecord` | 新增 `scanWarnings?: string[]`（安全扫描警告，人类可读）、`scannedAt?: string`（ISO 扫描时间）——置于 `updatedAt` 之后 |
| `:49-63` `PluginPackageInfo` | 同步新增两字段（供 `installFilesAtomically` → `upsertPackage` 传递） |
| `:89-121` `PluginStoreItem` | 同步新增两字段（+项 ① 的 `installable/blockedReason`） |
| `:155-165` 附近 | **新增** `interface ScanSummary`, `interface PluginInstallResult { plugins: PluginRecord[]; scan?: ScanSummary }` |
| `:167-198` `PluginRegistryService` | `install`/`update`/`importPackage` 返回类型改为 `Promise<PluginInstallResult>`（`uninstall/enable/setOrder/setGroups` 不变） |

**`packages/plugins/plugin-registry/src/loader.ts`｜`src/index.ts`**

| 文件/行号 | 改动 |
|---|---|
| `loader.ts:13-27` `PluginPackageManifest` | **不改**（不允许插件自报扫描结果） |
| `index.ts:70-82` loader `register` 回调 | **不改**（不传 scan 字段 → 依赖 `upsertPackage` 的「undefined 不清空」语义，避免 `loadAll` 抹掉扫描结果） |

**`packages/api/src/routes.ts`**

| 行号 | 改动 |
|---|---|
| `:342-353` install | `const { plugins, scan } = await ctx.pluginRegistry.install(body ?? {})`；`return { plugins, store: ctx.pluginRegistry.store(), scan }` |
| `:373-384` import | 同上（`scan` 随导入结果返回） |
| `:394-404` update | 同上 |
| `:290-295` `/api/plugins`、`:283-288` `/api/plugins/visible` | **不改**（`PluginRecord` 新增字段自动随 `list()`/`visibleFor()` 外发） |

**`apps/web/src/lib/plugins.ts`**

| 行号 | 改动 |
|---|---|
| `:8-17` `PluginRecord` | 新增 `scanWarnings?: string[]`、`scannedAt?: string`（**手写副本必须同步**） |
| `:61-80` `PluginStoreItem` | 同上两字段 |
| `:88-93` `installPlugin`、`:94-96` `updatePlugin`、`:100-106` `importPlugin` | 返回类型追加 `scan?: ScanSummary`（`{ warnings: string[]; scannedAt: string; scannedFiles: string[]; truncatedFiles: string[]; truncated: boolean }`，可仅声明用到的字段） |

**`apps/web/src/components/PluginStore.vue`**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:20-21` 状态 | `notice` / `error` | 新增 `result = ref<{ title: string; warnings: string[]; name: string } \| null>(null)`（安装结果横幅） |
| `:55-68` `install` | 成功后 `location.reload()` | 改为：`store.value = r.store`；`result.value = { title: p.title, warnings: r.scan?.warnings ?? [], name: p.name }`；**不再立即 reload**（横幅提供「刷新页面以启用」按钮） |
| `:70-83` `doUpdate` | 同上 | 同上 |
| `:118-148` `onImportFile` | 成功后 `location.reload()` | 同上（`warnings: r.scan?.warnings ?? []`；导入结果横幅是「导入结果也返回警告」的落点） |
| `:207-208` 通知区 | `notice` / `error` | 下方新增**黄色警示条**：`v-if="result"` → 标题「已安装/导入「X」成功」+ `warnings.length` 列表 + 说明「扫描为启发式提示，不构成安全保证」+ 按钮「刷新页面以启用」/「稍后」（`@click="result = null"`） |
| `:211-246` 卡片 | — | 新增 `v-if="p.scanWarnings?.length"` 黄色条：`⚠️ 该插件使用高风险 API（{{ p.scanWarnings.length }} 项），点击详情查看` |
| `:275-332` 详情弹窗 | — | 新增黄色区块：`scanWarnings` 逐条列出（`<ul><li>`）+ 免责说明；`p.scannedAt` 为空时显示灰色「未进行安全扫描（安装于本功能上线前）」 |
| `:336-437` 样式 | — | 新增 `.ps-warn`（黄底 `#fef3c7`/文字 `#92400e`/`border #fde68a`）、`.ps-warn li` 等；复用现有 `--panel/--border` 变量 |

**`apps/web/src/components/PluginSettings.vue`（可选、推荐做）**

| 行号 | 改动 |
|---|---|
| `:84-93` 条目头部 | 新增小黄点 `v-if="p.scanWarnings?.length"`（`title` 显示条数），让管理员一眼看到风险插件 |

### 4.4 契约变化（项 ②）

| 契约 | 变化 | 兼容性 |
|---|---|---|
| `PluginRecord`（`plugins.json` + `/api/plugins` + `/api/plugins/visible`） | +`scanWarnings?: string[]` +`scannedAt?: string` | 加法；旧记录读为 `undefined` = 未扫描 |
| `PluginStoreItem`（`/api/plugin-store`） | 同步两字段 | 加法 |
| `POST /api/plugin-store/install`、`/import`、`/:name/update` 成功响应 | +`scan?: { warnings: string[]; scannedAt: string; scannedFiles: string[]; truncatedFiles: string[]; truncated: boolean }` | 加法；`catalog` 假安装无 `scan` |
| 服务接口 `install/update/importPackage` | 返回 `Promise<PluginInstallResult>` | **内部改型**（唯一消费方 `routes.ts` 3 处，tsc 兜底）；备选见 §10-3 |
| `plugin.json` manifest / loader | 无变化 | 兼容（第三方无法伪造扫描结果） |

### 4.5 边界与异常（项 ②）

| 场景 | 处置 |
|---|---|
| 无命中 | `scan.warnings = []`；前端**不显示**任何提示（`v-if="length"`） |
| 命中多条 | 全部返回（≤50），落库 ≤20 条 + 溢出说明 |
| 扫描函数抛异常（正则/编码问题） | **不阻断安装**：`warnings = ['安全扫描失败：<原因>（不影响安装）']` + `console.warn`；仍写 `scannedAt` |
| 二进制文件 / 无扩展名文件 | 跳过（不报错） |
| 超大文件（>256KB） | 截断扫描 + `truncated:true` + `truncatedFiles` 记录；HTTP 响应可见，落库 warning 附加「（大文件已截断扫描）」 |
| 入口文件不存在 | 不可能到达（`validateZipBuffer:134-136` 已保证 entry 存在） |
| 命中但误报（如插件确有正当 `fs.rm` 清理自身缓存） | **不阻断**；管理员可继续安装/启用。忽略/白名单功能**不在本期**（列入 §10-1 备选） |
| 旧记录无 `scanWarnings` | 详情显示「未扫描」；列表/卡片无提示 |
| 更新（`update`）后 | 重新扫描并覆盖 `scanWarnings/scannedAt`（`upsertPackage` 传入新值） |
| 重装同名包 | 同上覆盖 |
| 卸载后重装 | 记录移除后新建，重新扫描 |
| 「扫不到 ≠ 安全」 | UI 免责文案 + README/总览措辞（本方案落笔） |

---

## 5. 项 ③：插件列表拖拽排序 + 实时预览

### 5.1 目标 / 非目标

**目标**

1. 「插件管理」列表支持拖拽排序，**拖动过程中即时预览**（松手前顺序已变），并让**顶部功能插件 nav**（`App.vue:380-391`）与**移动端 tabbar**（`:560-591`）顺序**同步变化**。
2. 松手后调用既有 `POST /api/plugins/order`（`routes.ts:308-314`）；成功后顺序持久化、**刷新页面保持**；失败**回滚**列表与 nav 并给出错误提示。
3. 仅 admin 可见/可拖；移动端（触控）**至少不报错**且可用（⬆/⬇ 按钮）。
4. 顺带修掉现状隐藏 bug：`/api/plugins` 与 `setOrder` 返回的是**未按 `order` 排序**的数组，导致拖拽后列表「跳回」（§1-#10）。

**非目标**

- 不引入拖拽库（`vuedraggable`/`SortableJS`），前端零新依赖。
- 不做跨分区拖拽（内置 `agent` 与第三方包混合排序即可满足需求；分组另立项）。
- 不做 pointer-events 版触控拖拽（首期用 ⬆/⬇ 按钮兑现「触控可用」）；见 §10-4。
- 不改后端排序语义（`order` 仍为「数组下标」序号，`setOrder` 只改 `order` 字段）、不新增排序 API。
- 不做多人并发排序冲突合并（JSON 存储 + 单管理员场景）。

### 5.2 逐文件改动清单（项 ③）

**后端 `packages/plugins/plugin-registry/src/service.ts`（唯一后端改动，推荐做）**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:485-494` `setOrder` | 逐项改 `p.order` → `await persist()` → `return config.plugins` | 在改动前快照 `const prev = config.plugins.map(p => [p.name, p.order] as const)`；`persist()` 包 try/catch，失败时**回滚内存 order** 后 `throw`（保证「写盘失败 → 服务端内存与磁盘一致」），成功则返回。返回数组**保持原语义**（前端自行 normalize） |

> 说明：`list()`（`:456-458`）返回未排序数组的问题，**由前端 normalize 解决**（避免改后端返回语义影响其它消费方）。若希望后端一并修，可在 `list()`/`setOrder()` 返回 `[...config.plugins].sort((a,b)=>a.order-b.order)`——**不建议本期做**（回归面大于收益）。

**`apps/web/src/components/PluginSettings.vue`（主要改动）**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:1-10` import | `ref, onMounted` + 4 个 API | 追加 `computed, inject`；`import type { ComputedRef } from 'vue'` |
| `:12-15` 状态 | `plugins/groups/loading/notice` | 追加：`dragIndex`、`dragging = ref(false)`、`saving = ref(false)`、`error = ref('')`、`baseline: string[] \| null` |
| `:13` 附近 | — | 追加 `const userRole = inject<ComputedRef<string>>('userRole', computed(() => 'guest'))` + `const isAdmin = computed(() => userRole.value === 'admin')`（`provide` 见 `App.vue:301`） |
| `:13` 附近 | — | 追加 `const orderSync = inject<{ preview(names: string[]): void; refresh(): void } \| null>('pluginOrderSync', null)`（App.vue 新增，见下） |
| `:17-33` `load` | `plugins.value = r.plugins` | 改为 `plugins.value = normalize(r.plugins)`；`dragging.value` 为真时**忽略**本次响应（防拖拽期间竞态覆盖） |
| `:35-38` `toggleEnabled`／`:40-46` `toggleGroup` | `plugins.value = r.plugins` | 同样 `normalize(r.plugins)`（否则启停/改可见性后顺序跳回） |
| `:48-60`（原 `dragIndex` + `onDragStart` + `onDrop`） | 原生 DnD，无预览/无回滚 | **重写**为：`normalize(list)` 助手；`namesOf()`；`previewMove(from, to)`（本地 splice + 调 `orderSync?.preview(names)`）；`onDragStart(i, e)`（非 admin 直接 return；快照 `baseline`；`dataTransfer.effectAllowed='move'` + `setData('text/plain', name)`——Firefox 必需）；`onDragOver(i, e)`（`preventDefault`；`dragIndex !== i` 时 `previewMove` 并更新 `dragIndex`）；`onDragEnd(e)`（`dropEffect === 'none'` 视为取消 → 回滚；否则 `commit()`）；`cancel()`；`commit()`（`saving=true` → `setPluginOrder(names)` → `plugins.value = normalize(r.plugins)` + `orderSync?.refresh()` → catch 回滚 `baseline` + `error.value='排序保存失败：'+e.message` → finally 复位）；`step(i, dir)`（⬆/⬇ 走同一 `commit` 通路，复用乐观预览） |
| `:52-60`（原 `onDrop`） | — | 删除（提交点统一为 `dragend`，可覆盖「拖出窗口」与「Esc」） |
| `:62` `onMounted(load)` | — | 不变 |
| `:71` notice 区 | `notice` | 追加 `error`（红色）与 `saving` 提示（「保存中…」） |
| `:74` 列表容器 | `.ps-list` | 容器级 `@dragover.prevent`（可选，避免拖到空白处无反馈） |
| `:75-83` 条目 | `draggable="true"` `@dragstart` `@dragover.prevent` `@drop` | 改为 `:draggable="isAdmin"`；`@dragstart="onDragStart(i, $event)"`、`@dragover.prevent="onDragOver(i, $event)"`、`@dragend="onDragEnd($event)"`；`:class="{ dragging: dragging && dragIndex === i, saving }"`；`@drop.prevent`（仅阻止默认，不再作为提交点） |
| `:84-93` 条目头部 | 拖动柄 `⠿` + 名称 + 版本 + order + 启停 | 追加 ⬆/⬇ 按钮（`:disabled="i === 0"` / `i === plugins.length - 1` 或 `saving`），始终渲染（触控与键盘可达），小尺寸 ghost 样式；保留 order 数字显示便于验证 |
| `:112-226` 样式 | — | 新增 `.ps-item.dragging { opacity: .5 }`、`.ps-item.saving { border-style: dashed }`、`.ps-move`（按钮）等；**不**依赖媒体查询即可用（按钮常显） |

**`apps/web/src/App.vue`**

| 行号 | 现状 | 改动 |
|---|---|---|
| `:102-123` `refreshPlugins` | 拉 `/api/plugins/visible` 并按可见性校正 tab | **不改**（供 `orderSync.refresh()` 复用） |
| `:164` 之后 | `features = computed(() => plugins.value)` | **新增** `function previewPluginOrder(names: string[])`：建立 `name → 排序下标` 映射，把 `plugins.value` 按该下标**稳定排序**（不在 `names` 中的项保持相对位置并排在其后）；**仅本地、不发请求**；同时赋值 `plugins.value = next` |
| `:299-303` provides | `provide('events'/'canWrite'/'userRole'/'username'/'currentUser')` | **新增** `provide('pluginOrderSync', { preview: previewPluginOrder, refresh: refreshPlugins })` |
| `:380-391`、`:560-591` 模板 | `v-for="p in features"` | **不改**（顺序由 `plugins.value` 决定 → 预览与提交后自动同步） |
| `:490` 插件管理挂载 | `tab === 'manager' && admin` | **不改**（admin 门控已满足「非 admin 不可拖」的第一层） |

**`apps/web/src/lib/plugins.ts`**

| 行号 | 改动 |
|---|---|
| `:37-43` `setPluginOrder` | 不改签名；调用方在 `PluginSettings` 内 normalize |
| `:8-17` `PluginRecord` | 仅项 ② 的字段（③ 无新字段） |

### 5.3 契约变化（项 ③）

| 契约 | 变化 |
|---|---|
| HTTP | **无变化**（沿用 `POST /api/plugins/order  {ordered: string[]}` → `{plugins: PluginRecord[]}`，`routes.ts:308-314`） |
| 服务 | `setOrder` 返回语义不变；仅新增「写盘失败回滚内存」的健壮性行为（失败仍抛错 → 路由 500/400 由 Fastify 处理，前端走回滚分支） |
| 前端内部 | 新增 `provide('pluginOrderSync')` 契约（App.vue ↔ PluginSettings.vue 单点约定，不涉前后端） |

### 5.4 边界与异常（项 ③）

| 场景 | 处置 |
|---|---|
| 拖到自身位置 / 未移动 | `dragIndex === i` → 不预览、不请求（no-op） |
| 拖动中按 Esc 或拖出窗口 | `dragend` 触发且 `dataTransfer.dropEffect === 'none'` → 视为取消：恢复 `baseline`（本地 + nav），**不发请求** |
| 排序保存失败（网络 / 403 / 500 / 写盘失败） | 恢复 `baseline` 列表顺序 + `orderSync.preview(baseline)` 回滚 nav + 红字「排序保存失败：…」；服务端 `setOrder` 已保证失败时内存/磁盘一致（§5.2 第 1 行） |
| 保存中重复拖动 | `saving === true` 时忽略 `dragstart` 与 ⬆/⬇ 点击 |
| 拖拽期间 `load()` 返回（如组件重挂载/竞态） | `dragging === true` 时忽略响应，避免覆盖预览 |
| 移动端触控 | 原生 DnD 在触控下不触发（**不报错**）；⬆/⬇ 按钮保证可排序（同一乐观预览 + 回滚通路） |
| 非 admin | ① 页面不可进入（`App.vue:490`）；② `:draggable="isAdmin"`；③ `POST /api/plugins/order` 返回 **403 `{error:'需要站主权限'}`**（`routes.ts:309-311`） |
| 仅 1 个插件 | 拖拽/⬆⬇ 均无副作用（按钮禁用） |
| `ordered` 缺项（防御） | 前端始终提交**完整** `plugins.value.map(p=>p.name)`（与 `setOrder` 语义一致） |
| 刷新后顺序 | 前端 `normalize()` 按 `order` 升序渲染 → 与持久化一致（**修掉现状跳回 bug**） |

---

## 6. 逐文件改动清单汇总（三项索引）

| # | 文件 | 主要行号 | 改动要点 | 项 |
|---|---|---|---|---|
| 1 | `packages/plugins/plugin-registry/src/errors.ts` | 新增 | `PluginError(code)` + `PLUGIN_ERR` | ① |
| 2 | `packages/plugins/plugin-registry/src/scanner.ts` | 新增 | 规则表 + 两遍扫描 + `ScanSummary/ScanFinding` | ② |
| 3 | `packages/plugins/plugin-registry/src/utils.ts` | `:21-23` 后 | `SHA256_HEX_RE` + `isSha256Hex` | ① |
| 4 | `packages/plugins/plugin-registry/src/service.ts` | `:47-70` | `sanitizeRemoteRegistry` 保留缺 sha256 条目 + refresh 汇总 warn | ① |
| 5 | 同上 | `:173-192`、`:221-243` | `enrich`/第三方分支镜像 `installable/blockedReason/scanWarnings/scannedAt` | ①② |
| 6 | 同上 | `:262-309` | `upsertPackage` 写 scan 字段（undefined 不清空） | ② |
| 7 | 同上 | `:311-382` | `installFilesAtomically` 落盘前扫描 + 返回 `ScanSummary` | ② |
| 8 | 同上 | `:385-429` | `installRemote` 前置 sha256 校验 + 删 warn 分支 + 返回 `{plugins, scan}` | ①② |
| 9 | 同上 | `:485-494` | `setOrder` 写盘失败回滚内存 order | ③ |
| 10 | 同上 | `:537-576`、`:596-612`、`:632-644` | `install/update/importPackage` 返回 `PluginInstallResult` | ①② |
| 11 | `packages/plugins/plugin-registry/src/types.ts` | `:7-46`、`:49-63`、`:89-121`、`:155-198` | 新字段（`scanWarnings/scannedAt/installable/blockedReason`）+ 新类型 + 接口返回改型 | ①② |
| 12 | `packages/api/src/routes.ts` | `:342-353`、`:373-384`、`:394-404` | 响应加 `scan`；catch 加 `code` | ①② |
| 13 | `apps/web/src/lib/plugins.ts` | `:8-17`、`:61-80`、`:88-106` | 类型同步 + `scan` 返回类型 | ①② |
| 14 | `apps/web/src/components/PluginStore.vue` | `:20-21`、`:34-37`、`:55-148`、`:207-248`、`:275-332`、样式 | 不可安装禁用 + 黄色警示条 + 安装/导入结果横幅（不立即 reload） | ①② |
| 15 | `apps/web/src/components/PluginSettings.vue` | `:1-63`、`:65-110`、`:112-226` | 拖拽预览/回滚/⬆⬇/admin 门控/normalize | ③ |
| 16 | `apps/web/src/App.vue` | `:164` 后、`:299-303` | `previewPluginOrder` + `provide('pluginOrderSync')` | ③ |
| 17 | `docs/需求功能总览.md`、`README.md` | 见 §2.6 | 文档同步 | ①②③ |

**明确不改**：`packaging.ts`（校验链与 `assertSha256` 复用，仅 `assertSha256` 文案细化）、`catalog.ts`、`store.ts`、`loader.ts`（manifest 不加 scan 字段）、`core/src/index.ts`、`store-data`、`plugins/hello`。

---

## 7. 契约变化汇总（对外）

| 契约面 | 变化 | 兼容策略 |
|---|---|---|
| `PluginRecord`（HTTP + `plugins.json`） | +`scanWarnings?`、+`scannedAt?` | 全可选；旧记录 `undefined` = 未扫描 |
| `PluginStoreItem`（`/api/plugin-store`） | +`installable?`、+`blockedReason?`、+`scanWarnings?`、+`scannedAt?` | 全可选；旧前端忽略 |
| install/update/import 成功响应 | +`scan?: ScanSummary` | 加法；catalog 分支无该字段 |
| install/update/import 失败响应 | +`code?: string`（3 个 sha256 码） | 加法；HTTP 仍 400 |
| 服务接口 | `install/update/importPackage` → `Promise<PluginInstallResult>` | 内部改型，唯一消费方 routes（3 处） |
| 前端手写类型副本 | `lib/plugins.ts` 两处接口同步 | AGENTS.md 要求，验收 grep 核对 |
| 前端内部 provide | `pluginOrderSync`（App.vue → PluginSettings.vue） | 单点约定，不涉前后端 |

---

## 8. 验收标准（可操作 AC）

> 前置：`develop`，`PLUGIN_DIR=./plugins`，admin 会话（`Authorization: Bearer <token>`）。获得「正确树哈希」的推荐办法：先本地 `export`→`import`（无需 sha256）后，从 `GET /api/plugin-store` 或 `data/plugins.json` 读取该包的 `sha256`（`importPackage` 会把 `treeSha256` 写入记录，`service.ts:374`）。

### ① 远端 sha256 必校验

1. **缺 sha256 的远端条目被标注**：`registry.json` 含 `{name:"hello",packageUrl:"https://<host>/hello.zip",version:"1.0.0"}`（无 sha256）→ `POST /api/plugin-store/refresh`（admin）200 → `GET /api/plugin-store` 中该条 `source:"remote"`、`installable:false`、`blockedReason` 含「缺少 sha256」。
2. **缺 sha256 拒装（registry 来源）**：`POST /api/plugin-store/install {"name":"hello"}` → **HTTP 400**，body 含 `code:"PLUGIN_SHA256_REQUIRED"` 且 `error` 含 `sha256`；随后 `plugins/hello` 不存在（或未被改动），`plugins/` 下无 `.staging-*`/`.backup-*` 残留。
3. **缺 sha256 拒装（packageUrl 来源）**：`POST {"packageUrl":"https://<host>/hello.zip"}` → 同 AC-2（且**未发生网络下载**，服务端无 fetch 日志）。
4. **格式非法拒装**：`{"packageUrl":"…","sha256":"abc123"}` → 400 + `code:"PLUGIN_SHA256_INVALID"`。
5. **带正确 sha256 正常安装**：`{"name":"hello"}`（registry 条目补齐正确 sha256）→ 200；`plugins/hello/index.ts` 落盘、服务热载、`GET /api/plugin-store` 该条 `installed:true`、`plugins.json` 记录 `sha256` 等于所填值。
6. **哈希不匹配拒装**：sha256 改为 64 位但错误的值 → 400 + `code:"PLUGIN_SHA256_MISMATCH"`，磁盘无半状态。
7. **本地 import 差异确认**：`POST /api/plugin-store/import {data:"<base64 zip>"}`（无 sha256）→ **200 安装成功**，服务端日志出现 `without sha256` warn；响应 `scan` 存在（项 ② 联调）。
8. **catalog 回归**：`{"name":"notes"}` → 200（仅注册标记，行为与 P1 一致）。

### ② 危险 API 扫描（警告不阻断）

9. **命中给警告且安装成功**：构造 zip（`index.js` 含 `require('child_process')` + `child_process.execSync('ls')` + `process.exit(1)` + `fs.rm(dir,{recursive:true})`）→ `POST /import` → **200**；响应 `scan.warnings` 至少含 `child-process`/`shell-exec`/`process-exit`/`fs-destructive` 四类（含 `index.js:<行号>`）；`GET /api/plugin-store` 该条 `scanWarnings.length > 0`、`scannedAt` 为 ISO 时间。
10. **无命中无警告**：仅 `ctx.set('x', …)` 的干净包 → `scan.warnings` 为空（或 `undefined`），前端无黄色条。
11. **前端警示条（不阻断）**：安装/导入成功后出现黄色横幅列出 warnings，插件已在列表、可启用/卸载；详情弹窗逐条展示 warnings；卡片显示「高风险 API（N 项）」。
12. **误报取舍验证**：包内仅含 `// 不要用 eval(` 注释、`const s = "eval(1)"` 字符串、`/abc/.exec(str)`、单个 `process.env.HOME` → **不产生** `eval`/`shell-exec`/`env-enum` 警告（验证「去注释去字符串」与规则取舍）。
13. **旧数据兼容**：手工在 `data/plugins.json` 保留一条无 `scanWarnings/scannedAt` 的旧记录 → 启动/接口正常、前端不崩、详情显示「未扫描」。
14. **扫描失败不阻断**（可选）：放入一个 300KB 的 `.js`（含危险模式）→ 安装成功，warning 含「大文件已截断扫描」或安装仍 200。

### ③ 拖拽排序 + 实时预览

15. **即时预览**：admin 打开底部「插件 → 插件管理」，按住条目上移 → **松手前**列表顺序已变，且 `order` 数字随预览更新。
16. **nav 同步**：同一拖动过程中，顶部功能插件 nav（与窄屏底部 tabbar）顺序**同步变化**。
17. **持久化且刷新保持**：松手 → `POST /api/plugins/order` 返回 200；`F5` 后顺序与拖动结果一致；`data/plugins.json` 中各插件 `order` 与新顺序一致（0..n-1）。
18. **失败回滚**：断开网络（或把 token 换成 user）后拖动 → 列表与 nav 均回到拖动前顺序，出现「排序保存失败：…」；`data/plugins.json` 未改变。
19. **非 admin 不可拖**：非 admin 会话登录 → 底部无「插件」入口、无法进入插件管理页；直接 `POST /api/plugins/order`（user token）→ **403 `{error:'需要站主权限'}`**。
20. **触控可用**：移动端/触控模拟下长按拖动无反应但**不报错**；⬆/⬇ 按钮可改序，且同样走「保存/失败回滚」。
21. **取消与 no-op**：拖动中按 Esc 或拖出窗口 → 不发请求、顺序不变；拖回原位 → 不发请求。

### 构建

22. `pnpm -r --if-present build` **exit 0**（tsc 全量类型检查 + `@ikit/web` vite build），无 `PluginInstallResult`/`scanWarnings` 相关类型错误。

---

## 9. 风险与回滚

| 风险 | 等级 | 说明 | 缓解 / 回滚 |
|---|---|---|---|
| 拒装后**已装旧远端包无法更新**（无 sha256） | 中 | 收紧的必然结果；运维会看到「更新失败」 | 前端 `blockedReason` 明确引导「卸载后从带校验值的目录源重装」；`refreshRegistry` warn 汇总缺失条目；回滚 = 恢复 `service.ts:422-426` 的 warn 分支（<10 行） |
| ① 导致本地导入/导出闭环被误解为「也要哈希」 | 低 | 语义差异易被误读 | §3.2 差异表 + README/总览写明；导入二次确认文案明示「未做完整性校验」 |
| ② 误报过多 → 管理员无视警示 | 中 | 静态启发式固有 | 规则取舍（去 `.exec(`/裸 `process.env`/裸 `fs.`）、两遍匹配、分级（高/中/低）；UI 明示「启发式提示」；忽略/白名单功能留待后续 |
| ② 漏报 → 产生「已扫描=安全」错觉 | **高影响** | 动态代码无法静态穷尽（评估 §2.3 已论证） | UI/文档双重声明「**扫不到 ≠ 安全**，不构成安全保证」；安全主责仍在 ① 的哈希 + 仅 admin + 二次确认 |
| ② 正则性能/灾难性回溯 | 低 | 大文件 + 复杂正则 | 规则避免嵌套量词；文件数 ≤200、单文件 ≤2MB（`packaging.ts:17-20`）、扫描截断 256KB、每规则每文件 3 条、总 50 条 |
| ② 落库膨胀（`plugins.json` 变大） | 低 | warnings 为文本 | 落库 ≤20 条、单条 ≤200 字符；findings 不落库 |
| ② 扫描异常导致安装失败 | 低 | 违反「不阻断」 | `safeScan` try/catch 降级为「扫描失败」警告，安装继续 |
| 服务接口改型遗漏消费点 | 低 | `install/update/importPackage` 返回结构变化 | 唯一消费方 `routes.ts` 3 处；`pnpm -r --if-present build` tsc 兜底；备选方案 §10-3 |
| 前端手写类型副本漂移 | 中 | `lib/plugins.ts` 是第二份定义 | §6 显式列出同步清单 + 验收 grep `scanWarnings\|installable\|PluginInstallResult` 两端核对 |
| ③ 原生 DnD 在 Firefox 下中断/需要 `setData` | 中 | Firefox 必须 `setData` 才启动拖拽；重排 DOM 可能中断 | `dragstart` 内 `setData('text/plain')`；提交点用 `dragend`（比 `drop` 可靠）；⬆/⬇ 按钮为兜底路径 |
| ③ 拖拽期间刷新竞态覆盖预览 | 低 | `load()` 异步返回 | `dragging` 时忽略 `load` 响应 |
| ③ `setOrder` 写盘失败导致内存/磁盘不一致 | 低 | 现状 `persist()` 抛错但内存已改 | §5.2 快照 + 失败回滚（5 行） |
| ③ 触控不可拖被误判为缺陷 | 低 | 移动端原生 DnD 无效 | ⬆/⬇ 按钮常显 + AC-20 明确「不报错且可排序」；pointer 拖拽见 §10-4 |

**回滚总纲**：三项**相互独立**，可分别回滚（① 恢复 warn 分支；② 停用 `scanner.ts` 调用并忽略新字段；③ 前端恢复原 `onDrop` 实现）。数据层只**新增可选键**，回滚后旧代码读取时忽略多余键（JSON 多余键无害），**无需数据回滚脚本**，也无需停机窗口。

---

## 10. 待确认问题（含推荐默认）

| # | 问题 | 推荐默认 | 影响 |
|---|---|---|---|
| 1 | **② 扫描结果的落库粒度与忽略机制**：只落库人类可读 `warnings`（≤20 条），还是同时落库结构化 `findings`、并提供「忽略此插件警告」开关？ | **只落库 `warnings` ≤20 条**；结构化 `findings` 仅在安装响应返回；**不做忽略开关**（本期最小） | 落库小、可读性高；忽略开关需新增字段 + UI + 持久化语义，建议留待有反馈后再立项 |
| 2 | **① 是否提供本地调试豁免开关**（如 `PLUGIN_REGISTRY_ALLOW_MISSING_SHA256=1`，与既有 `PLUGIN_REGISTRY_ALLOW_HTTP` 同形）？ | **不提供**（严格拒装） | 不新增配置项与文档面；QA 造「拒装」场景只需 registry 条目/参数不带 sha256，天然可测。若后续本地联调受阻，再加开关（3 处改动，见 §2.4） |
| 3 | **② 服务返回值改型**：`install/update/importPackage` 改为 `PluginInstallResult`（含 `scan`），还是保持 `PluginRecord[]` 由前端从 `store` 记录读取 warnings？ | **改为 `PluginInstallResult`**（安装/导入响应显式带 `scan`，AC-9 可直接断言） | 唯一消费方 `routes.ts` 3 处，tsc 兜底；备选方案零改型但 `import` 场景前端难以确定「刚装入的是哪条记录」，AC 可验证性下降 |
| 4 | **③ 移动端拖拽投入**：首期只做「原生 DnD + ⬆/⬇ 按钮」，还是投入 pointer-events 触控拖拽（约 +60 行 + `touch-action` + 自动滚动）？ | **只做原生 DnD + ⬆/⬇ 按钮**（不引入库、不写 pointer 拖拽） | 满足「触控至少不报错且可用」；pointer 版收益是可长按拖动，成本与回归面更高，建议按真实移动端反馈再排期 |

---

## 附：改动文件总览（实施阶段执行）

- **后端**：`packages/plugins/plugin-registry/src/{errors.ts(新), scanner.ts(新), utils.ts, service.ts, types.ts}`、`packages/api/src/routes.ts`（共 6 文件 + 2 新增）
- **前端**：`apps/web/src/lib/plugins.ts`、`apps/web/src/components/{PluginStore.vue, PluginSettings.vue}`、`apps/web/src/App.vue`（4 处）
- **文档（落地后）**：`docs/需求功能总览.md`（`:215-221`、`:226`、`:228`、`:373`）、`README.md`（`:234-242`），本方案文件 `docs/ai-delivery/完善⑤-P2lite-方案.md`
- **不改**：`packaging.ts`（仅 `assertSha256` 文案细化）、`catalog.ts`、`store.ts`、`loader.ts`、`packages/core/src/index.ts`、`store-data`、`plugins/hello`、`.env.example`（默认不加配置项）

*（本方案仅分析 + 落地方案文档；未改动任何代码/数据文件，未执行 git 操作。）*
