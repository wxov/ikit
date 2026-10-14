// 本地草稿快照（localStorage）——刷新 / 崩溃 / 断网时不丢内容（完善⑦ §4.4.4）
//
// 与 Vditor 内建 cache 的关系：编辑器 options 里 `cache.enable = false`（内建 cache 会用
// localStorage 覆盖传入的 value 且只弹一个 tip，行为不可控）；改由本模块 + 显式「恢复/丢弃」
// 提示条接管，保证**单一事实源**。

export interface DraftSnapshot {
  title: string
  content: string
  category: string
  tags: string[]
  cover: string
  /** 写入时刻（毫秒），用于和 `entry.updatedAt` 比较谁更新 */
  updatedAt: number
  /** 已创建条目的 id；虚拟草稿为 null */
  entryId: string | null
}

const PREFIX = 'ikit-kb-snap:'

/** 快照 key：已有条目按 id；虚拟草稿按父档（root 表示根级） */
export function snapKey(entryId?: string | null, parentId?: string): string {
  return entryId ? `${PREFIX}${entryId}` : `${PREFIX}new:${parentId || 'root'}`
}

export function readSnapshot(key: string): DraftSnapshot | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DraftSnapshot
    if (typeof parsed?.content !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function clearSnapshot(key: string) {
  pending.delete(key)
  try {
    localStorage.removeItem(key)
  } catch {
    /* 隐私模式 / 配额：忽略 */
  }
}

/** 立即写入 */
export function writeSnapshot(key: string, snap: DraftSnapshot) {
  pending.delete(key)
  try {
    localStorage.setItem(key, JSON.stringify(snap))
  } catch {
    /* 配额溢出：忽略（服务端自动保存仍是主路径） */
  }
}

// 节流 500ms：大文档每键 JSON.stringify 会明显掉帧
const pending = new Map<string, DraftSnapshot>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleSnapshot(key: string, snap: DraftSnapshot) {
  pending.set(key, snap)
  if (timers.has(key)) return
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const p = pending.get(key)
      if (p) writeSnapshot(key, p)
    }, 500),
  )
}

/** 同步落地所有待写快照（beforeunload / visibilitychange 用） */
export function flushSnapshots() {
  for (const [key, snap] of [...pending.entries()]) {
    writeSnapshot(key, snap)
  }
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

/** 是否比服务端更新（用于「有比服务端更新的本地内容」提示） */
export function isNewerThan(snap: DraftSnapshot | null, updatedAt?: string): boolean {
  if (!snap) return false
  const server = updatedAt ? new Date(updatedAt).getTime() : 0
  return snap.updatedAt > server
}
