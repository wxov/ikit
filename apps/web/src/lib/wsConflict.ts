// 多端冲突提示（完善⑦ §4.8 / AC-24；第 2 轮复验 R2-2/R2-3/R2-4 收敛口径）
// ——「他端改动了当前文章」判定的**纯逻辑**，与 UI 解耦。
//
// 目标：他端修改/删除当前文章时，本端**只提示、不覆盖**：
//  - 阅读态 → 顶部黄条 + 「重新载入」（用户显式点击才拉取最新并替换显示，见 App.vue）；
//    他端删除（`remove`）→ 黄条「该文章已被删除或移入回收站」+「返回列表」；
//  - 编辑/新建态 → 只提示（文案不同），**永不**因 WS 重载覆盖正在输入的内容（编辑器内容只由用户输入
//    与本端 HTTP 响应驱动，WS 从不回写编辑器）；他端删除时提供「返回列表 / 继续编辑」；
//  - **仅站主（admin）提示**（第 2 轮口径 R2-2）：`canPrompt()` 为假（游客 / 登录非站主）时完全不判定、
//    不弹条；
//  - **同一版本只提示一次**（第 2 轮口径 R2-2 / R2-4）：记录「最近提示过的 (文章 id, updatedAt, kind)」，
//    值相同的重复广播或重复写入不再弹（也顺带消除 R2-4 的重复 `onConflict` 回调）；出现**新的**
//    `updatedAt` 才再次提示。`clear()`（切换文章 / 离开详情 / 删除当前文章）重置该记录；
//    `dismiss()`（用户点「继续编辑」/「×」收起提示条）只收条、**保留**记录 → 同一版本不会因收起而复弹；
//  - **自更新回声抑制**：本端 autosave/PATCH/POST/DELETE 触发的 `knowledge:changed` 不应弹提示条。
//
// 回声抑制的两道闸（缺一不可）：
//  ① 指纹比对：`payload.entry.updatedAt === 本地已知 updatedAt` → 这条广播就是本端那次写入（HTTP 响应已回写本地）；
//  ② 写入在途保护窗：服务端 `ctx.emit('knowledge:changed')` 发生在 HTTP 响应**之前**，WS 帧可能先于
//     fetch 回包到达浏览器；此时①还不成立（本地 updatedAt 还是旧值）→ 会误报。因此本端每次写入前调用
//     `noteLocalWrite()` 打点，若消息落在保护窗内，则**推迟到窗口结束再复检①**：
//     - 本端自己的写入：此时 HTTP 响应已回写 updatedAt → ①成立 → 静默丢弃（不闪条）；
//     - 他端的写入：updatedAt 与本端不同 → ①不成立 → 正常提示（不因窗口而漏报）。
//  `noteLocalSaved()` 再做一次反向兜底：提示条上的 updatedAt 与本端写入响应相同 → 撤回提示条。
//  本端自己删除（DELETE）同样先 `noteLocalWrite()` 打点 → `remove` 广播落在保护窗内被推迟，
//  随后 `clear()`（`onDeleted`）撤销待复检定时器 → 不会对自己的删除弹「已被删除」。

/** 提示条类型：`update` = 他端修改（含创建）；`remove` = 他端软删除（移入回收站） */
export type WsConflictKind = 'update' | 'remove'

export interface WsConflictState {
  /** 冲突文章 id（= 提示条对应的当前文章） */
  id: string
  /** 他端版本的 updatedAt：本端随后的写入响应若与它相同，说明那条广播是自己的回声 */
  updatedAt: string
  /** 他端动作（决定文案与可用动作） */
  kind: WsConflictKind
}

export interface WsConflictGateOptions {
  /** 当前正在阅读/编辑的文章 id（null = 列表态 / 尚无 id 的虚拟草稿 → 无从判定，不提示） */
  currentId: () => string | null
  /** 本地已知的当前文章 updatedAt（来自本端最近的 HTTP 响应） */
  currentUpdatedAt: () => string | null
  /** 提示条状态变更（null = 清除）。调用方负责渲染非弹窗 UI */
  onConflict: (state: WsConflictState | null) => void
  /**
   * 是否允许提示（第 2 轮口径：仅站主 admin）。缺省恒 true（便于纯逻辑单测）；
   * 调用方传 `() => user?.role === 'admin'` → 游客/登录非站主完全不弹条（fail-closed）
   */
  canPrompt?: () => boolean
  /** 写入在途保护窗（ms，默认 3000；<=0 关闭②，退化为纯指纹比对） */
  graceMs?: number
  /** 定时器注入（仅测试用） */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** 定时器清理注入（仅测试用） */
  clearTimer?: (handle: unknown) => void
}

export interface WsConflictGate {
  /** 本端即将发起一次写入（POST/PATCH/DELETE 之前）：刷新保护窗起点 */
  noteLocalWrite(): void
  /** 本端写入成功（HTTP 响应回写本地后）：按 updatedAt 指纹撤回误报的提示条 */
  noteLocalSaved(entry: { updatedAt?: string } | null | undefined): void
  /** WS 消息入口（`type === 'knowledge:changed'` 且 `payload.action` 为 update/create/remove 才判定） */
  handleMessage(msg: { type?: string; payload?: any }): void
  /** 用户收起提示条（「继续编辑」/「×」）：只清 UI，**保留**「已提示过的版本」记录（同版本不再弹） */
  dismiss(): void
  /** 切换文章 / 离开详情 / 删除当前文章：清提示条 + 清待复检定时器 + **重置**版本记录 */
  clear(): void
  /** 当前提示条状态 */
  state(): WsConflictState | null
  dispose(): void
}

/** 会触发「他端改动了当前文章」判定的 WS action（`comment*` 不参与） */
const PROMPTABLE_ACTIONS = ['update', 'create', 'remove'] as const

export function createWsConflictGate(opts: WsConflictGateOptions): WsConflictGate {
  const graceMs = opts.graceMs ?? 3000
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let current: WsConflictState | null = null
  /** 最近一次**已提示过**的版本（R2-2/R2-4 去重）；`clear()` 重置，`dismiss()` 保留 */
  let prompted: WsConflictState | null = null
  /** 本端最近一次写入请求发起时刻（0 = 从未写入） */
  let localWriteAt = 0
  let timer: unknown = null
  let disposed = false

  const dropTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  /** 值相等（按 id + updatedAt + kind 比较）→ 不重复回调 onConflict（R2-4 最小幂等防护） */
  const sameState = (a: WsConflictState | null, b: WsConflictState | null): boolean => {
    if (!a || !b) return a === b
    return a.id === b.id && a.updatedAt === b.updatedAt && a.kind === b.kind
  }

  const setConflict = (next: WsConflictState | null) => {
    if (sameState(current, next)) return
    current = next
    opts.onConflict(next)
  }

  /** 当前文章是否就是 payload 里的那篇 */
  const hitsCurrent = (id: unknown): boolean => {
    const cur = opts.currentId()
    return !!cur && !!id && cur === id
  }

  /** ① 指纹比对：与本地已知 updatedAt 相同 → 本端自己的写入 */
  const isOwnEcho = (updatedAt: unknown): boolean => {
    const local = opts.currentUpdatedAt()
    return !!local && !!updatedAt && local === updatedAt
  }

  function evaluate(payload: any, allowDefer: boolean) {
    if (!(opts.canPrompt?.() ?? true)) return // 第 2 轮口径：非站主不提示
    const entry = payload?.entry
    if (!entry?.id || !hitsCurrent(entry.id)) return // 只关心「当前正在看/编辑的那篇」
    if (isOwnEcho(entry.updatedAt)) return // ① 自己的回声
    if (allowDefer && graceMs > 0) {
      const elapsed = Date.now() - localWriteAt
      if (elapsed < graceMs) {
        // ② 本端写入在途（或刚发起）：等 HTTP 回包落地后复检①，避免自己的自动保存误报
        dropTimer()
        timer = setTimer(() => {
          timer = null
          if (disposed) return
          evaluate(payload, false)
        }, graceMs - elapsed + 50)
        return
      }
    }
    const next: WsConflictState = {
      id: String(entry.id),
      updatedAt: String(entry.updatedAt ?? ''),
      kind: payload?.action === 'remove' ? 'remove' : 'update',
    }
    // 同一版本（id + updatedAt + kind）只提示一次：重复广播 / 他端同版本再次写入都不再弹
    if (prompted && sameState(prompted, next)) return
    prompted = next
    setConflict(next)
  }

  return {
    noteLocalWrite() {
      localWriteAt = Date.now()
    },

    noteLocalSaved(entry) {
      const at = entry?.updatedAt
      if (current && at && current.updatedAt === at) {
        // 提示条上的版本其实就是本端这次写入 → 误报，撤回提示条并丢弃该版本记录
        setConflict(null)
        if (prompted && prompted.updatedAt === at) prompted = null
      }
    },

    handleMessage(msg) {
      if (disposed) return
      if (msg?.type !== 'knowledge:changed') return
      const action = msg.payload?.action
      if (!PROMPTABLE_ACTIONS.includes(action)) return
      evaluate(msg.payload, true)
    },

    dismiss() {
      setConflict(null)
    },

    clear() {
      dropTimer()
      prompted = null
      setConflict(null)
    },

    state: () => current,

    dispose() {
      disposed = true
      dropTimer()
    },
  }
}
