// 拾光（日记 / 感悟 / 名言）插件类型定义

export type ShiguangEntryType = 'diary' | 'insight' | 'quote'

/** 一条记录：日记（可带日期）/ 感悟 / 名言（可带出处） */
export interface ShiguangEntry {
  id: string
  type: ShiguangEntryType
  /** 日记日期 YYYY-MM-DD；感悟/名言可空 */
  date?: string
  title?: string
  content: string
  /** 名言出处 / 作者 */
  author?: string
  tags?: string[]
  createdAt: string
  updatedAt: string
}

export interface ShiguangEntryInput {
  type: ShiguangEntryType
  content: string
  date?: string
  title?: string
  author?: string
  tags?: string[]
}

export interface ShiguangStatus {
  /** 是否已设置开门密码 */
  hasPasscode: boolean
  /** 当前是否处于锁定态（无有效解锁令牌） */
  locked: boolean
}

export interface ShiguangUnlockResult {
  token: string
  expiresAt: string
}

export interface ShiguangSetPasscodeInput {
  newPasscode: string
  oldPasscode?: string
}

/** 带错误码的错误（便于 API 映射到 401/429/400） */
export class ShiguangError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ShiguangError'
  }
}

export interface ShiguangService {
  status(): Promise<ShiguangStatus>
  hasPasscode(): Promise<boolean>
  setPasscode(input: ShiguangSetPasscodeInput): Promise<void>
  /** 重置开门密码（清除密码，内容保留；仅站主可用） */
  resetPasscode(): Promise<void>
  unlock(passcode: string): Promise<ShiguangUnlockResult>
  lock(token: string | undefined): void
  verify(token: string | undefined): boolean
  list(type?: ShiguangEntryType): Promise<ShiguangEntry[]>
  add(input: ShiguangEntryInput): Promise<ShiguangEntry>
  update(id: string, patch: Partial<ShiguangEntryInput>): Promise<ShiguangEntry>
  remove(id: string): Promise<void>
}
