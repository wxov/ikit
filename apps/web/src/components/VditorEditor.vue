<script setup lang="ts">
// Vditor 编辑器宿主（完善⑦ + 文章互链 + 飞书式可视化编辑）：负责 Vditor 生命周期与 v-model 桥接
//
// 性能红线（方案 §4.4.6）：**不在 input 回调里 getValue()** —— input 只发一个信号，
// 父组件在「保存时」才调用暴露出来的 readValue() 读一次完整 Markdown。
//
// ⚠️ 就绪时序（真实线上缺陷修复）：Vditor 的构造是**异步初始化**——`new Vditor(...)` 返回时
// `this.vditor` 尚未赋值（`dist/index.js:16243` 的 `this.vditor = {...}` 位于 lute 脚本加载后的
// `.then()` 里，`options.after` 在 `initUI` 之后才被调用，见 `dist/index.js:16296`），而实例方法
// （`getValue/setValue/insertValue/focus/isUploading/setTheme`）内部都会读 `this.vditor.currentMode`
// （`dist/index.js:15882` 附近 `getCurrentMode()`）→ 构造后立即调用必然抛
// `Cannot read properties of undefined (reading 'currentMode')`，被降级逻辑误判为「编辑器加载失败」。
// 因此本组件用 `ready` 标志严格把关：**after 回调之前绝不调用任何实例方法**，早期写入排队到
// `pendingValue`，在 after 里一次性应用。
//
// ---------------------------------------------------------------------------
// 飞书式可视化编辑（本次升级，方案见文件末尾注释与最终报告）
// ---------------------------------------------------------------------------
// 1) `mode: 'wysiwyg'`：富文本所见即所得，**不显示** `#` / `**` 等 Markdown 语法标记；
//    存取口径不变：`getValue()` 仍返回 Markdown（`lute.VditorDOM2Md`，dist/index.js:5204）。
// 2) `counter`（字数）/ `outline`（大纲）/ `hint`（`[[` 文档补全）为 Vditor 内建能力。
// 3) 自建增强（Vditor 无内建）：斜杠命令菜单、选中文字悬浮格式条、块手柄 + 块菜单。
//    三者都通过 `bridge`（见 `lib/editorBridge.ts`）只使用 Vditor **公开 API**
//    （`getValue/setValue/insertMD/focus`）与「派发工具栏 CustomEvent」实现，不直接改写
//    Lute 的 DOM 结构，避免破坏渲染约定与撤销栈。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../lib/api'
import { authHeaders } from '../lib/auth'
import { loadVditor, VDITOR_CDN, vditorThemeOf, type EditorTheme, type VditorCtor } from '../lib/vditor'
import {
  docLocationOf,
  escapeHtmlText,
  filterDocCandidates,
  insertableDocLink,
  type DocIndexItem,
} from '../lib/docLinks'
import { docIndex, docIndexLoading, refreshDocIndex } from '../lib/docIndex'
import type { EditorBridge } from '../lib/editorBridge'
import EditorSlashMenu from './EditorSlashMenu.vue'
import EditorSelectionToolbar from './EditorSelectionToolbar.vue'
import EditorBlockHandle from './EditorBlockHandle.vue'
import EditorInlineShortcuts from './EditorInlineShortcuts.vue'

const props = withDefaults(
  defineProps<{
    /** 初始内容（只在初始化 / 显式 setValue 时使用，编辑过程中由 Vditor 自己维护） */
    value?: string
    theme?: EditorTheme
    placeholder?: string
    minHeight?: number
    /**
     * 链接点击回调（详情页无模式编辑容器用）：Vditor 在 wysiwyg 下点中 `<a>` 时会**拦下默认行为**
     * （`dist/index.js` 的 wysiwyg click 分支：`options.link.click?.(a)` 否则 `window.open(href)`，
     * 且无论如何 `preventDefault()`）。传了本回调即由宿主接管：内部文档互链 → 同页跳转、
     * 页内锚点 → 容器内滚动、外链 → 新标签打开。
     * 不传则保持 Vditor 默认行为（`link.isOpen` 默认 true）。
     */
    linkClick?: (a: HTMLAnchorElement) => void
  }>(),
  {
    value: '',
    theme: 'light',
    placeholder: '开始写作……支持 Markdown：标题 / 列表 / 引用 / 代码块 / 表格 / $公式$',
    minHeight: 420,
  },
)

const emit = defineEmits<{
  (e: 'input'): void
  (e: 'blur'): void
  (e: 'ready'): void
}>()

const host = ref<HTMLElement | null>(null)
const failed = ref(false)
const failure = ref('')
const loading = ref(true)
/** Vditor 是否**真正就绪**（`after` 回调已触发）：就绪前不得触碰任何实例方法 */
const ready = ref(false)
/** wysiwyg 的 contenteditable 元素（`after` 时抓取；Vditor 重渲染后 `isConnected` 会失效 → 自动回退查询） */
const editableEl = ref<HTMLElement | null>(null)
/** 加载失败时的纯 Markdown 兜底（保证断网 / 资源缺失时仍可编辑保存） */
const fallback = ref(props.value)
const fallbackEl = ref<HTMLTextAreaElement | null>(null)
/** 就绪前排队的内容（初始值 / 早期 setValue / retry 前的内容），在 `after` 里应用 */
let pendingValue: string | null = props.value ?? ''
let instance: InstanceType<VditorCtor> | null = null
/** 就绪兜底定时器：lute 脚本加载失败时 `after` 永不触发，避免永远停在「加载中」 */
let readyTimer: ReturnType<typeof setTimeout> | null = null
const READY_TIMEOUT = 15000

function clearReadyTimer() {
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = null
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

/**
 * 图片上传（工具栏 / 粘贴 / 拖拽三条路径都进这里）。
 * 源码约束：设置 handler 后 Vditor **不做内置校验、不自动插入**，因此必须自行校验 5MB
 * 并调用 insertValue()；返回字符串 = Vditor 弹提示（错误）。
 */
async function doUpload(files: File[]): Promise<string | null> {
  const lines: string[] = []
  for (const f of files) {
    if (!f.type.startsWith('image/')) return '仅支持图片文件'
    if (f.size > 5 * 1024 * 1024) return `图片过大（最大 5MB）：${f.name}`
    try {
      const dataUrl = await readAsDataURL(f)
      const r = await api<{ url: string }>('/api/upload', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: f.name, data: dataUrl }),
      })
      lines.push(`![${f.name}](${r.url})`)
    } catch (e: any) {
      return `上传失败：${e?.message ?? e}`
    }
  }
  // 未就绪（理论上工具栏未出现，兜底防御）→ 忽略插入，不抛错
  if (lines.length && ready.value && instance) instance.insertValue(`${lines.join('\n')}\n`)
  return null
}

// Vditor 的类型把返回值写成 `string | Promise<string> | Promise<null> | null` 的联合，
// 而 async 函数整体返回 `Promise<string | null>`（运行时语义完全一致：字符串=错误提示，null=成功）。
// 这里仅做形状收窄，不改变行为。
const uploadHandler = ((files: File[]) => doUpload(files)) as (
  files: File[],
) => string | Promise<string> | Promise<null> | null

// ---------------------------------------------------------------------------
// 文章互链：工具栏「插入文档链接」+ `[[` 标题补全
// ---------------------------------------------------------------------------

/** 工具栏图标：文档（内联 SVG；Vditor 工具栏 CSS 已给 `svg` 设 15px + `fill: currentColor`） */
const DOC_LINK_ICON =
  '<svg viewBox="0 0 32 32"><path fill-rule="evenodd" d="M7 2h13l6 6v22a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM9 5v24h14V10h-5V5H9zM11 16h7v3h-7zM11 23h7v3h-7z"/></svg>'

const docPickerOpen = ref(false)
const docQuery = ref('')
const docSearchInput = ref<HTMLInputElement | null>(null)
const docItems = computed(() => filterDocCandidates(docQuery.value, docIndex.value, 100))

/** 打开「插入文档链接」选择器（按标题过滤，展示分类/父路径） */
async function openDocPicker() {
  docQuery.value = ''
  docPickerOpen.value = true
  void refreshDocIndex() // 幂等：在途请求复用；保证候选是最新的可见索引
  await nextTick()
  docSearchInput.value?.focus()
}

/** 就绪前的插入排队（正常路径下工具栏/补全只在就绪后可用，此处仅防御） */
let pendingInsert: string | null = null

function insertText(text: string) {
  if (failed.value) {
    insertIntoFallback(text)
    return
  }
  if (ready.value && instance) {
    instance.insertValue(text)
    return
  }
  pendingInsert = `${pendingInsert ?? ''}${text}`
}

/** 降级（纯 Markdown textarea）路径下按光标位置插入，保证「插入文档链接」在降级态也可用 */
function insertIntoFallback(text: string) {
  const el = fallbackEl.value
  if (!el) {
    fallback.value += text
    emit('input')
    return
  }
  const start = el.selectionStart ?? fallback.value.length
  const end = el.selectionEnd ?? start
  fallback.value = fallback.value.slice(0, start) + text + fallback.value.slice(end)
  emit('input')
  void nextTick(() => {
    el.focus()
    el.selectionStart = el.selectionEnd = start + text.length
  })
}

function insertDoc(item: DocIndexItem) {
  // 标题含特殊字符（`[` `]` / 换行）时自动退回 `[标题](ikit://doc/<id>)`，两种语法阅读端等价
  insertText(insertableDocLink(item.title, item.id))
  docPickerOpen.value = false
}

/** `[[` 补全候选（Vditor `hint.extend`）：`html` 为候选展示（路径 + 标题），`value` 为插入文本 */
function wikiHint(value: string): { html: string; value: string }[] {
  const list = docIndex.value
  if (!list) {
    void refreshDocIndex() // 索引尚未就绪 → 本次空候选，拉取后继续输入即命中
    return []
  }
  return filterDocCandidates(value, list, 8).map((it) => ({
    // 标题放在最后：Vditor 会对「最后一个 `>` 之后」的文本做关键字高亮
    html: `<span class="ikit-hint-path">${escapeHtmlText(docLocationOf(it, list))}</span>${escapeHtmlText(it.title)}`,
    value: insertableDocLink(it.title, it.id),
  }))
}

async function init() {
  loading.value = true
  failed.value = false
  failure.value = ''
  ready.value = false
  // 进入编辑态：刷新「当前用户可见的文章索引」（工具栏选择器 / `[[` 补全的候选数据源；在途请求会复用）
  void refreshDocIndex()
  try {
    const VditorClass = await loadVditor()
    if (!host.value) return
    const t = vditorThemeOf(props.theme)
    instance = new VditorClass(host.value, {
      cdn: VDITOR_CDN,
      // ★ 飞书式可视化编辑：wysiwyg（富文本所见即所得，不显示 Markdown 标记；存取仍是 Markdown）
      mode: 'wysiwyg',
      theme: t.editor,
      icon: 'ant',
      lang: 'zh_CN',
      height: 'auto',
      minHeight: props.minHeight,
      placeholder: props.placeholder,
      // 关闭 Vditor 内建 localStorage 缓存：改由 draftSnapshot + 服务端自动保存接管（单一事实源）
      cache: { enable: false },
      // 字数统计（飞书式状态条的数据来源之一；父组件另在底部状态条展示）
      counter: { enable: true, type: 'text' },
      // 大纲侧栏（默认收起，点工具栏「大纲」展开；位置左）
      outline: { enable: false, position: 'left' },
      typewriterMode: false,
      resize: { enable: false },
      // 工具栏按飞书式分组：标题 | 行内格式 | 列表 | 块 | 插入/媒体 | 自定义互链 | 历史/视图
      toolbar: [
        'headings', '|',
        'bold', 'italic', 'strike', 'inline-code', '|',
        'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
        'quote', 'line', 'code', 'link', 'table', '|',
        'upload', '|',
        // 文章互链：打开可搜索的「插入文档链接」选择器（插入 `[标题](ikit://doc/<id>)`）
        {
          name: 'ikit-doc-link',
          tip: '插入文档链接',
          tipPosition: 'n',
          className: 'ikit-toolbar-doc',
          icon: DOC_LINK_ICON,
          click: () => {
            void openDocPicker()
          },
        },
        '|',
        'undo', 'redo', '|', 'fullscreen', 'outline',
      ],
      // 文章互链：`[[` 触发标题补全（官方 hint API，见组件内说明与 README 的已知边界）
      // 斜杠命令**刻意不走 hint**：hint 的语义是「把候选 value 插到光标处」，而斜杠命令需要
      // 先删除已输入的 `/xxx` 再插入新块，两者行为不同（详见 lib/slashCommands.ts 顶部注释）
      hint: {
        delay: 150,
        emojiPath: `${VDITOR_CDN}/dist/images/emoji`,
        extend: [{ key: '[[', hint: (value: string) => wikiHint(value) }],
      },
      // 链接点击接管（仅当宿主提供回调；见 props.linkClick 说明）：
      // `isOpen:false` 关掉 Vditor 的 `window.open(href)` 默认行为，改由宿主分发（互链/锚点/外链）
      ...(props.linkClick
        ? {
            link: {
              isOpen: false,
              click: (el: Element) => props.linkClick?.(el as HTMLAnchorElement),
            },
          }
        : {}),
      preview: {
        delay: 1000,
        hljs: { enable: true, style: t.code, lineNumber: false },
        math: { engine: 'KaTeX' },
        markdown: { toc: false, codeBlockPreview: true, mathBlockPreview: true, sanitize: true },
        theme: { current: t.content },
      },
      upload: {
        handler: uploadHandler,
        accept: 'image/*',
        max: 5 * 1024 * 1024,
        multiple: true,
      },
      input: () => emit('input'),
      blur: () => emit('blur'),
      after: () => {
        clearReadyTimer()
        // 就绪兜底已经降级（lute 加载超时）→ 保留 fallback 为准，不回到半初始化实例
        if (failed.value) return
        ready.value = true
        loading.value = false
        // 抓取 wysiwyg 的 contenteditable（K 增强组件的挂载点；此时实例已完全初始化）
        editableEl.value = (instance as any)?.vditor?.wysiwyg?.element ?? null
        // 排队的初始内容在**就绪后**应用（此前调用 setValue 必然抛 currentMode 未定义）
        if (pendingValue !== null) {
          try {
            instance?.setValue(pendingValue)
          } catch (e) {
            console.warn('[vditor] apply pending value failed:', e)
          }
          pendingValue = null
        }
        if (pendingInsert !== null) {
          try {
            instance?.insertValue(pendingInsert)
          } catch (e) {
            console.warn('[vditor] apply pending insert failed:', e)
          }
          pendingInsert = null
        }
        editableEl.value = (instance as any)?.vditor?.wysiwyg?.element ?? editableEl.value
        emit('ready')
      },
    })
    // ⚠️ 此处**不得**调用 instance.setValue()：构造返回时 Vditor 尚未完成异步初始化。
    clearReadyTimer()
    readyTimer = setTimeout(() => {
      readyTimer = null
      if (ready.value || failed.value) return
      failed.value = true
      failure.value = '编辑器初始化超时（Vditor 运行资源未就绪）'
      loading.value = false
      fallback.value = pendingValue ?? props.value ?? ''
      emit('ready') // 降级路径同样通知「已就绪」：父组件据此建立保存基线
    }, READY_TIMEOUT)
  } catch (e: any) {
    clearReadyTimer()
    failed.value = true
    failure.value = e?.message ?? String(e)
    loading.value = false
    fallback.value = pendingValue ?? props.value ?? ''
    // 降级路径同样通知「已就绪」：父组件据此建立保存基线（fallback 的 textarea 立即可读）
    emit('ready')
  }
}

/** 读取当前内容（就绪前返回排队值 / 初始值，绝不返回空串） */
function readValue(): string {
  if (failed.value) return fallback.value
  if (ready.value && instance) return instance.getValue() ?? ''
  return pendingValue ?? props.value ?? ''
}

/** 重新加载（资源恢复后「点击重试」）：把当前内容带过去，避免重载丢输入 */
async function retry() {
  const current = readValue()
  destroy()
  pendingValue = current
  await init()
}

function destroy() {
  clearReadyTimer()
  ready.value = false
  editableEl.value = null
  try {
    instance?.destroy()
  } catch {
    /* 忽略销毁异常 */
  }
  instance = null
  if (host.value) host.value.innerHTML = ''
}

// ---------------------------------------------------------------------------
// 飞书式增强的桥接对象（见 `lib/editorBridge.ts`）：只暴露 Vditor **公开 API** 与容器元素
// ---------------------------------------------------------------------------

/** 当前可编辑元素：优先用 `after` 抓到的引用；Vditor 重渲染（setValue / 切模式）后自动回退查询 */
function editable(): HTMLElement | null {
  if (!ready.value) return null
  if (editableEl.value?.isConnected) return editableEl.value
  const el = (instance as any)?.vditor?.wysiwyg?.element as HTMLElement | undefined
  editableEl.value = el && el.isConnected ? el : null
  return editableEl.value
}

const bridge: EditorBridge = {
  readValue,
  writeValue: (md: string) => {
    if (failed.value) {
      fallback.value = md
      return
    }
    if (!ready.value || !instance) {
      pendingValue = md
      return
    }
    instance.setValue(md)
  },
  insertMarkdown: (md: string) => {
    if (!ready.value || !instance) {
      pendingInsert = `${pendingInsert ?? ''}${md}`
      return
    }
    // `insertMD`（公开 API）内部走 `lute.Md2VditorDOM` + `execAfterRender`，比 insertValue 更适合插块
    instance.insertMD(md)
  },
  editable,
  hostElement: () => host.value?.parentElement ?? host.value,
  notifyInput: () => emit('input'),
}

/** 「插入文档链接」选择器（悬浮工具条与降级工具条共用） */
function openDocPickerFromBar() {
  void openDocPicker()
}

watch(
  () => props.theme,
  (theme) => {
    // 未就绪时 `instance` 可能已存在但内部 `vditor` 尚未赋值 → 必须同时判 `ready`
    if (!ready.value || !instance) return
    const t = vditorThemeOf(theme)
    try {
      instance.setTheme(t.editor, t.content, t.code)
    } catch {
      /* 主题切换失败不阻断编辑 */
    }
  },
)

onMounted(init)
onBeforeUnmount(destroy)

defineExpose({
  /** 读取完整 Markdown（只在保存时调用）；**就绪前返回排队值 / 初始值**（不能返回空串） */
  readValue,
  /** 写入内容：未就绪 → 排队（after 后应用）；就绪 → 直接写入；降级 → 写 textarea */
  setValue: (v: string) => bridge.writeValue(v),
  focus: () => {
    if (ready.value) instance?.focus()
  },
  isUploading: (): boolean => (ready.value && instance ? instance.isUploading() : false),
  isFallback: (): boolean => failed.value,
  isReady: (): boolean => ready.value,
  /** 当前可编辑元素（供自动化验证 / 上层焦点判定；未就绪返回 null） */
  editableElement: editable,
  /** 工具栏元素（详情页容器据此测量品牌工具栏高度，用于「外壳收起时占位、零布局跳动」） */
  toolbarElement: (): HTMLElement | null =>
    (host.value?.querySelector('.vditor-toolbar') as HTMLElement | null) ?? null,
  retry,
})
</script>

<template>
  <div class="vditor-host-wrap md-editor">
    <div v-if="failed" class="vd-fallback">
      <div class="vd-fallback-bar">
        <span>编辑器加载失败 · {{ failure }}</span>
        <span class="vd-fallback-actions">
          <button class="ae-btn sm" @click="openDocPicker">🔗 插入文档链接</button>
          <button class="ae-btn sm" @click="retry">点击重试</button>
        </span>
      </div>
      <textarea
        ref="fallbackEl"
        v-model="fallback"
        class="vd-fallback-input"
        placeholder="已降级为纯 Markdown 编辑，内容仍可保存"
        @input="emit('input')"
        @blur="emit('blur')"
      />
    </div>
    <template v-else>
      <div v-if="loading" class="vd-loading">编辑器加载中…</div>
      <div ref="host" class="vditor-host" />
    </template>

    <!-- 飞书式增强浮层（自建）：斜杠命令 / 行内快捷 / 选中文字格式条 / 块手柄+块菜单 -->
    <!-- `ready` 之后才挂载：组件在 onMounted 里绑定 contenteditable 事件，必须等 Vditor 真正就绪 -->
    <template v-if="ready && !failed">
      <EditorInlineShortcuts :bridge="bridge" />
      <EditorSlashMenu :bridge="bridge" />
      <EditorSelectionToolbar :bridge="bridge" :on-doc-link="openDocPickerFromBar" />
      <EditorBlockHandle :bridge="bridge" />
    </template>

    <!-- 插入文档链接：可搜索选择器（标题过滤 + 分类/父路径；两种编辑模式下都可用） -->
    <div v-if="docPickerOpen" class="vd-doc-mask" @click="docPickerOpen = false"></div>
    <div v-if="docPickerOpen" class="vd-doc-picker" role="dialog" aria-label="插入文档链接">
      <div class="vdp-head">
        <input
          ref="docSearchInput"
          v-model="docQuery"
          class="vdp-search"
          placeholder="搜索文章标题 / 分类…"
          @keydown.esc="docPickerOpen = false"
        />
        <button class="vdp-close" title="关闭" @click="docPickerOpen = false">×</button>
      </div>
      <div class="vdp-list">
        <button v-for="d in docItems" :key="d.id" class="vdp-item" @click="insertDoc(d)">
          <span class="vdp-title">{{ d.title }}</span>
          <span class="vdp-path">{{ docLocationOf(d, docIndex ?? []) }}</span>
        </button>
        <div v-if="!docItems.length" class="vdp-empty">
          {{ docIndexLoading ? '索引加载中…' : docQuery.trim() ? '无匹配文章' : '暂无可链接的文章' }}
        </div>
      </div>
      <div class="vdp-foot">选中后插入 <code>[[标题]]</code>（标题含特殊字符时用 id 形式）</div>
    </div>
  </div>
</template>

<style scoped>
.md-editor {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
  position: relative;
}
.vditor-host {
  min-height: 200px;
}
.vd-loading {
  padding: 40px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.vd-fallback-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: var(--primary-soft);
  color: var(--primary-dark);
  font-size: 12px;
}
.vd-fallback-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.vd-fallback-input {
  width: 100%;
  min-height: 380px;
  border: none;
  outline: none;
  resize: vertical;
  padding: 14px 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 14px;
  line-height: 1.7;
  background: var(--panel);
  color: var(--text);
}
.ae-btn.sm {
  padding: 4px 10px;
  font-size: 12px;
}
/* 「插入文档链接」选择器（工具栏按钮下方；非遮罩弹窗，点空白可关） */
.vd-doc-mask { position: fixed; inset: 0; z-index: 30; }
.vd-doc-picker {
  position: absolute; left: 12px; top: 46px; z-index: 31;
  width: min(420px, calc(100% - 24px));
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18); padding: 8px;
}
.vdp-head { display: flex; align-items: center; gap: 6px; }
.vdp-search {
  flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
  font-size: 13px; font-family: inherit; background: var(--panel); color: var(--text);
}
.vdp-close {
  border: none; background: transparent; color: var(--muted); font-size: 18px;
  line-height: 1; cursor: pointer;
}
.vdp-list { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.vdp-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  border: none; background: transparent; color: var(--text); border-radius: 6px;
  padding: 6px 8px; font-size: 13px; font-family: inherit; cursor: pointer;
}
.vdp-item:hover { background: var(--primary-soft); }
.vdp-title { font-weight: 500; }
.vdp-path { font-size: 11px; color: var(--muted); }
.vdp-empty { font-size: 12px; color: var(--muted); padding: 8px; }
.vdp-foot { font-size: 11px; color: var(--muted); padding: 6px 8px 2px; border-top: 1px solid var(--border); margin-top: 4px; }
@media (max-width: 768px) {
  .md-editor :deep(.vditor) {
    min-height: 320px !important;
  }
}
</style>
