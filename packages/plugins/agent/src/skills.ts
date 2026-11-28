// 小知技能（SKILL 式渐进披露，2026-11-28，M2）
//
// 设计：主提示只注入「技能名 + 标题 + 何时用」，正文由 use_skill 工具按需加载，
// 避免长流程文本常驻上下文（参考 Anthropic Agent Skills 的 progressive disclosure）。
// 约束：description ≤ 80 字（发现信号），body ≤ 1500 字（加载时占用上下文）。

export interface AgentSkill {
  /** 唯一 id（工具参数枚举值） */
  name: string
  /** 中文名 */
  title: string
  /** 何时用 + 何时不用（发现信号） */
  description: string
  /** 流程正文，use_skill 时注入 */
  body: string
  /** 推荐搭配的工具（提示用，不强制） */
  tools?: string[]
  /** 写类技能：仅站主可加载 */
  requiresAdmin?: boolean
  version: string
}

export const SKILLS: AgentSkill[] = [
  {
    name: 'knowledge_curator',
    title: '文档整理',
    description: '当用户要求整理、归档、分类、去重、合并、拆分知识库文档时使用；纯检索或写作时不要用。',
    tools: ['knowledge_search', 'knowledge_update'],
    requiresAdmin: true,
    version: 'v1',
    body: `目标：把混乱的文档整理成结构清晰、无重复的知识库。

步骤：
1) 先用 knowledge_search 分主题检索候选（同一主题可换 1 个关键词再检一次），列出文档标题、分类、更新时间。
2) 给出「保留 / 合并 / 拆分 / 归档」方案：每条写清理由（重复内容、标题相近、层级过深）；
   合并方案要写明"保留哪篇标题、哪些内容并入、旧文档如何处理（改标题加「（已合并）」或移入回收站由用户操作）"。
3) 等用户确认，不要先动手。
4) 逐条执行：合并用 knowledge_update 的 append 模式追加内容并改标题；分类用 category 字段；
   不要整篇 replace，除非用户在确认时明确给出完整新正文。
5) 汇报：改了哪几篇、每篇改了什么、还有什么建议（如补标签、拆分长文）。

注意：删除与移动工具不支持，需要用户在界面操作；不要凭空新建分类。`,
  },
  {
    name: 'doc_writer',
    title: '文档写作',
    description: '当用户要求写一篇新文档、续写、改写成教程或结构化长文时使用；只是问问题时不要用。',
    tools: ['knowledge_add', 'knowledge_update'],
    requiresAdmin: true,
    version: 'v1',
    body: `目标：写出一篇结构清楚、可读、可维护的中文文档。

步骤：
1) 先确认三件事（能从上下文推断就不问）：读者是谁、要解决什么问题、期望长度。
2) 给出 3–6 节提纲（每节一句说明，标出代码块/表格位置），等用户确认。
3) 用 knowledge_add 写入：标题具体、分类按现有分类（不确定就先 knowledge_search 看同类文档放在哪）、
   status 缺省 draft；正文用 Markdown（## 分节、代码块标注语言、列表不超过 7 条）。
4) 写完自查：标题层级是否只有一级 ##、示例是否可运行、有没有空链接、长度是否匹配提纲。
5) 询问是否发布（published 需标题与正文均非空）；不要替用户发布。

续写时优先 knowledge_update 的 append；改写时先说明会改哪几节。`,
  },
  {
    name: 'research_web',
    title: '联网调研',
    description: '当用户明确要求查网上资料、最新动态、外部对比，且知识库没有相关内容时使用；站内问题不要用。',
    tools: ['web_fetch'],
    version: 'v1',
    body: `目标：给出有来源、可核对的调研结论，而不是网页原文堆砌。

步骤：
1) 把问题拆成 2–3 个具体查询（版本号、时间范围、对比对象）。
2) 最多抓 2 个链接（优先官方文档/项目仓库）；一次对话不要反复抓同一域名。
3) 输出固定三段：
   - 结论（3 句以内）
   - 依据（每条带来源标题或域名，标注抓取日期）
   - 不确定点（版本差异、缺少数据）
4) 不整段粘贴网页正文；引用单条不超过 2 句。
5) 若抓取失败：说明链接不可用，改用知识库或建议用户提供链接。

注意：站内问题先 knowledge_search；不要用 web_fetch 查需要登录的页面。`,
  },
  {
    name: 'daily_assistant',
    title: '站务助手',
    description: '当用户询问功能怎么用、在哪里设置、为什么报错时使用；写文档或调研外部资料时不要用。',
    tools: ['knowledge_search'],
    version: 'v1',
    body: `目标：用最短路径帮用户完成站务操作。

回答固定结构：
1) 功能一句话说明（做什么、影响范围）。
2) 入口（页面/按钮/快捷键；不确定就先 knowledge_search 查站内文档）。
3) 步骤（编号 ≤5 步）。
4) 注意（权限要求、不可逆操作、常见报错）。

规则：
- 不确定的功能不要臆测界面位置，直接说"站内文档没有写，建议在设置页确认"。
- 涉及权限（草稿/私密/用户组/插件启停）时说明需要站主。
- 报错类问题先问清报错原文与操作步骤，再给排查顺序。`,
  },
]

/** 供 system prompt 使用的技能索引（只有名字/标题/触发条件） */
export function skillIndexText(skills: AgentSkill[] = SKILLS): string {
  if (!skills.length) return ''
  return [
    '可用技能（需要时先调用 use_skill 加载完整流程，再按流程执行；一次最多加载 2 个）：',
    ...skills.map((s) => `- ${s.name}（${s.title}）：${s.description}`),
  ].join('\n')
}

/**
 * 技能变体正文（2026-11-28 M3 A/B）。
 * 只覆盖经过评审的技能；未覆盖的技能始终使用 SKILLS 里的基础正文。
 */
export const SKILL_VARIANTS: Record<string, Partial<Record<'a' | 'b', string>>> = {
  doc_writer: {
    a: `目标：写一篇「可验收」的中文文档（A 版：检查清单驱动）。

步骤：
1) 先写三行「验收标准」：读者是谁、读完能做什么、必须包含哪些信息。
2) 再给 3–6 节提纲，每节标注：目的、是否含代码/表格、预计篇幅。
3) 用 knowledge_add 写入；正文规范：
   - 只用一级 ##，不用 # 与 #### 混排；
   - 代码块标注语言，示例可复制运行；
   - 列表 ≤7 条，超过则拆小节；
   - 每个结论后尽量给依据（链接/命令/现象）。
4) 写完逐条对照检查清单：标题层级、可运行性、空链接、长度是否匹配提纲、是否编造。
5) 只问一次「是否发布」，不反复追问。

注意：发布需标题与正文均非空；不要替用户发布。`,
    b: `目标：写一篇「读者优先」的中文文档（B 版：从读者问题出发）。

步骤：
1) 先列 3–5 个读者会问的问题（是什么 / 为什么 / 怎么做 / 坑在哪）。
2) 按问题组织小节，每个问题一节；小节标题直接写成问题或结论。
3) 开头给「30 秒结论」：3 句以内说清这篇文档解决什么。
4) 用 knowledge_add 写入，status 缺省 draft；适当配代码块与对比表。
5) 结尾给「下一步 / 相关文档」两条即可，不写空洞总结。

约束：不编造未验证的数据；不确定处标注「待确认」；篇幅与问题数量成正比。`,
  },
  knowledge_curator: {
    a: `目标：按「分类树优先」整理文档（A 版）。

步骤：
1) 先 knowledge_search 拉出候选，再按现有分类（category 字段）归组。
2) 输出目标分类树：每个分类下列出应保留的文档与理由；跨分类的文档标注建议归属。
3) 给出「合并 / 拆分 / 归档」清单：合并要写保留标题与并入内容；拆分要写拆成几篇、各自标题。
4) 等用户确认后，用 knowledge_update 逐条执行（合并用 append，分类改 category）。
5) 汇报变更清单与剩余建议（标签、上级文档、待补内容）。

禁止：整篇 replace（除非用户给出完整新正文）；删除/移动由用户在界面操作。`,
    b: `目标：按「重复优先」整理文档（B 版：先查重、再归并）。

步骤：
1) 先检索同一主题的 2–3 组关键词，列出「疑似重复」文档对（标题相近 / 内容重合）。
2) 对每对给出结论：重复 / 部分重叠 / 无关；重复的写「保留哪篇、为什么」。
3) 再处理结构问题：层级过深、标题含糊、分类缺失。
4) 输出一次性执行方案（按依赖排序），等用户确认后逐条 knowledge_update。
5) 汇报：合并了几对、改了几篇标题/分类、还剩哪些建议。

禁止：无确认批量改写；不整篇 replace；不删除文档。`,
  },
}

/** 取技能变体正文（未配置则返回 undefined，调用方回落到基础正文） */
export function variantBody(name: string, variant?: 'a' | 'b'): string | undefined {
  if (!variant) return undefined
  return SKILL_VARIANTS[name]?.[variant]
}

export function findSkill(name: string, skills: AgentSkill[] = SKILLS): AgentSkill | undefined {
  const key = String(name ?? '').trim()
  return skills.find((s) => s.name === key)
}

/** 技能清单（给 API / UI 展示，不含正文） */
export function skillList(skills: AgentSkill[] = SKILLS): Array<Omit<AgentSkill, 'body'>> {
  return skills.map(({ body: _body, ...rest }) => rest)
}
