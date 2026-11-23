/**
 * 四维排序层：final = 相关度 × 可信度 × 新鲜度 × 热度（乘积，不是加权和）。
 *
 * 乘积是刻意的：任何一维接近 0 就应该把整条拉下来。一个「完全不相关但
 * 星标 70k 的通用库」不该靠热度赢；一个「名字一模一样但三年没更、只被
 * GitHub topic 收录」的仓库也不该靠相关度赢。
 *
 * 相关度用指数压缩：BM25 头部优势太大（10x 原始差距）会淹没其它三维，
 * 取 0.45 次幂后约 2.8x，让信任/新鲜度/热度真正能左右结果。
 *
 * 热度用对数有界：★1 与 ★3000 只差约 1.5x 而非 3000x，防止通用库碾压
 * 真插件。实测完全去掉 star 又会让 ★1 的名称命中压过 ★3k 的正经插件，
 * 所以保留为有界乘子——这正是「不只看 star，但也不无视 star」。
 *
 * @module dsh-find-right-plugin/rank
 */

import { relevanceScores } from './text.js'

export const RELEVANCE_EXPONENT = 0.45
export const STALE_DAYS = 14
const DSH_SPECIFIC = ['radar', 'lanshu', 'awesome', 'dsh.works', 'catalog', 'dsh.so']

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 已 N 天未更新；无日期返回 null。 */
export function ageDays (item, now) {
  if (!item.pushedAt) return null
  const t = Date.parse(item.pushedAt)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}

/**
 * 可信度：多源独立佐证 + 官方验证/实测 加分；安全风险、归档、仅 topic
 * 收录 扣分。风险只做 tiebreak 不淘汰——静态分析是弱信号，且调用方本就
 * 该读源码再装。
 */
export function trustScore (item) {
  let trust = 1
  trust += Math.min(0.45, 0.15 * ((item.sources?.length ?? 1) - 1)) // 多源佐证
  if ((item.verification?.level ?? 0) >= 3) trust += 0.25
  if (item.evidence === 'tested') trust += 0.25 // radar 实测
  const risk = String(item.security?.riskLevel ?? '').toLowerCase()
  if (risk === 'critical') trust -= 0.3
  else if (risk === 'high') trust -= 0.2
  else if (risk && risk !== 'low' && risk !== 'none') trust -= 0.08
  if (item.archived) trust -= 0.15
  const hasDshSource = (item.sources ?? []).some((s) => DSH_SPECIFIC.includes(s))
  if (!hasDshSource) trust *= 0.7 // 没有任何 DSH 专属目录佐证
  if (item.evidence === 'topic') trust *= 0.75 // 仅 GitHub topic
  return clamp(trust, 0.25, 2)
}

/**
 * 新鲜度：归档直接 0.4；无日期给中立的 0.85（缺日期 ≠ 废弃）；
 * 年龄曲线分段衰减；超过 14 天再整体乘 0.85（保持陈旧条目之间相对次序）。
 */
export function freshnessScore (item, now) {
  if (item.archived) return 0.4
  const days = ageDays(item, now)
  if (days === null) return 0.85
  const stale = days > STALE_DAYS ? 0.85 : 1
  let base
  if (days <= 90) base = 1
  else if (days <= 180) base = 0.95
  else if (days <= 365) base = 0.85
  else if (days <= 730) base = 0.7
  else base = 0.55
  return base * stale
}

/** 热度：对数有界，避免 ★70k 通用库碾压真正的插件。 */
export function popularityScore (item) {
  const stars = Math.max(0, item.stars || 0)
  return 0.6 + 0.7 * Math.min(1, Math.log10(1 + stars) / Math.log10(5001))
}

const round = (v) => Math.round(v * 1000) / 1000

/**
 * 主入口：query × 候选池 → 按 final 降序的打分行。
 * 每行带四个分量的明细，渲染层据此给出「为什么是它」的解释。
 * 返回全部命中（调用方再切 limit），因为「主推 1 个」的决策层需要看全局。
 */
export function rank (query, items, now = Date.now(), limit = items.length) {
  const scored = relevanceScores(query, items)
  if (scored.length === 0) return []
  const best = scored[0].score
  const rows = scored.map(({ item, score, coverage, nameHit }) => {
    const relevance = best > 0 ? Math.pow(score / best, RELEVANCE_EXPONENT) : 0
    const trust = trustScore(item)
    const freshness = freshnessScore(item, now)
    const popularity = popularityScore(item)
    const final = relevance * trust * freshness * popularity
    return {
      item,
      // rawScore 是 BM25+名称加权的绝对原始分（依赖语料 idf，仅诊断用）。
      // 判定「是否真找到相关插件」用 coverage（查询内容词命中比例，语料规模
      // 无关）与 nameHit（名称精确命中），绝不能用 rawScore/relative relevance：
      // 前者随语料大小漂移，后者第一名恒为 1，都会把泛词命中误判成高相关。
      rawScore: round(score),
      coverage: round(coverage ?? 0),
      nameHit: round(nameHit ?? 0),
      relevance: round(relevance),
      trust: round(trust),
      freshness: round(freshness),
      popularity: round(popularity),
      final: round(final),
    }
  })
  rows.sort((a, b) => b.final - a.final || b.item.stars - a.item.stars)
  return rows.slice(0, limit)
}
