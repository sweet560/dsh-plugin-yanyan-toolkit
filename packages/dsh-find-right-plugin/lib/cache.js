/**
 * 只读抓取层：TTL 缓存 + single-flight 去重 + 硬超时 + stale-if-error。
 *
 * 为什么需要每一块：
 *   - TTL 缓存：目录是数 MB 的大文件、变化慢；GitHub 匿名搜索 10 次/分钟。
 *     每次工具调用都重抓既慢又会被限流。
 *   - single-flight：两个并发查询不该各拉一份 3MB 目录。
 *   - 超时：某个源挂起不能拖住整个工具调用（实测 radar 会挂到超时）。
 *   - stale-if-error：过期的副本胜过没有答案；但它只在进程内存活，
 *     不是随包分发的离线快照，且结果里会明确标注「缓存副本」。
 *   - 容量上限：缓存活得和 dsh 进程一样久，查询型 URL 无界，故按写入顺序淘汰最旧的。
 *
 * @module dsh-find-right-plugin/cache
 */

const DEFAULT_TTL_MS = 30 * 60_000
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_ENTRIES = 200

const store = new Map()
const inflight = new Map()

/** 把抓取异常压成一句可展示给模型的中文短语。 */
export function shortError (error) {
  if (error === null || error === undefined) return '未知错误'
  const name = error.name || ''
  const message = String(error.message || error)
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout/i.test(message)) return '超时'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'DNS 失败'
  if (/ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network/i.test(message)) return '连接失败'
  if (/^HTTP \d+/.test(message)) return message // 例如 "HTTP 403"（限流/鉴权）
  return message.length > 60 ? message.slice(0, 60) + '…' : message
}

function remember (url, value) {
  // 先删再插：Map 保持插入顺序，淘汰时读到的就是「最久未写入」的那个键。
  store.delete(url)
  store.set(url, { at: Date.now(), value })
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value)
}

async function request (url, { timeoutMs, parse, headers, signal }) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
  const res = await fetch(url, {
    headers: { 'user-agent': 'dsh-find-right-plugin', accept: 'application/json', ...headers },
    signal: combined,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parse === 'text' ? await res.text() : await res.json()
}

async function load (url, { ttlMs, timeoutMs, parse, headers, signal }) {
  const hit = store.get(url)
  const fresh = hit !== undefined && Date.now() - hit.at < ttlMs
  if (fresh) return { ok: true, value: hit.value, cached: true }

  if (inflight.has(url)) return inflight.get(url)

  const pending = (async () => {
    try {
      const value = await request(url, { timeoutMs, parse, headers, signal })
      remember(url, value)
      return { ok: true, value, cached: false }
    } catch (error) {
      // stale-if-error：过期副本明确标注后仍可用，好过一个源凭空消失。
      if (hit !== undefined) return { ok: true, value: hit.value, cached: true, stale: true }
      return { ok: false, error: shortError(error) }
    } finally {
      inflight.delete(url)
    }
  })()

  inflight.set(url, pending)
  return pending
}

export function fetchJson (url, options = {}) {
  return load(url, {
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parse: 'json',
    headers: options.headers,
    signal: options.signal,
  })
}

export function fetchText (url, options = {}) {
  return load(url, {
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parse: 'text',
    headers: options.headers,
    signal: options.signal,
  })
}

/** 测试用：清空缓存，也用来强制刷新。 */
export function clearCache () {
  store.clear()
  inflight.clear()
}

export function cacheSize () {
  return store.size
}
