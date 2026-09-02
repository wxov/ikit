// 账号体系类型
export type UserRole = 'guest' | 'user' | 'admin'

/** 用户组：内置组 guest/user/admin 固定存在、不可删除；自定义组由站主增删改 */
export interface Group {
  id: string
  name: string
  /** 内置组 true，不可删除 */
  builtin: boolean
  description?: string
  /** 父组 id（包含关系：上级组包含下级组；仅自定义组可设，内置组恒为顶层） */
  parentId?: string
  createdAt: string
}

export interface User {
  id: string
  username: string
  /** passwordHash: scrypt 派生（salt 内嵌 hash） */
  passwordHash: string
  /** 角色：user(注册用户) / admin(站主) */
  role: 'user' | 'admin'
  /** 所属用户组 id（空 = 默认 ['user']；admin 恒有全部权限） */
  groupIds?: string[]
  /** 是否被禁用 */
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export interface PublicUser {
  id: string
  username: string
  role: 'user' | 'admin'
  groupIds?: string[]
  disabled: boolean
  createdAt: string
}

export interface Session {
  token: string
  userId: string
  createdAt: string
}

export interface UserConfig {
  users: User[]
  sessions: Session[]
  /** 用户组（缺省时由服务补齐内置组） */
  groups?: Group[]
}

/** 解析用户所属组集合（纯函数，供可见性判定使用）；注册用户始终保留 'user' 组身份 */
export function groupsOf(user: PublicUser | null): string[] {
  if (!user) return ['guest']
  if (user.role === 'admin') return ['admin']
  return Array.from(new Set(['user', ...(user.groupIds ?? [])]))
}

export interface AccountService {
  login(username: string, password: string): Promise<{ token: string; user: PublicUser }>
  /** 找回密码：生成一次性重置码并（若配置 SMTP）发送邮件 */
  requestReset(username: string): Promise<{ sent: boolean; resetToken?: string } | null>
  resetPassword(resetToken: string, newPassword: string): Promise<boolean>
  /** 校验 token → 返回当前用户（不含敏感字段），disabled 视为无效 */
  me(token: string): Promise<PublicUser | null>
  roleOf(token: string): Promise<'guest' | 'user' | 'admin'>
  logout(token: string): Promise<void>
  listUsers(): Promise<PublicUser[]>
  /** 站主手动添加用户（用于屏蔽注册后由站主创建账号） */
  createUser(username: string, password: string, role?: 'user' | 'admin', groupIds?: string[]): Promise<PublicUser>
  /** 用户自助修改资料：改用户名（唯一性校验）/ 改密码（需原密码） */
  updateProfile(id: string, patch: { username?: string; oldPassword?: string; newPassword?: string }): Promise<PublicUser>
  disableUser(id: string, disabled: boolean): Promise<PublicUser[]>
  deleteUser(id: string): Promise<PublicUser[]>
  setRole(id: string, role: 'user' | 'admin'): Promise<PublicUser[]>
  /** 用户组管理 */
  listGroups(): Promise<Group[]>
  createGroup(name: string, description?: string, parentId?: string): Promise<Group[]>
  renameGroup(id: string, name: string): Promise<Group[]>
  deleteGroup(id: string): Promise<Group[]>
  /** 设置组的父组（包含关系；parentId 为空 = 顶层；内置组不可移动） */
  setGroupParent(id: string, parentId: string | undefined): Promise<Group[]>
  setUserGroups(id: string, groupIds: string[]): Promise<PublicUser[]>
  /** 展开包含关系：返回用户有效组集合（直接所属组 + 递归被包含的子组） */
  effectiveGroupsOf(user: PublicUser | null): Promise<string[]>
  /** 确保存在一个默认站主（便于初次使用） */
  seedAdmin(username: string, password: string): Promise<void>
}
