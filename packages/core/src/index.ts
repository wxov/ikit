import { Context } from 'cordis'
import demoPlugin from '@ikit/plugin-demo'
import knowledgePlugin from '@ikit/plugin-knowledge'
import llmPlugin from '@ikit/plugin-llm'
import agentPlugin from '@ikit/plugin-agent'
import registryPlugin from '@ikit/plugin-registry'
import accountPlugin from '@ikit/plugin-account'
import storeDataPlugin from '@ikit/plugin-store-data'
import type { Config as DemoConfig } from '@ikit/plugin-demo'
import type { Config as KnowledgeConfig } from '@ikit/plugin-knowledge'
import type { Config as LlmConfig } from '@ikit/plugin-llm'
import type { Config as AgentConfig } from '@ikit/plugin-agent'
import type { Config as RegistryConfig } from '@ikit/plugin-registry'
import type { Config as AccountConfig } from '@ikit/plugin-account'
import type { Config as StoreDataConfig } from '@ikit/plugin-store-data'
import type { DemoService } from '@ikit/plugin-demo'
import type {
  EntryVisibility,
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeSearchResult,
  KnowledgeService,
  Viewer,
  VisibilitySyncMode,
} from '@ikit/plugin-knowledge'
import type { ChatMessage, LlmService } from '@ikit/plugin-llm'
import type {
  AgentRunResult,
  AgentService,
  AgentStep,
  AgentTool,
} from '@ikit/plugin-agent'

// 声明 Cordis 服务类型增强
declare module 'cordis' {
  interface Context {
    demo: DemoService
    knowledge: KnowledgeService
    llm: LlmService
    agent: AgentService
    pluginRegistry: import('@ikit/plugin-registry').PluginRegistryService
    account: import('@ikit/plugin-account').AccountService
    storeData: import('@ikit/plugin-store-data').StoreDataService
  }
}

export interface CoreOptions {
  demo?: DemoConfig
  knowledge?: KnowledgeConfig
  llm?: LlmConfig
  agent?: AgentConfig
  registry?: RegistryConfig
  account?: AccountConfig
  storeData?: StoreDataConfig
}

export async function createCore(options: CoreOptions = {}) {
  const ctx = new Context()
  ctx.plugin(llmPlugin, options.llm ?? {})
  ctx.plugin(demoPlugin, options.demo ?? {})
  ctx.plugin(knowledgePlugin, options.knowledge ?? {})
  ctx.plugin(agentPlugin, options.agent ?? {})
  // plugin-registry：注册表，依赖 dataDir 持久化插件配置
  ctx.plugin(registryPlugin, options.registry ?? {})
  // account：账号体系（注册/登录/找回/会话/用户管理）
  ctx.plugin(accountPlugin, options.account ?? {})
  // store-data：商店插件真实数据服务（统计/便签/日程/待办）
  ctx.plugin(storeDataPlugin, options.storeData ?? {})
  await ctx.start()
  return ctx
}

export type {
  ChatMessage,
  KnowledgeEntryInput,
  EntryVisibility,
  Viewer,
  VisibilitySyncMode,
}
