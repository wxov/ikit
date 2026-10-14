<script setup lang="ts">
// Vditor 编辑器宿主（完善⑦）：只负责 Vditor 生命周期与 v-model 桥接
//
// 性能红线（方案 §4.4.6）：**不在 input 回调里 getValue()** —— input 只发一个信号，
// 父组件在「保存时」才调用暴露出来的 readValue() 读一次完整 Markdown。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../lib/api'
import { authHeaders } from '../lib/auth'
import { loadVditor, VDITOR_CDN, vditorThemeOf, type EditorTheme, type VditorCtor } from '../lib/vditor'

const props = withDefaults(
  defineProps<{
    /** 初始内容（只在初始化 / 显式 setValue 时使用，编辑过程中由 Vditor 自己维护） */
    value?: string
    theme?: EditorTheme
    placeholder?: string
    minHeight?: number
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
/** 加载失败时的纯 Markdown 兜底（保证断网 / 资源缺失时仍可编辑保存） */
const fallback = ref(props.value)

let instance: InstanceType<VditorCtor> | null = null

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
  if (lines.length) instance?.insertValue(`${lines.join('\n')}\n`)
  return null
}

// Vditor 的类型把返回值写成 `string | Promise<string> | Promise<null> | null` 的联合，
// 而 async 函数整体返回 `Promise<string | null>`（运行时语义完全一致：字符串=错误提示，null=成功）。
// 这里仅做形状收窄，不改变行为。
const uploadHandler = ((files: File[]) => doUpload(files)) as (
  files: File[],
) => string | Promise<string> | Promise<null> | null

async function init() {
  loading.value = true
  failed.value = false
  failure.value = ''
  try {
    const VditorClass = await loadVditor()
    if (!host.value) return
    const t = vditorThemeOf(props.theme)
    instance = new VditorClass(host.value, {
      cdn: VDITOR_CDN,
      mode: 'ir',
      theme: t.editor,
      icon: 'ant',
      lang: 'zh_CN',
      height: 'auto',
      minHeight: props.minHeight,
      placeholder: props.placeholder,
      // 关闭 Vditor 内建 localStorage 缓存：改由 draftSnapshot + 服务端自动保存接管（单一事实源）
      cache: { enable: false },
      counter: { enable: true, type: 'text' },
      typewriterMode: false,
      resize: { enable: false },
      toolbar: [
        'headings', 'bold', 'italic', 'strike', '|',
        'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
        'quote', 'line', 'code', 'inline-code', 'link', 'table', '|',
        'upload', 'undo', 'redo', '|', 'fullscreen', 'outline',
      ],
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
        loading.value = false
        emit('ready')
      },
    })
    // 初始化内容（Vditor 构造完成后才能 setValue）
    if (props.value) instance.setValue(props.value)
    else loading.value = false
  } catch (e: any) {
    failed.value = true
    failure.value = e?.message ?? String(e)
    loading.value = false
    // 降级路径同样通知「已就绪」：父组件据此建立保存基线（fallback 的 textarea 立即可读）
    emit('ready')
  }
}

/** 重新加载（资源恢复后「点击重试」） */
async function retry() {
  destroy()
  await init()
}

function destroy() {
  try {
    instance?.destroy()
  } catch {
    /* 忽略销毁异常 */
  }
  instance = null
  if (host.value) host.value.innerHTML = ''
}

watch(
  () => props.theme,
  (theme) => {
    if (!instance) return
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
  /** 读取完整 Markdown（只在保存时调用） */
  readValue: (): string => (failed.value ? fallback.value : (instance?.getValue() ?? '')),
  setValue: (v: string) => {
    if (failed.value) fallback.value = v
    else instance?.setValue(v)
  },
  focus: () => instance?.focus(),
  isUploading: (): boolean => instance?.isUploading() ?? false,
  isFallback: (): boolean => failed.value,
  retry,
})
</script>

<template>
  <div class="vditor-host-wrap md-editor">
    <div v-if="failed" class="vd-fallback">
      <div class="vd-fallback-bar">
        <span>编辑器加载失败 · {{ failure }}</span>
        <button class="ae-btn sm" @click="retry">点击重试</button>
      </div>
      <textarea
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
  </div>
</template>

<style scoped>
.md-editor {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
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
@media (max-width: 768px) {
  .md-editor :deep(.vditor) {
    min-height: 320px !important;
  }
}
</style>
