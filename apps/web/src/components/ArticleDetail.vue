<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch, type Ref } from 'vue'
import { type KnowledgeEntry } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import {
  DOC_LINK_MISSING_TIP,
  classifyLink,
  docLocationOf,
  matchHeadingByText,
  resolveDocLink,
  type ClassifiedLink,
  type DocIndexItem,
} from '../lib/docLinks'
import { docIndex, refreshDocIndex } from '../lib/docIndex'
import CommentSection from './CommentSection.vue'

const props = withDefaults(
  defineProps<{
    entry: KnowledgeEntry
    /** 返回按钮文案（App 依返回栈深度给出：`← 返回上一篇` / `← 返回列表`） */
    backLabel?: string
  }>(),
  { backLabel: '← 返回列表' },
)

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'edit', entry: KnowledgeEntry): void
  (e: 'tag', tag: string): void
  (e: 'publish', entry: KnowledgeEntry): void
  /** 内部文档链接命中 → 同页切换到目标文章（App 负责返回栈） */
  (e: 'open-doc', id: string): void
  /** 轻提示（无法跳转等；由 App 统一展示 toast） */
  (e: 'notify', msg: string): void
}>()

const userRole = inject<Ref<string>>('userRole', ref('guest'))
// 可见文章索引：优先用 App 注入的同一份（模块级单例，天然去重请求）；未注入时退回模块单例
const injectedIndex = inject<Ref<KnowledgeEntry[] | null> | null>('docIndex', null)
const index = injectedIndex ?? docIndex

const canEdit = computed(() => userRole.value === 'admin')
const isAdmin = computed(() => userRole.value === 'admin')
// 草稿（含缺省 status 的存量条目视为已发布）：仅站主可见，故徽标/快捷发布也只对站主显示
const isDraft = computed(() => canEdit.value && (props.entry.status ?? 'published') !== 'published')

const rendered = computed(() => renderMarkdown(props.entry.content))
const bodyRef = ref<HTMLElement | null>(null)

/** 索引是否已成功加载（未加载时**不做失效标记**，避免把「尚未加载」误判为「不存在」） */
const indexReady = computed(() => Array.isArray(index.value))

function shortDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------------------
// 正文链接：失效标记（虚线/弱化色 + tooltip）
// ---------------------------------------------------------------------------
function linkOf(a: HTMLAnchorElement): ClassifiedLink | null {
  return classifyLink(a.getAttribute('href'), {
    docId: a.dataset.docId,
    docTitle: a.dataset.docTitle,
  })
}

/**
 * 渲染后按「当前用户可见索引」标注内部链接状态：
 * 解析不到（不存在 / 不可见 / 草稿对非站主不可见）→ `.ikit-doc-link--missing` + tooltip。
 * 用 DOM 后处理而非重写 HTML：`renderMarkdown` 保持纯函数（不依赖索引），逻辑集中在 `resolveDocLink`。
 */
function applyLinkStates() {
  const root = bodyRef.value
  if (!root) return
  const list = index.value
  root.querySelectorAll<HTMLAnchorElement>('a[data-doc-link]').forEach((a) => {
    const link = linkOf(a)
    const res = resolveDocLink(link, list, { isAdmin: isAdmin.value })
    const missing = indexReady.value && res.kind === 'missing'
    a.classList.toggle('ikit-doc-link--missing', missing)
    if (missing) {
      a.setAttribute('data-doc-missing', '1')
      a.setAttribute('title', DOC_LINK_MISSING_TIP)
      return
    }
    a.removeAttribute('data-doc-missing')
    const title = res.kind === 'doc' ? list?.find((x) => x.id === res.id)?.title ?? '' : ''
    if (title && title !== (a.textContent ?? '').trim()) a.setAttribute('title', `跳转到「${title}」`)
    else a.removeAttribute('title')
  })
}

watch([rendered, index], () => {
  void nextTick(applyLinkStates)
})

// ---------------------------------------------------------------------------
// 正文链接：点击拦截（事件委托）
// ---------------------------------------------------------------------------
const picker = ref<{ label: string; matches: DocIndexItem[] } | null>(null)
const pickerItems = computed(() => (picker.value ? picker.value.matches.slice(0, 5) : []))

function scrollToEl(el: HTMLElement) {
  const scroller = findScrollableAncestor(el)
  if (scroller) {
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12
    try {
      scroller.scrollTo({ top, behavior: 'smooth' })
    } catch {
      scroller.scrollTop = top
    }
    return
  }
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch {
    el.scrollIntoView()
  }
}

/** 就近的可滚动祖先（详情容器内滚动时只在容器内滚，否则退回 window 滚动） */
function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement
  while (p) {
    const overflowY = getComputedStyle(p).overflowY
    if (/(auto|scroll|overlay)/.test(overflowY) && p.scrollHeight > p.clientHeight + 1) return p
    p = p.parentElement
  }
  return null
}

/**
 * 页内锚点：**优先按生成的 `heading-N` id 匹配**（渲染时 `markdown.ts` 的 `heading_open` 生成），
 * 不匹配时**按标题文本**匹配（忽略大小写与空白）。命中后容器内平滑滚动并阻止默认 hash 跳转。
 */
function scrollToAnchor(anchor: string) {
  const root = bodyRef.value
  if (!root) return
  const frag = String(anchor ?? '').replace(/^#/, '').trim()
  if (!frag) return
  // 1) 按 id 精确匹配（`heading-N`；也兼容作者手写的其它 id）
  const byId =
    Array.from(root.querySelectorAll<HTMLElement>('[id]')).find((node) => node.id === frag) ?? null
  // 2) 按标题文本匹配
  const heads = byId ? [] : Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
  const byText = byId ? -1 : matchHeadingByText(frag, heads.map((h) => h.textContent ?? ''))
  const el: HTMLElement | null = byId ?? (byText >= 0 ? heads[byText] : null)
  if (!el) {
    emit('notify', `未找到锚点「${frag}」`)
    return
  }
  scrollToEl(el)
}

async function onBodyClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const a = (target?.closest?.('a') as HTMLAnchorElement | null) ?? null
  if (!a || !bodyRef.value?.contains(a)) return
  const link = linkOf(a)
  if (!link) return

  // 外链（渲染时已 `target="_blank" rel="noopener noreferrer"`）与相对链接：交给浏览器默认行为
  if (link.kind === 'external' || link.kind === 'relative') return

  if (link.kind === 'anchor') {
    e.preventDefault()
    scrollToAnchor(link.anchor ?? '')
    return
  }

  // 内部文档链接：必须命中「当前用户可见的文章索引」才允许跳转
  e.preventDefault()
  if (!index.value) {
    await refreshDocIndex()
    if (!index.value) {
      emit('notify', '文档索引加载失败，请稍后重试')
      return
    }
    applyLinkStates()
  }
  const res = resolveDocLink(link, index.value, { isAdmin: isAdmin.value })
  if (res.kind === 'missing') {
    emit('notify', DOC_LINK_MISSING_TIP)
    return
  }
  if (res.kind !== 'doc') return
  // 同名多篇 → 轻量选择列表（2–5 项，可取消）
  if (res.matches.length > 1) {
    picker.value = { label: link.title || link.id || '', matches: res.matches }
    return
  }
  picker.value = null
  emit('open-doc', res.id)
}

function chooseDoc(id: string) {
  picker.value = null
  emit('open-doc', id)
}

onMounted(() => {
  // 阅读端索引：App 通常已注入（启动即拉取）；未加载时此处按需补一次（简单缓存 + 在途去重）
  if (!index.value) void refreshDocIndex()
  void nextTick(applyLinkStates)
})
</script>

<template>
  <article class="article-detail">
    <div class="ad-toolbar">
      <button class="ad-back" @click="emit('back')">{{ backLabel }}</button>
      <span class="ad-actions">
        <button v-if="isDraft" class="ad-publish" @click="emit('publish', entry)">发布</button>
        <button v-if="canEdit" class="ad-edit" @click="emit('edit', entry)">✎ 编辑</button>
      </span>
    </div>

    <header class="ad-head">
      <h1 class="ad-title">{{ entry.title }}</h1>
      <div class="ad-meta">
        <span v-if="isDraft" class="ad-status">草稿 · 仅站主可见</span>
        <span class="am"><b>📂</b> {{ entry.category || '未分类' }}</span>
        <span class="am"><b>🕑</b> {{ shortDate(entry.updatedAt) }}</span>
        <span v-if="entry.views" class="am"><b>👁</b> {{ entry.views }}</span>
      </div>
    </header>

    <!-- 同名多篇：轻量选择列表（非遮罩弹窗，可取消） -->
    <div v-if="picker" class="ad-picker" role="dialog" aria-label="选择同名文档">
      <div class="adp-head">
        「{{ picker.label }}」匹配到 {{ picker.matches.length }} 篇同名文档，请选择：
      </div>
      <button v-for="m in pickerItems" :key="m.id" class="adp-item" @click="chooseDoc(m.id)">
        <span class="adp-title">{{ m.title }}</span>
        <span class="adp-path">{{ docLocationOf(m, index ?? []) }}</span>
      </button>
      <div v-if="picker.matches.length > pickerItems.length" class="adp-more">
        仅显示前 {{ pickerItems.length }} 篇（共 {{ picker.matches.length }} 篇）
      </div>
      <div class="adp-foot">
        <button class="adp-cancel" @click="picker = null">取消</button>
      </div>
    </div>

    <div ref="bodyRef" class="markdown-body" v-html="rendered.html" @click="onBodyClick"></div>

    <div v-if="entry.tags?.length" class="ad-tags">
      <span v-for="t in entry.tags" :key="t" class="ad-tag" @click="emit('tag', t)"># {{ t }}</span>
    </div>

    <CommentSection :entry-id="entry.id" class="ad-comments" />
  </article>
</template>

<style scoped>
.article-detail { padding: 8px 2px 24px; }
.ad-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.ad-actions { display: flex; align-items: center; gap: 8px; }
.ad-back, .ad-edit, .ad-publish {
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.ad-edit { color: var(--primary-dark); border-color: var(--primary); }
.ad-publish { color: #fff; border-color: var(--ok, #22c55e); background: var(--ok, #22c55e); }
.ad-status {
  font-size: 12px; padding: 3px 10px; border-radius: 999px;
  background: var(--warn-soft, #fef3c7); color: var(--warn, #b45309);
  border: 1px solid var(--warn, #f59e0b);
}
.ad-title { margin: 0 0 8px; font-size: 26px; line-height: 1.3; }
.ad-meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; color: var(--muted); margin-bottom: 14px; }
.am b { font-weight: 400; margin-right: 2px; }
.ad-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.ad-tag {
  font-size: 12px; padding: 4px 12px; border-radius: 999px;
  background: var(--primary-soft); color: var(--primary-dark); cursor: pointer;
}
/* 同名文档选择：轻量内联面板（非遮罩） */
.ad-picker {
  border: 1px solid var(--primary); background: var(--primary-soft);
  border-radius: 10px; padding: 10px 12px; margin-bottom: 14px;
  display: flex; flex-direction: column; gap: 6px;
}
.adp-head { font-size: 13px; color: var(--primary-dark); font-weight: 600; }
.adp-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 7px 10px; cursor: pointer; font-family: inherit; font-size: 13px;
}
.adp-item:hover { border-color: var(--primary); }
.adp-title { font-weight: 600; }
.adp-path { font-size: 11px; color: var(--muted); }
.adp-more { font-size: 11px; color: var(--muted); }
.adp-foot { display: flex; justify-content: flex-end; }
.adp-cancel {
  border: 1px solid var(--border); background: var(--panel); color: var(--muted);
  border-radius: 8px; padding: 4px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
</style>
