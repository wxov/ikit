import { Schema } from 'cordis'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events<C extends Context = Context> {
    'demo:greeted'(payload: { name: string; message: string; count: number }): void
  }
}

export const name = 'demo'

export interface Config {
  greeting?: string
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello from i-kit'),
})

export interface DemoService {
  hello(name?: string): string
  readonly greetCount: number
}

export function apply(ctx: Context, config: Config) {
  const greeting = config.greeting ?? 'Hello from i-kit'

  let count = 0
  const service: DemoService = {
    get greetCount() {
      return count
    },
    hello(name = 'world') {
      count++
      const message = `${greeting}, ${name}!`
      ctx.emit('demo:greeted', { name, message, count })
      return message
    },
  }

  ctx.set('demo', service)
  ctx.on('dispose', () => {
    console.log('[demo] plugin disposed')
  })

  console.log(`[demo] plugin started, greeting = "${greeting}"`)
}

export default { name, apply, Config }
