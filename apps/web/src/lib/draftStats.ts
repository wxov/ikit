// 编辑器辅助纯函数（P2-10 前端拆分，2026-11-28）
//
// 从 ArticleEditView.vue 抽出，无 Vue / DOM 依赖，便于 node 单测。

/** 正文统计：去掉空白后的字符数 + 中日韩字符与拉丁词数之和 */
export function countOf(text: string): { chars: number; words: number } {
  const chars = text.replace(/\s/g, '').length
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const latin = (
    text
      .replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9_'-]+/g) ?? []
  ).length
  return { chars, words: cjk + latin }
}

/** 把 `api()` 抛出的错误消息还原为可读文案（后端以 JSON `{error}` 返回时取 error 字段） */
export function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  try {
    const j = JSON.parse(raw) as { error?: string }
    if (j?.error) return j.error
  } catch {
    /* 非 JSON：原样展示 */
  }
  return raw
}
