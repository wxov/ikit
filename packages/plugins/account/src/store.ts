// 账号存储：JSON 文件持久化
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { UserConfig } from './types.js'

export interface AccountStore {
  load(): Promise<UserConfig>
  save(config: UserConfig): Promise<void>
}

export class JsonAccountStore implements AccountStore {
  private cache: UserConfig | null = null
  constructor(private readonly file: string) {}

  async load(): Promise<UserConfig> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as UserConfig
      this.cache = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        groups: Array.isArray(parsed.groups) ? parsed.groups : undefined,
      }
    } catch {
      this.cache = { users: [], sessions: [] }
    }
    return this.cache
  }

  async save(config: UserConfig): Promise<void> {
    this.cache = config
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(config, null, 2), 'utf-8')
  }
}
