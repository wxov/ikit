# i-kit 验收报告 · 完善③ P1 插件导出/导入 + 静态 JSON 市场

> 角色：测试验收工程师（独立验收）
> 评估依据：`docs/ai-delivery/完善③-插件生态评估.md`（P1 + D1/D2/D5/D7 决策）
> P0 已验收：`docs/ai-delivery/acceptance-report-完善③P0-插件卸载修复.md`
> 日期：2026-09-04

## 一、基线构建

- 命令：`pnpm -r --if-present build`
- 结果：**PASS（exit code 0）**
- Scope 11/12；tsc 全通过（含 `plugin-registry`，adm-zip 类型解析正常）、`@ikit/web` vite build 通过（159 modules，仅 chunk 体积常规警告）。

## 二、改动清单核验表

| 文件 | 声称改动 | 结果 | 证据 |
|---|---|---|---|
| `src/packaging.ts`（新增） | zip 打包/解包 + validateZipBuffer 统一校验链 | PASS | `ZIP_MAX_BYTES=2MB/EXTRACT_TOTAL_MAX_BYTES=10MB/FILE_MAX_BYTES=2MB/MAX_FILES=200`(:17-20)；`decodeZipBase64`(:41-57)；`validateZipBuffer`(:78-155)；`assertSha256`(:158-163)；`exportPackageToZip`(:166-195)。 |
| `src/utils.ts`（新增） | ENTRY_EXTENSIONS 白名单、树哈希、compareSemver、normalizeRelPath/isWithinDir | PASS | `ENTRY_EXTENSIONS={'.js','.cjs','.mjs','.ts'}`(:6)；`IMPORT_NAME_RE`(:9)；`sha256OfFileTree` 规范序 `relPath\0content`(:30-39)；`compareSemver`(:45-53)；`normalizeRelPath` 拒绝绝对/盘符/`..`/`.`/空/NUL(:72-80)；`isWithinDir`(:62-66)。 |
| `src/service.ts` | installFilesAtomically/installRemote/importPackage/exportPackage/refreshRegistry | PASS | 见「校验链 / 安全边界 / 商店回归」。 |
| `src/loader.ts` | resolveEntryPath 复用扩展名白名单；uninstall 先校验后移除；register 改 await | PASS | `resolveEntryPath` 增加 `isEntryExtensionAllowed`(:102)；`uninstall` 先 `isWithinRoot` 校验(:259-262)再 dispose/delete/rm；`await register(...)`(:169/:193/:223)。 |
| `src/types.ts` | PluginInstallInput/RemoteRegistryPlugin/RemoteRegistry/PluginLoaderHooks(onLoadOne/onReloadOne) | PASS | `RemoteRegistryPlugin`(:66-78)、`RemoteRegistry`(:81-86)、`PluginLoadResult`(:149-153)、`PluginLoaderHooks.onLoadOne/onReloadOne`(:160-161)、`PluginInstallInput`(:165)。 |
| `src/index.ts` | registryUrl/allowHttp 配置 + PLUGIN_REGISTRY_URL/ALLOW_HTTP env | PASS | `Config.registryUrl/allowHttp`(:26-28,:34-35)；`process.env.PLUGIN_REGISTRY_URL`(:44)、`PLUGIN_REGISTRY_ALLOW_HTTP==='1'`(:46)；`setLoaderHooks onLoadOne/onReloadOne`(:90-91)。 |
| `api/src/routes.ts` | export/import/refresh 路由全 requireAdmin；install 支持 {packageUrl,sha256} | PASS | 见「安全与边界实证」。 |
| 前端 `lib/plugins.ts` + `PluginStore.vue` | 导入按钮+confirm、导出、远端来源标识 | PASS | 见「前端」。 |
| 文档 | .env.example 新键、README API 表、总览 | PASS | 见「文档核验」。 |

## 三、校验链实证（packaging.ts / utils.ts）

- **大小/炸弹上限**：zip ≤2MB(:79)、解压后总 ≤10MB(:109)、单文件 ≤2MB(:105)、文件数 ≤200(:90)。
- **条目路径防穿越**：每条 `normalizeRelPath`(:96)，拒绝绝对路径/盘符/`../`/`.`/空段/NUL；符号链接条目拒绝(:98)。
- **manifest 校验**：`plugin.json` 必须位于包根(:116-117)；`name` 匹配 `^[a-z0-9_-]+$`(:125-126)；`entry` 扩展名白名单(:129-131) + 归一化不越界(:132-133) + **文件存在**(:134-136)。
- **sha256 树哈希一致性**：`validateZipBuffer` 返回 `treeSha256 = sha256OfFileTree(files)`(:154)，import(`service.ts:636`)与 remote(`service.ts:418`)共用同一语义（解压后规范序哈希，非 zip 整体），`assertSha256` 统一比对(:158-163)。已在 `utils.ts:25-29` 注释文档化。

## 四、安全与边界实证

- **鉴权**：`GET /api/plugin-store/:name/export`(:356)、`POST /api/plugin-store/import`(:373，bodyLimit 5MB)、`POST /api/plugin-store/refresh`(:387)、`install/update/uninstall` 全部 `requireAdmin`（未登录 401 / 非 admin 403）。
- **导出拒绝**：`exportPackage` 对内置目录条目/builtin 抛「内置插件不可导出」(:620-622，路由映射 400)；不存在/非目录包 → 404(:366)。
- **远程仅 https**：`installRemote` 校验 `new URL(url).protocol`(:389-405)，非 https 抛错；仅 `allowHttp`（默认 false，读 `PLUGIN_REGISTRY_ALLOW_HTTP=1`）豁免 http 并 warn(:396-397)。
- **失败路径原子性**：`installFilesAtomically`(:312-382) 写 `.staging-<uuid>` 目录（二次 normalizeRelPath + isWithinDir 兜底）→ 已有目录则备份 `.backup-<uuid>` → `rename` 替换 → `reloadOne`；reloadOne 失败则 rm 新目录 + 恢复备份 + reloadOne 旧版(:345-350)；全新安装失败则 rm 目标目录(:357-359)；最外层 catch 清 staging(:378-380)。**无半状态**。

## 五、商店回归

- **store() 合并**：内置 7 条 catalog + 远端 remoteCatalog（同名内置优先）+ 已装第三方 local/remote，`enrichedStore`(:168-245) 附带 `source/updateAvailable/rating/reviews`。
- **远端降级**：`refreshRegistry`(:434-453) try-catch，fetch 失败/结构非法 → `remoteCatalog=[]` + warn，不拖垮；`sanitizeRemoteRegistry`(:47-70) 丢弃缺 name/packageUrl/version 的条目。
- **内置 7 条假安装不变**：`install` 无 packageUrl 时走 catalog「仅注册标记」分支(:548-569)，行为与 P0 一致。
- **register await**：loader 的 `register` 回调返回 `upsertPackage` Promise 并 `await`（loader:169/193/223；index.ts:70-82），避免启动 `loadAll` 与并发 install 的 source/sha256 竞态覆盖。
- **semver**：catalog 保留字符串比较、remote/local 用 `compareSemver`（`enrichedStore` :180）。

## 六、前端

- `lib/plugins.ts`：`PluginStoreItem.source/packageUrl/sha256`(:74-76)、`installPlugin(input: string|{name,packageUrl,sha256})`(:88-89)、`importPlugin(data,sha256?)`(:100-104)、`downloadPlugin`(:116-117，带 authHeaders)。
- `PluginStore.vue`：导入按钮(:188-189)、导入二次确认 + 风险提示「第三方插件将获得与主程序同等的系统权限，仅安装你信任的来源」(:124，符合 D5)、导出按钮(:240/:325，仅第三方)、远端/本地来源标识 `sourceLabel`(:29-31, :232)。**未引入动态前端面板加载**（符合 D7 首期不放开）。

## 七、依赖与仓库卫生

- **adm-zip@0.6.0**：已声明为 `plugin-registry` **运行时依赖**（`packages/plugins/plugin-registry/package.json:11`，dependencies），根 `package.json:24` devDeps 亦含（供 `scripts/build-web-update.mjs`）。`Dockerfile` 全量 `pnpm install --frozen-lockfile`（非 --prod），无生产缺依赖风险。
- **仓库卫生**：glob 无 `.staging-*` / `.backup-*` / `.smoke` 残留；`plugins/` 仅 `hello/{plugin.json,index.ts}`（未触碰真实 data 与 plugins/）；无新增测试 `.zip` 产物。**未执行 git status**（遵守「不做 git 操作」约束）。

## 八、文档核验

| 文件 | 要求 | 结果 | 证据 |
|---|---|---|---|
| `.env.example` | 新键 PLUGIN_REGISTRY_URL / ALLOW_HTTP | PASS | `:40` `PLUGIN_REGISTRY_URL=`、`:42` `PLUGIN_REGISTRY_ALLOW_HTTP=`，含中文注释。 |
| `README.md` API 表 | export/import/refresh 标注 | PASS | `:237-240`：install（`{name}` 或 `{name,packageUrl,sha256}` 远端）、export、import、refresh 均标「站主」。 |
| 总览模块④ | 「P1 已完成 2026-09」 | PASS | `需求功能总览.md:226`「A（P1 已完成 2026-09）：插件导出/导入…静态 JSON 市场目录源…sha256 强校验 + semver…」；`:215-219` 实现位置补 catalog/packaging/utils/index；`:228` B 项保留「危险 API 扫描/ed25519 签名/拖拽预览未实现（P2）」。 |
| 总览第六节第3项 | 进度更新 | PASS | `:373`「P0 已完成…；P1 已完成 2026-09（导出/导入 zip + 校验、静态 JSON 市场 + 远程安装 + sha256 + semver）；P2 待启动（签名/自建市场/沙箱/拖拽预览/危险 API 扫描）」。 |

## 九、结论

**PASS。**

插件导出/导入（zip + 完整校验链）、静态 JSON 市场（registry.json 拉取 + 远程安装 + 降级）、统一 sha256 树哈希语义、原子落盘 + 失败回滚、requireAdmin 鉴权、前端导入/导出/来源标识全部正确落地，构建通过，依赖声明正确，仓库无临时残留，文档同步一致。

**次要观察（非 FAIL，建议后续）**：
1. **sha256 为「若提供则强校验、未提供则告警放行」**：`installRemote`(:422-426) 与 `importPackage`(:637-641) 在缺 sha256 时仅 `console.warn` 并继续，未按评估文档 §4 L1「sha256 必做」拒装。总览措辞用「强校验」（= 提供了则严格比对）与此一致；但严格意义上「官方源缺 sha256 仍安装」弱于「必做」。建议后续将「官方源/远端缺 sha256」升级为强提示或默认拒装（除非显式信任）。
2. **`POST /api/plugin-store/rate` 仍公开**（`routes.ts:335-340`，无 requireAdmin，匿名作者）——既有行为、与 P1 无关，未纳入本次范围。
3. **冒烟未独立重跑**：纯函数（`normalizeRelPath`/`sha256OfFileTree`/`validateZipBuffer`/`compareSemver`）已逐行代码级核验；集成路径（`installFilesAtomically` 原子替换、loader `loadOne/reloadOne`）依赖运行时 Cordis 上下文，未在隔离环境独立执行，证据为上述代码级核验 + 全量构建通过。
4. `PluginSource` 取值 `'catalog'|'local'|'remote'`（非方案示例 `'market'`），沿用 P0 命名，内部类型无外部契约。

*（本报告仅新增 `docs/ai-delivery/acceptance-report-完善③P1-插件导出导入.md`；未改动任何代码/数据文件，未执行 git 操作，未执行会读写真实数据的运行时冒烟。）*
