// 商店插件数据服务
import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type { Note, CalendarEvent, TodoItem, MdDraft, RssItem, StatEntry, StoreDataService } from './types.js'
import type { JsonStoreData } from './store.js'

export function createStoreData(ctx: Context, store: JsonStoreData): StoreDataService {
  let loaded = false
  let data: { notes: Note[]; events: CalendarEvent[]; todos: TodoItem[]; md: MdDraft[] } = {
    notes: [],
    events: [],
    todos: [],
    md: [],
  }

  const ensureLoaded = async () => {
    if (loaded) return
    data = await store.load()
    loaded = true
  }
  const persist = async () => {
    await store.save(data)
  }
  void ensureLoaded()

  return {
    async statistics() {
      const kbCount = (ctx as any).knowledge?.count ? await (ctx as any).knowledge.count() : 0
      const pluginCount = ((ctx as any).pluginRegistry?.list?.().length) ?? 0
      const stats: StatEntry[] = [
        { label: '知识库条目', value: kbCount },
        { label: '已装插件', value: pluginCount },
        { label: '便签数', value: data.notes.length },
        { label: '日程数', value: data.events.length },
        { label: '待办数', value: data.todos.length },
      ]
      return stats
    },

    async listNotes() {
      await ensureLoaded()
      return data.notes
    },
    async addNote(text) {
      await ensureLoaded()
      const now = new Date().toISOString()
      data.notes.unshift({ id: randomUUID(), text: text.trim(), createdAt: now, updatedAt: now })
      await persist()
      return data.notes
    },
    async deleteNote(id) {
      await ensureLoaded()
      data.notes = data.notes.filter((n) => n.id !== id)
      await persist()
      return data.notes
    },

    async listEvents() {
      await ensureLoaded()
      return data.events
    },
    async addEvent(input) {
      await ensureLoaded()
      data.events.push({
        id: randomUUID(),
        title: input.title.trim(),
        date: input.date || '',
        time: input.time || '',
        done: false,
        createdAt: new Date().toISOString(),
      })
      await persist()
      return data.events
    },
    async deleteEvent(id) {
      await ensureLoaded()
      data.events = data.events.filter((e) => e.id !== id)
      await persist()
      return data.events
    },
    async toggleEvent(id) {
      await ensureLoaded()
      const e = data.events.find((x) => x.id === id)
      if (e) e.done = !e.done
      await persist()
      return data.events
    },

    async listTodos() {
      await ensureLoaded()
      return data.todos
    },
    async addTodo(text) {
      await ensureLoaded()
      data.todos.unshift({ id: randomUUID(), text: text.trim(), done: false, createdAt: new Date().toISOString() })
      await persist()
      return data.todos
    },
    async toggleTodo(id) {
      await ensureLoaded()
      const t = data.todos.find((x) => x.id === id)
      if (t) t.done = !t.done
      await persist()
      return data.todos
    },
    async deleteTodo(id) {
      await ensureLoaded()
      data.todos = data.todos.filter((x) => x.id !== id)
      await persist()
      return data.todos
    },

    // 天气：open-meteo 免费接口（无需 key），失败降级返回默认
    async weather(city) {
      try {
        // 城市名 → 经纬度（open-meteo geocoding）
        const geo: any = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
        ).then((r) => r.json())
        const loc = geo?.results?.[0]
        if (!loc) return { city, temperature: 0, condition: '未知', humidity: 0, windSpeed: 0 }
        const wx: any = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`,
        ).then((r) => r.json())
        const cw = wx?.current_weather ?? {}
        return {
          city: loc.name || city,
          temperature: cw.temperature ?? 0,
          condition: weatherCode(cw.weathercode),
          humidity: wx?.current?.relative_humidity_2m ?? 0,
          windSpeed: cw.windspeed ?? 0,
        }
      } catch {
        return { city, temperature: 0, condition: '获取失败', humidity: 0, windSpeed: 0 }
      }
    },

    // RSS：抓取并提取 <title>/<link>
    async rss(url) {
      try {
        const html = await fetch(url, { headers: { 'user-agent': 'i-kit-rss/1.0' } }).then((r) => r.text())
        const items: RssItem[] = []
        const re = /<item[^>]*>([\s\S]*?)<\/item>/gi
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && items.length < 20) {
          const body = m[1]
          const title = /<title>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() || ''
          const link = /<link>([\s\S]*?)<\/link>/i.exec(body)?.[1]?.trim() || ''
          const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(body)?.[1]?.trim() || ''
          if (title || link) items.push({ title: decodeEntities(title), link: decodeEntities(link), pubDate })
        }
        return items
      } catch {
        return []
      }
    },

    // Markdown 剪贴板草稿
    async listMd() {
      await ensureLoaded()
      return data.md
    },
    async saveMd(text) {
      await ensureLoaded()
      const now = new Date().toISOString()
      data.md.unshift({ id: randomUUID(), text: text, createdAt: now, updatedAt: now })
      await persist()
      return data.md
    },
    async deleteMd(id) {
      await ensureLoaded()
      data.md = data.md.filter((x) => x.id !== id)
      await persist()
      return data.md
    },
  }
}

// 天气 code → 中文描述
function weatherCode(code: number | undefined): string {
  const map: Record<number, string> = {
    0: '晴天', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '小雨', 55: '中雨', 61: '小雨', 63: '中雨', 65: '大雨',
    71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 95: '雷雨',
  }
  return map[code ?? -1] ?? '多云'
}

// 简单实体解码 + 去 CDATA
function decodeEntities(s: string): string {
  if (!s) return s
  const map: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#8203;': '' }
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;|&lt;|&gt;|&quot;|&apos;|&#8203;/g, (mm) => map[mm] ?? mm)
    .replace(/<[^>]+>/g, '')
    .trim()
}
