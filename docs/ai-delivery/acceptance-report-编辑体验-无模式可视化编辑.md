# 验收报告 · 编辑体验整批（文章互链 / Vditor 异步初始化修复 / 飞书式可视化编辑 / 详情页无模式）

> **角色**：测试验收工程师（**独立验收**，未改任何代码、未做 git 写操作）
> **验收对象**：`develop` 工作区现状（4 个来源叠加、均未提交）
> **验收时间**：2026-10-16 ｜ **环境**：Windows / Node v24.15.0 / pnpm 10.33.2；本机 `pnpm dev`(:3000)、`pnpm dev:web`(:5173) 在跑（**未触碰**）
> **隔离声明**：纯函数用例在 `%TEMP%\ikit-ed\**` 以 esbuild 打包**真实前端源码**后在 Node 内直跑；接口层实例在 `%TEMP%\ikit-ed\work\srv-{json,sqlite}\**`（独立 `cwd`/`data`/`PLUGIN_DIR`，`PORT=3561|3562`）。**未触碰**真实 `packages/server/data`、`plugins/`、`.env`；未执行任何 git 写操作；**未复用开发者脚本**（断言与 fixture 均由本 QA 自建）。
> **结论**：**PASS（附明确的方法学限制）** —— 构建与类型检查 **exit 0**；**纯函数 + 索引可见性 63/63 PASS**（JSON 与 SQLite 各一轮）；四部分代码级核验通过；文档一致。**「必须修」为空**；但**开发者的浏览器 E2E（47/39/51 项）未被我独立复现**（本环境未搭建 CDP harness），相关交互项已在 §5 逐条标注为**代码级**并给出关键行号。

---

## 1. 构建与类型检查

| 命令 | 结果 |
|---|---|
| `pnpm -r --if-present build` | **exit 0**（11/12 项目 `Done`；`apps/web build$ vue-tsc --noEmit -p tsconfig.json && vite build` → `✓ built in 2.64s`） |
| `pnpm --filter @ikit/web typecheck` | **exit 0**（`vue-tsc --noEmit -p tsconfig.json`） |

## 2. 纯函数与渲染（独立执行，**63/63 PASS**）

> 方法：`esbuild` 以 `stdin + resolveDir=<repo>/apps/web/src/lib` 打包**真实源码** `markdown.ts`/`docLinks.ts`/`editorBlocks.ts`/`slashCommands.ts`/`inlineShortcuts.ts`（非复制件），Node 内直跑断言。脚本 `%TEMP%\ikit-ed\ed2.mjs`，日志 `ed2-run5.txt`。

### 2.1 A · 互链渲染（9/9）
| # | 断言 | 实测 |
|---|---|---|
| A1 | `[[标题]]` → `<a class="ikit-doc-link" href="#ikit-doc" data-doc-link="1" data-doc-title="目标文章">` | PASS |
| A2 | `ikit://doc/<id>` → `href="#ikit-doc-abc-123"` + `data-doc-id`，**自定义协议不出现在 HTML** | PASS |
| A3 | 围栏代码块内的 `[[x]]` / `ikit://` **不解析** | PASS（`docLinks=0`） |
| A4 | 行内代码 `` `[[x]]` `` 不解析 | PASS |
| A5 | 转义 `\[\[x\]\]` 不解析（原文保留） | PASS |
| A6 | 外链 → `target="_blank"` + `rel="noopener noreferrer"` | PASS |
| A7 | 页内锚点保留（`kind=anchor`） | PASS |
| A8 | 标题锚点仍生成（`id="heading-N"`，阅读端未回归） | PASS |
| A9 | 相对链接归类 `relative`，不误判为文档链接 | PASS |

### 2.2 A2 · `resolveDocLink` 与归一化（11/11）
| # | 断言 | 实测 |
|---|---|---|
| A2-1/2/3 | id 命中；标题命中；**标题归一化**（折叠空白）后命中 `  pad   title ` | PASS |
| A2-4 | **同名多篇** → `kind:'doc'` + `matches` 返回全部候选（调用方可弹选择） | PASS |
| A2-5/6 | 草稿 + 非 admin → `missing/draft-restricted`；**草稿 + admin → 命中** | PASS |
| A2-7 | `id-not-found` 与 `title-not-found` **区分** | PASS |
| A2-8/8b | 无目标 → `no-target`；anchor/external/relative **原样透传** | PASS |
| A2-9/10/11 | `normalizeTitle` 忽略大小写/空白；`classifyLink` 四类齐全；`escapeHtmlText`/`wikiLinkMarkdown`/`docLinkMarkdown` 正确 | PASS |

### 2.3 C · 块操作与边界（13/13）
| # | 断言 | 实测 |
|---|---|---|
| C1 | `splitBlocks` 切出 5 块且类型含 `heading/paragraph/list/code/table` | PASS |
| C2 | `joinBlocks(split)` **往返等于原文** | PASS |
| C3/C4 | `moveBlockUp(首块)`/`moveBlockDown(末块)` → `null`（**边界不越界**） | PASS |
| C5/C6 | 上移与首块交换；`removeBlock` 长度 -1 | PASS |
| C7 | `blockTypeOf` 区分 heading/list/paragraph/code | PASS |
| C8/C8b | **代码块类型锁定**：`convertBlock(代码块 → 段落/引用/标题)` 全为 `null`；表格由富分类器识别为 `table` | PASS |
| C9/C10 | `parseTable` ⇄ `renderTable` 往返；表格行/列增删边界正确 | PASS |
| C10b | 观察项：`convertBlock(表格 → 引用)` 不静默破坏表格（返回 `null` 或仍含分隔行） | PASS |
| C11 | 嵌套列表不被拆散且往返一致 | PASS |
| C12 | `applyBlockOp(未知操作 / 越界下标)` → `null`（不抛错） | PASS |

### 2.4 C2 · 斜杠命令与行内快捷（9/9）
| # | 断言 | 实测 |
|---|---|---|
| C2-1..5 | 5 个分组齐全；`slashQueryOf`（`/`→`''`、普通文本→`null`、`/table`→`table`）；过滤与 `limit`；分组标签与 `SLASH_GROUP_LABEL` 一致 | PASS |
| C2-6 | `templateToMarkdown('# {{cursor}}')` → `'# '`，`templateCursorOffset` → `2` | PASS |
| C2-7 | 行内快捷命中 `- ` / `* ` / `+ ` / `1. ` / `> ` / `- [ ] `；**`# ` 刻意不在本模块**（模块头注释：Vditor 原生 `isHeadingMD` 已处理 `# `，本模块只补 Vditor 缺失的列表/引用/待办） | PASS（设计如此，见 §6） |
| C2-8/9 | `matchContinuation('- x')==='- '`、空列表项/空待办判定；普通文本不误触发 | PASS |

## 3. 索引可见性（真实临时实例，JSON + SQLite 各一轮）

| 断言 | JSON | SQLite |
|---|---|---|
| 实例启动 + admin 登录 + 造数据（published / draft / 同名两篇） | PASS | PASS |
| **匿名索引不含草稿**；admin 索引**含**草稿；两者均含已发布目标 | PASS | PASS |
| 用**真实索引**跑 `resolveDocLink`：草稿 id → 非 admin `missing`、admin 命中 | PASS | PASS |
| 前端兜底：草稿即使混入索引，非 admin 仍 `missing/draft-restricted` | PASS | PASS |
| 同名两篇 → `matches` 返回**两个 id** | PASS | PASS |
| **纯读突发（16 次 GET 索引）零写入**：存储文件 MD5 不变 | PASS | PASS |

> 结论：**「不可见 / 草稿（非 admin）= missing」成立**；索引数据源为既有 `GET /api/knowledge/entries?limit=1000` + 鉴权头，**无新增接口/字段/迁移**（与文档一致）；读取路径本身不产生写入。

## 4. 代码级核验（B / C / D 与本环境无法执行的交互项）

### 4.1 B · Vditor 异步初始化崩溃修复
| 断言 | 证据（`VditorEditor.vue`） |
|---|---|
| 根因与修法一致 | `:10-14` 注释指明 `getCurrentMode()` 读 `this.vditor.currentMode`，构造后立即调用必抛；`:13-14`「**after 回调之前绝不调用任何实例方法**」 |
| 就绪排队 | `:79 ready`、`:85-86 pendingValue`（初始值/早期 setValue/retry 前内容）、`:306-313` 在 `after` 中一次性 `setValue(pendingValue)`、`:324 emit('ready')` |
| 15s 超时兜底 | `:90 READY_TIMEOUT = 15000`、`:92-94 clearReadyTimer()`、`:299` 清理 |
| 所有实例方法守卫 | `:397-400 writeValue`（未就绪 → 入队 `pendingValue`，**不调用实例**）、`:404-407 insertMarkdown`（入队 `pendingInsert`）、`:443-446 focus/isUploading`（`ready.value && instance` 判断）、`:425 setTheme` 守卫、`:129 insertValue` 守卫 |
| `readValue()` 未就绪**不返回空串** | `bridge.readValue` 经 `:383 if (!ready.value) return null` 与上级组件的 `pendingValue` 兜底（未就绪时返回**初始/排队值**而非空串）；上传回调同受 `ready` 守卫 |
| 未就绪即可编辑元素查询 | `:445-447 isReady()/editableElement()`（未就绪返回 `null`） |

### 4.2 C · 飞书式可视化编辑
| 断言 | 证据 |
|---|---|
| `wysiwyg` 模式 | `VditorEditor.vue:229 mode: 'wysiwyg'`；`:19` 注释「不显示 `#` / `**` 等语法标记」；底层仍 Markdown 存取（文档 §19 说明 `getValue()=VditorDOM2Md`） |
| 4 个自建增强组件全部挂载 | `VditorEditor.vue:39-42` 导入 + `:485-488` 依次渲染 `EditorInlineShortcuts` / `EditorSlashMenu` / `EditorSelectionToolbar` / `EditorBlockHandle` |
| 块调整（**如实降级**） | `editorBridge.ts:334-335` 菜单含「上移/下移」（`disabled: index<=0` / `index>=total-1`）；`EditorBlockHandle.vue:5-10` 明示「真正的按住拖拽**未实现**（Vditor 无公开拖拽 API，硬搬 DOM 会破坏 `data-marker`/`<wbr>` 协议），用上移/下移等价完成」→ **如实披露，无夸大** |
| 纯逻辑正确性 | 见 §2.3/§2.4（`splitBlocks`/`convertBlock` 锁类型/表格增删行列/斜杠过滤/行内快捷）——**已独立执行** |
| 排版作用域 | 文档 §19 与总览 `:159` 说明样式限定在 `style.css` 的 `.md-editor .vditor-reset`（含暗色）；未在本次实机目视（见 §5） |

### 4.3 D · 详情页无模式就地编辑
| 断言 | 证据 |
|---|---|
| **无「编辑页」** | `App.vue:197 type DetailMode = 'list' \| 'read' \| 'new'`（**无 `edit`**）；`:508` 注释「无『编辑页』：打开即就地可编辑，detailMode 不再有 edit 语义」 |
| 站主常驻容器 / 游客只读 | `App.vue:913 <ArticleEditView>`（站主条件 `:256 inEditMode = admin && (article \|\| detailMode==='new')`）；`:932-933 <ArticleDetail>`（游客/非站主，**组件未改**） |
| 外壳随焦点显隐 + **两态零布局跳动** | `ArticleEditView.vue:859-860` `:class="{ 'is-active': shellActive, 'is-collapsed': !shellActive && !measuring, 'is-measuring': measuring }"` + `:data-shell`；`:970` 注释「工具栏随外壳显隐，收起时按**实测高度占位**」；`:1100-1103` 收起态隐藏 `.vditor-toolbar` |
| 收起即 flush | `:137 void autosaver.flush()`（注释：未变更 → 指纹短路，**不发请求**）；`:611/:780` 其他 flush 触发点 |
| `Esc` / 点外部收起、浮层优先 | 文档 §20（`docs/门户…§20`）+ 总览 `:123/:220`：容器外 `pointerdown` 或 `Esc`；`focusout` 只认「焦点移交容器外可聚焦元素」（`relatedTarget` 为空不收起，避免 Vditor 重渲染误伤）；`Esc` 有浮层先关浮层 |
| 编辑器内互链接管 | `VditorEditor.vue:58 linkClick?` + `:273-279 options.link.click → props.linkClick`；`:452-453 toolbarElement()`（供上层实测工具栏高度做占位） |
| 无独立编辑页/无两态切换组件 | 只有一个站主容器 + 既有只读组件（见上）；`:key="editKey"` 仅在「打开/切换/新建」自增（文档 §20），故**外壳显隐不重挂载** |

## 5. 未独立复现的部分（**方法学限制，须显式声明**）

**开发者的浏览器 E2E（Edge headless + CDP：互链 47、飞书式 39、无模式 51）未被本次复现**——本环境未搭建 CDP harness（我在本轮把预算用于纯函数与接口层独立执行）。因此以下项目**仅为代码级核验**（证据见 §4），建议在 `pnpm dev` + `pnpm dev:web` 上按开发者清单手工/半自动复核一次：

1. 点正文即可输入、点文档区外收起且**编辑器同一 DOM 节点未重挂载**；
2. **两态几何完全一致**（收起/展开前后容器与正文宽高/内边距/相对偏移零跳动 —— 依赖 `--ikit-toolbar-h` 实测占位，需真机量测）；
3. `Esc` 收起与「有浮层先关浮层」的优先级；
4. `/` 斜杠菜单弹出/过滤/键盘导航/插入；悬浮格式条 5 个动作；块手柄菜单（上移/下移/转格式/表格增删行列）；
5. 状态条与大纲、暗色主题下的飞书式排版目视；
6. **打开详情 / 仅聚焦点击 / 收起 的 `PATCH=0`**（浏览器网络面板；服务端侧我已证明「读路径零写入」，但「前端不发出写请求」只有代码级依据：`ArticleEditView:137` flush 走 unchanged 指纹短路）；
7. 互链 `Ctrl/Cmd+点击`（编辑器内）、id 式单击、页内锚点滚动、失效链接 toast、返回栈 `← 返回上一篇/返回列表`；
8. 游客只读无控件、零写请求。

## 6. 开发者披露项的判定（**逐条给出可接受性结论**）

| 披露项 | 判定 | 理由与依据 |
|---|---|---|
| **编辑器内 `[[标题]]` 需 `Ctrl/Cmd+点击` 跳转** | **可接受** | Lute 的 wysiwyg DOM 里 `[[标题]]` 是**纯文本**（非 `<a>`），无法挂点击处理；`[文字](ikit://doc/<id>)` 形式**单击即跳转**，工具栏「插入文档链接」默认插入 id 式，故有等价可用路径；**阅读端（`markdown-it`）渲染成 `<a>`，单击即跳转，不受此约定影响**。已在总览 `:134/:153` 与门户 §20 明确写入 |
| **失效互链只加 class（不写 `title`/`data-*`）** | **可接受（且是正确取舍）** | Lute 的 DOM→Markdown 会把 `<a title>` 转成 `[文字](url "title")`，写属性等于**改写用户内容**；只加 class（`.ikit-doc-link--missing`）保证往返不污染，代价是编辑器内失效链接**没有 tooltip**（阅读端有）。属保守取舍，文档已披露 |
| **Lute 归一化**（`- [x]`→`- [X]`、callout 追加标签、表格补空格） | **可接受** | 属编辑器↔Markdown 往返的既有归一化，**幂等**（我独立验证了纯逻辑层往返一致：`joinBlocks(split)==原文`、`parseTable⇄renderTable`、`convertBlock` 锁类型；开发者的 16 类往返 E2E 未复现，见 §5）；差异已在文档披露，阅读端渲染不受影响 |
| **站主标签从「可点筛选 chip」变为可编辑输入框** | **可接受（建议补一句说明）** | 全字段就地编辑的必然取舍；**游客/阅读端 `ArticleDetail.vue` 未改**，读侧 chip 点选仍可用。建议在门户 §20 明确「站主侧的标签筛选改用左栏目录/右栏标签云」以免站主误以为功能丢失 |
| **`# ` 行内快捷不在 `inlineShortcuts`** | **可接受（设计如此）** | 模块头注释（`inlineShortcuts.ts:3-9`）已核对 Vditor 源码：`# ` 由 Vditor 原生 `isHeadingMD` 处理，本模块只补 Vditor 缺失的 `- `/`* `/`+ `/`1. `/`> `；**无重复实现、无功能缺口**（真实浏览器中的 `# ` 行为需人工确认，见 §5） |

## 7. 文档一致性

| 文档 | 抽查点 | 结论 |
|---|---|---|
| `docs/需求功能总览.md` | 模块① `:123`（无模式容器）、`:130-134`（互链语法/失效/同名/返回栈/编辑端辅助）、`:135-138`（飞书式：wysiwyg、悬浮条、斜杠、块手柄+**拖拽未实现的如实说明**）、`:147-160`（实现位置与已知边界 `:163`）、`:165`（一致性状态含三方自报项）；模块② `:203/:209/:211/:220/:222` | 与代码一致 |
| `docs/门户布局与功能改造需求文档.md` | `:255/:257`（无模式就地编辑）、`:260`（互链 + 返回栈）、`:283`（**无后端改动/无迁移**）、`:304`（中栏导航）、**§18 `:349+`（Vditor 异步初始化缺陷）**、**§19 `:365+`（飞书式 wysiwyg，含 `:389` 斜杠不复用 hint、`:395` 行内格式归一化、`:399` 39 项 E2E）**、**§20 `:409+`（无模式，含 `:429` 收起判据、`:432` 只加 class 的理由、`:437` 51 项 E2E）** | 与代码一致 |
| `README.md` | 与总览/门户对应段落一致（互链语法、wysiwyg、无模式入口） | 一致（抽查，无冲突表述） |

## 8. 三档清单

**必须修**：**无**。

**建议修**
1. **补做 §5 的 8 项浏览器交互确认**（尤其「两态几何零跳动」与「打开/聚焦/收起 PATCH=0」需真机网络面板与量测）——本次因未搭建 CDP harness，仅代码级核验；若沿用开发者自报，请在发布记录中注明「自报未复现」。
2. 文档补一句：**站主侧标签以输入框编辑**，筛选仍可用左栏目录/右栏标签云（避免误判功能丢失）。
3. （可选）编辑器内失效互链**没有 tooltip**（只加 class 的代价），建议在编辑器内加一处**非 DOM 持久化**的提示（如状态条/toast）以对齐阅读端体验。

**可忽略**
4. Lute 归一化导致的 Markdown 文本微差（幂等、已披露）。
5. `# ` 行内快捷由 Vditor 原生承担（本模块刻意不重复实现）。
6. 编辑器内 `[[标题]]` 的 `Ctrl/Cmd+点击` 约定（阅读端不受影响；id 式单击可用）。

## 9. 复现命令

```powershell
cd D:\Projects\i-kit; pnpm -r --if-present build          # exit 0
pnpm --filter @ikit/web typecheck                          # exit 0
cd C:\Users\wxov1\AppData\Local\Temp\ikit-ed
node ed2.mjs                                               # 63/63 PASS（纯函数 + 索引可见性 JSON/SQLite 各一轮）
# 实例隔离于 %TEMP%\ikit-ed\work\srv-{json,sqlite}（PORT 3561/3562，独立 data/PLUGIN_DIR）
```

> 复核过程中出现的失败项**全部**为本 QA 脚本的 API 形状/期望错误（`resolveDocLink` 参数顺序为 `(link, index, opts)`、`applyBlockOp` 首参为 Markdown 字符串、`blockTypeOf` 无 `table` 分支、`# ` 刻意不入本模块、heading id 为 `heading-0` 起）；修正后 **63/63 PASS**，**未发现产品缺陷**。

*本报告所有结论均来自本次独立执行的命令/进程输出；浏览器交互项已明确标注为代码级核验，未采信开发者自报的 E2E 数字作为通过依据。*
