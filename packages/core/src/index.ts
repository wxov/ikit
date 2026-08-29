import { Context } from 'cordis'
import demoPlugin from '@ikit/plugin-demo'
import knowledgePlugin from '@ikit/plugin-knowledge'
import llmPlugin from '@ikit/plugin-llm'
import agentPlugin from '@ikit/plugin-agent'
import type { Config as DemoConfig } from '@ikit/plugin-demo'
import type { Config as KnowledgeConfig } from '@ikit/plugin-knowledge'
import type { Config as LlmConfig } from '@ikit/plugin-llm'
import type { Config as AgentConfig } from '@ikit/plugin-agent'
import type { DemoService } from '@ikit/plugin-demo'
import type {
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeSearchResult,
  KnowledgeService,
} from '@ikit/plugin-knowledge'
import type { ChatMessage, LlmService } from '@ikit/plugin-llm'
import type {
  AgentRunResult,
  AgentService,
  AgentStep,
  AgentTool,
} from '@ikit/plugin-agent'

// 声明 Cordis 服务类型增强：让 ctx.demo / ctx.knowledge / ctx.llm / ctx.agent 有完整类型提示
declare module 'cordis' {
  interface Context {
    demo: DemoService
    knowledge: KnowledgeService
    llm: LlmService
    agent: AgentService
  }
}

export interface CoreOptions {
  demo?: DemoConfig
  knowledge?: KnowledgeConfig
  llm?: LlmConfig
  agent?: AgentConfig
}

export async function createCore(options: CoreOptions = {}) {
  const ctx = new Context()
  ctx.plugin(llmPlugin, options.llm ?? {})
  ctx.plugin(demoPlugin, options.demo ?? {})
  ctx.plugin(knowledgePlugin, options.knowledge ?? {})
  ctx.plugin(agentPlugin, options.agent ?? {})
  await ctx.start()
  return ctx
}

export type {
  DemoService,
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeSearchResult,
  KnowledgeService,
  ChatMessage,
  LlmService,
  AgentRunResult,
  AgentService,
  AgentStep,
  AgentTool,
}
