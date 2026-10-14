/** 文章可见性级别 */
export type EntryVisibility = 'public' | 'login' | 'groups' | 'private'

/** 当前访问者权限上下文（由 API 层解析后传入） */
export interface Viewer {
  /** 用户所属组 id 集合（未登录为 ['guest']；admin 为 ['admin']） */
  groups: string[]
  /** 是否站主（恒可访问全部） */
  isAdmin: boolean
}

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  tags: string[]
  /** 分类路径，如 "技术/前端"，可选 */
  category?: string
  /** 父文档 id（用于文档树层级，根文档为空） */
  parentId?: string
  /** 同级排序序号（越小越靠前） */
  sortOrder?: number
  /** 置顶/收藏标记 */
  pinned?: boolean
  /**
   * 发布态：`draft`（草稿，**仅站主可见**，见 `KB_DRAFT_VISIBILITY`）/ `published`（已发布）/
   * `archived`（历史值，当前无写入入口，PATCH/POST 显式拒绝）。
   * **缺省/`undefined`/`NULL` 一律视为 `published`**（存量数据兼容，不因发布态过滤而消失）。
   */
  status?: 'draft' | 'published' | 'archived'
  /** 访问/浏览量 */
  views?: number
  /** 封面图 URL（可选；未设置时前端用正文首图或渐变兜底） */
  cover?: string
  /** 文章可见性：public=公开 / login=仅登录 / groups=指定组 / private=仅站主；缺省视为 public */
  visibility?: EntryVisibility
  /** visibility='groups' 时的可见组 id 列表 */
  visibleGroups?: string[]
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
  parentId?: string
  cover?: string
  visibility?: EntryVisibility
  visibleGroups?: string[]
  /**
   * 发布态（仅创建/更新路径使用）：缺省时由**调用方**决定默认值——
   * `create()` = `draft`（交互式新建走草稿流）、`importMany()` = `published`（导入即可见）。
   * `'archived'` 不在白名单内，由 API 路由拒绝（400）。
   */
  status?: 'draft' | 'published'
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry
  score: number
}

export interface KnowledgeDb {
  entries: KnowledgeEntry[]
  /** 分类路径列表（树状层级用 "/" 分隔） */
  categories: string[]
  /** 评论列表（可选，兼容旧库） */
  comments?: KnowledgeComment[]
  /**
   * 元信息键值（JSON 直接作为普通键；SQLite 为 `meta(key,value)` 表）。
   * 当前用于数据迁移标记（如 `draftPublishV1`）；旧库缺省为 `undefined`，使用时初始化。
   */
  meta?: Record<string, string>
}

/** 文章评论 */
export interface KnowledgeComment {
  id: string
  entryId: string
  author: string
  content: string
  /** 回复哪条评论（可选，用于楼中楼） */
  parentId?: string
  likes?: number
  createdAt: string
}

export interface CommentInput {
  content: string
  parentId?: string
}

/** 分类树节点 */
export interface CategoryNode {
  name: string
  path: string
  count: number
  children: CategoryNode[]
}

/** 目录「权限设置」的子文件同步策略 */
export type VisibilitySyncMode = 'self' | 'same' | 'all'

export interface KnowledgeService {
  create(input: KnowledgeEntryInput): Promise<KnowledgeEntry>
  /**
   * 批量导入条目（站主）：与 create 行为一致（分类补全 / sortOrder / 向量化 / knowledge:changed 广播），
   * 跳过标题为空的条目；返回实际创建数量与条目列表。
   * **默认发布态为 `published`**（导入即可见）；条目显式传 `status` 时以显式值为准。
   */
  importMany(items: KnowledgeEntryInput[]): Promise<{ created: number; entries: KnowledgeEntry[] }>
  list(options?: { limit?: number; offset?: number }, viewer?: Viewer): Promise<KnowledgeEntry[]>
  /**
   * 更新条目（站主）。`opts.skipEmbedding = true`（自动保存路径）跳过 embedding 向量化，
   * 避免 2s 一次的外部 API 调用；发布/撤回与手动保存不传，向量化照常。
   */
  update(
    id: string,
    patch: Partial<KnowledgeEntryInput>,
    opts?: { skipEmbedding?: boolean },
  ): Promise<KnowledgeEntry | undefined>
  moveDoc(id: string, parentId: string | undefined | null): Promise<KnowledgeEntry | undefined>
  reorder(parentId: string | undefined | null, orderedIds: string[]): Promise<{ updated: number }>
  remove(id: string): Promise<boolean>
  togglePin(id: string): Promise<KnowledgeEntry | undefined>
  view(id: string, viewer?: Viewer): Promise<KnowledgeEntry | undefined>
  listTrash(): Promise<KnowledgeEntry[]>
  restore(id: string): Promise<boolean>
  purge(id: string): Promise<boolean>
  emptyTrash(): Promise<number>
  search(query: string, viewer?: Viewer): Promise<KnowledgeSearchResult[]>
  count(): Promise<number>
  getCategories(viewer?: Viewer): Promise<CategoryNode[]>
  addCategory(path: string): Promise<CategoryNode[]>
  bulkSetCategory(ids: string[], category: string | undefined): Promise<{ updated: number }>
  /** 设置单篇文章可见性，并按 syncMode 同步子文档 */
  setVisibility(id: string, visibility: EntryVisibility, visibleGroups: string[] | undefined, syncMode?: VisibilitySyncMode): Promise<{ updated: number }>
  /** 批量设置可见性 */
  bulkSetVisibility(ids: string[], visibility: EntryVisibility, visibleGroups: string[] | undefined): Promise<{ updated: number }>
  listComments(entryId: string, viewer?: Viewer): Promise<KnowledgeComment[]>
  addComment(entryId: string, input: CommentInput, author: string, viewer?: Viewer): Promise<KnowledgeComment>
  removeComment(id: string, isAdmin: boolean, author: string): Promise<boolean>
  listAllComments(viewer?: Viewer): Promise<KnowledgeComment[]>
}
