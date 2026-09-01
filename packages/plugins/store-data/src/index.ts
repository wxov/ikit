import { Schema } from 'cordis'
import type { Context } from 'cordis'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { JsonStoreData } from './store.js'
import { createStoreData } from './service.js'

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
  console.log('[store-data] plugin started')
  ctx.on('dispose', () => {
    console.log('[store-data] plugin disposed')
  })
}

export default { name, apply, Config }
export type { Note, CalendarEvent, TodoItem, StoreDataService } from './types.js'
