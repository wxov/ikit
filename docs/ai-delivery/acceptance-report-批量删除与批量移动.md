# 验收报告 · 知识库目录树「批量删除 / 批量移动」

> **角色**：测试验收工程师（**独立验收**，未改任何代码、未做 git 写操作）
> **验收对象**：`develop` 工作区现状（`HEAD = f625ba4` + 本功能未提交改动）
> **权威依据**：用户已确认的四项决策（切换式批量入口 / 级联软删除 / 可搜索层级下拉 + 环校验 / 全成功或全失败）
> **验收时间**：2026-10-14 ｜ **环境**：Windows / Node v24.15.0 / pnpm 10.33.2；本机 `pnpm dev`(:3000)、`pnpm dev:web`(:5173) 在跑（**未触碰**）
> **隔离声明**：测试实例位于 `%TEMP%\ikit-bd\{json,sqlite}\**`（独立 `cwd` / `data` / `PLUGIN_DIR` / `PORT=3551|3552`）。**未触碰**真实 `packages/server/data`、`plugins/`、`.env`；未执行任何 git 写操作。断言脚本为本 QA 自建（`%TEMP%\ikit-bd\bd.mjs`），**未复用开发者脚本**。
> **结论**：**PASS** —— 后端独立复测 **70/70 PASS**（35 项 × JSON/SQLite 各一轮，含 `0` 孤儿、失败**零写入**（存储文件 MD5 不变）、WS 广播条数与 `affectedIds` 逐一对齐）；前端 4 项决策与导入弹窗回归为**代码级核验通过**；文档 4 处一致。**「必须修」为空。**

---

## 1. 构建

| 命令 | 结果 |
|---|---|
| `pnpm -r --if-present build` | **exit 0** —— 11/12 项目全部 `Done`（含 `@ikit/plugin-knowledge`、`@ikit/api`、`@ikit/core`、`@ikit/plugin-agent` 的 `tsc`）；`apps/web build$ vue-tsc --noEmit -p tsconfig.json && vite build` 通过 |

## 2. 后端独立复测（35 项 × 2 存储 = **70/70 PASS**）

> 造树（每个实例独立）：`P` → `C1` → `G1`；`P` → `C2`；旁系根 `S`、`S2`；预置回收站条目 `D`。
> 断言同时校验「响应体 + 持久化状态（列表/回收站/存储文件哈希）」。

### 2.1 级联删除（决策 3）
| # | 用例 | JSON | SQLite |
|---|---|---|---|
| 1 | 选择 `[P, C1, S]`（`C1` 被 `P` 覆盖）→ 200，`deleted=2`（**根数** = P、S），`affectedIds` = **5 条**（P/C1/G1/`C2`/S，含 `P` 的另一个子项 `C2`） | PASS | PASS |
| 2 | P/C1/G1/C2/S **全部进回收站且 `deletedAt` 有值** | PASS | PASS |
| 3 | 回收站保留层级字段（`C1.parentId=P`、`G1.parentId=C1`、`C2.parentId=P`） | PASS | PASS |
| 4 | **无孤儿**：未删除集合中不存在 `parentId` 指向已删条目者 | PASS | PASS |
| 5 | 未选中且不在该子树的 `S2` 完全未受影响 | PASS | PASS |
| 6 | WS `knowledge:changed` **remove 广播 5 条**，id 集合 == `affectedIds` | PASS | PASS |
| 7 | 恢复父项 `P` → 父项可用；再逐条恢复 `C1/G1/C2/S` → **子树恢复且层级正确**（C1 挂 P、G1 挂 C1、C2 挂 P） | PASS | PASS |

### 2.2 原子性 / 全成功或全失败（决策 5）
| # | 用例 | JSON | SQLite |
|---|---|---|---|
| 8 | `[C2, 不存在的 id]` → **400**「部分条目不存在或已在回收站」+ 条目状态不变 + **存储文件 MD5 不变** | PASS | PASS |
| 9 | `[S2, D]`（`D` 已在回收站）→ **400** + MD5 不变 + `S2` 仍存活 | PASS | PASS |
| 10 | 501 条 → 400（`too many ids (max 500)`，路由层上限）+ MD5 不变 | PASS | PASS |
| 11 | 元素类型非法（`[123,'x']`）/ 空数组 / 纯空白 id / `parentId` 类型非法 → **均 400** | PASS | PASS |
| 12 | 去重后仍含不存在 id → 400（**去重不掩盖校验**） | PASS | PASS |

### 2.3 批量移动（决策 4）
| # | 用例 | JSON | SQLite |
|---|---|---|---|
| 13 | `[C2]` → `S`：200、`parentId=S`、`sortOrder` 为数值（追加末尾） | PASS | PASS |
| 14 | **分类不变**（未设置分类者移动后仍无分类） | PASS | PASS |
| 15 | WS update 广播 1 条且 id == `affectedIds` | PASS | PASS |
| 16 | **连续两次验证追加末尾**：再移 `X` → `S`，`X.sortOrder == C2.sortOrder + 1` | PASS | PASS |
| 17 | **子孙跟随**：移动 `C1` → `S` 后 `G1.parentId` 仍为 `C1` | PASS | PASS |
| 18 | **顶层**：`parentId: null` → 条目无 `parentId` | PASS | PASS |
| 19 | 移到**自身** → 400 + MD5 不变 | PASS | PASS |
| 20 | 移到**自身子孙** → 400 + MD5 不变 | PASS | PASS |
| 21 | **目标已删除** → 400 + MD5 不变 | PASS | PASS |
| 22 | **嵌套选择折叠**：`[C1, G1]` → `moved:1`、`affectedIds=[C1]` | PASS | PASS |

### 2.4 单条 `moveDoc` 加固 + 权限
| # | 用例 | JSON | SQLite |
|---|---|---|---|
| 23 | 单条 move 到自身子孙 → **400（原为 500）+ 零写入** | PASS | PASS |
| 24 | 单条 move 到自身 → 400；目标不存在 → 400；合法目标 → 200 且 `parentId` 正确 | PASS | PASS |
| 25 | 未登录批量删除 → **403**；非站主（真实 `user` 账号）批量删除/移动 → **403/403** | PASS | PASS |

> 补充：`normalizeBatchIds` 的「类型/空值/上限」校验、`foldNestedSelection` 的祖先折叠、`isSelfOrDescendant` 的环校验均在**任何写入之前**完成（源码 `service.ts:98-145` 与 407-491；路由层 `parseBatchIds` 在进服务前先 400）——与实测的「失败零写入」一致。

## 3. 前端代码级核验（无头环境无法模拟原生拖拽/键盘，明确标注）

| 决策/要求 | 判定 | 证据（行号） |
|---|---|---|
| ① 切换式批量入口，**仅站主** | PASS | `DocTree.vue:466` `<button v-if="isAdmin && !batchMode" class="batch-toggle">`；`:472` 工具条 `v-if="isAdmin && batchMode"`；`isAdmin` 来自 `inject('userRole')`（`:25`） |
| ① 工具条四项 + 计数 | PASS | `:473` `已选 {{ selected.size }} 项`、`:474-475` 全选本层（`title` 显示层级）、`:478` 批量移动、`:479` 批量删除（`selected.size` 为空时 `disabled`）、`:480` 退出 |
| ① 退出自动清空 / 日常不显示复选框 | PASS | `exitBatch()`（`:250-256`）清 `selected`/`batchLevel`/关弹窗；复选框仅在 `batchMode` 下渲染（`DocTreeItem.vue:98-112`） |
| ② 勾选父节点 → 子孙禁用单独勾选并标「随父级处理」 | PASS | `DocTree.vue:218-222 cascadeIds`（选中项 + 全部子孙）；`:262` `if (cascadeIds.value.has(id)) return`（禁止单独勾选）；`:266-268` 勾选父级时移除已选子孙（避免重复计数）；`DocTreeItem.vue:100`（非 cascade 才渲染 checkbox）、`:109-111`（cascade 渲染禁用框 + `title="随父级处理（父级已选中，无需单独勾选）"`）、`:129` 行内 `<span class="kb-cascade">随父级处理</span>` |
| ③ 级联软删除 + 确认弹窗文案 | PASS | `BatchDeleteDialog.vue:74` 「将删除 **{{stats.total}}** 篇（含 {{stats.children}} 篇子文档），移入回收站后可恢复」；`:20-48` 预览统计与服务端口径一致（折叠嵌套 + 级联收集子孙）；`:77` 明确「如需彻底清空请使用回收站 → 清空」→ **不提供彻底删除** |
| ④ 可搜索层级下拉（含顶层/清空/仅未删除） | PASS | 公共组件 `DocParentPicker.vue`：`:51` 空串 → `顶层（无父文档）`、`:55-58` 标题/路径过滤（`limit` 截断）、`:70-75 clear()`、`:64/:75` `disabled` 时禁止改挂载；`BatchMoveDialog.vue:117-123` 以 `label="移动到"` 复用，`:64-66` 目标标签回溯完整路径 |
| ④ 移到自身/子孙由**服务端**校验 | PASS | 服务端 `service.ts:458-466`（`idSet.has(pid)` + `isSelfOrDescendant` 逐条校验，先校验后写入）；实测 400 |
| ④ 同级追加末尾 / 分类不变 / 子孙跟随 | PASS | 服务端 `service.ts:473-486`（目标层 `sortOrder` 归一化 0..k-1 + 被移动项 k..k+m-1）；实测第 13/16/14/17 项 |
| ⑤ 全成功或全失败 | PASS | 服务端先整体校验后写入（`service.ts:408-415` / `450-467`）+ 实测零写入 MD5 不变 |
| 完成后刷新与 toast | PASS | `DocTree.vue:288-303`（`onBatchMoved`/`onBatchDeleted` → 关弹窗 + `exitBatch()` + `await load()` + `emit('changed',{message})`）；`App.vue:766` `@changed="onDocTreeChanged"` → 该函数（toast + `loadCategories()` + `dataKey++`） |
| 批量模式下拖拽/菜单不被破坏 | PASS | `DocTreeItem.vue:89` `:draggable="!!admin && !batchMode && !movePickMode"`；`:82-87` 拖拽高亮类均加 `!batchMode`；`:133` 行内 `＋/⋯` 动作 `v-if="admin && !batchMode && !movePickMode"`；非批量模式渲染路径未变（所有新增元素均以 `batchMode` 为条件） |
| 递归透传 | PASS | `DocTreeItem.vue:156-158` 向下透传 `batch-mode`/`batch-cascade`；`:174` 等透传 `toggle-select` 事件链；`DocTree.vue:502` 向子组件传 `:batch-mode` |
| **导入弹窗回归（重点）** | PASS | `ImportDocsDialog.vue:277` `<DocParentPicker v-model="parentId" :docs="docOptions" label="导入到" :disabled="busy">` + `#actions` 插槽保留「＋ 新建父文档」按钮、默认插槽保留新建子表单（`:279-…`）；`:152` 新建成功后 `parentId.value = r.entry.id`（**自动选中**）+ `:154` `createNotice` 提示；忙碌时 `:disabled="busy"`；`DocParentPicker` 的 `emptyLabel`/`placeholder` 默认值沿用（`:37-39`）→ 抽取公共组件**未引入行为回归**（选择/清空/顶层/搜索/禁用语义等价） |

## 4. 文档一致性

| 文档 | 抽查点 | 结论 |
|---|---|---|
| `README.md` | `:173` 能力行（级联软删除 / 批量移动 / 目标含顶层 / 追加末尾 / 分类不变 / 子孙跟随 / 先校验后写入）；`:335` `POST /api/knowledge/batch-delete`；`:336` `POST /api/knowledge/batch-move`（含服务端环校验与 400 语义） | 与代码一致 |
| `docs/需求功能总览.md` | 模块① `:116`（批量模式 + 级联 + 折叠 + 原子性）、`:133`（路由）、`:134`（前端组件清单）；模块② `:151-153`（批量入口/级联软删除/批量移动）、`:174`（左栏目录树描述） | 与代码一致 |
| `docs/门户布局与功能改造需求文档.md` | §14.1 `:261`（切换式入口 + 工具条）、`:263`（级联软删除 + 确认弹窗文案）、`:264`（可搜索层级下拉 + 环校验 + 分类不变）；§14.2 `:283`（两接口契约 + 零写入）；§15 `:302`（目录树一节补充批量模式） | 与代码一致 |

## 5. 观察与三档清单

**必须修**：**无**（四项决策与「全成功或全失败」均有真实执行证据；`moveDoc` 500 → 400 的加固亦已实测）。

**建议修**
1. **手工补做前端交互验收**（本次为代码级）：切换式入口、父级勾选后子孙禁用与「随父级处理」提示、全选本层、退出清空、两个弹窗的影响条数换算、层级下拉的搜索/清空/仅未删除过滤与键盘操作、批量模式下拖拽与 `⋯` 菜单禁用但不报错、以及**导入弹窗「导入到」下拉的实机回归**（建议同时验证 Firefox，原生 DnD 有已知差异）。
2. （可选，文档口径）`batchRemove` 响应中 `deleted` = **折叠后的根级条目数**，而实际入回收站条数 = `affectedIds.length`；README `:335` 已写明「返回 `deleted=`…」，但若后续有其它消费者，建议在 API 表里把两者显式并列（前端提示语已正确使用 `affectedIds.length` + 根数，实测一致）。

**可忽略**
3. `batchMove` 会把**目标层既有同级条目**的 `sortOrder` 归一化重排（不更新其 `updatedAt`、不单独广播）——与既有 `reorder` 的排序簿记约定一致（源码注释已说明），不影响业务字段。
4. 级联删除只处理**未删除**条目；已进回收站的子孙保持原状（其 `deletedAt` 不被覆盖），选择集中含已删除 id 会整体 400（实测第 9 项）——符合「全成功或全失败」。
5. 路由层上限 501 → 400 文案为 `too many ids (max 500)`（英文，与既有 `parseBatchIds` 风格一致），服务层上限为中文文案；无功能差异。

## 6. 复现命令

```powershell
cd D:\Projects\i-kit; pnpm -r --if-present build      # exit 0（web 含 vue-tsc）
cd C:\Users\wxov1\AppData\Local\Temp\ikit-bd
node bd.mjs                                           # PASS 70 / FAIL 0（日志 bd-run2.txt；JSON 与 SQLite 各 35 项）
# 实例隔离于 %TEMP%\ikit-bd\{json,sqlite}（PORT 3551/3552，独立 data/PLUGIN_DIR）
```

> 复核过程中曾出现 18 项 FAIL，经查为**本 QA 脚本的 fixture 期望错误**（`C2` 是 `P` 的子项，级联删除本就应包含它；脚本却把它当作「未受影响的旁系」并试图移动它）。修正期望（并新增真正未受影响的旁系 `S2`）后复跑 **70/70 PASS**；**未发现产品缺陷**。

*本报告所有结论均来自本次独立执行的命令/进程输出；前端交互项已明确标注为代码级核验。*
