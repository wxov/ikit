// 本地快照节流器（P2-10 前端拆分，2026-11-28）
//
// 从 ArticleEditView.vue 抽出：input 回调不直接读 getValue()，由 500ms 定时器统一读一次，
// 减少编辑器读值次数（性能红线）；同一节流窗口顺带刷新字数（onThrottle）。
import { ref } from 'vue'
import type { DraftSnapshot } from '../lib/draftSnapshot'

export interface UseDraftSnapshotOptions {
  /** 当前存储键（entryId + parentId 派生） */
  currentKey: () => string
  /** 读取当前编辑态（会调用编辑器 readValue） */
  readSnapshot: () => DraftSnapshot
  /** 落盘函数（localStorage 等） */
  writeSnapshot: (key: string, snap: DraftSnapshot) => void
  /** 每次节流窗口内额外动作（如刷新字数统计） */
  onThrottle?: () => void
  throttleMs?: number
}

export function useDraftSnapshot(options: UseDraftSnapshotOptions) {
  const pendingSnap = ref<DraftSnapshot | null>(null)
  const snapDismissed = ref(false)
  const throttleMs = options.throttleMs ?? 500

  let snapTimer: ReturnType<typeof setTimeout> | null = null

  function cancelSnapTimer() {
    if (snapTimer) clearTimeout(snapTimer)
    snapTimer = null
  }

  function snapshot(): DraftSnapshot {
    return options.readSnapshot()
  }

  function writeSnapNow() {
    cancelSnapTimer()
    options.writeSnapshot(options.currentKey(), snapshot())
  }

  function touchSnapshot() {
    if (snapTimer) return
    snapTimer = setTimeout(() => {
      snapTimer = null
      // 同一个节流窗口内顺手刷新字数（复用这一次读值，不额外调用 getValue）
      options.onThrottle?.()
      options.writeSnapshot(options.currentKey(), snapshot())
    }, throttleMs)
  }

  return { pendingSnap, snapDismissed, snapshot, cancelSnapTimer, writeSnapNow, touchSnapshot }
}
