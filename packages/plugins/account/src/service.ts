// 账号服务：scrypt 密码哈希 + token 会话
import { randomBytes, randomUUID, scrypt as _scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { AccountService, Group, PublicUser, User, UserRole } from './types.js'
import type { JsonAccountStore } from './store.js'

export type EmailSender = (to: string, subject: string, html: string) => Promise<void>

const scrypt = promisify(_scrypt) as (pwd: string, salt: string, keylen: number) => Promise<Buffer>

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = (await scrypt(password, salt, 64)) as Buffer
  return `${salt}:${hash.toString('hex')}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(':')
  if (!salt || !hex) return false
  const hash = (await scrypt(password, salt, 64)) as Buffer
  const expected = Buffer.from(hex, 'hex')
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}

function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    groupIds: u.groupIds?.length ? u.groupIds.slice() : undefined,
    disabled: u.disabled,
    createdAt: u.createdAt,
  }
}

// 简化密码找回：生成一次性 resetToken 存入用户记录（无邮件时返回给调用方演示）
interface UserWithReset extends User {
  resetToken?: string
  resetExpires?: string
}

// 收集某组的全部子孙组 id（含被递归包含的子组，不含自身）
function collectGroupDescendants(groups: Group[], rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const g of groups) {
    if (g.parentId) {
      const arr = children.get(g.parentId) ?? []
      arr.push(g.id)
      children.set(g.parentId, arr)
    }
  }
  const out = new Set<string>()
  const q = [rootId]
  while (q.length) {
    const cur = q.shift()!
    for (const c of children.get(cur) ?? []) {
      if (!out.has(c)) {
        out.add(c)
        q.push(c)
      }
    }
  }
  return out
}

export function createAccount(
  store: JsonAccountStore,
  opts: { emailSender?: EmailSender; appUrl?: string } = {},
): AccountService {
  let loaded = false
  let config = { users: [] as UserWithReset[], sessions: [] as { token: string; userId: string; createdAt: string }[], groups: [] as Group[] }

  const persist = async () => {
    await store.save(config as any)
  }

  const BUILTIN_GROUPS: Group[] = [
    { id: 'guest', name: '游客', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    { id: 'user', name: '注册用户', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    { id: 'admin', name: '站主', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
  ]

  // 补齐内置组 + 迁移旧用户 groupIds
  const ensureGroups = () => {
    if (!Array.isArray(config.groups)) config.groups = []
    for (const g of BUILTIN_GROUPS) {
      if (!config.groups.some((x) => x.id === g.id)) config.groups.push({ ...g })
    }
    for (const u of config.users) {
      if (!Array.isArray(u.groupIds) || !u.groupIds.length) {
        u.groupIds = u.role === 'admin' ? [] : ['user']
      }
    }
  }

  const ensureLoaded = async () => {
    if (loaded) return
    config = (await store.load()) as any
    if (!Array.isArray(config.sessions)) config.sessions = []
    const hadGroups = Array.isArray(config.groups) && config.groups.length >= BUILTIN_GROUPS.length
    ensureGroups()
    if (!hadGroups) await persist()
    loaded = true
  }
  void ensureLoaded()

  const findUser = (username: string) =>
    config.users.find((u) => u.username.toLowerCase() === username.toLowerCase())

  return {
    async login(username, password) {
      await ensureLoaded()
      const user = findUser(username)
      if (!user) throw new Error('用户名或密码错误')
      if (user.disabled) throw new Error('账号已被禁用')
      if (!(await verifyPassword(password, user.passwordHash))) throw new Error('用户名或密码错误')
      const token = randomBytes(24).toString('hex')
      config.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() })
      await persist()
      return { token, user: toPublic(user) }
    },

    async requestReset(username) {
      await ensureLoaded()
      const user = findUser(username)
      if (!user) return null
      const resetToken = randomBytes(16).toString('hex')
      user.resetToken = resetToken
      user.resetExpires = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      await persist()
      // 若配置了邮件，则发送重置邮件；否则返回 token 供演示
      if (opts.emailSender && opts.appUrl) {
        try {
          const link = `${opts.appUrl}/#/reset?token=${resetToken}`
          await opts.emailSender(
            user.username,
            'i-kit 密码重置',
            `<p>你好，请点击以下链接重置密码（30 分钟内有效）：</p><p><a href="${link}">${link}</a></p>`,
          )
          return { sent: true }
        } catch (e) {
          console.warn('[account] reset email failed:', e instanceof Error ? e.message : e)
          return { sent: false, resetToken }
        }
      }
      return { sent: false, resetToken }
    },

    async resetPassword(resetToken, newPassword) {
      await ensureLoaded()
      if (newPassword.length < 6) return false
      const user = config.users.find(
        (u) => u.resetToken === resetToken && u.resetExpires && new Date(u.resetExpires) > new Date(),
      )
      if (!user) return false
      user.passwordHash = await hashPassword(newPassword)
      delete user.resetToken
      delete user.resetExpires
      await persist()
      return true
    },

    async me(token) {
      await ensureLoaded()
      const s = config.sessions.find((x) => x.token === token)
      if (!s) return null
      const user = config.users.find((u) => u.id === s.userId)
      if (!user || user.disabled) return null
      return toPublic(user)
    },

    async roleOf(token) {
      const user = token ? await this.me(token) : null
      return (user?.role as UserRole) ?? 'guest'
    },

    async logout(token) {
      await ensureLoaded()
      config.sessions = config.sessions.filter((s) => s.token !== token)
      await persist()
    },

    async listUsers() {
      await ensureLoaded()
      return config.users.map(toPublic)
    },

    async createUser(username, password, role = 'user', groupIds = []) {
      await ensureLoaded()
      const name = username.trim()
      if (!name || password.length < 6) throw new Error('用户名不能为空且密码至少 6 位')
      if (findUser(name)) throw new Error('该用户名已存在')
      const isAdmin = role === 'admin'
      const now = new Date().toISOString()
      const validGroups = [...new Set((groupIds || []).filter((gid) => config.groups.some((g) => g.id === gid)))]
      const user: UserWithReset = {
        id: randomUUID(),
        username: name,
        passwordHash: await hashPassword(password),
        role: isAdmin ? 'admin' : 'user',
        groupIds: isAdmin ? [] : validGroups.length ? validGroups : ['user'],
        disabled: false,
        createdAt: now,
        updatedAt: now,
      }
      config.users.push(user)
      await persist()
      return toPublic(user)
    },

    async updateProfile(id, patch) {
      await ensureLoaded()
      const user = config.users.find((u) => u.id === id)
      if (!user) throw new Error('用户不存在')
      if (patch.username !== undefined && patch.username.trim() !== user.username) {
        const name = patch.username.trim()
        if (!name) throw new Error('用户名不能为空')
        const existing = findUser(name)
        if (existing && existing.id !== id) throw new Error('该用户名已存在')
        user.username = name
      }
      if (patch.newPassword) {
        if (patch.newPassword.length < 6) throw new Error('新密码至少 6 位')
        if (!patch.oldPassword || !(await verifyPassword(patch.oldPassword, user.passwordHash))) {
          throw new Error('原密码错误')
        }
        user.passwordHash = await hashPassword(patch.newPassword)
      }
      user.updatedAt = new Date().toISOString()
      await persist()
      return toPublic(user)
    },

    async disableUser(id, disabled) {
      await ensureLoaded()
      const u = config.users.find((x) => x.id === id)
      if (u) {
        u.disabled = disabled
        u.updatedAt = new Date().toISOString()
        await persist()
      }
      return config.users.map(toPublic)
    },

    async deleteUser(id) {
      await ensureLoaded()
      config.users = config.users.filter((x) => x.id !== id)
      // 清理该用户会话
      config.sessions = config.sessions.filter((s) => s.userId !== id)
      await persist()
      return config.users.map(toPublic)
    },

    async setRole(id, role) {
      await ensureLoaded()
      const u = config.users.find((x) => x.id === id)
      if (u) {
        u.role = role
        u.updatedAt = new Date().toISOString()
        await persist()
      }
      return config.users.map(toPublic)
    },

    async listGroups() {
      await ensureLoaded()
      return config.groups.map((g) => ({ ...g }))
    },

    async createGroup(name, description, parentId) {
      await ensureLoaded()
      const trimmed = (name || '').trim()
      if (!trimmed) throw new Error('组名不能为空')
      if (config.groups.some((g) => g.name === trimmed)) throw new Error('该组名已存在')
      if (parentId) {
        const p = config.groups.find((g) => g.id === parentId)
        if (!p) throw new Error('父组不存在')
        if (p.builtin) throw new Error('不能挂到内置组下')
      }
      const group: Group = {
        id: randomUUID(),
        name: trimmed,
        builtin: false,
        description: description || undefined,
        parentId: parentId || undefined,
        createdAt: new Date().toISOString(),
      }
      config.groups.push(group)
      await persist()
      return config.groups.map((g) => ({ ...g }))
    },

    async renameGroup(id, name) {
      await ensureLoaded()
      const g = config.groups.find((x) => x.id === id)
      if (!g) throw new Error('组不存在')
      if (g.builtin) throw new Error('内置组不可重命名')
      const trimmed = (name || '').trim()
      if (!trimmed) throw new Error('组名不能为空')
      if (config.groups.some((x) => x.id !== id && x.name === trimmed)) throw new Error('该组名已存在')
      g.name = trimmed
      await persist()
      return config.groups.map((x) => ({ ...x }))
    },

    async deleteGroup(id) {
      await ensureLoaded()
      const g = config.groups.find((x) => x.id === id)
      if (!g) throw new Error('组不存在')
      if (g.builtin) throw new Error('内置组不可删除')
      const parent = g.parentId
      config.groups = config.groups.filter((x) => x.id !== id)
      // 子组上挂到被删组的父组（保持层级）
      for (const x of config.groups) {
        if (x.parentId === id) x.parentId = parent
      }
      // 组内用户回落至 user 组
      for (const u of config.users) {
        if (Array.isArray(u.groupIds) && u.groupIds.includes(id)) {
          u.groupIds = u.groupIds.filter((gid) => gid !== id)
          if (!u.groupIds.length) u.groupIds = ['user']
        }
      }
      await persist()
      return config.groups.map((x) => ({ ...x }))
    },

    async setGroupParent(id, parentId) {
      await ensureLoaded()
      const g = config.groups.find((x) => x.id === id)
      if (!g) throw new Error('组不存在')
      if (g.builtin) throw new Error('内置组不可移动')
      const pid = parentId || undefined
      if (pid === id) throw new Error('不能将组设为其自身子组')
      if (pid) {
        const p = config.groups.find((x) => x.id === pid)
        if (!p) throw new Error('父组不存在')
        if (p.builtin) throw new Error('不能挂到内置组下')
        const descendants = collectGroupDescendants(config.groups, g.id)
        if (descendants.has(pid)) throw new Error('不能挂到自己的子组下')
      }
      g.parentId = pid
      await persist()
      return config.groups.map((x) => ({ ...x }))
    },

    async setUserGroups(id, groupIds) {
      await ensureLoaded()
      const u = config.users.find((x) => x.id === id)
      if (!u) throw new Error('用户不存在')
      const valid = [...new Set((groupIds || []).filter((gid) => config.groups.some((g) => g.id === gid)))]
      u.groupIds = valid.length ? valid : ['user']
      u.updatedAt = new Date().toISOString()
      await persist()
      return config.users.map(toPublic)
    },

    async effectiveGroupsOf(user) {
      await ensureLoaded()
      const base = !user
        ? ['guest']
        : user.role === 'admin'
          ? ['admin']
          : Array.from(new Set(['user', ...(user.groupIds ?? [])]))
      const out = new Set<string>(base)
      const q = [...base]
      const children = new Map<string, string[]>()
      for (const g of config.groups) {
        if (g.parentId) {
          const arr = children.get(g.parentId) ?? []
          arr.push(g.id)
          children.set(g.parentId, arr)
        }
      }
      while (q.length) {
        const cur = q.shift()!
        for (const c of children.get(cur) ?? []) {
          if (!out.has(c)) {
            out.add(c)
            q.push(c)
          }
        }
      }
      return [...out]
    },

    async seedAdmin(username, password) {
      await ensureLoaded()
      if (findUser(username)) return
      const now = new Date().toISOString()
      config.users.push({
        id: randomUUID(),
        username,
        passwordHash: await hashPassword(password),
        role: 'admin',
        disabled: false,
        createdAt: now,
        updatedAt: now,
      })
      await persist()
    },
  }
}
