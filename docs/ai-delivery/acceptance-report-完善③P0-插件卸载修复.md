# i-kit 验收报告 · 完善③ P0 插件卸载修复 + 模型扩展

> 角色：测试验收工程师（独立验收）
> 方案依据：`docs/ai-delivery/完善③-插件生态评估.md`（P0 范围 + D1-D7 决策，默认已采纳）
> 现状基准：`docs/需求功能总览.md` 模块 ④
> 日期：2026-09-04

## 一、基线构建

- 命令：`pnpm -r --if-present build`
- 结果：**PASS（exit code 0）**
- Scope 11/12 项目；tsc 全通过（含 `plugin-registry`），`@ikit/web` vite build 通过（159 modules，仅 chunk 体积常规警告）。

## 二、改动清单核验表

| 文件 | 声称改动 | 结果 | 证据 |
|---|---|---|---|
| `plugin-registry/src/catalog.ts`（新建） | STORE_CATALOG 外置（7 条，行为不变）；service.ts 改引用 | PASS | `catalog.ts:11-96` 外置 `STORE_CATALOG`（stats/notes/calendar/todo/weather/rss/mdclip 共 7 条，元数据与改造前一致）；`service.ts:12` `import { STORE_CATALOG } from './catalog.js'`。 |
| `plugin-registry/src/types.ts` | PluginRecord 全可选新字段 + 新增 PluginSource/PluginPackageInfo/PluginUninstallResult；upsertPackage 入参 + onUninstall 签名 async | PASS | `source?: PluginSource`(:25)、`packageUrl?`(:27)、`sha256?`(:29)、`deps?: string[]`(:31)、`minIkit?`(:33)、`minVersion?`(:35)、`author?`(:37)、`description?`(:39)、`category?`(:41)、`installedAt?`(:43)、`updatedAt?`(:45) 全部 `?` 可选；`PluginSource`(:5)、`PluginPackageInfo`(:49-63)、`PluginUninstallResult`(:104-111)；`upsertPackage(p: PluginPackageInfo)`(:133)；`onUninstall?: (name)=> Promise<PluginUninstallResult> | PluginUninstallResult`(:138)。 |
| `plugin-registry/src/loader.ts` | runApply 捕获 dispose；LoadedEntry 记 pkgDir/entryPath；isWithinRoot/resolvePkgDir/resolveEntryPath 防穿越；loadAll→loadPackageDir 复用；loadOne/reloadOne；uninstall async（dispose→移除→fs.rm→{handled,ok,error}） | PASS | `runApply`(:105-110) 捕获函数/`{dispose}` 两种返回；`LoadedEntry.pkgDir/entryPath`(:49/:51)；`isWithinRoot`(:84-87)、`resolvePkgDir`(:90-94)、`resolveEntryPath`(:97-102)；`loadAll`(:143-172) 复用 `loadPackageDir`(:113-141)；`loadOne`(:175-194)、`reloadOne`(:197-225，dispose→cache-bust→wasActive 重 apply)；`uninstall`(:250-274) async：dispose→`packages.delete`→`isWithinRoot` 越界拒删(:262-265)→`fs.rm`(:267)→返回 `{handled,ok,error}`。 |
| `plugin-registry/src/service.ts` | uninstall 先 await onUninstall（builtin 守卫在前抛错）、失败保留记录、成功移除并 persist；install/upsertPackage 填充新字段（updatedAt 仅版本变化、installedAt 不覆盖） | PASS | `uninstall`(:253-269)：`if (p.builtin) throw`(:257) → `await loaderHooks.onUninstall(name)`(:260) → `!result.ok` 抛错保留记录(:261-264) → 成功才 filter+persist(:266-267)；`install`(:228-251) 填充 `source:'catalog'/author/description/category/installedAt/updatedAt`；`upsertPackage`(:180-226) `versionChanged` 才更新 `updatedAt`(:199)、`if(!existing.installedAt) existing.installedAt=now`(:200)。 |
| `plugin-registry/src/index.ts` | manifest 字段透传 upsertPackage；onUninstall 接线签名匹配 | PASS | `upsertPackage({name/title/version/panel/description/author/category/deps/minIkit/minVersion/sha256})`(:56-68)；`onUninstall: (name) => loader.uninstall(name)`(:75) 返回 Promise<PluginUninstallResult>。 |
| 前端 | 无改动（卸载已有 confirm） | PASS | 声明无前端改动；`@ikit/web` build 通过，无回归。 |
| P1 | 未做（loadOne/reloadOne 仅打底不接路由） | PASS（越界，非 FAIL） | `loadOne/reloadOne` 已实现但 `routes.ts` 未引用（属 P1 打底，验收步骤允许）。 |

## 三、卸载链路实证（三种情形）

| 情形 | 路径 | 结果 | 证据 |
|---|---|---|---|
| 第三方目录包（如 hello） | builtin 守卫通过 → `onUninstall` → loader.uninstall 命中 → dispose → `packages.delete` → `isWithinRoot(pkgDir)` 真 → `fs.rm(pkgDir,{recursive,force})` → `{handled:true,ok:true}` → service filter+persist | PASS（真卸载） | `service.ts:253-269` + `loader.ts:250-274`。 |
| 内置 `agent` | `p.builtin===true` → 在 `onUninstall` **之前**抛「内置插件不可卸载」 | PASS（守卫顺序正确） | `service.ts:257`。 |
| 商店 7 条元数据（stats/notes/…） | 非 builtin → `onUninstall` → loader 未加载该包 → `{handled:false,ok:true}` → service 仅移除注册记录（无目录可删） | PASS | `loader.ts:251-254` + `service.ts:266-267`。 |
| 越界目录 | `isWithinRoot` false → 不 `fs.rm`、返回 `{handled:true,ok:false,error:'目录越界，已拒绝删除'}` → service 抛错并**保留注册记录** | PASS（防穿越 + 可恢复） | `loader.ts:262-265` + `service.ts:261-264`。 |

## 四、模型兼容

- 旧 `plugins.json` 记录（无新字段）加载不报错：`ensureLoaded`（`service.ts:33-61`）仅做「knowledge 剔除 + visibility→visibleGroups 迁移」，新字段全 `?` 可选，`JSON.parse` 不校验 → 兼容。
- `applySeed`（:63-79）对缺字段的既有记录仅补 title/panel/builtin/version，不碰新字段 → 容错。
- `upsertPackage` 既有分支（:184-200）对缺省字段用 `if (p.xxx)` 保护、`installedAt` 不覆盖 → 幂等。

## 五、回归走查（未动的逻辑）

- `enable/disable` + `onEnable/onDisable`：`service.ts:117-130` 逻辑未变。
- `setOrder`(:136-145)、`visibleFor`(:111-115)、`setGroups`(:147-154)：未变。
- `store()/categories()/rate()/update()`：改为读 `STORE_CATALOG`（外置后同值），行为不变。
- `loadOne/reloadOne`：dispose→cache-bust→重 apply 逻辑合理（`loader.ts:197-225`），不接路由属 P1 打底。

## 六、文档核验

| 文件 | 要求 | 结果 | 证据 |
|---|---|---|---|
| 总览模块④ | 「P0 已修正 2026-09」 | PASS | `需求功能总览.md:224`「A（P0 已修正 2026-09）：卸载语义升级为真卸载…」；`:206` 概述、`:217` 实现位置同步。 |
| 总览第六节第3项 | 进度更新 | PASS | `:370`「3. 插件生态类：P0 已完成 2026-09（…）；P1/P2 待启动（…）」；`:226` B 项保留「导出/导入、市场、安全扫描、拖拽预览未实现」。 |
| 门户文档 §16 | 追加说明 | PASS | `门户布局与功能改造需求文档.md:307`「插件生态 P0（2026-09 后续）：修复假卸载…STORE_CATALOG 外置…PluginRecord 增补全可选字段…loadOne/reloadOne」。与代码一致。 |

## 七、结论

**PASS。**

核心 P0 交付（卸载修复、数据模型扩展、STORE_CATALOG 外置、loader 单包热载/真卸载、manifest 扩展 + 防穿越）全部正确落地，构建通过，文档同步一致，旧数据兼容。

**次要观察（非 FAIL，建议后续）**：
1. **「扩展名白名单」未落地**：方案 P0 第 4 项「sanitizeManifest 强化」含「入口路径越界校验、扩展名白名单、字段补全」三项；已做「路径越界校验（`resolveEntryPath` :97-102）」+「字段补全（`sanitizeManifest` :66-71）」，但 `entry` 无 `.js/.cjs/.mjs/.ts` 扩展名白名单（`sanitizeManifest` :64 仅类型校验，`resolveEntryPath` 仅路径包含校验）。属轻微硬化缺口，不影响当前流程（entry 默认 `index.js`，动态 import 可加载），建议 P1 导入校验时一并补上。
2. **`PluginSource` 取值微调**：实现为 `'catalog'|'local'|'remote'`（`types.ts:5`），方案 §2.4 示例为 `'builtin'|'catalog'|'market'|'local'`。属内部类型命名，无外部契约，可接受；`builtin` 语义由 `PluginRecord.builtin` 布尔承载。
3. **越界分支内存移除顺序**：`loader.uninstall` 先 `packages.delete(name)`（:261）再做 `isWithinRoot` 检查（:262）——越界分支会「内存已移除但目录保留 + 注册记录保留」。因 `pkgDir` 恒由 `path.join(root, name)` 生成（loadAll/loadOne），该分支实际不可达，属防御性逻辑，无实际影响。

*（本报告仅新增 `docs/ai-delivery/acceptance-report-完善③P0-插件卸载修复.md`；未改动任何代码/数据文件，未执行 git 操作。）*
