// 拾光服务：日记/感悟/名言的增删改查 + 开门密码（scrypt 哈希、短时解锁令牌、失败限流）
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type {
  ShiguangEntry,
  ShiguangEntryInput,
  ShiguangEntryType,
  ShiguangService,
  ShiguangSetPasscodeInput,
  ShiguangStatus,
  ShiguangUnlockResult,
} from './types.js'
import { ShiguangError } from './types.js'
import type { ShiguangPersist } from './store.js'

const TYPES: ShiguangEntryType[] = ['diary', 'insight', 'quote']
const PASSCODE_MIN = 4
const PASSCODE_MAX = 32
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 60_000

export interface ShiguangServiceOptions {
  /** 解锁令牌有效期（默认 30 分钟；重启后失效） */
  tokenTtlMs?: number
}

function hashPasscode(passcode: string, saltHex: string): string {
  return scryptSync(passcode, Buffer.from(saltHex, 'hex'), 64).toString('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function normalizeType(type: unknown): ShiguangEntryType {
  return TYPES.includes(type as ShiguangEntryType) ? (type as ShiguangEntryType) : 'insight'
}

function cleanText(v: unknown, max = 20000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function createShiguangService(persist: ShiguangPersist, options: ShiguangServiceOptions = {}): ShiguangService {
  const tokenTtlMs = Math.max(60_000, options.tokenTtlMs ?? 30 * 60_000)
  /** token → 过期时间戳 */
  const tokens = new Map<string, number>()
  /** 失败次数 / 冷却截止时间（进程内，重启清零） */
  let fails = 0
  let lockedUntil = 0

  const anyValidToken = (): boolean => {
    const now = Date.now()
    for (const [t, exp] of tokens) {
      if (exp <= now) tokens.delete(t)
    }
    return tokens.size > 0
  }

  return {
    async status(): Promise<ShiguangStatus> {
      const data = await persist.load()
      return {
        hasPasscode: !!data.passcodeHash,
        locked: !anyValidToken(),
      }
    },

    async hasPasscode(): Promise<boolean> {
      const data = await persist.load()
      return !!data.passcodeHash
    },

    async setPasscode(input: ShiguangSetPasscodeInput): Promise<void> {
      const next = String(input.newPasscode ?? '')
      if (next.length < PASSCODE_MIN || next.length > PASSCODE_MAX) {
        throw new ShiguangError('E_PASSCODE_LENGTH', `密码长度需为 ${PASSCODE_MIN}-${PASSCODE_MAX} 位`)
      }
      const data = await persist.load()
      if (data.passcodeHash && data.passcodeSalt) {
        const old = String(input.oldPasscode ?? '')
        if (!old) throw new ShiguangError('E_OLD_REQUIRED', '请输入原密码')
        if (!safeEqualHex(hashPasscode(old, data.passcodeSalt), data.passcodeHash)) {
          throw new ShiguangError('E_BAD_OLD_PASSCODE', '原密码不正确')
        }
      }
      const salt = randomBytes(16).toString('hex')
      data.passcodeSalt = salt
      data.passcodeHash = hashPasscode(next, salt)
      await persist.save(data)
      // 改密码后所有旧令牌失效
      tokens.clear()
    },

    async resetPasscode(): Promise<void> {
      const data = await persist.load()
      delete data.passcodeHash
      delete data.passcodeSalt
      await persist.save(data)
      tokens.clear()
    },

    async unlock(passcode: string): Promise<ShiguangUnlockResult> {
      const now = Date.now()
      if (lockedUntil > now) {
        const sec = Math.ceil((lockedUntil - now) / 1000)
        throw new ShiguangError('E_LOCKED_OUT', `尝试过于频繁，请 ${sec} 秒后再试`)
      }
      const data = await persist.load()
      if (!data.passcodeHash || !data.passcodeSalt) {
        throw new ShiguangError('E_NO_PASSCODE', '尚未设置开门密码')
      }
      const ok = safeEqualHex(hashPasscode(String(passcode ?? ''), data.passcodeSalt), data.passcodeHash)
      if (!ok) {
        fails++
        if (fails >= MAX_ATTEMPTS) {
          fails = 0
          lockedUntil = Date.now() + LOCKOUT_MS
          throw new ShiguangError('E_LOCKED_OUT', '密码错误次数过多，请 60 秒后再试')
        }
        throw new ShiguangError('E_BAD_PASSCODE', `密码不正确（还可尝试 ${MAX_ATTEMPTS - fails} 次）`)
      }
      fails = 0
      const token = randomBytes(32).toString('hex')
      const exp = Date.now() + tokenTtlMs
      tokens.set(token, exp)
      return { token, expiresAt: new Date(exp).toISOString() }
    },

    lock(token: string | undefined): void {
      if (token) tokens.delete(token)
    },

    verify(token: string | undefined): boolean {
      if (!token) return false
      const exp = tokens.get(token)
      if (!exp) return false
      if (exp <= Date.now()) {
        tokens.delete(token)
        return false
      }
      return true
    },

    async list(type?: ShiguangEntryType): Promise<ShiguangEntry[]> {
      const data = await persist.load()
      const t = type && TYPES.includes(type) ? type : undefined
      return data.entries
        .filter((e) => (t ? e.type === t : true))
        .sort((a, b) => (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt))
    },

    async add(input: ShiguangEntryInput): Promise<ShiguangEntry> {
      const content = cleanText(input.content)
      if (!content) throw new ShiguangError('E_EMPTY_CONTENT', '内容不能为空')
      const now = new Date().toISOString()
      const entry: ShiguangEntry = {
        id: randomUUID(),
        type: normalizeType(input.type),
        content,
        date: input.date ? cleanText(input.date, 10) : undefined,
        title: cleanText(input.title, 200) || undefined,
        author: cleanText(input.author, 100) || undefined,
        tags: Array.isArray(input.tags) ? input.tags.map((t) => cleanText(t, 30)).filter(Boolean).slice(0, 12) : undefined,
        createdAt: now,
        updatedAt: now,
      }
      const data = await persist.load()
      data.entries.push(entry)
      await persist.save(data)
      return entry
    },

    async update(id: string, patch: Partial<ShiguangEntryInput>): Promise<ShiguangEntry> {
      const data = await persist.load()
      const entry = data.entries.find((e) => e.id === id)
      if (!entry) throw new ShiguangError('E_NOT_FOUND', '记录不存在')
      if (patch.type !== undefined) entry.type = normalizeType(patch.type)
      if (patch.content !== undefined) {
        const content = cleanText(patch.content)
        if (!content) throw new ShiguangError('E_EMPTY_CONTENT', '内容不能为空')
        entry.content = content
      }
      if (patch.date !== undefined) entry.date = cleanText(patch.date, 10) || undefined
      if (patch.title !== undefined) entry.title = cleanText(patch.title, 200) || undefined
      if (patch.author !== undefined) entry.author = cleanText(patch.author, 100) || undefined
      if (patch.tags !== undefined) {
        entry.tags = Array.isArray(patch.tags)
          ? patch.tags.map((t) => cleanText(t, 30)).filter(Boolean).slice(0, 12)
          : undefined
      }
      entry.updatedAt = new Date().toISOString()
      await persist.save(data)
      return entry
    },

    async remove(id: string): Promise<void> {
      const data = await persist.load()
      const idx = data.entries.findIndex((e) => e.id === id)
      if (idx < 0) throw new ShiguangError('E_NOT_FOUND', '记录不存在')
      data.entries.splice(idx, 1)
      await persist.save(data)
    },
  }
}
