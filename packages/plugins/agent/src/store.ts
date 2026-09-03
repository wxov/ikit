import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentDb } from './types.js'

/** Agent 会话存储抽象（当前为 JSON 文件） */
export interface AgentStore {
  load(): Promise<AgentDb>
  save(db: AgentDb): Promise<void>
}

export class JsonAgentStore implements AgentStore {
  private cache: AgentDb | null = null
  constructor(private readonly file: string) {}

  async load(): Promise<AgentDb> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as AgentDb
      this.cache = {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      }
    } catch {
      this.cache = { sessions: [], messages: [], nodes: [], tasks: [] }
    }
    return this.cache
  }

  async save(db: AgentDb): Promise<void> {
    this.cache = db
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(db, null, 2), 'utf-8')
  }
}
