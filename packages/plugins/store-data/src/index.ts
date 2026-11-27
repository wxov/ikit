import { Schema } from 'cordis'
import type { Context } from 'cordis'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { JsonStoreData } from './store.js'
import { createStoreData } from './service.js'
import { createLogger } from '@ikit/shared'

const log = createLogger('store-data')

declare module 'cordis' {
  interface Context {
    storeData: ReturnType<typeof createStoreData>
  }
}

export const name = 'store-data'

export interface Config {
  dataDir?: string
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('./data'),
})

export function apply(ctx: Context, config: Config) {
  const dataDir = config.dataDir || './data'
  mkdirSync(dataDir, { recursive: true })
  const store = new JsonStoreData(path.join(dataDir, 'store-data.json'))
  const service = createStoreData(ctx, store)
  ctx.set('storeData', service)
  log.info('[store-data] plugin started')
  ctx.on('dispose', () => {
    log.info('[store-data] plugin disposed')
  })
}

export default { name, apply, Config }
export type { Note, CalendarEvent, TodoItem, StoreDataService } from './types.js'
