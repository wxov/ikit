// 拾光 AI 润色提示词构建（2026-11-28，M1）
//
// 与路由分离成纯函数，便于单测与后续 A/B（prompt 版本化）。
// 设计：硬约束 + 风格卡 + 编辑动作 + 自检，日记/感悟各有一套**可检查的编辑清单**。
export type PolishType = 'diary' | 'insight'
export type PolishIntensity = 'light' | 'standard' | 'deep'
export type PolishStyle = 'plain' | 'literary'
/** full=整篇润色；section=只润色选中段（上下文仅供参考） */
export type PolishMode = 'full' | 'section'

export const POLISH_PROMPT_VERSION = 'v2'

/** 日记：更贴近生活 */
const DIARY_RULES = `1) 场景落地：保留或补一个具体时刻/地点（如「下午三点」「楼下便利店」）；原文没提到的地方不要编造。
2) 感官细节：至少 1 处可感知的细节（温度、声音、气味、光线、手上的动作）。
3) 口语与短句：允许「就…」「挺…」「有点…」；句子平均不超过 25 字。
4) 情绪曲线：保留原来的起伏，不强行升华、不硬拗正能量结尾。
5) 去作文腔：删「通过这件事我明白了」「总而言之」等总结句。`

/** 感悟：更富哲学与文笔 */
const INSIGHT_RULES = `1) 概念提炼：从具体经历中抽出 1 个可命名的概念（如「延迟满足」「边界感」），并说明为什么。
2) 因果/张力：写出至少一组对立或转折（「越…反而越…」），避免单线陈述。
3) 隐喻克制：最多 1 个贯穿隐喻；不用网络热梗。
4) 文笔：长短句交替，删形容词堆砌；引用最多 1 句，且不编造出处。
5) 留白：结尾不下结论，留一个开放问题或画面。
6) 篇幅：控制在原文 ±30%，不注水。`

const LITERARY_CLAUSE = '风格偏向：文笔优先——可适度锤炼动词与意象，但仍以作者口吻为准，不堆砌辞藻。'
const PLAIN_CLAUSE = '风格偏向：朴素优先——用日常词，少修辞，像作者自己随手写的。'

const TOLERANCE: Record<PolishIntensity, string> = {
  light: '±15%（只做必要修整）',
  standard: '±25%',
  deep: '±35%（可补足细节与层次）',
}

export interface PolishPrompt {
  system: string
  temperature: number
  maxTokens: number
}

export function normalizePolishType(v: unknown): PolishType | null {
  return v === 'diary' || v === 'insight' ? v : null
}

export function normalizePolishIntensity(v: unknown): PolishIntensity {
  return v === 'light' || v === 'deep' ? v : 'standard'
}

export function normalizePolishStyle(v: unknown): PolishStyle {
  return v === 'literary' ? 'literary' : 'plain'
}

/** 双候选用：第二版比第一版更"深"一档（deep 保持 deep，靠温度差异） */
export function nextIntensity(v: PolishIntensity): PolishIntensity {
  return v === 'light' ? 'standard' : 'deep'
}

/** 构建 system prompt 与采样参数（温度/上限按类型与强度） */
export function buildPolishPrompt(
  type: PolishType,
  intensity: PolishIntensity,
  style: PolishStyle,
  mode: PolishMode = 'full',
): PolishPrompt {
  const kind = type === 'diary' ? '日记' : '感悟'
  const rules = type === 'diary' ? DIARY_RULES : INSIGHT_RULES
  const styleClause = style === 'literary' ? LITERARY_CLAUSE : PLAIN_CLAUSE
  const lengthTolerance = TOLERANCE[intensity]

  const system = `你是中文私人写作编辑，服务一位写日记与感悟的普通作者。你的工作是「编辑」，不是「代笔」。

<硬约束>
- 不改变原意与事实：人物、时间、地点、数字、引用一律不动；原文没有的信息不新增（可抽象，不可编造）。
- 保留第一人称与作者口吻；不把作者改造成别人。
- 只输出正文，不要解释、标题、引号或 Markdown 代码块包裹。
</硬约束>

<scope>
${mode === 'section'
      ? '只润色【选中段】：上文/下文仅用于理解语气、指代与衔接，不要改写上下文，不要把上下文并入输出。输出只包含选中段润色后的文字。'
      : '整篇润色：保持原文段落顺序与段落划分，不要合并或新增段落。'}
</scope>

<style_card>
类型：${kind}
强度：${intensity === 'light' ? '轻' : intensity === 'deep' ? '深' : '标准'}
篇幅：${lengthTolerance}
${styleClause}
</style_card>

<editing_actions>
按顺序执行，但只做必要的：
1) 修错别字与语病；
2) 调整语序与断句，删重复与口水词；
3) 按下面的清单补足缺失的 1–2 项（不虚构）：
${rules}
4) 通读，确保结尾不像模板。
</editing_actions>

<self_check>
输出前逐条确认：事实未变？口吻仍是作者？清单至少命中 2 条？没有新增专有名词？没有总结式套话？
</self_check>`

  const table: Record<PolishType, Record<PolishIntensity, { temperature: number; maxTokens: number }>> = {
    diary: { light: { temperature: 0.55, maxTokens: 1200 }, standard: { temperature: 0.65, maxTokens: 1600 }, deep: { temperature: 0.7, maxTokens: 1800 } },
    insight: { light: { temperature: 0.55, maxTokens: 1200 }, standard: { temperature: 0.6, maxTokens: 1400 }, deep: { temperature: 0.7, maxTokens: 1800 } },
  }
  const p = table[type][intensity]
  return { system, temperature: p.temperature, maxTokens: p.maxTokens }
}
