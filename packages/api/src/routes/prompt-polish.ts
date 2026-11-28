// 小知「✨优化」：把口语输入改写为结构化指令（2026-11-28，M1）
//
// 纯函数模块（便于单测）：构建提示词、解析模型 JSON、降级兜底。
export const PROMPT_POLISH_VERSION = 'v1'

export type PolishIntent = 'ask' | 'search' | 'write' | 'organize' | 'other'

export interface PolishResult {
  prompt: string
  added: string[]
  intent: PolishIntent
  /** true = 模型输出无法解析，已回退为原文（前端提示「未能优化，可直接发送」） */
  degraded: boolean
}

const INTENTS: PolishIntent[] = ['ask', 'search', 'write', 'organize', 'other']

export function buildPromptPolishMessages(
  text: string,
  context?: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `你是「小知」的提示词优化器。把用户的口语化输入改写为一条清晰、可执行的指令，供另一个助手执行。

规则：
1. 保留用户原意与所有事实、数字、专有名词；不新增事实、不替用户做决定。
2. 仅在能从上下文合理推断时补齐：目标、对象/范围、受众、约束（长度/风格/格式）、期望输出。
3. 不要把简单问题复杂化：能一句说清就一句；用户输入已完整时只做轻微润色。
4. 输出必须是严格 JSON：
{"prompt":"改写后的指令","added":["补充点1","补充点2"],"intent":"ask|search|write|organize|other"}
5. 不输出 JSON 以外的任何文字。`

  const user = `<用户输入>
${text}
</用户输入>
<会话上下文>
${(context ?? '').trim().slice(0, 200) || '（无）'}
</会话上下文>`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

/** 解析模型输出；无法解析时降级返回原文 */
export function parsePromptPolishOutput(raw: string, fallbackText: string): PolishResult {
  const text = stripFences(String(raw ?? ''))
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return { prompt: fallbackText, added: [], intent: 'other', degraded: true }
  }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return { prompt: fallbackText, added: [], intent: 'other', degraded: true }
  }
  const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : ''
  if (!prompt) return { prompt: fallbackText, added: [], intent: 'other', degraded: true }
  const added = Array.isArray(obj.added)
    ? obj.added
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 3)
        .map((s) => s.slice(0, 60))
    : []
  const intent = INTENTS.includes(obj.intent as PolishIntent) ? (obj.intent as PolishIntent) : 'other'
  return { prompt, added, intent, degraded: false }
}
