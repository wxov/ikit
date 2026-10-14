// 自动保存控制器（完善⑦ §4.4）
//
// 职责：把「内容快照」以受控节奏写回服务端，保证不并发、不丢更新、失败可重试、状态可见。
//
// - 防抖 `delay`（默认 2s）+ 最大等待 `maxWait`（默认 10s，连续打字也保证每 10s 落一次盘）
// - **严格串行**：内部用 Promise 链排队，永不并发 PATCH（杜绝乱序覆盖）
// - `rev` 计数：保存期间又有输入 → 保持「未保存」状态，等下一轮（不把旧内容当成最终态）
// - unchanged 短路：与最近一次成功保存的快照一致 → 不发请求
// - 失败退避重试（1/2/5/10s）；**4xx 不重试**（校验类错误立即暴露给用户）
// - 退避用尽后仍为 `error` 且内容仍脏时：`retryFailed()` 可由「回到前台 / 窗口获焦」触发，
//   另有一个低频定时器（默认 30s）在后台上自动再试 → 长时间断网恢复后无需手动点击（AC-10）
// - `flush()`：立刻保存并等待结果（返回是否成功），供「返回阅读 / 取消 / 发布 / Ctrl+S / 跳转」使用
import { ApiError } from './api'

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface AutosaverOptions<T> {
  /** 读取当前内容快照（只在保存时调用，不在每次按键调用） */
  snapshot: () => T
  /** 把快照写回服务端；抛错视为失败（按 4xx/5xx 决定是否重试） */
  save: (snap: T) => Promise<void>
  /** 快照指纹（默认 JSON.stringify），用于 unchanged 短路 */
  fingerprint?: (snap: T) => string
  delay?: number
  maxWait?: number
  maxRetries?: number
  retryDelays?: number[]
  /** 退避用尽后的低频自动重试间隔（ms，默认 30000；<=0 关闭） */
  retryInterval?: number
  onState?: (state: SaveState, info?: { error?: unknown; at?: number; stale?: boolean }) => void
}

export interface Autosaver<T> {
  /** 内容变更：标记脏 + 重置防抖计时 */
  schedule(): void
  /** 立刻保存并等待结果 */
  flush(): Promise<boolean>
  /**
   * 失败后的自动恢复重试：仅当「当前处于 error、上次失败可重试（非 4xx）、内容仍脏」时真正发起；
   * 返回是否发起了重试。供 `visibilitychange`（回到前台）/ `window focus` / 低频定时器调用。
   */
  retryFailed(): boolean
  /** 把当前快照当作「已保存」基线（进入编辑态且无本地恢复内容时调用，避免空内容立即建条目） */
  prime(): void
  /** 最近一次成功保存的快照（用于「取消并回滚」） */
  lastSaved(): T | null
  isDirty(): boolean
  getState(): SaveState
  dispose(): void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 是否值得重试：网络错误 / 5xx / 429 重试；4xx（校验、权限）不重试 */
function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 429
  return true
}

export function createAutosaver<T>(opts: AutosaverOptions<T>): Autosaver<T> {
  const delay = opts.delay ?? 2000
  const maxWait = opts.maxWait ?? 10000
  const maxRetries = opts.maxRetries ?? 4
  const retryDelays = opts.retryDelays ?? [1000, 2000, 5000, 10000]
  const retryInterval = opts.retryInterval ?? 30000
  const fingerprint = opts.fingerprint ?? ((snap: T) => JSON.stringify(snap))

  let state: SaveState = 'idle'
  let lastFp: string | null = null
  let lastSnap: T | null = null
  let rev = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 上次失败是否值得重试（4xx = false → 自动恢复重试也不发起，保留「4xx 不重试」语义） */
  let lastErrorRetryable = false
  let chain: Promise<boolean> = Promise.resolve(true)

  const setState = (next: SaveState, info?: { error?: unknown; at?: number; stale?: boolean }) => {
    state = next
    opts.onState?.(next, info)
  }

  const clearRetryTimer = () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  const clearTimers = () => {
    if (timer) clearTimeout(timer)
    if (maxTimer) clearTimeout(maxTimer)
    timer = null
    maxTimer = null
  }

  /** 退避用尽后的低频自动重试（仍在 error 且仍脏时）；每次失败都会重新武装，直到成功或内容不再脏 */
  const armRetryTimer = () => {
    clearRetryTimer()
    if (disposed || retryInterval <= 0) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      retryFailed()
    }, retryInterval)
  }

  /**
   * 失败后的自动恢复重试：`visibilitychange`（回到前台）/ `window focus` / 低频定时器统一走这里。
   * 守卫条件缺一不可 —— 必须仍在 `error`、上次失败**可重试**（4xx 不重试）、且内容**仍脏**。
   */
  function retryFailed(): boolean {
    if (disposed || state !== 'error' || !lastErrorRetryable) return false
    if (!isDirty()) return false
    void run()
    return true
  }

  function isDirty(): boolean {
    return fingerprint(opts.snapshot()) !== lastFp
  }

  async function attempt(snap: T): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await opts.save(snap)
        return
      } catch (e) {
        if (disposed || i >= maxRetries || !isRetryable(e)) throw e
        await sleep(retryDelays[Math.min(i, retryDelays.length - 1)])
      }
    }
  }

  function run(): Promise<boolean> {
    clearTimers()
    chain = chain.then(async () => {
      if (disposed) return true
      const snap = opts.snapshot()
      const fp = fingerprint(snap)
      if (fp === lastFp) {
        setState('saved')
        return true
      }
      const myRev = rev
      setState('saving')
      try {
        await attempt(snap)
      } catch (e) {
        lastErrorRetryable = isRetryable(e)
        setState('error', { error: e })
        // 退避用尽（或网络类失败）→ 武装低频自动重试；4xx 不武装（不重试）
        if (lastErrorRetryable) armRetryTimer()
        else clearRetryTimer()
        return false
      }
      // 成功：撤销自动重试定时器（内容已落盘，无需再试）
      lastErrorRetryable = false
      clearRetryTimer()
      lastFp = fp
      lastSnap = snap
      if (rev > myRev) {
        // 保存期间又有输入：内容已过时，保持「未保存」，由后续 schedule 再落一次
        setState('dirty', { stale: true })
      } else {
        setState('saved', { at: Date.now() })
      }
      return true
    })
    return chain
  }

  return {
    schedule() {
      if (disposed) return
      rev++
      if (state !== 'saving') setState('dirty')
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void run()
      }, delay)
      if (!maxTimer) {
        maxTimer = setTimeout(() => {
          maxTimer = null
          void run()
        }, maxWait)
      }
    },

    async flush() {
      if (disposed) return true
      return run()
    },

    retryFailed,

    prime() {
      const snap = opts.snapshot()
      lastFp = fingerprint(snap)
      lastSnap = snap
      lastErrorRetryable = false
      clearRetryTimer()
      setState('idle')
    },

    lastSaved: () => lastSnap,

    isDirty,

    getState: () => state,

    dispose() {
      disposed = true
      clearTimers()
      clearRetryTimer()
    },
  }
}
