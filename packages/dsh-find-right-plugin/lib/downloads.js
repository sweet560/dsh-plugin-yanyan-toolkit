/**
 * 30 天下载量与涨跌趋势（npm downloads API，只读）。
 *
 * 为什么独立成模块：对比表里的「★star / 30天下载」是**原始人气数据**，
 * 和四维评分里的「热度」（0.6~1.3 的对数有界乘子）是两回事。这里只负责
 * 取数与算趋势，绝不参与排序或打分，避免把下载量偷偷变成第二个 star 权重。
 *
 * 数据：https://api.npmjs.org/downloads/range/last-month/<name> 返回近 30 天
 * 每日明细 `{ downloads:[{downloads, day}, …] }`。实测 scoped 包 @scope/name
 * 需要把 `%40` 还原成 `@` 才能命中（其余 `/` 保持 %2F）。包不存在返回 404。
 *
 * 接口刻意与 npm 核验对齐：都吃候选的 item，都用 guessNpmName() 推导包名，
 * 因此两者可以在 runSearch 里并发跑、互不依赖，不给冷启动增加串行等待。
 *
 * 严格预算：只对主推 + 少量备选（≤6 行）查，并发受限、单请求硬超时、
 * 整体硬上限；失败一律「未知(null)」而不是编一个 0，渲染层据此显示「—」。
 *
 * @module dsh-find-right-plugin/downloads
 */

import { fetchJson } from './cache.js'
import { guessNpmName } from './npm-verify.js'

const DOWNLOADS_API = 'https://api.npmjs.org/downloads/range/last-month'
const TIMEOUT_MS = 4_000
const CONCURRENCY = 4
const TTL_MS = 30 * 60_000 // 下载量按天聚合，缓存久一点无妨
export const DEFAULT_BUDGET_MS = 5_000

// 前后半月日均相差不到 5% 视为持平，避免单日抖动被画成 ↑/↓。
const TREND_THRESHOLD = 0.05

/** 构造下载 API URL；scoped 包的 `@` 必须保留，否则 npm 返回 404。 */
export function downloadsUrl (name) {
  return `${DOWNLOADS_API}/${encodeURIComponent(name).replace('%40', '@')}`
}

/**
 * 纯函数：把 range API 的日明细压成 { total, trend, days }。
 * trend ∈ 'up' | 'down' | 'flat' | null（数据不足/包不存在时为 null）。
 * 用「前半月日均 vs 后半月日均」比较，天数奇偶不敏感。
 */
export function summarizeDownloads (json) {
  const days = Array.isArray(json?.downloads) ? json.downloads : []
  const counts = days.map((d) => (Number.isFinite(d?.downloads) ? d.downloads : 0))
  const total = counts.reduce((a, b) => a + b, 0)
  if (counts.length < 4) {
    return { total: counts.length ? total : null, trend: null, days: counts.length }
  }
  const half = Math.floor(counts.length / 2)
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  const first = avg(counts.slice(0, half))
  const second = avg(counts.slice(half))
  let trend
  if (first === 0 && second === 0) trend = 'flat'
  else if (first === 0) trend = second > 0 ? 'up' : 'flat'
  else {
    const rate = (second - first) / first
    trend = rate > TREND_THRESHOLD ? 'up' : rate < -TREND_THRESHOLD ? 'down' : 'flat'
  }
  return { total, trend, days: counts.length }
}

const UNKNOWN = () => ({ total: null, trend: null, days: 0 })

const TREND_ARROW = { up: '↑', down: '↓', flat: '→' }

/**
 * 纯函数：把「★star 数 + 30 天下载数（带涨跌箭头）」拼成对比表单元格文本。
 * 放在数据模块里是为了让「箭头口径」和「趋势计算」在同一处、可单测；
 * 渲染层只管把它塞进表格，不再自己解释 trend。
 *
 * 例：★115 · 30天 4,225↑   /   ★0 · 30天 —（无 npm 下载数据时）
 */
export function renderPopularity (signals) {
  const s = signals || {}
  const stars = Number.isFinite(s.stars) ? s.stars : 0
  const starPart = `★${stars}`
  const total = s.downloads30d
  let dlPart = '30天 —'
  if (typeof total === 'number' && Number.isFinite(total)) {
    const arrow = TREND_ARROW[s.downloadTrend] || ''
    dlPart = `30天 ${total.toLocaleString('en-US')}${arrow}`
  }
  return `${starPart} · ${dlPart}`
}

/**
 * 并发受限地查多行的 30 天下载量；返回按输入顺序对齐的数组。
 * @param {Array<object>} items 候选的 item（或含 .item 的打分行）列表
 * @returns {Array<{total:number|null, trend:string|null, days:number}>}
 */
export async function loadDownloads (items, { signal, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length).fill(null)
  let cursor = 0
  const deadline = Date.now() + budgetMs

  async function worker () {
    while (true) {
      if (Date.now() > deadline) return
      const i = cursor++
      if (i >= list.length) return
      const item = list[i]?.item ?? list[i]
      const name = guessNpmName(item)
      if (!name) { results[i] = UNKNOWN(); continue }
      try {
        const res = await fetchJson(downloadsUrl(name), { ttlMs: TTL_MS, timeoutMs: TIMEOUT_MS, signal })
        results[i] = res.ok ? summarizeDownloads(res.value) : UNKNOWN()
      } catch {
        results[i] = UNKNOWN()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length || 1) }, worker))
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) results[i] = UNKNOWN() // 整体预算耗尽：如实标未知
  }
  return results
}
