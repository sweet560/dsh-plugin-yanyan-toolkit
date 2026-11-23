/**
 * 检索管线（纯编排，不依赖宿主模块，可离线/联网单测）。
 *
 * index.js 只负责用 defineTool 把它包成工具；这里承载全部真实逻辑：
 *   搜遍生态 → 合并去重 → 四维排序 → 未验证下限过滤 → npm 目标核验 → 决策。
 * 抽出来的目的：能在 node 里直接 import 并用真实/模拟数据端到端验证，
 * 而不必加载只存在于 DSH 宿主里的 @deepseek-ai/dsh-tools。
 *
 * @module dsh-find-right-plugin/search
 */

import { mergeEntries } from './merge.js'
import { rank } from './rank.js'
import { loadAll } from './sources.js'
import { verifyRows } from './npm-verify.js'
import { loadDownloads } from './downloads.js'
import { decide } from './decide.js'
import { detectHostVersion } from './host-version.js'

export const DEFAULT_LIMIT = 4
export const MAX_LIMIT = 8
export const VERIFY_BUDGET_MS = 6_000

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 可选解析 GitHub token（提升匿名 10 次/分限流到 30 次/分）。不写进 inject。 */
export async function resolveGithubToken (ctx) {
  for (const key of ['DSH_FIND_RIGHT_PLUGIN_GITHUB_TOKEN', 'SCOUT_GITHUB_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[key]) return process.env[key]
  }
  try {
    const creds = ctx?.get?.('credentials')
    if (creds?.resolve) {
      const v = await Promise.resolve(creds.resolve('GITHUB_TOKEN'))
      if (typeof v === 'string' && v) return v
    }
  } catch { /* 可选服务不可用：匿名继续 */ }
  return null
}

/**
 * 完整检索。返回可 lossless-JSON 往返的结构化结果（渲染由 render.js 负责）。
 * 允许注入 loadAllFn / verifyFn 以便离线单测；默认走真实实现。
 */
export async function runSearch (args, exec, ctx, deps = {}) {
  const loadAllFn = deps.loadAll ?? loadAll
  const verifyFn = deps.verifyRows ?? verifyRows
  const downloadsFn = deps.loadDownloads ?? loadDownloads
  const detectVersion = deps.detectHostVersion ?? detectHostVersion
  const resolveToken = deps.resolveGithubToken ?? resolveGithubToken

  const query = String(args?.query ?? '').trim()
  if (!query) {
    return {
      query: '', limit: DEFAULT_LIMIT, includeUnvetted: false,
      hostVersion: detectVersion(), sources: {},
      poolSize: 0, matched: 0, hiddenUnvetted: 0,
      found: false, note: 'query 不能为空：请描述想找的插件功能。',
      recommendation: null, alternatives: [], considered: 0,
    }
  }

  const limit = clamp(Math.floor(Number(args?.limit) || DEFAULT_LIMIT), 1, MAX_LIMIT)
  const includeUnvetted = args?.includeUnvetted === true
  const now = deps.now ?? Date.now()
  const signal = exec?.signal
  const hostVersion = detectVersion()
  const githubToken = await resolveToken(ctx)

  // 1) 搜遍生态（每源独立硬超时，单源失败隔离）
  const { entries, sources } = await loadAllFn(query, { signal, githubToken })
  // 2) 按 key 去重合并成候选池
  const pool = mergeEntries(entries)
  // 3) 四维乘积排序（返回全部命中，决策层要看全局）
  const rows = rank(query, pool, now, pool.length)
  const matched = rows.length

  // 4) 未验证下限过滤：只被 topic 收录且零 star 的默认隐藏但计数
  const vetted = []
  let hiddenUnvetted = 0
  for (const r of rows) {
    const unvetted = r.item.evidence === 'topic' && (r.item.stars || 0) === 0
    if (unvetted && !includeUnvetted) { hiddenUnvetted++; continue }
    vetted.push(r)
  }

  // 5) 只对少数可能被推的行做 npm 目标核验 + 查 30 天下载量。
  //    两者互不依赖 → 并发跑，下载查询不增加串行等待；都有界预算、失败=未知。
  const head = vetted.slice(0, Math.min(vetted.length, Math.max(limit + 3, 6)))
  const [verificationsPartial, downloadsPartial] = await Promise.all([
    head.length ? verifyFn(head, VERIFY_BUDGET_MS) : Promise.resolve([]),
    head.length ? downloadsFn(head.map((r) => r.item), { signal }) : Promise.resolve([]),
  ])
  const verifications = new Array(vetted.length).fill(null)
  for (let i = 0; i < verificationsPartial.length; i++) verifications[i] = verificationsPartial[i]
  // 下载量挂回行上，决策层 profileOf 会把它们写进统一画像（供对比表加列）。
  const downloads = new Array(vetted.length).fill(null)
  for (let i = 0; i < downloadsPartial.length; i++) downloads[i] = downloadsPartial[i]

  // 6) 决策：主推 1 个 + 少量备选 + 可核验的理由
  const decision = decide(vetted, { query, now, hostVersion, verifications, downloads, limit })

  return {
    query, limit, includeUnvetted, hostVersion, sources,
    poolSize: pool.length, matched, hiddenUnvetted,
    ...decision,
  }
}
