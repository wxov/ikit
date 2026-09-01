// 账号体系类型
export type UserRole = 'guest' | 'user' | 'admin'

export interface User {
  id: string
  username: string
  /** passwordHash: scrypt 派生（salt 内嵌 hash） */
  passwordHash: string
  /** 角色：user(注册用户) / admin(站主) */
  role: 'user' | 'admin'
  /** 是否被禁用 */
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export interface PublicUser {
  id: string
  username: string
  role: 'user' | 'admin'
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
  createUser(username: string, password: string, role?: 'user' | 'admin'): Promise<PublicUser>
  disableUser(id: string, disabled: boolean): Promise<PublicUser[]>
  deleteUser(id: string): Promise<PublicUser[]>
  setRole(id: string, role: 'user' | 'admin'): Promise<PublicUser[]>
  /** 确保存在一个默认站主（便于初次使用） */
  seedAdmin(username: string, password: string): Promise<void>
}
