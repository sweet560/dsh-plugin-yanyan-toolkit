/**
 * 渲染层：把结构化结果翻成给 agent / 用户看的中文文本。
 *
 * 设计原则（按用户反馈改版）：
 *   1. 不用表格 —— 多列 + 长中文会把会话宽度撑爆、格子挤成一块块。
 *      改成「一个插件一张卡片，一张接一张」：每张卡是竖向单列，宽度恒定，
 *      主推与全部备选都各有自己的卡片，按推荐顺序排下来。
 *   2. 「第一时间能判断是不是我需要的」—— 每张卡开头就写「用途」，
 *      再给「优势 / 需留意 / ★star·30天下载 / 综合评分拆解 / 安装目标」，
 *      自包含，不用来回对照别处。
 *   3. 「综合评分每个数字是什么」—— 卡片里用「相关度 X × 可信度 X ×
 *      新鲜度 X × 热度 X = 综合 X」把四个数字各自标上名字；文末再给一段
 *      非表格的四维释义，讲清基准、范围、怎么算高。绝不丢裸乘法给人猜。
 *   4. 源状态单独一段，如实区分「生态里只有这些」和「某源挂了」。
 *
 * @module dsh-find-right-plugin/render
 */

import { renderPopularity } from './downloads.js'

const MAX_DESC = 170

function cut (text, max = MAX_DESC) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

const SOURCE_LABEL = {
  catalog: 'Awesome DSH 精选目录', 'dsh.works': 'dsh.works 目录', 'dsh.so': 'dsh.so 索引',
  awesome: 'awesome-dsh-plugin 目录', lanshu: '蓝书 agent 目录', radar: 'radar 实测清单',
  github: 'GitHub 实时', npm: 'npm 实时',
}

function sourceStatus (sources, hostVersion) {
  const lines = []
  if (hostVersion) lines.push(`当前 DSH 版本：${hostVersion}`)
  else lines.push('宿主 DSH 版本：未检测到（已跳过版本兼容核对）')
  lines.push('数据源状态（如实呈现，挂掉的源不会伪装成「没有」）：')
  for (const [id, s] of Object.entries(sources || {})) {
    const label = SOURCE_LABEL[id] || s.label || id
    if (s.ok) {
      const bits = [`✓ ${label}`, `${s.count} 条`]
      if (s.total && s.total !== s.count) bits.push(`池内 ${s.total}`)
      if (s.stale) bits.push('（过期副本）')
      if (s.truncated) bits.push('（查询被截断）')
      if (s.error) bits.push(`（部分失败：${s.error}）`)
      lines.push('  ' + bits.join(' · '))
    } else {
      lines.push(`  ✗ ${label}：不可用（${s.error || '未知错误'}）— 已跳过，不影响其它源`)
    }
  }
  return lines.join('\n')
}

/** 从可核验信号生成「优势」一行。 */
function strengths (p) {
  const s = p.signals || {}
  const bits = []
  if (s.sourceCount >= 3) bits.push(`${s.sourceCount} 源佐证`)
  else if (s.sourceCount === 2) bits.push('2 源收录')
  if (s.verified) bits.push('目录已验证')
  if (s.tested) bits.push('有实测记录')
  if (s.ageDays !== null && s.ageDays !== undefined && s.ageDays <= 30) bits.push(`${s.ageDays} 天内更新`)
  if (s.npmVerified === true) bits.push('npm 已核验')
  return bits.length ? bits.join(' · ') : '—'
}

/** 从可核验信号生成「需留意」一行。 */
function caveats (p, hostVersion) {
  const s = p.signals || {}
  const bits = []
  if (s.compatLevel === 'cross') {
    bits.push(`⚠ 验证于 ${s.compatAgainst}，跨版本线${hostVersion ? `（当前 ${hostVersion}）` : ''}`)
  } else if (s.compatLevel === 'same-line') {
    bits.push(`同版本线（验证于 ${s.compatAgainst}）`)
  }
  if (['critical', 'high'].includes(s.risk)) bits.push(`⚠ 安全风险 ${s.risk}`)
  if (s.archived) bits.push('⚠ 仓库已归档')
  if (s.ageDays !== null && s.ageDays !== undefined && s.ageDays > 180) bits.push(`⚠ 已 ${s.ageDays} 天未更新`)
  if (s.npmVerified === false) bits.push('⚠ npm 核验未过')
  return bits.length ? bits.join(' · ') : '—'
}

/** 带维度名字的连乘式：四个数字各自是什么，第一眼就看得懂。 */
function scoreExpr (s) {
  if (!s) return ''
  return `相关度 ${s.relevance} × 可信度 ${s.trust} × 新鲜度 ${s.freshness} × 热度 ${s.popularity} = 综合 ${s.final}`
}

/**
 * 一张卡片 = 一个插件，竖向单列、宽度恒定、自包含。
 * @param {object} p 统一画像（profileOf 的产物）
 */
function card (p, { isPrimary, index, hostVersion }) {
  const s = p.score || {}
  const badge = isPrimary ? '⭐ 主推' : `备选 ${index}`
  const conf = isPrimary && p.confidence ? ` · 置信度 ${p.confidence}` : ''
  const out = []
  out.push(`### ${badge} · \`${p.name}\` · 综合分 \`${s.final ?? p.final}\`${conf}`)
  out.push('')
  const row = (label, value) => out.push(`- **${label}**：${value || '—'}`)
  row('它是做什么的（用途）', cut(p.description || '（未提供描述）'))
  row('★star / 30天下载', renderPopularity(p.signals))
  row('优势', strengths(p))
  row('需留意', caveats(p, hostVersion))
  row('综合评分拆解', scoreExpr(p.score))
  if (!isPrimary && p.why) row('与主推的差异', p.why)
  const reasons = (isPrimary ? (p.reasons || []) : (p.shortReason || p.reasons || [])).slice(0, 5)
  if (reasons.length) row('为什么推荐它', reasons.join('；'))
  if (isPrimary) {
    const srcs = (p.sources || []).map((x) => SOURCE_LABEL[x] || x).join('、')
    if (srcs) row('来源', srcs)
    if (p.switchedFrom) row('注', `排序更靠前的「${p.switchedFrom.name}」因「${p.switchedFrom.reason}」未作为主推`)
  }
  row('安装目标', `\`${p.installTarget || '（无可用安装目标）'}\``)
  // 来源网址：优先各数据源真实记录的网址（目录页 / GitHub / npm 包页…），
  // 按域名如实标注，不强求都是 GitHub。一行可放多条，点哪个跳哪个。
  const links = (Array.isArray(p.projectLinks) && p.projectLinks.length)
    ? p.projectLinks
    : (p.projectUrl && p.projectUrl.url ? [p.projectUrl] : [])
  if (links.length) {
    const text = links
      .map((l) => `[${l.label}](${l.url})`)
      .join(' · ')
    row('来源网址', `${text}（点击直接跳转）`)
  }
  return out.join('\n')
}

/** 评分释义：不用表格，用逐条说明把「四个数字各代表什么」讲清楚。 */
function scoreLegend () {
  return [
    '## 综合评分怎么读（四个数字各代表什么）',
    '',
    '**综合分 = 相关度 × 可信度 × 新鲜度 × 热度**（四维**相乘**，不是加权平均；任何一维接近 0 都会把整条拉下来，所以不能只看 star）。每张卡的「综合评分拆解」已经把四个数字各自标了名字。',
    '',
    '- **相关度**：查询词与插件「名称 + 描述 + 分类 + 标签」的匹配程度。**相对值**：本轮最佳 = 1，其余按 0.45 次幂压缩；用 BM25 + 中文 bigram 分词 + 中英同义词扩展 + 名称命中加权。',
    '- **可信度**：来路是否可靠、是否经过验证。**1 = 基线**；上限 2、下限 0.25。多源独立佐证 / 目录验证 / 第三方实测 加分；安全风险 / 归档 / 仅 GitHub topic 收录 扣分。',
    '- **新鲜度**：维护是否活跃。**1 = 近期活跃**；归档 0.4；无日期 0.85。按最近更新时间分段衰减，超过 14 天再整体 ×0.85。',
    '- **热度**：受欢迎程度（★star）。**0.6 ~ 1.3**，对数有界，防止 ★70k 通用库碾压真插件。',
    '',
    '> 两个常见误解：①「相关度 0.593」是**相对本轮最佳**的压缩值，不是绝对匹配率；②综合分高 = 四维均衡地好，**不代表功能最全**。挑插件请先看每张卡「它是做什么的」是否对症。',
  ].join('\n')
}

/**
 * 主渲染：返回给模型的完整中文文本。
 * @param {object} value execute 返回的结构化结果
 */
export function renderText (value) {
  if (!value || typeof value !== 'object') return '（无结果）'
  const out = []
  out.push(`# 查找结果：${value.query}`)
  out.push('')

  // 1) 源状态（先讲清楚数据可信范围）
  out.push(sourceStatus(value.sources, value.hostVersion))
  out.push('')
  out.push(`候选池 ${value.poolSize} 条 · 命中 ${value.matched} 条${value.hiddenUnvetted ? ` · 另有 ${value.hiddenUnvetted} 条未验证下限条目默认隐藏` : ''}`)
  out.push('')

  // 2) 没找到
  if (!value.found) {
    out.push('## 结论：没找到足够匹配的插件')
    out.push(value.note || '')
    out.push('')
    out.push(footer())
    return out.join('\n')
  }

  const rec = value.recommendation
  // 容错：value.found 为 true 但画像字段缺失时（外部 mock / 版本错位），
  // 退回「没找到」而不是渲染空卡片或抛错。
  if (!rec || !rec.score) {
    out.push('## 结论：没找到足够匹配的插件')
    out.push(value.note || '结果缺少可用的主推信息，请换个说法再试。')
    out.push('')
    out.push(footer())
    return out.join('\n')
  }
  const alternatives = value.alternatives || []
  const candidates = [
    { p: rec, isPrimary: true },
    ...alternatives.map((p) => ({ p, isPrimary: false })),
  ]

  // 3) 卡片流：一个插件一张卡，一张接一张，不用表格
  out.push(`下面把每个插件做成**一张卡片**，按推荐顺序一张接一张排好（共 ${candidates.length} 张）。先看每张卡「它是做什么的」判断是否对症，再看「综合评分拆解」里四个数字。`)
  out.push('')
  out.push('> 「★star / 30天下载」：★ 是 GitHub 星数；`30天 N↑/↓/→` 是 npm 近 30 天下载量与趋势（↑ 后半月比前半月高、↓ 更低、→ 持平，按前后半月日均比较）。纯 GitHub 安装目标不在 npm，显示「30天 —」。该项只作人气参考，**不参与排序**，与「热度」维度（对数有界乘子）是两回事。')
  out.push('')

  for (let i = 0; i < candidates.length; i++) {
    const { p, isPrimary } = candidates[i]
    out.push(card(p, { isPrimary, index: i, hostVersion: value.hostVersion }))
    out.push('')
    if (i < candidates.length - 1) {
      out.push('---')
      out.push('')
    }
  }

  // 4) 综合评分释义（非表格，逐条说明四个数字）
  out.push('---')
  out.push('')
  out.push(scoreLegend())
  out.push('')

  if (value.note) {
    out.push(`> ${value.note}`)
    out.push('')
  }

  out.push(footer())
  return out.join('\n')
}

function footer () {
  return [
    '---',
    '安装命令：`dsh plugin --profile <你的 profile> add <安装目标>`（把 <安装目标> 换成上面任一张卡里给出的值）。',
    '提醒：这些都是第三方插件，装之前建议先看仓库源码与权限；装完需重启 DSH 才会生效。',
    '本工具只做检索与推荐，不会替你安装或修改任何 profile。',
  ].join('\n')
}
