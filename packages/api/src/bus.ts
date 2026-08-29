import type { WebSocket } from 'ws'
import type { Context } from 'cordis'

export interface EventBus {
  clients: Set<WebSocket>
  broadcast(message: unknown): void
  dispose(): void
}

/**
 * 事件桥接：把 Cordis 核心内部事件转发到 WebSocket 客户端。
 * 这是「核心服务 + Web 端连接」链路的实时通道。
 */
export function createBus(ctx: Context): EventBus {
  const clients = new Set<WebSocket>()

  const broadcast = (message: unknown) => {
    const data = JSON.stringify(message)
    for (const client of clients) {
      if (client.readyState === 1 /* OPEN */) client.send(data)
    }
  }

  const onKnowledgeChanged = (payload: unknown) =>
    broadcast({ type: 'knowledge:changed', payload, ts: Date.now() })
  const onDemoGreeted = (payload: unknown) =>
    broadcast({ type: 'demo:greeted', payload, ts: Date.now() })

  const offKnowledge = ctx.on('knowledge:changed', onKnowledgeChanged)
  const offDemo = ctx.on('demo:greeted', onDemoGreeted)

  return {
    clients,
    broadcast,
    dispose() {
      offKnowledge()
      offDemo()
    },
  }
}
