import path from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { Schema } from 'cordis'
import type { Context } from 'cordis'
import type { LlmService } from '@ikit/plugin-llm'
import type { KnowledgeDb, KnowledgeEntry } from './types.js'
import { JsonStore, SqliteStore, type KnowledgeStore } from './store.js'
import {
  createKnowledgeService,
  type DraftVisibility,
  type EmbedFn,
} from './service.js'
import { DRAFT_PUBLISH_CUTOFF, migrateLegacyDrafts } from './migrate.js'

declare module 'cordis' {
  interface Events<C extends Context = Context> {
    'knowledge:changed'(payload: {
      action: 'create' | 'update' | 'remove' | 'comment' | 'comment-removed'
      entry?: KnowledgeEntry
      entryId?: string
      comment?: unknown
      id?: string
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
  /**
   * 草稿可见性（完善⑦ · 方案 X）：`admin-only`（默认，草稿仅站主可见）
   * / `everyone`（回滚为历史行为：草稿全员可见）。env `KB_DRAFT_VISIBILITY` 优先。
   */
  draftVisibility?: DraftVisibility
  /**
   * 存量草稿一次性迁移：`publish`（默认，把上线前的 draft 改判为 published）
   * / `off`（跳过，且不写幂等标记）。env `KB_MIGRATE_DRAFT_STATUS` 优先。
   */
  migrateDrafts?: 'publish' | 'off'
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  filename: Schema.string().default('knowledge.json'),
  storage: Schema.union(['json', 'sqlite']).default('json'),
  dbPath: Schema.string().default('knowledge.db'),
  draftVisibility: Schema.union(['admin-only', 'everyone']).default('admin-only'),
  migrateDrafts: Schema.union(['publish', 'off']).default('publish'),
})

export async function apply(ctx: Context, config: Config) {
  const dataDir = config.dataDir ?? './data'
  mkdirSync(dataDir, { recursive: true })
  const filename = config.filename ?? 'knowledge.json'
  const storage = config.storage ?? 'json'

  // env 优先于 Config（范式同 plugin-registry/src/index.ts）
  const envDraftVisibility = process.env.KB_DRAFT_VISIBILITY
  const draftVisibility: DraftVisibility =
    envDraftVisibility === 'everyone' || envDraftVisibility === 'admin-only'
      ? envDraftVisibility
      : (config.draftVisibility ?? 'admin-only')
  const envMigrate = process.env.KB_MIGRATE_DRAFT_STATUS
  const migrateDrafts: 'publish' | 'off' =
    envMigrate === 'off' || envMigrate === 'publish'
      ? envMigrate
      : (config.migrateDrafts ?? 'publish')

  const llm = (ctx as Context & { llm?: LlmService }).llm
  const embed: EmbedFn | undefined = llm?.embeddingEnabled
    ? (texts) => llm.embed(texts)
    : undefined

  const jsonFile = path.resolve(dataDir, filename)
  let store: KnowledgeStore
  let storageLabel: string
  let storageFile: string

  if (storage === 'sqlite') {
    const dbFile = path.resolve(dataDir, config.dbPath ?? 'knowledge.db')
    const sqlite = new SqliteStore(dbFile)
    // 自动迁移：SQLite 为空且 JSON 有数据时，从 JSON 迁移
    migrateFromJson(sqlite, jsonFile)
    store = sqlite
    storageFile = dbFile
    storageLabel = `sqlite:${dbFile}`
  } else {
    store = new JsonStore(jsonFile, { entries: [], categories: [], comments: [] })
    storageFile = jsonFile
    storageLabel = `json:${jsonFile}`
  }

  // 存量草稿一次性迁移（幂等 + 截止时间 + 写前备份；只作用于本实例的数据目录）
  const migration = await migrateLegacyDrafts(store, {
    file: storageFile,
    cutoff: DRAFT_PUBLISH_CUTOFF,
    enabled: migrateDrafts !== 'off',
  })
  if (migration.ran) {
    console.log(
      `[knowledge] draft-publish migration: drafts=${migration.drafts} published=${migration.drafts} skipped=0 backup=${migration.backup ?? '<none>'} v1`,
    )
  } else if (migration.reason && migration.reason !== 'already-migrated' && migration.reason !== 'disabled') {
    console.warn(`[knowledge] draft-publish migration skipped: ${migration.reason}`)
  }

  const service = createKnowledgeService(ctx, store, embed, { draftVisibility })

  ctx.set('knowledge', service)
  ctx.on('dispose', () => {
    if (store instanceof SqliteStore) store.close()
    console.log('[knowledge] plugin disposed')
  })

  console.log(
    `[knowledge] plugin started, storage = "${storageLabel}", vector = ${embed ? 'on' : 'off'}, draftVisibility = ${draftVisibility}, migratedDrafts = ${migration.ran ? `publish(${migration.drafts})` : migrateDrafts === 'off' ? 'off' : 'skip'}`,
  )
}

/** 从 JSON 文件迁移到 SQLite（仅当 SQLite 为空时） */
function migrateFromJson(sqlite: SqliteStore, jsonFile: string) {
  try {
    if (!sqlite.isEmpty()) return
    const raw = readFileSync(jsonFile, 'utf-8')
    const data = JSON.parse(raw) as KnowledgeDb
    if (!data.entries?.length && !data.categories?.length) return
    sqlite.importData({
      entries: data.entries ?? [],
      categories: data.categories ?? [],
      comments: data.comments ?? [],
      // 透传 meta：否则「JSON 迁移过 + SQLite 空库」的实例切换存储后会重跑迁移
      meta: data.meta ?? {},
    })
    console.log(`[knowledge] 已从 JSON 迁移 ${data.entries?.length ?? 0} 条到 SQLite`)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn('[knowledge] JSON 迁移失败:', e instanceof Error ? e.message : e)
    }
  }
}

export default { name, inject, apply, Config }
export * from './types.js'
export {
  DRAFT_PUBLISH_CUTOFF,
  DRAFT_PUBLISH_MARKER,
  migrateLegacyDrafts,
  type MigrateDraftOptions,
  type MigrateDraftResult,
} from './migrate.js'
export { isPublished, type DraftVisibility } from './service.js'
