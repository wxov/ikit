// 商店插件数据服务类型
export interface Note {
  id: string
  text: string
  createdAt: string
  updatedAt: string
}

export interface CalendarEvent {
  id: string
  title: string
  date: string
  time?: string
  done: boolean
  createdAt: string
}

export interface TodoItem {
  id: string
  text: string
  done: boolean
  createdAt: string
}

export interface StatEntry {
  label: string
  value: number
}

export interface WeatherInfo {
  city: string
  temperature: number
  condition: string
  humidity: number
  windSpeed: number
}

export interface RssItem {
  title: string
  link: string
  pubDate?: string
}

export interface MdDraft {
  id: string
  text: string
  createdAt: string
  updatedAt: string
}

export interface StoreDataService {
  // 统计（聚合真实数据）
  statistics(): Promise<StatEntry[]>
  // 便签 CRUD
  listNotes(): Promise<Note[]>
  addNote(text: string): Promise<Note[]>
  deleteNote(id: string): Promise<Note[]>
  // 日程 CRUD
  listEvents(): Promise<CalendarEvent[]>
  addEvent(input: { title: string; date: string; time?: string }): Promise<CalendarEvent[]>
  deleteEvent(id: string): Promise<CalendarEvent[]>
  toggleEvent(id: string): Promise<CalendarEvent[]>
  // 待办 CRUD
  listTodos(): Promise<TodoItem[]>
  addTodo(text: string): Promise<TodoItem[]>
  toggleTodo(id: string): Promise<TodoItem[]>
  deleteTodo(id: string): Promise<TodoItem[]>
  // 天气（经 open-meteo，无需 key；失败降级）
  weather(city: string): Promise<WeatherInfo>
  // RSS 抓取解析
  rss(url: string): Promise<RssItem[]>
  // Markdown 剪贴板草稿
  listMd(): Promise<MdDraft[]>
  saveMd(text: string): Promise<MdDraft[]>
  deleteMd(id: string): Promise<MdDraft[]>
}
