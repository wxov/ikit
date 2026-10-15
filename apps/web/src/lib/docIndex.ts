// 「当前用户可见的文章索引」——文章互链解析的数据源（模块级单例 + 简单缓存 + 防抖刷新）。
//
// 为什么放模块级单例：阅读端（`ArticleDetail.vue` 判定链接是否失效 / 点击时能否跳转）与编辑端
// （`VditorEditor.vue` 的「插入文档链接」选择器与 `[[` 补全）需要**同一份**索引；单例天然去重，
// 不会因组件各自 `onMounted` 而重复请求。刷新时机（需求约定）：
//   - 应用启动 / 登录态变化（可见范围随之变化 → 必须重新拉）；
//   - 进入编辑态（编辑器打开时保证候选是最新的）；
//   - `knowledge:changed`（他端/本端写入）→ 走 `scheduleDocIndexRefresh()` 轻微防抖，避免连续写入时请求风暴；
//   - 导入 / 批量操作 / 删除 / 发布撤回等数据变更点（由 `App.vue` 显式调用）。
//
// 接口：`GET /api/knowledge/entries?limit=1000` + `authHeaders()`（与 `ImportDocsDialog.vue` 一致）——
// 服务端已按当前用户可见性过滤（非 admin 不含草稿 / private 等），故**无需前端再做权限过滤**；
// 前端只在此之上做「草稿对非 admin 视为不可见」的兜底（`resolveDocLink` 的 `isAdmin` 选项）。
import { ref, type Ref } from 'vue'
import { api, type KnowledgeEntry } from './api'
import { authHeaders } from './auth'

/** 与 `ImportDocsDialog.vue` 的 `limit=1000` 一致（单次拉取上限） */
export const DOC_INDEX_LIMIT = 1000

/** 可见文章索引（null = 尚未成功加载过；加载失败保留上一次的值，避免链接整片变「失效」） */
export const docIndex: Ref<KnowledgeEntry[] | null> = ref(null)
export const docIndexLoading = ref(false)
export const docIndexError = ref('')

let inflight: Promise<KnowledgeEntry[] | null> | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** 从条目列表构造索引（过滤已软删除；其余字段原样保留，供「打开文章」直接同页切换） */
export function toDocIndex(entries: readonly KnowledgeEntry[] | null | undefined): KnowledgeEntry[] {
  return (entries ?? []).filter((e) => !!e && !e.deletedAt)
}

/** 立即刷新可见文章索引（并发调用会复用同一个在途请求）；失败返回 `docIndex.value`（可能为 null） */
export function refreshDocIndex(): Promise<KnowledgeEntry[] | null> {
  if (inflight) return inflight
  docIndexLoading.value = true
  inflight = (async () => {
    try {
      const r = await api<{ entries: KnowledgeEntry[] }>(
        `/api/knowledge/entries?limit=${DOC_INDEX_LIMIT}`,
        { headers: authHeaders() },
      )
      docIndex.value = toDocIndex(r.entries)
      docIndexError.value = ''
      return docIndex.value
    } catch (e) {
      docIndexError.value = e instanceof Error ? e.message : String(e)
      return docIndex.value
    } finally {
      docIndexLoading.value = false
      inflight = null
    }
  })()
  return inflight
}

/** 防抖刷新（`knowledge:changed` 等高频信号用；默认 600ms 合并） */
export function scheduleDocIndexRefresh(delay = 600): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void refreshDocIndex()
  }, Math.max(0, delay))
}

export function cancelDocIndexRefresh(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/** 退出登录 / 身份切换：清空缓存（下一次按需重新拉取） */
export function resetDocIndex(): void {
  cancelDocIndexRefresh()
  docIndex.value = null
  docIndexError.value = ''
}
