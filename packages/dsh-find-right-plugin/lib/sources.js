/**
 * 数据源层：搜遍整个 DSH 插件生态，把每个源归一化成统一条目。
 *
 * 分两类：
 *   - 目录型（catalog / dsh.works / dsh.so / awesome / lanshu / radar）：
 *     与 query 无关的大候选池，变化慢，走 30 分钟磁盘无关的进程内缓存，
 *     可在 apply() 里后台预热。
 *   - 实时型（github / npm）：按 query 现查，短 TTL，catch 新发布/新仓库。
 *
 * 铁律：单源失败绝不影响其它源，也绝不把「某源挂了」伪装成「生态里
 * 没有」。每个源回传状态（ok/count/error/stale/truncated），渲染层如实呈现。
 * 实测 awesome-dsh-plugin.com / dsh.so / lanshu / radar 经常 ECONNRESET
 * 或连接超时，因此它们都是「短超时、尽力而为」的补充源；
 * catalog(jsdelivr) 与 dsh.works 是当前最稳、最高质量的主源。
 *
 * @module dsh-find-right-plugin/sources
 */

import { fetchJson, fetchText, shortError } from './cache.js'
import {
  entry, repoFromUrl, repoFromSpec, cleanRepo, npmNameFromTarget,
  targetFromCommand, specFragment, textDescription,
} from './merge.js'

// ---- URL 常量（全部实测过连通性） -----------------------------------------
const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
const CATALOG_MIRROR = 'https://fastly.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
const DSHWORKS_URL = 'https://dsh.works/awesome-dsh-plugins/plugins.json'
const DSHSO_URL = 'https://www.dsh.so/plugins-index.json'
const AWESOME_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const LANSHU_URL = 'https://dsh.lanshuagent.com/api/plugins'
const RADAR_URL = 'https://raw.githubusercontent.com/AdamPlatin123/dsh-plugin-radar/main/PLUGINS.md'
const GITHUB_API = 'https://api.github.com/search/repositories'
const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search'

// 每个源独立的硬超时：目录型给足，易挂的补充源快速失败不拖整体。
const TTL_CATALOG = 30 * 60_000
const TTL_SHORT = 5 * 60_000
const T_CATALOG = 18_000
const T_DSHWORKS = 22_000
const T_REALTIME = 12_000
const T_BEST_EFFORT = 8_000
// loadAll 整体安全预算：任何源到点就降级为「超时」而不拖住全局。
// 各源自己的超时都 ≤ 22s，正常从不触发；它只是防 DNS 挂死这类异常。
const OVERALL_BUDGET_MS = 25_000

/**
 * 并发赛跑取「首个成功」的结果；全失败时返回最后的错误。
 * 用于同一数据的多个镜像：谁快用谁，而不是串行等前一个超时。
 * 落败的请求不取消——它们继续跑完并预热各自 URL 的缓存（下次调用可命中）。
 */
export function firstOk (promises) {
  const list = [...promises]
  return new Promise((resolve) => {
    let pending = list.length
    let settled = false
    let lastError = null
    if (pending === 0) { resolve({ ok: false, error: '无结果' }); return }
    for (const p of list) {
      Promise.resolve(p).then((r) => {
        if (!settled && r?.ok) { settled = true; resolve(r); return }
        if (r && r.error) lastError = r.error
      }).catch((e) => { lastError = shortError(e) }).finally(() => {
        pending--
        if (pending === 0 && !settled) {
          settled = true
          resolve({ ok: false, error: lastError || '无结果' })
        }
      })
    }
  })
}

/**
 * 给单个源套一层「整体预算」外壳：超过 budgetMs 就降级为超时状态，但源请求
 * 本身不取消，继续在后台跑完以预热缓存。budgetMs 可注入以便离线单测。
 */
export function withBudget (promise, meta, budgetMs = OVERALL_BUDGET_MS) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __deadline: true }), budgetMs)
  })
  const guarded = Promise.resolve(promise).then(
    (v) => { clearTimeout(timer); return v },
    (e) => {
      clearTimeout(timer)
      return { ...meta, ok: false, entries: [], count: 0, error: shortError(e) }
    },
  )
  return Promise.race([guarded, deadline]).then((r) => {
    if (r && r.__deadline) return { ...meta, ok: false, entries: [], count: 0, error: '超时' }
    return r
  })
}

/** 统一的结果包装：从 fetchJson/fetchText 结果构造源状态。 */
function wrap (meta, res, normalize) {
  if (!res.ok) {
    return { ...meta, ok: false, entries: [], count: 0, error: res.error }
  }
  try {
    const { entries, total, truncated } = normalize(res.value)
    return {
      ...meta, ok: true, entries, count: entries.length,
      ...(total !== undefined && { total }),
      ...(truncated && { truncated: true }),
      ...(res.stale && { stale: true }),
    }
  } catch (error) {
    return { ...meta, ok: false, entries: [], count: 0, error: shortError(error) }
  }
}

function asArray (value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.plugins)) return value.plugins
  if (value && Array.isArray(value.items)) return value.items
  return []
}

/** epoch 秒 → ISO；取 versions 里最新的时间戳。 */
function latestPublish (versions) {
  let best = 0
  let version = null
  for (const v of Array.isArray(versions) ? versions : []) {
    const t = Number(v?.publishTimestamp ?? 0)
    if (t > best) { best = t; version = v.version ?? null }
  }
  return best > 0 ? { pushedAt: new Date(best * 1000).toISOString(), npmVersion: version } : { pushedAt: null, npmVersion: null }
}

// ---- 目录型 ---------------------------------------------------------------

/** Awesome DSH 官方精选目录（jsdelivr CDN，5126 条，中英双语描述）。主源。 */
export async function loadCatalog (signal) {
  const meta = { id: 'catalog', label: 'Awesome DSH 精选目录' }
  // 主 CDN 与镜像「并发赛跑」，谁先成功用谁。串行先等主源超时（18s）再试镜像
  // 会白白翻倍等待——真实冒烟里冷启动就是被这个拖到 52s。落败的请求不取消，
  // 继续跑完以预热各自 URL 的缓存（下次调用可命中）。
  const res = await firstOk([
    fetchJson(CATALOG_URL, { ttlMs: TTL_CATALOG, timeoutMs: T_CATALOG, signal }),
    fetchJson(CATALOG_MIRROR, { ttlMs: TTL_CATALOG, timeoutMs: T_CATALOG, signal }),
  ])
  return wrap(meta, res, (j) => {
    const list = asArray(j)
    const entries = list.map((p) => {
      const repo = repoFromUrl(p?.repository?.url) || cleanRepo(p?.title)
      const npm = npmNameFromTarget(p?.name)
      const { pushedAt, npmVersion } = latestPublish(p?.versions)
      const compat = p?.versions?.[0]?.engines?.dsh
        ? { version: String(p.versions[0].engines.dsh) } : null
      return entry({
        source: 'catalog', repo, npm,
        name: p?.name || undefined,
        // 目录既有介绍页 homepage，也有 GitHub 源码 repository.url；两条都是
        // 数据源真实记录的网址，交给合并层保留，卡片按域名如实标注。
        url: [p?.homepage, p?.repository?.url],
        description: { en: p?.description?.en || '', zh: p?.description?.zh || '' },
        category: p?.metadata?.category || null,
        topics: p?.metadata?.keywords || [],
        stars: 0,
        pushedAt, npmVersion, compat,
        notes: ['官方精选目录收录'],
      })
    }).filter((e) => e.key)
    return { entries, total: list.length }
  })
}

/** dsh.works 大目录（32321 条，带 stars/验证/推送时间/tags）。第二主源。 */
export async function loadDshworks (signal) {
  const meta = { id: 'dsh.works', label: 'dsh.works 目录' }
  const res = await fetchJson(DSHWORKS_URL, { ttlMs: TTL_CATALOG, timeoutMs: T_DSHWORKS, signal })
  return wrap(meta, res, (j) => {
    const list = asArray(j)
    const entries = list
      .filter((p) => (p?.category === 'plugin' || !p?.category) && p?.status !== 'broken')
      .map((p) => {
        const repo = cleanRepo(p?.repo) || repoFromUrl(p?.url)
        const npm = npmNameFromTarget(p?.npm)
        return entry({
          source: 'dsh.works', repo, npm,
          name: p?.name || undefined,
          url: p?.url,
          description: textDescription(p?.description),
          stars: Number(p?.stars) || 0,
          pushedAt: p?.pushedAt || p?.lastVerified || null,
          category: 'plugin',
          topics: Array.isArray(p?.tags) ? p.tags : [],
          path: p?.path || null,
          compat: p?.verifiedAgainst ? { version: p.verifiedAgainst, at: p?.lastVerified } : null,
          verification: p?.status === 'verified' ? { level: 3, label: 'dsh.works 已验证' } : null,
          official: p?.official === true,
          notes: p?.official ? ['dsh.works 官方标记'] : [],
        })
      }).filter((e) => e.key)
    return { entries, total: list.length }
  })
}

/** dsh.so 索引（带安全扫描与验证级别）。实测常挂，尽力而为。 */
export async function loadDshso (signal) {
  const meta = { id: 'dsh.so', label: 'dsh.so 索引' }
  const res = await fetchJson(DSHSO_URL, { ttlMs: TTL_CATALOG, timeoutMs: T_BEST_EFFORT, signal })
  return wrap(meta, res, (j) => {
    const list = asArray(j)
    const entries = list.map((p) => {
      const target = targetFromCommand(p?.install) || p?.target
      const repo = repoFromSpec(target) || repoFromUrl(p?.url)
      const npm = npmNameFromTarget(p?.npm) || npmNameFromTarget(target)
      const notes = []
      const risk = String(p?.security?.riskLevel ?? '').toLowerCase()
      if (['critical', 'high', 'medium'].includes(risk)) notes.push(`安全风险：${risk}`)
      return entry({
        source: 'dsh.so', repo, npm,
        name: p?.name || undefined,
        url: p?.url,
        description: p?.description || '',
        stars: Number(p?.stars) || 0,
        pushedAt: p?.pushedAt || null,
        category: p?.category || null,
        topics: Array.isArray(p?.topics) ? p.topics : [],
        security: p?.security || null,
        verification: p?.verification || null,
        ref: specFragment(target),
        notes,
      })
    }).filter((e) => e.key)
    return { entries, total: list.length }
  })
}

/** awesome-dsh-plugin.com 目录。实测常挂，尽力而为。 */
export async function loadAwesome (signal) {
  const meta = { id: 'awesome', label: 'awesome-dsh-plugin 目录' }
  const res = await fetchJson(AWESOME_URL, { ttlMs: TTL_CATALOG, timeoutMs: T_BEST_EFFORT, signal })
  return wrap(meta, res, (j) => {
    const list = asArray(j)
    const entries = list.map((p) => {
      const repo = repoFromUrl(p?.url)
      const npm = npmNameFromTarget(p?.npm) || npmNameFromTarget(targetFromCommand(p?.install))
      return entry({
        source: 'awesome', repo, npm,
        name: p?.name || undefined,
        url: p?.url,
        description: p?.description || '',
        stars: Number(p?.stars) || 0,
        category: p?.category || null,
      })
    }).filter((e) => e.key)
    return { entries, total: list.length }
  })
}

/** 蓝书 agent 目录（带筛选状态/维护度）。实测常挂，尽力而为。 */
export async function loadLanshu (signal) {
  const meta = { id: 'lanshu', label: '蓝书 agent 目录' }
  const res = await fetchJson(LANSHU_URL, { ttlMs: TTL_CATALOG, timeoutMs: T_BEST_EFFORT, signal })
  return wrap(meta, res, (j) => {
    const list = asArray(j)
    const entries = list.map((p) => {
      const repo = cleanRepo(p?.repo) || repoFromUrl(p?.url)
      const notes = []
      const state = p?.screening?.state
      const risk = p?.screening?.risk
      if (risk) notes.push(`筛选风险：${risk}`)
      if (state) notes.push(`筛选状态：${state}`)
      for (const r of Array.isArray(p?.attention?.reasons) ? p.attention.reasons : []) notes.push(String(r))
      return entry({
        source: 'lanshu', repo, npm: npmNameFromTarget(p?.npm),
        name: p?.name || undefined,
        url: p?.url,
        description: p?.description || '',
        stars: Number(p?.stars) || 0,
        pushedAt: p?.pushedAt || p?.maintenance?.lastCommit || null,
        archived: p?.archived === true,
        license: p?.license || null,
        notes,
      })
    }).filter((e) => e.key)
    return { entries, total: list.length }
  })
}

/** dsh-plugin-radar 实测清单（Markdown 四列表格）。实测常挂/空，尽力而为。 */
export async function loadRadar (signal) {
  const meta = { id: 'radar', label: 'dsh-plugin-radar 实测清单' }
  const res = await fetchText(RADAR_URL, { ttlMs: TTL_SHORT, timeoutMs: T_BEST_EFFORT, signal })
  return wrap(meta, res, (text) => {
    const entries = []
    for (const line of String(text).split('\n')) {
      if (!/^\s*\|/.test(line)) continue
      const cells = line.split('|').map((c) => c.trim())
      if (cells.length < 5) continue
      const [, nameCell, repoCell, descCell] = cells
      if (/^[-:\s]+$/.test(repoCell) || /插件|仓库/i.test(repoCell)) continue
      const repo = repoFromUrl(repoCell) || cleanRepo(repoCell.replace(/^\[|\]\(.*\)$/g, ''))
      if (!repo) continue
      // radar 的仓库列是 markdown 链接 [o/r](https://...)，把里面的真实网址抽出来
      const linkMatch = /\]\((https?:\/\/[^)]+)\)/.exec(repoCell)
      entries.push(entry({
        source: 'radar', repo,
        name: nameCell.replace(/^\[|\]\(.*\)$/g, '') || undefined,
        url: linkMatch ? linkMatch[1] : null,
        description: textDescription(descCell),
        stars: 0,
        notes: ['radar 实测可运行'],
      }))
    }
    return { entries, total: entries.length }
  })
}

// ---- 实时型（按 query） ---------------------------------------------------

const GITHUB_TOPICS = ['dsh-plugin', 'dsh-plugins']

/** GitHub 实时：按 topic 搜仓库（可选 token 提升 30 次/分钟配额）。 */
export async function loadGithub (query, signal, token) {
  const meta = { id: 'github', label: 'GitHub 实时搜索' }
  const q = String(query || '').trim()
  if (!q) return { ...meta, ok: true, entries: [], count: 0 }
  const headers = { accept: 'application/vnd.github+json' }
  if (token) headers.authorization = `Bearer ${token}`
  const tasks = GITHUB_TOPICS.map((topic) => {
    const url = `${GITHUB_API}?q=${encodeURIComponent(`${q} topic:${topic}`)}&per_page=60&sort=updated`
    return fetchJson(url, { ttlMs: TTL_SHORT, timeoutMs: T_REALTIME, headers, signal })
  })
  const results = await Promise.all(tasks)
  const first = results.find((r) => r.ok)
  const merged = []
  let sawError = null
  for (const r of results) {
    if (!r.ok) { sawError = sawError || r.error; continue }
    for (const it of asArray(r.value)) merged.push(it)
  }
  if (merged.length === 0 && !first) {
    return { ...meta, ok: false, entries: [], count: 0, error: sawError || '无结果' }
  }
  const entries = merged.map((r) => entry({
    source: 'github', repo: cleanRepo(r?.full_name),
    name: r?.name || undefined,
    url: r?.html_url,
    description: textDescription(r?.description),
    stars: Number(r?.stargazers_count) || 0,
    pushedAt: r?.pushed_at || null,
    archived: r?.archived === true,
    license: r?.license?.spdx_id || null,
    topics: Array.isArray(r?.topics) ? r.topics : [],
  })).filter((e) => e.key)
  return { ...meta, ok: true, entries, count: entries.length, ...(sawError && { error: sawError }) }
}

const NPM_QUALIFIER = 'keywords:dsh-plugin'
const NPM_MAX_TEXT = 64

/**
 * npm 搜索响应归一化（抽成纯函数，便于离线回归）。
 * npm 返回 { objects:[{package}], total, time }，不是 plugins/items；
 * 曾因复用 asArray（只认那两个键）导致整个 npm 源恒返回 0 条、漏掉 npm 生态。
 */
export function normalizeNpmObjects (j, truncated = false) {
  const list = Array.isArray(j?.objects) ? j.objects : []
  const entries = list.map((o) => {
    const p = o?.package || {}
    const repo = repoFromUrl(p?.links?.repository) || repoFromSpec(p?.links?.repository)
    return entry({
      source: 'npm', repo, npm: npmNameFromTarget(p?.name),
      name: p?.name || undefined,
      // npm 搜索同时给 homepage（多为 GitHub 源码）、repository、npm 包页
      url: [p?.links?.homepage, p?.links?.repository, p?.links?.npm],
      description: textDescription(p?.description),
      stars: 0,
      pushedAt: p?.date || null,
      npmVersion: p?.version || null,
      license: p?.license || null,
      topics: Array.isArray(p?.keywords) ? p.keywords : [],
    })
  }).filter((e) => e.key)
  return { entries, total: typeof j?.total === 'number' ? j.total : list.length, truncated }
}

/** npm 实时：搜带 dsh-plugin 关键词的包（截断过长中文 query）。 */
export async function loadNpm (query, signal) {
  const meta = { id: 'npm', label: 'npm 实时搜索' }
  let text = String(query || '').trim()
  if (!text) return { ...meta, ok: true, entries: [], count: 0 }
  let truncated = false
  const budget = NPM_MAX_TEXT - NPM_QUALIFIER.length - 1
  if (text.length > budget) {
    text = text.slice(0, budget)
    // 去掉尾部孤立的高代理项，避免 encodeURIComponent 抛 URIError
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
    text = text.replace(/\s+\S*$/, '') || text
    truncated = true
  }
  const url = `${NPM_SEARCH}?text=${encodeURIComponent(`${text} ${NPM_QUALIFIER}`)}&size=50`
  const res = await fetchJson(url, { ttlMs: TTL_SHORT, timeoutMs: T_REALTIME, signal })
  return wrap(meta, res, (j) => normalizeNpmObjects(j, truncated))
}

// ---- 聚合 -----------------------------------------------------------------

// 统一的源描述表：id/label 只在这里写一次，loadAll 用它构造超时状态，
// prewarm 用它挑目录型源。避免两处各维护一份、meta 对不上。
const CATALOG_SPECS = [
  { id: 'catalog', label: 'Awesome DSH 精选目录', fn: loadCatalog },
  { id: 'dsh.works', label: 'dsh.works 目录', fn: loadDshworks },
  { id: 'dsh.so', label: 'dsh.so 索引', fn: loadDshso },
  { id: 'awesome', label: 'awesome-dsh-plugin 目录', fn: loadAwesome },
  { id: 'lanshu', label: '蓝书 agent 目录', fn: loadLanshu },
  { id: 'radar', label: 'radar 实测清单', fn: loadRadar },
]

/**
 * 后台预热大目录：apply() 里延迟调用，把慢源先填进缓存，
 * 让首次真实查询大概率命中缓存、秒回。fire-and-forget。
 */
export async function prewarmCatalogs (signal) {
  await Promise.allSettled(CATALOG_SPECS.map((s) => s.fn(signal)))
}

/**
 * 并发加载全部源。每个源自己有硬超时；外面再套一层「整体预算」，
 * 任何源到点就降级为超时而不拖住全局（防 DNS 挂死这类异常）。
 * 单源 catch 不影响其它源；返回条目池 + 每个源的状态字典（渲染层如实呈现）。
 *
 * budgetMs 可注入以便离线单测验证「超时降级」分支。
 */
export async function loadAll (query, { signal, githubToken, budgetMs = OVERALL_BUDGET_MS } = {}) {
  const specs = [
    ...CATALOG_SPECS.map((s) => ({ id: s.id, label: s.label, promise: s.fn(signal) })),
    { id: 'github', label: 'GitHub 实时搜索', promise: loadGithub(query, signal, githubToken) },
    { id: 'npm', label: 'npm 实时搜索', promise: loadNpm(query, signal) },
  ]
  const settled = await Promise.all(specs.map((s) => withBudget(
    s.promise, { id: s.id, label: s.label }, budgetMs,
  ).catch((e) => ({
    id: s.id, label: s.label, ok: false, entries: [], count: 0, error: shortError(e),
  }))))

  const entries = []
  const sources = {}
  for (const s of settled) {
    sources[s.id] = {
      ok: s.ok, label: s.label, count: s.count ?? 0,
      ...(s.total !== undefined && { total: s.total }),
      ...(s.error && { error: s.error }),
      ...(s.stale && { stale: true }),
      ...(s.truncated && { truncated: true }),
    }
    if (s.ok) for (const e of s.entries) entries.push(e)
  }
  return { entries, sources }
}
