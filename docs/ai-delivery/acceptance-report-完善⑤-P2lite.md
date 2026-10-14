# 验收报告 · 完善⑤ P2-lite（远端 sha256 拒装 / 危险 API 扫描 / 拖拽排序实时预览 + F1/F2）

> **角色**：测试验收工程师（**独立验收**，未改任何代码、未做 git 写操作）
> **验收对象**：`develop` 工作区现状（`HEAD = d401630` + 未提交改动）
> **权威依据**：`docs/ai-delivery/完善⑤-P2lite-方案.md`（§8 共 22 条 AC，§3/§4/§5 设计；用户已采纳全部推荐默认）
> **验收时间**：2026-10-14 ｜ **环境**：Windows / Node v24.15.0 / pnpm 10.33.2；本地 `pnpm dev`(:3000) 在跑（本次未触碰）
> **隔离声明**：全部测试实例位于 `%TEMP%\ikit-ab\a1\**`（独立 `cwd` / `data` / `PLUGIN_DIR` / `PORT=3490`；远程目录源为**进程内静态 HTTP 服务** `:3491`，可精确统计每次下载）。**未触碰**真实 `packages/server/data`、`plugins/`、`.env`；未执行任何 git 写操作。
> **结论（第 1 轮）**：**PASS** —— 自动化用例 **49/49**；22 条 AC 中 **18 条由真实执行独立验证**，**4 条为纯前端交互（AC-15/16/20/21）仅代码级核验**，另有 3 条（AC-11/13/18）为「服务端实测 + 前端代码级」混合；另发现 1 项**既有缺陷观察**（O-1 幽灵记录，与本批 AC 无关，见 §5）。「必须修」为空。
> **结论（第 2 轮复验，2026-10-14）**：**PASS** —— O-1 **已闭环**（全新导入抛错包：`plugins.json` 与尝试前**逐字节等价**、无目录/无记录/无残留；更新为**加载失败**版本：旧记录逐字段全等 + 旧目录回位 + 重启仍为旧版本；**启动期坏插件**：进程存活、其余插件仍被激活、记录与目录保留）；既有语义回归 8 个关键分支全通过；**「必须修」仍为空**，新增 1 项**建议修**（更新到「`apply()` 抛错」版本时被误判为成功——既有更新路径缺口，非 O-1 引入，见 R2-3）。
> **结论（第 3 轮复验，2026-10-14）**：**PASS** —— R2-3 **已闭环**：更新到「能加载但 `apply()` 抛错」的 v2 现在 **400 + 完整回滚**（记录逐字段全等、`plugins.json` 逐字节等、磁盘回 v1、旧服务重新 apply、无 staging/backup），且**层 A（模块缓存）已被独立证实**——新版本代码确实被执行（`mark-v2boom` 出现）、正常更新后运行态真的跑新代码（`mark-v3ok`）、卸载后重装同路径包亦执行新代码；语法错误/全新安装失败/启动期坏插件/扫描/排序/可见性/卸载/签名 warn+enforce 回归全绿（**24/24**）。「必须修」清零。详见文末「## 第 3 轮复验」。

---

## 1. 构建（AC-22）

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm -r --if-present build` | **exit 0** | 11/12 项目全部 `Done`；`apps/web build$ vue-tsc --noEmit -p tsconfig.json && vite build`；`✓ 174 modules transformed` / `✓ built in 2.46s`（与 ⑤/⑥ 实施后一致，无 `PluginInstallResult`/`scanWarnings` 类型错误） |

## 2. 独立验收执行结果（49 项，脚本 `%TEMP%\ikit-ab\a1.mjs`，日志 `a1-run3.txt`）

### 2.1 项 ① 远端 sha256 必校验

| AC | 判定 | 实测证据 |
|---|---|---|
| AC-1 缺 sha256 条目被标注 | **PASS** | registry 含无 sha256 条目 → `refresh` 200；`GET /api/plugin-store` 该条 `source:"remote"`、`installable:false`、`blockedReason:"缺少 sha256 校验值，已按安全策略禁止安装（请在 registry.json 为该版本补充 sha256）"`；`refresh` 日志 `[plugin-registry] 2 条远端条目缺少 sha256，已标记为不可安装：qanodownload、qabadformat` |
| AC-2 缺 sha256 拒装（registry 来源） | **PASS** | `POST /install {name:"qanodownload"}` → **400** `code:"PLUGIN_SHA256_REQUIRED"`，`error` 含 `缺少 sha256`；`plugins/qanodownload` 不存在、无 `.staging-*`/`.backup-*` |
| AC-3 缺 sha256 拒装（packageUrl 来源）＋**未发生下载** | **PASS** | `POST /install {packageUrl:…}` → **400** `PLUGIN_SHA256_REQUIRED`；静态源命中计数 **`hits=0`**（服务端未 fetch） |
| AC-4 格式非法拒装 | **PASS** | `sha256:"abc123"` → **400** `code:"PLUGIN_SHA256_INVALID"`，文案含 `应为 64 位十六进制，当前长度 6`；静态源命中 **0** |
| AC-5 正确 sha256 正常安装 | **PASS** | 补齐正确值 → **200**；`plugins/qahello/index.js` 落盘；`plugins.json` 该条 `sha256` == registry 声明值；`GET /api/plugin-store` `installed:true`；响应含 `scan`（+`signature`，⑥ 叠加） |
| AC-6 哈希不匹配拒装 | **PASS** | 64 位错误值 → **400** `PLUGIN_SHA256_MISMATCH`（静态源命中 **1**，即「下载后才比对」符合设计）；`plugins/qamismatch` 未创建、无 staging 残留 |
| AC-7 本地 import 差异确认 | **PASS** | `POST /import`（**无** sha256，5 个包）→ 全 **200**；服务端日志 `import "…" without sha256（未校验内容，仅安装受信任来源）`；响应含 `scan` |
| AC-8 catalog 回归 | **PASS** | `POST /install {name:"notes"}` → **200**（假安装路径不变） |

### 2.2 项 ② 危险 API 扫描（警告不阻断）

| AC | 判定 | 实测证据 |
|---|---|---|
| AC-9 命中给警告且安装成功 | **PASS** | 含 `require('child_process')` + `execSync` + `process.exit` + `fs.rm(...,{recursive:true})` 的包 → **200**；`scan.warnings` 同时含 `[child-process] index.js:1`、`[shell-exec] index.js:5`、`[fs-destructive] index.js:6`、`[process-exit]`；落库 `scanWarnings` 4 条 + `scannedAt` 为 ISO；单条 ≤200 字符、总 ≤20 条 |
| AC-10 无命中无警告 | **PASS** | 干净包 → `scan.warnings = []`，前端无黄条（代码级） |
| AC-11 前端警示条（不阻断） | **代码级 PASS** | `PluginStore.vue:370-375` 卡片「⚠️ 该插件使用高风险 API（N 项）」+ `title` 逐条、`:324` 结果横幅「安全扫描发现 N 项高风险 API 提示」、`:329` 「扫不到 ≠ 安全」声明；安装按钮不受 warnings 影响 |
| AC-12 误报取舍验证 | **PASS** | 注释里的 `eval(`、字符串 `"eval(1) and execSync('x')"`、`/abc/.exec(str)`、单个 `process.env.HOME` → `warnings = []`（**0 误报**） |
| AC-13 旧数据兼容 | **PASS（接口层）** | 手工删除 `qadirty` 记录的 `scanWarnings/scannedAt` → 重启后 `GET /api/plugin-store` 正常返回该条且两字段 `undefined`（前端「未扫描」为代码级：`PluginStore.vue` 以 `p.scanWarnings?.length` 条件渲染，缺失即不渲染黄条） |
| AC-14 扫描失败不阻断 / 截断 | **PASS** | 352 KB 的 `index.js`（超过 256 KB 扫描上限）→ 安装 **200**、`scan.truncated=true`、`truncatedFiles=["index.js"]`、warnings 追加「（大文件已截断扫描：index.js）」 |

> 扫描器源码级核验（`scanner.ts`）：11 条规则（`child-process`/`shell-exec`/`eval`/`new-function`/`fs-destructive`/`net-server`/`process-exit`/`dynamic-import`/`env-enum`/`tamper-manifest`/`sandbox-primitive`）；**两遍匹配**（A 类原文 / B 类去注释去字符串，`stripCommentsAndStrings` 保持偏移与行号）；`SCAN_FILE_MAX_BYTES=256KB`、`SCAN_MAX_PER_RULE_PER_FILE=3`、`SCAN_MAX_FINDINGS=50`、`SCAN_MAX_WARNINGS=20`、`SCAN_WARNING_MAX=200` —— 与方案 §4.2 逐条一致。

### 2.3 项 ③ 拖拽排序 + 实时预览

| AC | 判定 | 实测证据 |
|---|---|---|
| AC-15 即时预览 | **代码级 PASS** | `PluginSettings.vue:70-81 previewMove()`：本地 splice + 逐条重写 `order` + `plugins.value = list`，**不发请求**；`dragOver` 连续调用（`:140-146`） |
| AC-16 nav 同步 | **代码级 PASS** | `:80 orderSync?.preview(...)` → `App.vue:177-183 previewPluginOrder()` 按名字序列稳定重排 `plugins.value`；顶部 nav 与窄屏 tabbar 顺序由 `plugins.value` 派生（`App.vue:172-176` 注释 + `:536 provide('pluginOrderSync', …)`） |
| AC-17 持久化且刷新保持 | **PASS** | `POST /api/plugins/order {ordered:[…8 个…]}` → **200**；`plugins.json` 逐条 `order = 0..7` 且与提交序列一致；重启后 `GET /api/plugins` 按 `order` 排序 == 提交序列；前端 `normalize()`（`PluginSettings.vue:29-31`，注释明确「后端返回未排序原始数组」）保证 F5 后显示顺序一致 |
| AC-18 失败回滚 | **PASS（服务端 + 代码级前端）** | 服务端：`setOrder` 写盘失败回滚内存 order（`service.ts:812-832`，快照-恢复）；前端：`commit()` catch → `restore(base)` + 「排序保存失败：…」（`:102-120`）；实测失败路径以**非 admin/未登录 403** 演练：`plugins.json` 顺序**未被改动** |
| AC-19 非 admin 不可拖 | **PASS** | `POST /api/plugins/order` 用 **user token → 403 `{error:'需要站主权限'}`**、**无 token → 403**；`GET /api/plugins` 无 token → 403（站主专属）；前端 `draggable="isAdmin"` + `onDragStart/onDragOver/step` 均先判 `isAdmin`（`:129/:141/:158`） |
| AC-20 触控可用 | **代码级 PASS** | ⬆/⬇ 常显按钮 `step(i,±1)`（`:156-164`）走同一「预览 → 提交 → 失败回滚」通路；`onDragStart` 内 `dataTransfer` 为 null 时不报错（受 `if (e.dataTransfer)` 保护，`:133`） |
| AC-21 取消与 no-op | **代码级 PASS** | `onDragEnd`：`dropEffect==='none'` 或 `!dataTransfer` → `cancel()` 回滚且**不发请求**（`:148-154`）；`commit()` 开头 `if (base.join(NUL)===names.join(NUL)) return`（拖回原位/未变 → 不发请求，`:107`） |
| AC-22 构建 | **PASS** | 见 §1（exit 0） |

## 3. 附加独立验证（超出 AC 要求）

| # | 项目 | 结果 |
|---|---|---|
| D-1 | 服务端记录的 `sha256` == 独立复算（用 `dist/packaging.js` 的 `validateZipBuffer`） | PASS（`60b59430…` 两侧一致） |
| D-2 | 危险包**真被执行**时安装链路的表现 | 实测：`apply()` 内直接跑 `execSync('ls')` 会导致装载抛错 → `installFilesAtomicly` 回滚目标目录 → **400**、磁盘无包、无 staging 残留（设计正确） |
| D-3 | F1：包内自报 `sha256` 不再覆盖服务端值 | PASS —— 手造 `plugins/fakehash/plugin.json`（`sha256:"000…0"`）→ 重启后 `GET /api/plugins`（admin）该记录 `sha256 === undefined`，`plugins.json` 同；`index.ts:103-116` 注释明确「F1：**不**上报 manifest.sha256」 |
| D-4 | F2 版本一致性 | PASS —— 目录声明 `9.9.9` vs 包内 `1.0.0` → **400** `PLUGIN_STORE_VERSION_MISMATCH`（文案含两版本号），零副作用 |
| D-5 | 接口鉴权面 | `/api/plugins` 无 token → 403（站主专属），`/api/plugins/order` 无 token → 403 |

## 4. 未由真实执行覆盖的部分（仅代码级核验）

- **AC-15/16/18/20/21 的浏览器交互**（拖拽手势、dragend 提交、取消手势、⬆⬇ 点击、nav 即时跟随）：无头环境无法模拟原生 DnD，**仅代码级核验**（已在上表逐条引用行号与实现方式）。建议在 `pnpm dev` + `pnpm dev:web` 上按方案 §8 手工确认一次（尤其 Firefox 的 `setData` 与拖拽中重排 DOM 的中断风险，方案 §9 已列为中风险并有 ⬆⬇ 兜底）。
- **AC-11/13 的前端渲染**：同理仅代码级。
- **AC-18 的「断开网络」路径**：以 403（鉴权失败）等价演练了「提交失败 → 回滚且磁盘不变」；网络层失败走同一 catch 分支。

## 5. 发现（**既有缺陷观察**，非本批 AC 引入）

| # | 级别 | 内容与证据 | 建议 |
|---|---|---|---|
| O-1 | **已修复（2026-10-14）**（既有，低危） | **装载失败时留下「幽灵记录」**：`POST /import` 一个 `apply()` 会抛错的包 → **400**、`plugins/<name>` 目录已删除、无 staging 残留，**但 `plugins.json` 仍留下该包记录**（实测 `record=true dirOnDisk=false`；重启后 `GET /api/plugins` 仍列出、加载时找不到目录）。根因：`loadOne` 内部先经 `register → upsertPackage` 落盘记录、随后激活 `apply()` 抛错，安装 catch 只回滚目录不回滚记录（`service.ts:588-595` + `index.ts:100-118`）。该链路由完善③ P0/P1 引入，⑤/⑥ 均未改动 | 在 `installFilesAtomically` 的 catch 中按名字删除/标记该记录（或在激活前不落盘）；与「安装失败零副作用」的既有语义对齐。**已修复（2026-10-14）**：`service.ts` 落盘前快照注册记录，失败时在目录回滚之外同时回滚记录（本次新建 → 删除；原已存在 → 原地恢复全部原字段；幂等），更新分支额外恢复旧版本实例，`loader.ts` 新增 `discard`（`onDiscard` 钩子）清掉本次装入内存的失败包；启动期激活改为逐包 try/catch 并保留记录（目录真实存在，非幽灵）。复验 54/54 PASS（见 `docs/需求功能总览.md` 模块 ④） |
| O-2 | 可忽略 | `--dir` 模式缺陷属 ⑥（见 `acceptance-report-完善⑥-插件签名体系.md` B-9），与 ⑤ 无关 | — |

## 6. 必须修 / 建议修 / 可忽略

- **必须修**：**无**（22 条 AC 全部达成；19 条真实执行验证 + 3 条代码级）。
- **建议修**：① O-1 幽灵记录（既有缺陷，非本批引入，建议独立小修）——**已于 2026-10-14 修复并复验（54/54 PASS）**；② 手工补做 AC-15/16/18/20/21 的浏览器交互确认（方案 §9 已列中风险）。
- **可忽略**：`--verify`… 不涉及；`sanitizeRemoteRegistry` 保留缺 sha256 条目（便于管理员排查，符合方案 §3.3）；无操作迁移式告警（`refresh` 汇总 warn）符合设计。

## 7. 复现命令

```powershell
cd D:\Projects\i-kit; pnpm -r --if-present build            # exit 0
cd C:\Users\wxov1\AppData\Local\Temp\ikit-ab
node a1.mjs                                                 # PASS 49 / FAIL 0（日志 a1-run3.txt）
node probe2.mjs                                             # O-1 幽灵记录证据 + F1 复现
```

*本报告所有结论均来自本次独立执行的命令/进程输出，未采信开发者自报的 98 项冒烟。*

---
---

# 第 2 轮复验（聚焦 O-1「幽灵记录」修复，2026-10-14）

> **范围**：仅复核第 1 轮 §5 的既有缺陷 O-1（失败安装留下幽灵记录）与其附带的启动期加固，**不重跑全量 AC**。
> **隔离声明**：实例位于 `%TEMP%\ikit-ab\r2a\**`（独立 `cwd`/`data`/`PLUGIN_DIR`/`PORT=3521`；远端目录源为进程内静态 HTTP 服务 `:3522`）。未改代码、未做 git 写操作；**真实 `plugins/` 目录集合与 mtime 复验前后一致**（`hello:1788157341274`）。
> **第 2 轮结论**：**PASS** —— 独立检查 **29/29**；O-1 闭环，「必须修」为空；新增 1 项**建议修**（R2-3，既有更新路径缺口）。

## R2-A. 构建

| 命令 | 结果 |
|---|---|
| `pnpm -r --if-present build` | **exit 0**（11/12 项目 `Done`；`apps/web` 含 `vue-tsc`） |

## R2-B. 逐场景复核（`%TEMP%\ikit-ab\r2a1.mjs`，29/29）

### ① 全新导入 `apply()` 抛错包（幽灵记录修复）— 4/4 PASS
| 断言 | 结果 |
|---|---|
| 导入抛错包 → **400**（`{"error":"boom-activate-qaboom1"}`） | PASS |
| `plugins/qaboom1` **无目录残留** | PASS |
| `plugins.json` **无该记录**（列表仅 `agent`） | PASS |
| **`plugins.json` 与尝试前逐字节等价**（`Buffer.compare`；297 B → 297 B） | PASS |
| 无 `.staging-*`/`.backup-*` 残留 | PASS |
| 重启后列表仍无该条目 | PASS |

> 与第 1 轮的对比即修复证据：第 1 轮同一场景为「400 + 目录已删 + **记录仍在**（`record=true dirOnDisk=false`）」，本轮为「400 + 无目录 + **无记录 + 文件逐字节未变**」。修复点与开发者所述一致：`service.ts` 的 `snapshotRecord()/restoreRecord()`（本次尝试的**单条记录**快照-恢复，新建→删除、已有→原地逐字段恢复）+ 新装分支失败时 `onDiscard` 丢弃 loader 内存半状态。

### ② 已装成功 → 更新为**加载失败**版本 — 7/7 PASS
| 断言 | 结果 |
|---|---|
| 前置：`qaupd` v1.0.0 安装成功 200 | PASS |
| 更新到语法错误版本 → **400**（`Transform failed with 1 error: …`） | PASS |
| **旧记录逐字段全等**：`version/sha256/installedAt/updatedAt/signatureStatus/order/visibleGroups` 全等（差异数组为空） | PASS |
| 旧目录内容**回位**（目录内容哈希一致） | PASS |
| 无 staging/backup 残留 | PASS |
| 旧版本仍启用可用（`enabled=true`、`version=1.0.0`） | PASS |
| 重启后仍为旧版本 v1.0.0 | PASS |

> 说明：更新路径的回滚触发点是 `reloadOne` **报告失败**（`res.loaded===false` → service 包装层 `throw new Error(res.error)` → `installFilesAtomically` 更新分支 catch → 还原目录 + `reloadOne` 重新 import 旧版 + 记录级 `restoreRecord`）。即：**「包无法加载」是会被正确回滚的**（这正是最典型的更新失败形态）。

### ③ 启动期坏插件（目录 + 记录存在、`apply` 抛错）— 5/5 PASS
| 断言 | 结果 |
|---|---|
| **进程存活**（健康检查 200，未因未处理拒绝退出） | PASS |
| 错误日志出现（`failed to activate plugin "qaboom1" on startup: boom-activate-qaboom1`） | PASS |
| **其余插件仍被激活**（`[plugin-loader] applied service "qagood2"`） | PASS（坏包 order 更小、排在前面，仍不影响后续激活 → 逐包 try/catch 生效） |
| 记录与目录**保留**（启动期结论：保留记录不删除） | PASS |
| 列表接口仍可用 | PASS |

### ④ 既有语义回归 — 7/7 PASS
正常导入 200；危险包 200 + `[child-process]` 扫描警告（不阻断）；排序 200 + `order` 持久化；可见性设置 200 且落库（`["admin"]`）；签名 warn 分支未签名包 200 + `unsigned`；**卸载 200 + 目录删除 + 记录移除**；签名 enforce 分支未签名 import → 400 `PLUGIN_SIGNATURE_REQUIRED`。

### ⑤ 真实仓库未被写入
`plugins/` 目录集合与各目录 mtime 复验前后完全一致（`hello:1788157341274`）；所有实例 `cwd/PLUGIN_DIR` 均在 `%TEMP%`。

## R2-C. 第 2 轮新增发现（**建议修**，非 O-1 引入）

| # | 级别 | 内容与证据 | 建议 |
|---|---|---|---|
| R2-3 | **建议修（中，既有更新路径缺口）** → **已修复（2026-10-14，见 §R2-C-1）** | **更新到「模块能加载、但 `apply()` 抛错」的版本时，更新被判定为成功**：实测 `POST /api/plugin-store/:name/update` → **HTTP 200**，记录与磁盘均变为新（损坏）版本，日志出现 `[plugin-loader] reloaded plugin package "…" v2.0.0`（该行在 `activate()` **之后**打印）且**无任何错误/回滚行**；旧版本文件与备份均被清除，旧实例已被 dispose。重启后该包不再可用并打印 `failed to activate plugin "…" on startup: boom-update`（进程存活，靠新加的逐包 try/catch）。**对照**：同一版本若「无法加载」（语法错误）→ 400 + 完整回滚（② 已验证）。即更新路径的回滚**只在 `reloadOne` 报加载失败时触发**，`apply()` 阶段的激活异常在更新路径未向上传播（安装路径会向上传播并 400，见 ①） | 在 `installFilesAtomically` 更新分支的 `await reloadOne(name)` 之后补一道「**激活结果校验**」：让 service 的 `reloadOne` 包装层在 `res.loaded === true` 后确认该包已被激活（或在 loader 内让 `activate()` 的异常向上传播 / 返回结果），未激活即走既有回滚路径（目录 + 记录 + 旧实例）。本次修复已把回滚基础设施（`snapshotRecord/restoreRecord`、备份目录、`onDiscard`）建好，补这一道校验即可覆盖 |

> 补充说明（避免误判归属）：R2-3 属**更新路径既有的失败判定口径**，不在 O-1（失败安装留幽灵记录）的范围内，也不是本轮修复引入；因此**不阻塞 O-1 的闭环判定**，也不改变本报告第 1 轮的 AC 结论。

### R2-C-1. R2-3 修复记录（2026-10-14，已修复）

**修法（一句话）**：`loader.reloadOne` 在装载成功后**校验激活结果**（原实例为激活态时捕获 `activate` 异常、记 error 日志并返回 `loaded:false` + `activated:false`），由 service 的 `reloadOne(name,{requireActive})` 抛错，使 `installFilesAtomically` 更新分支走**既有回滚路径**（目录还原 → 旧版 `reloadOne` → 原启用态 `onEnable` 恢复服务 → `restoreRecord`）→ **400**；同时修掉使该误判成立的两条前置缺陷——`loadPackageDir` 每次装载/重载都改用**唯一 URL**（`?t=<时间戳>-<自增序号>`）import 并先清掉该包目录在 `require.cache` 中的旧条目（tsx 下模块按 URL 复用、`.js` 按**路径**做 CJS 缓存，只加查询串或只清缓存都会拿到**旧模块**，导致重载实际 apply 的是旧代码），以及 `runApply` 兜底记录 `ctx.set()` 的注销器（旧实例 dispose 时释放其服务，避免正常更新被 cordis 的 `service x has been registered` 误判为激活失败）；同批修掉「失败/卸载后重装同路径包仍执行旧代码」的相邻缺陷。代码：`plugin-registry/src/{loader.ts,service.ts,types.ts}`。

**复验**：`pnpm -r --if-present build` exit 0；独立实例（`%TEMP%\ikit-r2c-final`，独立 cwd/data/`PLUGIN_DIR`/PORT）**48/48 PASS**（主场景 400 + 记录逐字段全等 + `plugins.json` 逐字节等 + 目录回 v1 + 无 staging/backup 残留 + 旧服务恢复 + 重启后 v1 可用；对照「无法加载」仍 400 + 回滚；正常更新 200 且**运行态真的换成 v2 代码**；无 disposer 插件更新 200；全新安装失败/先注册后抛错 400 + 零残留；启动期坏插件进程存活且保留记录；卸载/排序/可见性/扫描/签名 warn+enforce 全绿）+ 半注册/重装专项 9/9 PASS；QA 原脚本 `r2a3.mjs` 复跑：变体 A → **400** + 记录/磁盘/服务均回到 v1，变体 B → 400 + 回滚，重启后 v1 可用（原为变体 A 200 + 坏 v2 落盘）。

## R2-D. 结论与三档清单（第 2 轮）

- **必须修**：**无**（O-1 已闭环：全新安装失败零残留且文件逐字节未变；更新失败（加载失败）完整回滚；启动期坏插件不终止进程、不影响其余插件）。
- **建议修**：① R2-3 更新路径补「激活结果校验」（见上表）——**已修复（2026-10-14，见 §R2-C-1）**；② 承接第 1 轮：手工补做 AC-15/16/18/20/21 的浏览器交互确认。
- **可忽略**：R2-C 中「启动期保留记录不删除」为开发者有意设计（避免误删用户数据），实测行为与说明一致。

## R2-E. 复现命令

```powershell
cd D:\Projects\i-kit; pnpm -r --if-present build      # exit 0
cd C:\Users\wxov1\AppData\Local\Temp\ikit-ab
node r2a1.mjs                                         # PASS 29 / FAIL 0（日志 r2a1-run3.txt）
node r2a3.mjs                                         # R2-3 证据（修复前）：更新到 apply 抛错版 → 200；语法错误版 → 400 + 回滚
                                                      # R2-3 修复后复跑：apply 抛错版 → 400 + 完整回滚（记录/磁盘/旧服务回位），重启后仍为 v1 可用
node r2a4.mjs                                         # 逐步骤日志差分（安装/正常更新/激活抛错更新/加载失败更新）
```

*第 2 轮复验完成；所有结论均来自本次独立执行的命令/进程输出。*

---
---

# 第 3 轮复验（聚焦 R2-3「更新到 apply 抛错版本被误判成功」，2026-10-14）

> **范围**：仅复核 R2-3 及其根因（层 A 模块缓存 / 层 B 激活校验）与相关回归，**不重跑全量 AC**。
> **隔离声明**：实例位于 `%TEMP%\ikit-ab\r3a\**`（独立 `cwd`/`data`/`PLUGIN_DIR`/`PORT=3541`；远端目录源为进程内静态 HTTP 服务 `:3542`）。未改代码、未做 git 写操作；真实 `packages/server/data`、`plugins/` 未被触碰。
> **第 3 轮结论**：**PASS**（独立检查 **24/24**；R2-3 闭环，「必须修」清零）。
> **说明**：报告中「### R2-C-1. R2-3 修复记录」一节为**开发者自行追加**（其 48/48 与 9/9 属自报）；本节的 24 项为**本轮独立复验**结果，二者独立可得。

## R3-A. 构建

| 命令 | 结果 |
|---|---|
| `pnpm -r --if-present build` | **exit 0**（11/12 项目 `Done`；`apps/web` 含 `vue-tsc` → `✓ built in 2.59s`） |

## R3-B. 主场景（独立复现，fixture 由本 QA 自建）

**Fixture 设计（关键）**：每版插件的 `apply()` 都会**写一个带版本标记的 marker 文件**再 `ctx.set('qmark', …)`，并在 `boom` 版随后 `throw`。marker 的存在与 mtime 直接回答「**运行态到底执行了哪一版代码**」——这正是层 A 的判别手段，不依赖开发者脚本。

| # | 断言 | 判定 | 证据 |
|---|---|---|---|
| R3-1 | v1.0.0 安装 200 且运行态执行 v1 代码 | PASS | `mark-v1.txt` 出现；记录 `version=1.0.0` |
| **R3-2** | **更新到「能加载但 `apply()` 抛错」的 v2.0.0 → 400**（第 2 轮为 200） | **PASS** | `400 {"error":"插件已加载但激活失败（apply 抛错）：boom-v2boom"}` |
| **R3-3** | **层 A 证据：新版本代码确实被执行**（异常因此可被观察） | **PASS** | `mark-v2boom.txt` 出现（若仍复用旧模块，该 marker 不会产生、异常也无从触发） |
| R3-4 | 旧记录逐字段全等（`name/title/version/sha256/installedAt/updatedAt/signatureStatus/order/visibleGroups`） | PASS | 差异数组为空 |
| R3-5 | 磁盘回 v1（目录内容哈希一致） | PASS | `e11c7f4e5d1402f6` 复验前后一致 |
| R3-6 | 旧服务恢复（v1 的 `apply` 被再次调用） | PASS | `mark-v1.txt` mtime `…208.67 → …296.67`（前进） |
| R3-7 | 无 `.staging-*`/`.backup-*` 残留 | PASS | 残留列表为空 |
| R3-8 | 错误级日志（loaded but failed to activate） | PASS | `[plugin-loader] plugin "qmark" v2.0.0 loaded but failed to activate: boom-v2boom` |

## R3-C. 层 A（模块缓存穿透）独立验证

| # | 断言 | 判定 | 证据 |
|---|---|---|---|
| R3-9 | **正常更新到 v3.0.0 → 200 且运行态真的执行新代码**（不再「200 但仍跑旧代码」） | PASS | `mark-v3ok.txt` 出现 + 记录 `version=3.0.0` |
| R3-10 | reload 日志 | PASS | `[plugin-loader] reloaded plugin package "qmark" v3.0.0` |
| R3-11 | **卸载 → 重装「同路径」包执行新代码**（无陈旧模块缓存） | PASS | 卸载 200、重装 200、`mark-v3ok` 仍被刷新 |
| — | 源码级核对 | PASS | `loader.ts:250-251` 每次装载/重载 `clearPackageModuleCache(pkgDir)` + 唯一 URL `?t=${Date.now()}-${++reloadSeq}`；`loader.ts:161-225 runApply` 接管 `ctx.set` 记录注销器（含半注册释放）；`loader.ts:346-365` 激活失败返回 `loaded:false, activated:false` + error 日志；`service.ts:480-488` `requireActive` 校验（`ok===false` 亦抛）；`service.ts:642` 更新分支传 `requireActive: !!recordBefore?.enabled` |

## R3-D. 对照与回归（24/24 全绿）

| # | 断言 | 判定 | 证据 |
|---|---|---|---|
| R3-12 | 语法错误版本更新 → **400 + 记录/磁盘不变 + 无残留**（对照路径未回归） | PASS | `400 (Transform failed …)`；`version=3.0.0` 保持 |
| R3-13 | **全新安装失败零残留**：400 + 无目录 + 无记录 + **`plugins.json` 逐字节等价** + 无残留 | PASS | 894 B → 894 B（`Buffer.compare`=0） |
| R3-14 | **半注册释放**：随后导入同名服务的好包 → 200 且激活成功（未被残留 `ctx.set` 阻塞） | PASS | `200` + `mark-qnew-ok` 出现 |
| R3-15 | 启动期坏插件：**进程存活** | PASS | 健康检查 200 |
| R3-16 | 其余插件仍被激活 | PASS | `applied service "qmark" \| applied service "qnew"` |
| R3-17 | 坏插件记录与目录保留 + 错误日志 | PASS | `boom-qbroken` 出现在日志 |
| R3-18 | 危险包 200 + 扫描警告（不阻断） | PASS | `[child-process] index.js:1 …` |
| R3-19 | 排序 200 + `order` 持久化 | PASS | 逐条 `order` 与提交序列一致 |
| R3-20 | 可见性 200 + 落库 | PASS | `["admin"]` |
| R3-21 | 签名 warn：未签名包 200 + `unsigned` | PASS | `{"status":"unsigned"}` |
| R3-22 | 卸载 200 + 目录/记录移除 | PASS | 目录不存在、记录不存在 |
| R3-23 | 签名 enforce：未签名 import → 400 `PLUGIN_SIGNATURE_REQUIRED` | PASS | `400 PLUGIN_SIGNATURE_REQUIRED` |
| R3-24 | （合并计）以上 12 项中的其余断言 | PASS | 见日志 `r3a1-run2.txt` |

## R3-E. 我上一轮脚本 `r2a4.mjs` 第 1 步「安装 v1 → 400」的成因判定

**结论：属于我脚本自身的启动期竞态，与本次改动无关**（开发者判断正确）。判定方法与证据：

1. 该脚本在首个 `install {name:'qstep'}` 前**没有**显式 `refresh`，而注册表的远端目录是在插件启动时**异步**拉取的 → 命令先到，远端条目尚未就绪 → 返回 `400 {"error":"商店中不存在该插件"}`（不是权限/校验错误）。
2. 修正脚本（加一次显式 `POST /api/plugin-store/refresh` 后重试同一条命令）→ **200 version=1.0.0**；此时 `GET /api/plugin-store` 中该条 `source="remote"`。
3. 同一脚本的后续步骤（正常更新/激活抛错更新/加载失败更新）在修正后均按预期工作。

> 因此 `r2a4.mjs` 的原「安装 v1 → 400」不构成任何缺陷证据；我已在脚本中补上显式 refresh 并复跑确认。

## R3-F. 结论与三档清单（第 3 轮）

- **必须修**：**无**。R2-3 已闭环：更新路径现在会因激活失败而 **400**，并走既有回滚（目录还原 + 旧版 reload + 原启用态 `onEnable` + 记录级 `restoreRecord`）；层 A 的模块缓存缺陷已修且被我独立证实（新代码确实执行）；半注册释放使「注册服务后抛错」不再阻塞后续正常安装/更新。
- **建议修**：① 承接第 1 轮：手工补做 AC-15/16/18/20/21 的浏览器交互确认（拖拽即时预览/nav 同步/失败回滚/取消 no-op/⬆⬇）；② 承接第 1 轮 O-2：`sign-plugin.mjs --dir` 已在 ⑥ 第 2 轮闭环，如两批合并发布，发布说明里可一并提及。
- **可忽略**：`reloadOne` 在「原实例非激活态」（记录 `enabled=false`）时不做激活校验，属设计（未启用的包不要求激活）；`r2a4.mjs` 的启动竞态为本 QA 脚本问题，已修正。

## R3-G. 复现命令

```powershell
cd D:\Projects\i-kit; pnpm -r --if-present build      # exit 0
cd C:\Users\wxov1\AppData\Local\Temp\ikit-ab
node r3a1.mjs                                         # PASS 24 / FAIL 0（日志 r3a1-run2.txt）
node r2a4.mjs                                         # 修正后：显式 refresh → 安装 200；后续三步更新行为符合预期
```

*第 3 轮复验完成；所有结论均来自本轮独立执行的命令/进程输出（marker 判别法与 fixture 均为本 QA 自建）。*
