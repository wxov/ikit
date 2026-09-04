# i-kit 验收报告 · 完善① 死字段清理

> 角色：测试验收工程师（独立验收）
> 方案依据：`docs/ai-delivery/完善①-死字段清理-方案.md`
> 基线背景：`docs/ai-delivery/acceptance-report-1.md`（第 1/2 轮回归 + 文档修正）
> 日期：2026-09-04

## 一、基线构建

- 命令：`pnpm -r --if-present build`
- 结果：**PASS（exit code 0）**
- 范围：Scope 11/12 个 workspace 项目（`@ikit/server` 无 build 脚本，tsx 运行，不参与构建）。
- tsc 类型检查全通过：`knowledge / api / core / demo / llm / agent / plugin-registry / account / store-data`；`@ikit/web` `vite build` 通过（159 modules，仅有 chunk >500kB 常规体积警告）。
- 说明：tsc strict 全通过 = 删除死字段后**无任何残留类型引用**（若仍有 `entry.rating/likes/summary/history/shareToken` 或 `EntryVersion` 引用会编译报错）。

## 二、改动清单核验表（逐项实证）

| 文件 | 方案要求 | 核验结果 | 证据 |
|---|---|---|---|
| `knowledge/src/types.ts` | 删 `EntryVersion` + 5 死字段；`status`/`'archived'`/`KnowledgeComment.likes` 保留 | PASS | `types.ts` 现从 `:1` EntryVisibility 起，`EntryVersion` 已无；`KnowledgeEntry`（`:12-41`）无 rating/likes/summary/history/shareToken；`status`（`:26`，含 `'archived'`）保留；`KnowledgeComment.likes`（`:75`）保留。 |
| `knowledge/src/store.ts` | 新库建表不含 5 死列；addCol/load/persist 删对应项；存量库无 DROP/重建 | PASS | `CREATE TABLE entries`（`:47-65`）17 列无 rating/likes/summary/history/share_token；`addCol` 迁移（`:86-92`）仅 parent_id/sort_order/cover/views/status/visibility/visible_groups；`load()` 映射（`:98-116`）无死字段；`persist()` INSERT 列（`:148`）与值（`:152-169`）无死字段；**无 `DROP COLUMN`/重建逻辑**（A+ 策略）。`comments` 表 `likes`（`:75/177/181`）保留（范围外）。 |
| `knowledge/src/service.ts` | update 不再写 history | PASS | `update`（`:217-261`）直接由 `newContent` → 可见性处理 → `{...prev,...}` 对象字面量（`:242-252`），无 history 写入块；全文件 grep 无 `history` 引用；`addComment` 的 `likes: 0`（`:534`）保留（范围外）。 |
| `apps/web/src/lib/api.ts` | 删重复 `EntryVersion` + 5 死字段；`status`/评论 likes 保留 | PASS | `EntryVersion` 已无（`:3` 起为 EntryVisibility）；`KnowledgeEntry`（`:5-21`）无死字段，`status`（`:14`）保留；`KnowledgeComment.likes`（`:36`）保留。 |
| `ContentCardFeed.vue` | 删 👍/★ 渲染 + `star()` + `.cf-item.stars` | PASS | grep `star(\|e.likes\|e.rating\|\.stars` → **No matches**（全仓库无）。 |
| `ArticleDetail.vue` | 删 👍/★/「AI 摘要」+ `star()` + `.stars/.ad-summary/.as-label` | PASS | 同上 grep → **No matches**。 |
| `PortalRight.vue` | 删 `score()`、热门排序改 `updatedAt` 降序、去 `0👍` | PASS | `score()` 已无；热门排序（`:35-37`）`.sort((a,b)=> new Date(b.updatedAt).getTime()-new Date(a.updatedAt).getTime()).slice(0,8)`；热门 meta（`:108`）`{{ shortDate(e.updatedAt) }} · {{ e.category \|\| '未分类' }}`，无 `0👍`。 |
| `api/src/routes.ts` | 无改动（无显式 DTO） | PASS | 全仓库 `packages/` grep `shareToken\|share_token\|EntryVersion` → **No matches**；routes 无死字段引用（字段从类型移除后 JSON 自动不外发）。 |

## 三、残留分析（grep 全量）

`packages/plugins/knowledge/src` 与 `apps/web/src` 中 `rating|likes|summary|shareToken|EntryVersion` 匹配项，逐条定性：

| 位置 | 内容 | 定性 |
|---|---|---|
| `knowledge/src/types.ts:75`、`store.ts:75/128/177/181`、`service.ts:534` | 评论 `KnowledgeComment.likes`（恒 0，无点赞路由） | **范围外（允许）**——方案 §1 非目标 + §8-3，非本次 5 字段清单 |
| `apps/web/src/lib/plugins.ts:69-70`、`PluginStore.vue` 多处 | 插件商店 `PluginRecord.rating/ratingCount`（商店评分，活功能） | **范围外（允许）**——活功能，与知识库 rating 同名不同域 |
| `apps/web/src/components/SettingsPanel.vue:96` | `<summary class="faq-q">`（HTML `<summary>` 标签，FAQ 折叠） | **范围外（允许）**——与 AI 摘要无关 |
| `apps/web/src/style.css:498-519` | `.summary-row/.summary-text/.summary-label/.summary-box` 暗色主题规则（「摘要框」） | **次要观察（孤儿 CSS）**——无任何组件引用（grep 全 src 仅 style.css 命中）、无浅色定义；不影响功能，建议可选后续清理 |
| Agent 会话 `ChatMessage[]` history | `agent/` 域（LLM 对话历史，`routes.ts:872/884`） | **范围外（允许）**——同名不同域 |

结论：`KnowledgeEntry` 的 rating/likes/summary/history/shareToken 与 `EntryVersion` 类型在**后端类型/存储/服务 + 前端类型/组件渲染**中已无任何类型或消费残留；仅存合法范围外项（评论 likes、商店 rating、FAQ `<summary>`）与 1 处孤儿 CSS。

## 四、文档同步核验

| 文件 | 方案要求 | 结果 | 证据 |
|---|---|---|---|
| `README.md:138` | 「更新（写入版本历史）」→「更新」 | PASS | 现为「创建 / 列表（分页 + 可见性过滤）/ 更新」，无版本历史措辞。 |
| `门户文档` §14/§15 | 移除点赞/星级/AI摘要渲染描述、权限描述中「评分/点赞」、SQLite/数据模型 5 死字段 | PASS | `:263` 与 `:294` 权限改「评论/浏览」；`:265` SQLite 列无死列；`:291` 卡片流信息条「分类/日期/浏览」；`:295` 记录「rating/likes/summary/history/share_token 死字段已清理（存量库列保留、新库不建）」；`:302` §16 历史记录**不改**（正确保留）。 |
| `总览` 模块① / 第四节 / 第六节第1项 | 处置列=已清理、第1项 ✅ | PASS | 模块① D 项 `:129`「已清理（2026-09）」；第四节表 `:329-333` 处置列均「已清理（2026-09）」+ `:336` 说明；第六节 `:366`「1. ✅ 死字段清理（已完成 2026-09）」。 |
| `用户组文档:173` | shareToken 补注「已随死字段清理移除」 | PASS | 「分享链接 `shareToken`（当前未启用，已随死字段清理移除 2026-09）」。 |

## 五、结论

**PASS。**

- 构建通过（tsc strict + vite，exit 0）。
- 5 死字段 + `EntryVersion` 类型从**数据模型 / 读写路径 / 序列化外发 / 前端渲染**四层面全部移除，无类型/消费残留（`shareToken`/`EntryVersion` 全仓库零引用）。
- SQLite 采用方案 A+ 正确落地：新库建表不含 5 死列、addCol/load/persist 已删对应项、存量库列保留、**无 DROP/重建**（回滚=改回代码，零数据风险）。
- 热门文章排序已改为 `updatedAt` 降序（零行为变化），卡片/详情不再渲染 👍/★/AI 摘要。
- 文档同步（README / 门户文档 §14-15 / 总览 / 用户组文档）全部落笔且与代码一致。

**次要观察（非 FAIL，可选后续）**：
1. `apps/web/src/style.css:498-519` 存在孤儿暗色 CSS `.summary-*` 块（无组件引用、无浅色定义），属「遗留 CSS」，不影响功能，建议后续随手清理。
2. `门户布局与功能改造需求文档.md:68` 与 `:172`（§3 功能清单表）仍列「导出/版本/AI 摘要/评分/点赞/分享」为知识库功能——属早期需求清单（非 as-built 记录），不在方案 §3.4 目标行内；as-built §14/§15/§16 已正确记录清理。如需彻底一致可后续一并更新 §3 清单措辞。

*（本报告仅新增 `docs/ai-delivery/acceptance-report-完善①-死字段清理.md`；未改动任何代码/数据文件，未执行 git 操作。）*
