import path from 'node:path'
import { readFileSync } from 'node:fs'
import { Schema } from 'cordis'
import type { Context } from 'cordis'
import type { LlmService } from '@ikit/plugin-llm'
import type { KnowledgeDb, KnowledgeEntry } from './types.js'
import { JsonStore, SqliteStore, type KnowledgeStore } from './store.js'
import { createKnowledgeService, type EmbedFn } from './service.js'

declare module 'cordis' {
  interface Events<C extends Context = Context> {
    'knowledge:changed'(payload: {
      action: 'create' | 'update' | 'remove'
      entry: KnowledgeEntry
    }): void
  }
}

export const name = 'knowledge'

// 可选依赖 llm：配置了 embedding 时启用向量检索，否则退化为纯关键词检索
export const inject = { llm: { required: false } }

export interface Config {
  dataDir?: string
  filename?: string
  /** 存储后端：json（默认，中小数据量）/ sqlite（大数据量） */
  storage?: 'json' | 'sqlite'
  dbPath?: string
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  filename: Schema.string().default('knowledge.json'),
  storage: Schema.union(['json', 'sqlite']).default('json'),
  dbPath: Schema.string().default('knowledge.db'),
})

export function apply(ctx: Context, config: Config) {
  const dataDir = config.dataDir ?? './data'
  const filename = config.filename ?? 'knowledge.json'
  const storage = config.storage ?? 'json'

  const llm = (ctx as Context & { llm?: LlmService }).llm
  const embed: EmbedFn | undefined = llm?.embeddingEnabled
    ? (texts) => llm.embed(texts)
    : undefined

  const jsonFile = path.resolve(dataDir, filename)
  let store: KnowledgeStore
  let storageLabel: string

  if (storage === 'sqlite') {
    const dbFile = path.resolve(dataDir, config.dbPath ?? 'knowledge.db')
    const sqlite = new SqliteStore(dbFile)
    // 自动迁移：SQLite 为空且 JSON 有数据时，从 JSON 迁移
    migrateFromJson(sqlite, jsonFile)
    store = sqlite
    storageLabel = `sqlite:${dbFile}`
  } else {
    store = new JsonStore(jsonFile, { entries: [], categories: [] })
    storageLabel = `json:${jsonFile}`
  }

  const service = createKnowledgeService(ctx, store, embed)

  ctx.set('knowledge', service)
  ctx.on('dispose', () => {
    if (store instanceof SqliteStore) store.close()
    console.log('[knowledge] plugin disposed')
  })

  console.log(
    `[knowledge] plugin started, storage = "${storageLabel}", vector = ${embed ? 'on' : 'off'}`,
  )
}

/** 从 JSON 文件迁移到 SQLite（仅当 SQLite 为空时） */
function migrateFromJson(sqlite: SqliteStore, jsonFile: string) {
  try {
    if (!sqlite.isEmpty()) return
    const raw = readFileSync(jsonFile, 'utf-8')
    const data = JSON.parse(raw) as KnowledgeDb
    if (!data.entries?.length && !data.categories?.length) return
    sqlite.importData({ entries: data.entries ?? [], categories: data.categories ?? [] })
    console.log(`[knowledge] 已从 JSON 迁移 ${data.entries?.length ?? 0} 条到 SQLite`)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn('[knowledge] JSON 迁移失败:', e instanceof Error ? e.message : e)
    }
  }
}

export default { name, inject, apply, Config }
export * from './types.js'
