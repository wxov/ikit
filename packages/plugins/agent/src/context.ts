// 会话摘要（2026-11-28，M3）：纯函数，便于单测
//
// 触发逻辑在 agent 插件；这里只负责「较早对话 → 摘要提示词」与「摘要 → 上下文消息」。
import type { ChatMessage } from '@ikit/plugin-llm'

export const SUMMARY_PROMPT_VERSION = 'v1'
export const SUMMARY_MAX_CHARS = 300

/** 把消息拼成「用户：... / 助手：...」文本；超长时保留最后部分（近期信息更重要） */
export function transcriptOf(messages: ChatMessage[], maxChars = 4000): string {
  const text = messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content ?? '').trim()}`)
    .filter((line) => line.length > 0)
    .join('\n')
  return text.length > maxChars ? text.slice(-maxChars) : text
}

/** 摘要请求消息：严格约束为「只输出摘要」 */
export function buildSummaryMessages(transcript: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是对话摘要器。把较早的对话压缩成一段中文摘要，供后续对话作为背景。

规则：
1. 只输出摘要正文，不要标题、列表符号、引号或代码块。
2. 不超过 ${SUMMARY_MAX_CHARS} 字。
3. 保留：用户的目标与约束、已确认的事实/结论、未完成的待办、用户的偏好。
4. 不要编造原文没有的信息；不确定的内容不要写。
5. 用「用户希望…」「已确认…」「待办…」这类短句，不要逐轮复述。`,
    },
    { role: 'user', content: `以下是较早的对话，请压缩成摘要：\n${transcript}` },
  ]
}

/** 摘要注入上下文时的包装（明确告诉模型这是历史背景） */
export function summaryContextText(summary: string): string {
  return `【较早对话摘要（已压缩）】\n${String(summary ?? '').trim()}`
}
