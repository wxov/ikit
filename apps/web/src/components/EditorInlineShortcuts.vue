<script setup lang="ts">
// 飞书式编辑 · 行内快捷转换处理器（无界面；挂在编辑器 contenteditable 的 beforeinput 上）
//
// 覆盖（详见 `lib/inlineShortcuts.ts` 顶部说明：Vditor 只自带 `# `）：
// - 行首输入 `- ` / `* ` / `+ ` → 无序列表；`1. ` → 有序列表；`> ` → 引用；`- [ ] ` → 待办；
// - 列表/待办/引用内按 Enter → 自动续行（有序列表序号 +1；空项按 Enter 结束该列表，交给 Vditor）；
// - `# ` / `## ` … 由 Vditor 自带能力处理，本组件不介入。
//
// 实现要点：命中时 `preventDefault()` 掉这次空格输入，删掉「标记」文本并 `insertMD` 插入真正的
// 块标记（Vditor 公开 API：`lute.Md2VditorDOM` + `execAfterRender`），随后把光标放回块内继续输入。
import { onBeforeUnmount, onMounted } from 'vue'
import {
  blockIndexOf,
  closestBlock,
  currentBlockOf,
  placeCaretAt,
  type EditorBridge,
} from '../lib/editorBridge'
import { splitBlocks } from '../lib/editorBlocks'
import {
  isEmptyListItem,
  isEmptyTaskLine,
  matchContinuation,
  matchInlineShortcut,
} from '../lib/inlineShortcuts'

const props = defineProps<{ bridge: EditorBridge }>()

/** 块内「光标之前的文本」 */
function textBeforeCaret(root: HTMLElement): string {
  const block = currentBlockOf(root)
  const sel = document.getSelection()
  if (!block || !sel || sel.rangeCount === 0) return ''
  const r = sel.getRangeAt(0)
  if (!block.contains(r.startContainer) && r.startContainer !== block) return ''
  try {
    const probe = document.createRange()
    probe.selectNodeContents(block)
    probe.setEnd(r.startContainer, r.startOffset)
    return probe.toString()
  } catch {
    return ''
  }
}

/** 把 `index` 处的块替换成 `blockMd`（Markdown 层；文档为空时等价于插入） */
function withBlock(md: string, index: number, blockMd: string): string | null {
  const blocks = splitBlocks(md)
  if (!blocks.length) return blockMd // 空文档：直接落地该块
  if (index < 0 || index >= blocks.length) return null
  const all = blocks.map((b) => b.md)
  all[index] = blockMd
  return all.join('\n\n')
}

/** 在 `index` 之后插入一个新块 */
function withBlockAfter(md: string, index: number, blockMd: string): string | null {
  const blocks = splitBlocks(md)
  if (!blocks.length) return blockMd
  if (index < 0 || index >= blocks.length) return null
  const all = blocks.map((b) => b.md)
  all.splice(index + 1, 0, blockMd)
  return all.join('\n\n')
}

/**
 * 用 Markdown 级改写完成「块替换」并落位光标。
 *
 * 为什么不用 `insertMD` 就地插入：实测 `insertMD` 会在**原段落元素之后**追加新块，
 * 原段落被清空后仍留在文档里，渲染成多余空行。整篇 `writeValue`（Vditor 公开 API `setValue`
 * → `renderDomByMd`）会把结构重建成「块替换」的正确形态，代价是光标位置由本函数显式指定。
 */
function applyRewrite(next: string | null, markerToFind: string) {
  const root = props.bridge.editable()
  if (!next || !root) return
  props.bridge.writeValue(next)
  const at = next.lastIndexOf(markerToFind)
  if (at >= 0) {
    try {
      placeCaretAt(root, at + markerToFind.length)
    } catch {
      /* 落位失败不影响内容正确性 */
    }
  }
  props.bridge.notifyInput()
}

/** 当前块在文档中的序号；编辑器为空（返回编辑器自身）或定位失败时回退到 0 */
function blockIndexForEdit(root: HTMLElement, block: HTMLElement): number {
  const idx = blockIndexOf(block, root)
  return idx >= 0 ? idx : 0
}

function onBeforeInput(e: InputEvent) {
  const root = props.bridge.editable()
  if (!root) return
  const block = currentBlockOf(root)
  if (!block) return

  // ---- Enter 续行 ----
  if (e.inputType === 'insertParagraph') {
    const blockText = block.textContent ?? ''
    if (isEmptyTaskLine(blockText) || isEmptyListItem(blockText)) return // 空项 → 交给 Vditor 结束列表
    const marker = matchContinuation(blockText)
    if (!marker) return
    e.preventDefault()
    const idx = blockIndexForEdit(root, block)
    const next = withBlockAfter(props.bridge.readValue(), idx, marker.trimEnd())
    applyRewrite(next, marker)
    return
  }

  // ---- `- ` / `> ` / `1. ` 等标记 + 空格 ----
  // 注：`e.data` 可能是**多字符**（粘贴 / 自动化插入 `- ` 整串），故只要求以空格结尾
  if (e.inputType !== 'insertText' || !e.data || !e.data.endsWith(' ')) return
  // 注意：beforeinput 触发时这次输入**尚未进入 DOM**，因此要把 `e.data` 一起参与判定
  const before = textBeforeCaret(root).replace(/\u200b/g, '')
  const shortcut = matchInlineShortcut(before + e.data)
  if (!shortcut) return
  e.preventDefault()
  const idx = blockIndexForEdit(root, closestBlock(block, root) ?? block)
  const next = withBlock(props.bridge.readValue(), idx, shortcut.replacement.trimEnd())
  applyRewrite(next, shortcut.replacement)
}

onMounted(() => {
  props.bridge.editable()?.addEventListener('beforeinput', onBeforeInput as EventListener, true)
})
onBeforeUnmount(() => {
  props.bridge.editable()?.removeEventListener('beforeinput', onBeforeInput as EventListener, true)
})
</script>

<template>
  <!-- 无界面逻辑组件 -->
  <span v-show="false" aria-hidden="true" />
</template>
