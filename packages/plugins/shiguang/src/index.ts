// 拾光（日记 · 感悟 · 名言）：默认内置插件，带开门密码
import path from 'node:path'
import { Schema } from 'cordis'
import type { Context } from 'cordis'
import { JsonShiguangStore } from './store.js'
import { createShiguangService } from './service.js'
import type { ShiguangService } from './types.js'
import { createLogger } from '@ikit/shared'

const log = createLogger('shiguang')

export const name = 'shiguang'

export interface Config {
  /** 数据目录（与知识库/账号等共用 ./data） */
  dataDir?: string
  /** 数据文件（留空 = <dataDir>/shiguang.json） */
  dataFile?: string
  /** 解锁令牌有效期（毫秒，默认 30 分钟） */
  tokenTtlMs?: number
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
  dataFile: Schema.string().default(''),
  tokenTtlMs: Schema.number().default(30 * 60_000),
})

export function apply(ctx: Context, config: Config) {
  const dataFile = config.dataFile || path.join(config.dataDir ?? './data', 'shiguang.json')
  const store = new JsonShiguangStore(dataFile)
  const service = createShiguangService(store, { tokenTtlMs: config.tokenTtlMs })
  ctx.set('shiguang', service)
  log.info(`[shiguang] plugin started (file=${dataFile})`)
  ctx.on('dispose', () => {
    log.info('[shiguang] plugin disposed')
  })
}

export default { name, apply, Config }
export type {
  ShiguangEntry,
  ShiguangEntryInput,
  ShiguangEntryType,
  ShiguangService,
  ShiguangSetPasscodeInput,
  ShiguangStatus,
  ShiguangUnlockResult,
} from './types.js'
export { ShiguangError } from './types.js'
