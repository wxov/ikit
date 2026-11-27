// 写操作审计日志（P2-8，2026-11-28）
//
// 目的：对「谁、何时、从哪个 IP、对什么对象、做了什么写操作、是否成功」留痕，便于事后追溯。
// 形态：JSON Lines（每行一条），默认 `./data/audit.jsonl`，可用 AUDIT_LOG_FILE 覆盖；AUDIT_LOG=off 关闭。
// 设计：写入串行化（Promise 链），失败只告警不影响请求；字段做长度裁剪，避免超长内容灌入日志。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('audit')

export interface AuditEvent {
  /** 动作标识，形如 `auth.login` / `knowledge.delete` / `plugin.install` */
  action: string
  ok: boolean
  /** 操作者（用户名或 id） */
  user?: string
  ip?: string
  /** 目标对象（id / 名称） */
  target?: string
  detail?: Record<string, unknown>
}

export interface AuditLog {
  write(event: AuditEvent): void
  /** 等待已入队写入完成（测试/优雅停机用） */
  flush(): Promise<void>
}

const clip = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  return String(v).slice(0, max)
}

export function createAuditLog(options: { file?: string; enabled?: boolean } = {}): AuditLog {
  const enabled = options.enabled ?? process.env.AUDIT_LOG !== 'off'
  const file = options.file ?? process.env.AUDIT_LOG_FILE ?? './data/audit.jsonl'
  let chain: Promise<void> = Promise.resolve()

  return {
    write(event: AuditEvent): void {
      if (!enabled) return
      const record = {
        ts: new Date().toISOString(),
        action: clip(event.action, 80) ?? 'unknown',
        ok: !!event.ok,
        user: clip(event.user, 64),
        ip: clip(event.ip, 64),
        target: clip(event.target, 128),
        detail: event.detail,
      }
      chain = chain.then(async () => {
        try {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf-8')
        } catch (e) {
          log.warn('write failed:', e instanceof Error ? e.message : e)
        }
      })
    },
    flush(): Promise<void> {
      return chain
    },
  }
}
