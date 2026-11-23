/**
 * 相关性层：零依赖的 BM25 + 中文 bigram 分词 + 中英同义词扩展 + 名称加权。
 *
 * 为什么不用别的：插件目录里 5126+ 条目、描述是中英混合的；纯子串匹配
 * 在「跨会话长期记忆」这类中文查询上几乎全灭。bigram 让「跨会话记忆」
 * 与「跨会话长期记忆」共享 跨会/会话/话记/记忆；同义词表让 agent 用英文
 * 提问时也能命中中文描述（反之亦然）。BM25 负责压低「插件 / plugin」
 * 这种到处都有的词，抬高真正的稀有词。
 *
 * @module dsh-find-right-plugin/text
 */

export const K1 = 1.5
export const B = 0.75

const LATIN_OR_CJK = /[a-z0-9]+|[\u4e00-\u9fff]+/g

/** latin 整词保留；每个连续 CJK 串内部切 bigram（不跨串拼接，避免造伪词）。 */
export function tokenize (text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = []
  LATIN_OR_CJK.lastIndex = 0
  let m
  while ((m = LATIN_OR_CJK.exec(s)) !== null) {
    const seg = m[0]
    if (/^[a-z0-9]+$/.test(seg)) {
      tokens.push(seg)
    } else if (seg.length === 1) {
      tokens.push(seg) // 单字中文无法切 bigram，保留单字
    } else {
      for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
    }
  }
  return tokens
}

/**
 * 英文复数/单数变体。只对 ≥4 字符的纯字母数字词动手，避免把
 * `is`/`as`/`ss` 结尾或短标识符改坏。
 */
export function pluralVariants (token) {
  if (!/^[a-z0-9]{4,}$/.test(token)) return []
  if (/ies$/.test(token)) return [token.replace(/ies$/, 'y')]
  if (/s$/.test(token)) {
    // 已经以 s 结尾：ss/us/is/as/os 结尾既不该盲去 s，更不该再加 s
    // （status → statuss 是错的），直接不给变体。
    if (/(ss|us|is|as|os)$/.test(token)) return []
    return [token.replace(/s$/, '')]
  }
  if (/[^aeiou]y$/.test(token)) return [token.replace(/y$/, 'ies')]
  return [token + 's']
}

// 中英双向同义组。每组 [A, B]，建表时互相指向；值可以是多个词。
const SYNONYM_PAIRS = [
  ['terminal', '终端'], ['tui', '终端'], ['memory', '记忆'],
  ['screenshot', '截图'], ['notification', '通知'], ['notify', '通知'],
  ['ocr', '文字识别'], ['translate', '翻译'], ['voice', '语音'], ['tts', '语音'],
  ['theme', '主题'], ['skin', '皮肤'], ['image', '图片'], ['search', '搜索'],
  ['sidebar', '侧边栏'], ['vision', '视觉'], ['context', '上下文'], ['model', '模型'],
  ['browser', '浏览器'], ['file', '文件'], ['session', '会话'], ['agent', '智能体'],
  ['task', '任务'], ['calendar', '日历'], ['wechat', '微信'], ['feishu', '飞书'],
  ['lark', '飞书'], ['proxy', '代理'], ['backup', '备份'], ['sync', '同步'],
  ['chart', '图表'], ['cost', '用量'], ['usage', '用量'], ['prompt', '提示词'],
  ['skill', '技能'], ['plugin', '插件'], ['email', '邮件'], ['mail', '邮件'],
  ['schedule', '定时'], ['cron', '定时'], ['push', '推送'], ['log', '日志'],
  ['monitor', '监控'], ['database', '数据库'], ['cli', '命令行'], ['docs', '文档'],
  ['download', '下载'], ['upload', '上传'], ['export', '导出'], ['import', '导入'],
  ['workflow', '工作流'], ['note', '笔记'], ['todo', '待办'], ['docker', '容器'],
  ['sms', '短信'], ['excel', '表格'],
]

const SYNONYMS = (() => {
  const map = new Map()
  const add = (a, b) => {
    if (!map.has(a)) map.set(a, [])
    if (!map.get(a).includes(b)) map.get(a).push(b)
  }
  for (const [a, b] of SYNONYM_PAIRS) {
    add(a, b); add(b, a)
  }
  // 常见缩写/中文俗称
  for (const [a, b] of [['dsh', 'deepseek'], ['llm', '大模型'], ['ai', '人工智能']]) {
    add(a, b); add(b, a)
  }
  return map
})()

/**
 * 查询词扩展：先复数变体（否则 screenshots 拿不到中文扩展），
 * 再对扩展后的每个词查同义词，把映射词重新分词后并入。
 */
export function expandTokens (queryTokens) {
  const base = new Set(queryTokens)
  for (const t of queryTokens) for (const v of pluralVariants(t)) base.add(v)
  const expanded = new Set(base)
  for (const t of base) {
    const syn = SYNONYMS.get(t)
    if (!syn) continue
    for (const word of syn) for (const tt of tokenize(word)) expanded.add(tt)
  }
  return [...expanded]
}

/** 参与匹配的文档文本。name 重复两次以压过描述命中；不含信任类字段。 */
export function documentText (item) {
  return [
    item.name, item.name, item.repo, item.npm,
    item.description?.en, item.description?.zh,
    item.category, (item.topics || []).join(' '),
  ].filter(Boolean).join(' ')
}

function buildCorpus (items) {
  const docs = items.map((it) => tokenize(documentText(it)))
  const N = docs.length
  const avg = N > 0 ? docs.reduce((s, d) => s + d.length, 0) / N : 0
  const df = new Map()
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1)
  }
  return { docs, N, avg, df }
}

function bm25Score (qTokens, doc, corpus) {
  if (doc.length === 0 || corpus.N === 0) return 0
  const tf = new Map()
  for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1)
  let score = 0
  for (const q of qTokens) {
    const f = tf.get(q) || 0
    if (f === 0) continue
    const n = corpus.df.get(q) || 0
    const idf = Math.log(1 + (corpus.N - n + 0.5) / (n + 0.5))
    score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * doc.length / Math.max(corpus.avg, 1)))
  }
  return score
}

/**
 * 名称/仓库命中加权。needles = 整条 query + 每个 ≥2 字符的查询词，取 max，
 * 否则多词查询时整串永远不命中、boost 失效。
 */
export function nameBoost (item, needles) {
  const name = String(item.name ?? '').toLowerCase()
  const repo = String(item.repo ?? '').toLowerCase()
  let best = 0
  for (const needle of needles) {
    const n = String(needle).toLowerCase()
    if (n.length < 2) continue
    let b = 0
    if (name === n || repo === n) b = 4
    else if (name.startsWith(n)) b = 2.5
    else if (name.includes(n)) b = 1.5
    else if (repo.includes(n)) b = 0.75
    if (b > best) best = b
  }
  return best
}

// 到处都有的泛词：它们不该参与「是否真的找到了相关插件」的判定，
// 否则任何查询都会因为命中 插件/dsh 而被当成「有结果」而硬推一个凑数的包。
export const STOP_TOKENS = new Set([
  'dsh', 'plugin', 'plugins', 'deepseek', 'harness', '插件',
  'the', 'for', 'with', 'and', '一个', '这个',
])

/**
 * 给每个条目算原始相关性分数，过滤 score>0 后按分数降序返回。
 * 这个分数会被 rank.js 归一化成 relevance 乘子。
 *
 * 额外产出两个「语料规模无关」的信号，供决策层判断「是否真找到了」：
 *   - coverage：查询内容词（去掉泛词、展开同义词后）在该文档中的命中比例。
 *     BM25 绝对分依赖 idf（语料越大分越高），不能拿来当绝对阈值；
 *     覆盖率只看「查询词有没有真的出现在文档里」，与语料大小无关。
 *   - nameHit：名称/仓库加权值，精确到插件名时可直接判定为找到。
 */
export function relevanceScores (query, items) {
  const rawTokens = tokenize(query)
  if (rawTokens.length === 0) return []
  const qTokens = expandTokens(rawTokens)
  // 覆盖率只用「查询原始内容词」做分母（同义词扩展只帮忙命中、不撑大分母），
  // 否则多语言扩展会把一个词变成 3 个，反而把真正相关的文档判成不相关。
  const origContent = [...new Set(rawTokens.filter((t) => !STOP_TOKENS.has(t) && t.length >= 2))]
  const variantMap = origContent.map((t) => ({ t, variants: expandTokens([t]) }))
  const needles = [String(query).trim(), ...rawTokens].filter((n) => n && n.length >= 2)
  const corpus = buildCorpus(items)
  const out = []
  for (let i = 0; i < items.length; i++) {
    const doc = corpus.docs[i]
    const nameHit = nameBoost(items[i], needles)
    const score = bm25Score(qTokens, doc, corpus) + nameHit
    if (score <= 0) continue
    const docSet = new Set(doc)
    // 一个原始词只要它的任一变体（复数 / 同义词 / 中文）出现在文档里就算命中，
    // 这样 'memory' 也能命中只有中文「记忆」的文档。
    const matched = variantMap.reduce((n, { variants }) => n + (variants.some((v) => docSet.has(v)) ? 1 : 0), 0)
    const coverage = origContent.length > 0 ? matched / origContent.length : 0
    out.push({ item: items[i], score, coverage, nameHit })
  }
  out.sort((a, b) => b.score - a.score || b.item.stars - a.item.stars)
  return out
}
