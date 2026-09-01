// 商店插件数据存储（JSON 文件）
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Note, CalendarEvent, TodoItem, MdDraft } from './types.js'

export interface StoreData {
  notes: Note[]
  events: CalendarEvent[]
  todos: TodoItem[]
  md: MdDraft[]
}

export class JsonStoreData implements StoreDataPersist {
  private cache: StoreData | null = null
  constructor(private readonly file: string) {}

  async load(): Promise<StoreData> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const p = JSON.parse(raw) as StoreData
      this.cache = {
        notes: Array.isArray(p.notes) ? p.notes : [],
        events: Array.isArray(p.events) ? p.events : [],
        todos: Array.isArray(p.todos) ? p.todos : [],
        md: Array.isArray(p.md) ? p.md : [],
      }
    } catch {
      this.cache = { notes: [], events: [], todos: [], md: [] }
    }
    return this.cache
  }

  async save(data: StoreData): Promise<void> {
    this.cache = data
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), 'utf-8')
  }
}

export interface StoreDataPersist {
  load(): Promise<StoreData>
  save(data: StoreData): Promise<void>
}
