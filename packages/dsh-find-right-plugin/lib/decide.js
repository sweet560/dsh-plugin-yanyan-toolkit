/**
 * 决策层 —— 本插件与「返回一堆榜单」的现成包最本质的区别。
 *
 * 输入：排好序的打分行 + npm 验证结果 + 上下文。
 * 输出：明确告诉 agent「最该装的是这一个」+ 为什么，只附少量高置信备选。
 *
 * 关键判断：
 *   - 不硬凑：如果最相关的条目本身就不相关（relevance 太低 / 全是弱命中），
 *     就如实说「没找到足够匹配的」，而不是推一个凑数的包。
 *   - 看分差：第 1 与第 2 差距很小时，降低置信度并提示「这几个很接近」，
 *     让调用方知道这不是板上钉钉。
 *   - 主推必须能装：若主推候选的 npm 目标验证明确失败（不是插件/仓库不符），
 *     顺位换到下一个验证通过的，并在 reason 里说明换人原因。
 *   - 理由必须来自可核验的信号（四维分数、来源佐证、验证、风险、版本兼容），
 *     不编造、不臆测。
 *
 * @module dsh-find-right-plugin/decide
 */

import { installTarget, projectUrl, projectLinks } from './merge.js'
import { ageDays } from './rank.js'
import { compatNote } from './host-version.js'

// 判定「是否真找到了相关插件」用两个语料规模无关的信号：
//   - coverage：查询内容词（去掉 dsh/插件 等泛词）在最佳文档里的命中比例；
//     CJK 改述会打断 bigram，门槛不能太高，0.25 表示「至少命中相当一部分」。
//   - nameHit：名称/仓库精确命中（用户按插件名查找时直接算找到）。
// 绝不用 rawScore（随语料 idf 漂移，语料小会误杀、语料大会虚高）或
// relative relevance（第一名恒为 1，会把「只命中泛词」误判成高相关）。
const COVERAGE_FLOOR = 0.25
const NAME_HIT_FLOOR = 1.5
const RELEVANCE_FLOOR = 0.28 // 相对相关度下限（用于备选筛选）

/** 把一行的信号翻译成几条中文理由（都可核验）。 */
export function reasonsFor (row, ctx) {
  const { item, relevance, trust, freshness, popularity, final } = row
  const out = []
  const name = item.name || item.repo || item.npm || '该插件'

  // 1) 相关性。注意 relevance 是「相对本轮最佳」的压缩值，不是绝对名次：
  // 备选条目也可能 >= 0.9，所以绝不能写「候选中最匹配」这种绝对化措辞。
  if (relevance >= 0.9) out.push(`与「${ctx.query}」高度相关（相关度 ${relevance}）`)
  else if (relevance >= 0.6) out.push(`与「${ctx.query}」相关（相关度 ${relevance}）`)
  else out.push(`与「${ctx.query}」有一定相关（相关度 ${relevance}）`)

  // 2) 可信度信号
  const sources = item.sources || []
  if (sources.length >= 3) out.push(`被 ${sources.length} 个独立来源共同收录，交叉佐证充分`)
  else if (sources.length === 2) out.push(`被 2 个来源收录`)
  if ((item.verification?.level ?? 0) >= 3) out.push(`经目录验证（${item.verification.label || '已验证'}）`)
  if (item.evidence === 'tested') out.push('有第三方实测可运行记录')
  if (item.evidence === 'curated' && sources.length === 1) out.push('官方/社区精选目录收录')
  const risk = String(item.security?.riskLevel ?? '').toLowerCase()
  if (['critical', 'high'].includes(risk)) out.push(`⚠ 安全风险标记：${risk}（安装前务必读源码）`)
  if (item.archived) out.push('⚠ 仓库已归档')

  // 3) 新鲜度
  const days = ageDays(item, ctx.now)
  if (days === null) out.push('未提供更新时间')
  else if (days <= 30) out.push(`最近 ${days} 天内有更新，维护活跃`)
  else if (days <= 180) out.push(`约 ${days} 天前更新`)
  else out.push(`已约 ${days} 天未更新，偏旧`)

  // 4) 热度（有界，明确说明不是唯一依据）
  if (item.stars >= 50) out.push(`★${item.stars}（热度作为有界加权，非唯一依据）`)

  // 5) 版本兼容
  const compat = compatNote(ctx.hostVersion, item)
  if (compat.level === 'match') out.push(`与当前 DSH ${ctx.hostVersion} 版本完全匹配`)
  else if (compat.level === 'same-line') out.push(`与当前 DSH ${ctx.hostVersion} 同一版本线（验证于 ${compat.against}）`)
  else if (compat.level === 'cross') out.push(`⚠ 验证于 DSH ${compat.against}，与当前 ${ctx.hostVersion} 跨版本线，需留意兼容`)

  // 6) npm 验证
  const v = row.verify
  if (v?.verified === true) out.push(`npm 目标已核验为 DSH 插件${v.version ? `（最新 ${v.version}）` : ''}`)
  else if (v?.verified === false) out.push(`⚠ npm 目标核验未通过：${v.reason || '可能不是插件'}`)
  // v === null（网络抖动）不写，避免误导为「不是插件」

  return { name, final, reasons: out }
}

/**
 * 把一个打分行翻成「统一画像」——主推与备选共用，供渲染层做横向对比表。
 *
 * 全部字段来自可核验信号，不编造：描述取自目录双语描述，优势 / 需留意由
 * 来源数、验证、实测、更新时间、版本兼容、风险、归档、npm 核验推导。
 * 以前备选只有「名字 + 综合分」，调用方根本看不出它是干什么的；现在四个
 * 候选带同一套字段，才能放进一张表里直接比。
 */
export function profileOf (row, ctx) {
  const item = row.item || {}
  const d = item.description || {}
  const description = String(d.zh || d.en || '').replace(/\s+/g, ' ').trim()
  const sources = item.sources || []
  const compat = compatNote(ctx.hostVersion, item)
  const now = ctx.now ?? Date.now()
  const info = reasonsFor(row, { ...ctx, now }) // { name, final, reasons }
  return {
    ...info,
    description,
    installTarget: installTarget(item),
    projectUrl: projectUrl(item), // 兼容旧调用：第一条来源网址
    // 来源网址列表：优先各数据源真实记录的网址，按域名如实标注，不强求 GitHub
    projectLinks: projectLinks(item), // 可点击跳转，仅展示

    score: {
      relevance: row.relevance, trust: row.trust,
      freshness: row.freshness, popularity: row.popularity, final: row.final,
    },
    signals: {
      sourceCount: sources.length,
      verified: (item.verification?.level ?? 0) >= 3,
      tested: item.evidence === 'tested',
      stars: Math.max(0, item.stars || 0),
      downloads30d: row.downloads?.total ?? null,
      downloadTrend: row.downloads?.trend ?? null,
      downloadDays: row.downloads?.days ?? 0,
      ageDays: ageDays(item, now),
      compatLevel: compat.level,
      compatAgainst: compat.against,
      risk: String(item.security?.riskLevel ?? '').toLowerCase(),
      archived: !!item.archived,
      npmVerified: row.verify?.verified ?? null,
    },
  }
}

/**
 * 主决策：从排好序（含 verify 字段）的行里挑出主推与备选。
 * rows 已按 final 降序；verifications 与 rows 对齐。
 */
export function decide (rows, ctx) {
  const now = ctx.now ?? Date.now()
  const query = ctx.query ?? ''
  const enriched = rows.map((r, i) => ({
    ...r,
    verify: ctx.verifications?.[i] ?? null,
    downloads: ctx.downloads?.[i] ?? null,
  }))

  // 用覆盖率 / 名称命中判断是否真有相关结果，不硬凑。
  // 注意先判空：所有数据源都挂掉时 enriched 为空，top 为 undefined，
  // 原来先读 top.coverage 会抛 TypeError，连「没找到」的结论都渲染不出来。
  const top = enriched[0]
  const isRelevant = !!top && ((top.coverage ?? 0) >= COVERAGE_FLOOR || (top.nameHit ?? 0) >= NAME_HIT_FLOOR)
  if (!isRelevant) {
    return {
      found: false,
      query, now,
      note: '在所有来源里都没找到与查询足够相关的插件（最匹配的条目也只命中了泛词）。可以换个说法：用更具体的功能词、或中英文各试一次。',
      recommendation: null,
      alternatives: [],
      considered: enriched.length,
    }
  }

  // 主推：优先选「验证通过或未知」且 relevance 达标的最高分行；
  // 若最高分明确验证失败（就是不是插件），顺位换人。
  let primaryIdx = 0
  let switchedFrom = null
  let foundPrimary = false
  for (let i = 0; i < enriched.length; i++) {
    if (enriched[i].verify?.verified === false) continue
    primaryIdx = i
    foundPrimary = true
    break
  }
  // 全部候选都验证失败 → 不硬推，如实说没找到（而非退回 idx 0 那个失败项）。
  if (!foundPrimary) {
    return {
      found: false, query, now,
      note: '找到的候选其 npm 目标均未能核验为 DSH 插件；为避免推荐错包，本次不给出主推。可换个说法再试。',
      recommendation: null, alternatives: [], considered: enriched.length,
    }
  }
  // 若前 0..primaryIdx-1 里有被跳过的，说明换过人
  for (let i = 0; i < primaryIdx; i++) {
    if (enriched[i].verify?.verified === false) { switchedFrom = enriched[i]; break }
  }

  const primary = enriched[primaryIdx]
  const runnerUp = enriched[primaryIdx + 1] || null

  // 置信度：相关度 + 多维是否都在线 + 与第二名的分差
  const margin = runnerUp ? primary.final - runnerUp.final : primary.final
  const relativeMargin = primary.final > 0 ? margin / primary.final : 1
  let confidence
  if (primary.relevance >= 0.85 && relativeMargin >= 0.2 && primary.trust >= 1 && primary.freshness >= 0.7) confidence = '高'
  else if (relativeMargin < 0.08) confidence = '中（前几名很接近，建议都看一眼）'
  else if (primary.relevance < 0.5 || primary.freshness < 0.7) confidence = '中'
  else confidence = '中高'

  const primaryInfo = profileOf(primary, { query, now, hostVersion: ctx.hostVersion })
  primaryInfo.item = primary.item
  primaryInfo.sources = primary.item.sources
  primaryInfo.confidence = confidence
  if (switchedFrom) {
    primaryInfo.switchedFrom = {
      name: switchedFrom.item.name || switchedFrom.item.repo,
      reason: switchedFrom.verify?.reason || 'npm 目标核验未通过',
    }
  }

  // 备选：取主推之后、验证未明确失败、且 relevance 达标的最多 3 个，
  // 每个给一句话理由（与主推的差异化定位），不铺开成榜单。
  // limit 语义：主推 1 个 + 最多 (limit-1) 个备选，且默认封顶 3 个，
  // 绝不铺开成一堆榜单（用户明确不要「一堆插件」）。
  const ALTERNATIVES = Math.max(0, Math.min(3, (ctx.limit ?? 4) - 1))
  const alternatives = []
  for (let i = primaryIdx + 1; i < enriched.length && alternatives.length < ALTERNATIVES; i++) {
    const r = enriched[i]
    if (r.verify?.verified === false) continue
    if (r.relevance < RELEVANCE_FLOOR) break
    const info = profileOf(r, { query, now, hostVersion: ctx.hostVersion })
    const diff = []
    if (info.signals.sourceCount >= 3 && primaryInfo.signals.sourceCount < 3) diff.push('多源佐证更强')
    else if (r.freshness > primary.freshness + 0.15) diff.push('更新更近')
    else if (info.signals.stars > primaryInfo.signals.stars * 2) diff.push('社区热度更高')
    else if (r.relevance > primary.relevance) diff.push('字面相关度略高')
    else diff.push('可作为不同实现思路的备选')
    info.why = diff.join('；')
    info.shortReason = info.reasons.slice(0, 3)
    alternatives.push(info)
  }

  return {
    found: true,
    query, now,
    confidence,
    considered: enriched.length,
    recommendation: primaryInfo,
    alternatives,
    note: relativeMargin < 0.08
      ? '前几名综合分非常接近，主推只是略胜；若它与你的具体环境不合，备选同样值得考虑。'
      : null,
  }
}
