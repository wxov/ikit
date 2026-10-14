import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { KnowledgeStore } from './store.js'

/**
 * 存量草稿一次性发布迁移（完善⑦）。
 *
 * 背景：本功能上线前，`create()`/`importMany()` 写的条目一律是 `status='draft'`（历史实现里
 * `status` 只有 `create` 一处写入点）。上线「草稿仅站主可见」（方案 X）后，这些历史条目会对
 * 游客集体消失，与用户预期不符 → 故把这些**历史遗留草稿**一次性改判为 `published`。
 *
 * 四重护栏：
 * 1. **截止时间常量**（`DRAFT_PUBLISH_CUTOFF`）：只迁移 `createdAt < cutoff` 的条目，
 *    即使幂等标记丢失导致重跑，也**永远不会**把上线后新产生的真实草稿发布出去。
 * 2. **幂等标记**（`db.meta.draftPublishV1`）：与数据同库，跑过一次即跳过（启动开销 = 一次 meta 读）。
 * 3. **写前自动备份**：复制存储文件到同目录 `<file>.bak-<yyyyMMddTHHmmss>`，失败则中止迁移。
 * 4. **开关**：`KB_MIGRATE_DRAFT_STATUS=off` / Config `migrateDrafts:'off'` → 跳过（**不写标记**，
 *    便于日后手动开启）。
 */

/**
 * 草稿改判的截止时间：**本功能上线时刻**。
 * 语义 = 「在此时间之前创建的 `draft` 视为历史遗留数据」。
 *
 * ⚠️ **发布前必须由发布者确认/校正**：该值一旦改变，等价于数据迁移范围变更，需评审
 * （改小 → 部分历史草稿仍对游客不可见；改大 → 可能误伤上线后新产生的真实草稿，见方案 R10）。
 */
export const DRAFT_PUBLISH_CUTOFF = '2026-10-14T05:29:24.000Z'

/** 幂等标记键（写在 `KnowledgeDb.meta`，随存储文件一起备份/回滚） */
export const DRAFT_PUBLISH_MARKER = 'draftPublishV1'

export interface MigrateDraftOptions {
  /** 存储文件绝对路径（用于写前备份；文件不存在则跳过备份） */
  file: string
  /** 截止时间（ISO 字符串），默认 `DRAFT_PUBLISH_CUTOFF` */
  cutoff?: string
  /** 是否启用；false → 直接跳过且不写标记 */
  enabled?: boolean
  /** 注入时钟（测试用） */
  now?: () => Date
}

export interface MigrateDraftResult {
  /** 本次是否真正执行了迁移逻辑（未启用 / 已迁移过 → false） */
  ran: boolean
  /** 被改判为 published 的条目数 */
  drafts: number
  /** 备份文件绝对路径（未备份时 undefined） */
  backup?: string
  /** 跳过原因（未启用 / 已迁移 / 备份失败），仅用于日志 */
  reason?: string
}

/** 备份文件名时间戳：yyyyMMddTHHmmss（UTC） */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('Z', '')
}

/**
 * 执行（幂等）存量草稿迁移。**只作用于传入 store 所指向的目标数据目录**。
 * 返回统计信息；调用方负责打印日志。
 */
export async function migrateLegacyDrafts(
  store: KnowledgeStore,
  options: MigrateDraftOptions,
): Promise<MigrateDraftResult> {
  if (options.enabled === false) {
    return { ran: false, drafts: 0, reason: 'disabled' }
  }

  const now = options.now?.() ?? new Date()
  const cutoff = options.cutoff ?? DRAFT_PUBLISH_CUTOFF
  const db = await store.load()
  const meta = (db.meta ??= {})

  // 幂等：标记存在 → 不查不强改数据
  if (meta[DRAFT_PUBLISH_MARKER]) {
    return { ran: false, drafts: 0, reason: 'already-migrated' }
  }

  // 只处理未删除、显式 draft、且创建于截止时间之前的条目
  const targets = db.entries.filter(
    (e) => !e.deletedAt && e.status === 'draft' && e.createdAt < cutoff,
  )

  // 写前备份（文件不存在则跳过，例如首次启动的空库）
  let backup: string | undefined
  let fileExists = true
  try {
    await fs.access(options.file)
  } catch {
    fileExists = false
  }
  if (fileExists) {
    try {
      const backupFile = path.join(
        path.dirname(options.file),
        `${path.basename(options.file)}.bak-${stamp(now)}`,
      )
      await fs.copyFile(options.file, backupFile)
      backup = backupFile
    } catch (e) {
      // 备份失败 → 中止迁移（不冒险改数据）
      console.warn(
        '[knowledge] draft-publish migration aborted (backup failed):',
        e instanceof Error ? e.message : e,
      )
      return { ran: false, drafts: 0, reason: 'backup-failed' }
    }
  } else if (targets.length) {
    // 有改判目标却找不到存储文件 → 不冒险写（正常流程不会出现）
    return { ran: false, drafts: 0, reason: 'backup-missing' }
  }

  for (const entry of targets) {
    entry.status = 'published'
  }
  meta[DRAFT_PUBLISH_MARKER] = now.toISOString()

  await store.save()

  return { ran: true, drafts: targets.length, backup }
}
