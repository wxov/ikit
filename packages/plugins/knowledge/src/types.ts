/** 版本历史记录 */
export interface EntryVersion {
  version: number
  title: string
  content: string
  updatedAt: string
}

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  tags: string[]
  /** 分类路径，如 "技术/前端"，可选 */
  category?: string
  /** 置顶/收藏标记 */
  pinned?: boolean
  /** 文档状态：草稿 / 已发布 / 已归档 */
  status?: 'draft' | 'published' | 'archived'
  /** 版本历史（旧版本，最新的在前） */
  history?: EntryVersion[]
  /** AI 生成的摘要 */
  summary?: string
  /** 星级评分（1-5） */
  rating?: number
  /** 点赞数 */
  likes?: number
  /** 外部分享令牌 */
  shareToken?: string
  /** 软删除标记（回收站） */
  deletedAt?: string
  createdAt: string
  updatedAt: string
  /** 可选的文本向量（embedding），用于向量检索 */
  embedding?: number[]
}

export interface KnowledgeEntryInput {
  title: string
  content: string
  tags?: string[]
  category?: string
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry
  score: number
}

export interface KnowledgeDb {
  entries: KnowledgeEntry[]
  /** 分类路径列表（树状层级用 "/" 分隔） */
  categories: string[]
}

/** 分类树节点 */
export interface CategoryNode {
  name: string
  path: string
  count: number
  children: CategoryNode[]
}

export interface KnowledgeService {
  create(input: KnowledgeEntryInput): Promise<KnowledgeEntry>
  importMany(items: KnowledgeEntryInput[]): Promise<{ created: number; entries: KnowledgeEntry[] }>
  list(options?: { limit?: number; offset?: number }): Promise<KnowledgeEntry[]>
  get(id: string): Promise<KnowledgeEntry | undefined>
  update(id: string, patch: Partial<KnowledgeEntryInput>): Promise<KnowledgeEntry | undefined>
  remove(id: string): Promise<boolean>
  togglePin(id: string): Promise<KnowledgeEntry | undefined>
  setStatus(id: string, status: 'draft' | 'published' | 'archived'): Promise<KnowledgeEntry | undefined>
  restoreVersion(id: string, version: number): Promise<KnowledgeEntry | undefined>
  generateSummary(id: string): Promise<KnowledgeEntry | undefined>
  rate(id: string, rating: number): Promise<KnowledgeEntry | undefined>
  like(id: string): Promise<KnowledgeEntry | undefined>
  generateShareLink(id: string): Promise<KnowledgeEntry | undefined>
  getByShareToken(token: string): Promise<KnowledgeEntry | undefined>
  listTrash(): Promise<KnowledgeEntry[]>
  restore(id: string): Promise<boolean>
  purge(id: string): Promise<boolean>
  emptyTrash(): Promise<number>
  search(query: string): Promise<KnowledgeSearchResult[]>
  count(): Promise<number>
  getCategories(): Promise<CategoryNode[]>
  addCategory(path: string): Promise<CategoryNode[]>
  removeCategory(path: string): Promise<CategoryNode[]>
  renameCategory(oldPath: string, newPath: string): Promise<CategoryNode[]>
  bulkSetCategory(ids: string[], category: string | undefined): Promise<{ updated: number }>
}
