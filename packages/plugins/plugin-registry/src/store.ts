// 插件注册表存储：JSON 文件持久化
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PluginConfig, PluginRecord } from './types.js'

export interface PluginStore {
  load(): Promise<PluginConfig>
  save(config: PluginConfig): Promise<void>
}

export class JsonPluginStore implements PluginStore {
  private cache: PluginConfig | null = null
  constructor(private readonly file: string) {}

  async load(): Promise<PluginConfig> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as PluginConfig
      this.cache = {
        plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
        reviews: parsed.reviews ?? {},
      }
    } catch {
      this.cache = { plugins: [], reviews: {} }
    }
    return this.cache
  }

  async save(config: PluginConfig): Promise<void> {
    this.cache = config
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(config, null, 2), 'utf-8')
  }
}
