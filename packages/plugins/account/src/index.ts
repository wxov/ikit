import { Schema } from 'cordis'
import type { Context } from 'cordis'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { JsonAccountStore } from './store.js'
import { createAccount } from './service.js'
import { createSmtpSender, type SmtpConfig } from './mail.js'

declare module 'cordis' {
  interface Context {
    account: ReturnType<typeof createAccount>
  }
}

export const name = 'account'

export interface Config {
  dataDir?: string
  /** 默认站主账号（初始化时若无同名账号则创建） */
  adminUsername?: string
  adminPassword?: string
  /** SMTP 邮件配置（用于密码找回邮件；留空则不发送，降级返回重置码） */
  smtp?: SmtpConfig
  /** 站点公网地址（用于拼接待验证码/重置链接） */
  appUrl?: string
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  adminUsername: Schema.string().default('admin'),
  adminPassword: Schema.string().default('admin123'),
})

export function apply(ctx: Context, config: Config) {
  const dataDir = config.dataDir || './data'
  mkdirSync(dataDir, { recursive: true })
  const store = new JsonAccountStore(path.join(dataDir, 'accounts.json'))
  const smtp = (config.smtp ?? {}) as SmtpConfig
  const emailSender = createSmtpSender(smtp) || undefined
  const account = createAccount(store, { emailSender, appUrl: config.appUrl || undefined })
  ctx.set('account', account)

  void account.seedAdmin(config.adminUsername || 'admin', config.adminPassword || 'admin123')

  console.log('[account] plugin started')
  if (!emailSender) console.log('[account] SMTP 未配置，密码找回将降级返回重置码')
  ctx.on('dispose', () => {
    console.log('[account] plugin disposed')
  })
}

export default { name, apply, Config }
export type { User, PublicUser, UserRole, Group, AccountService } from './types.js'
export { groupsOf } from './types.js'
