/**
 * 内部统一条目结构，以及把每个目录归一化、去重合并成一个候选池的纯函数。
 *
 * 每个数据源都先归一化成这里的 `entry()` 形状，合并逻辑因此不认识任何
 * 具体数据源、也不碰网络，可以离线单测。
 *
 * @module dsh-find-right-plugin/merge
 */

/**
 * 每个源的可信等级，及其隐含的证据等级。
 * rank 越高越可信；evidence 同时用作信任乘子与「谁验证过」的标签。
 */
export const SOURCE_CLASS = {
  'dsh.so': { rank: 5, evidence: 'verified' },
  radar: { rank: 4, evidence: 'tested' },
  catalog: { rank: 4, evidence: 'curated' }, // Awesome DSH 官方精选目录（dsh-plugin-catalog）
  lanshu: { rank: 3, evidence: 'curated' },
  awesome: { rank: 3, evidence: 'curated' },
  'dsh.works': { rank: 3, evidence: 'curated' },
  npm: { rank: 2, evidence: 'indexed' },
  github: { rank: 1, evidence: 'topic' },
}

export const EVIDENCE_RANK = { verified: 5, tested: 4, curated: 3, indexed: 2, topic: 1 }

// 仓库名在空白、路径分隔符、query/hash、以及包裹仓库的标点处结束
// （`[o/r](https://github.com/o/r)` 不能得到 `r)`）。贪婪且非锚定：
// 用 `$` 锚定会让结尾的 `)` 无法匹配，整条 URL 就废了。
const REPO_NAME = '[^/\\s#?)\\]}\'"`,;]+'

/** 从任意 GitHub URL 里取 `owner/name`。 */
export function repoFromUrl (url) {
  if (typeof url !== 'string') return null
  const m = new RegExp(`github\\.com[/:]([^/\\s]+)/(${REPO_NAME})`, 'i').exec(url.trim())
  if (m === null) return null
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`
}

/** 从 `github:owner/name#ref` 形式取 `owner/name`。 */
export function repoFromSpec (spec) {
  if (typeof spec !== 'string') return null
  const m = new RegExp(`^(?:github:|git\\+https?://github\\.com/|https?://github\\.com/)([^/\\s#]+)/(${REPO_NAME})`, 'i').exec(spec.trim())
  if (m === null) return null
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`
}

/**
 * 清洗一个「来源网址」：只接受可解析的 http(s) URL，去掉 `git+` 前缀、
 * 末尾 `.git` 与 `#readme` 之类锚点，并去掉结尾斜杠。不是 URL 就返回 null。
 * 用于把数据源自带的 homepage / repository / links 变成可点击链接。
 */
export function cleanSourceUrl (value) {
  if (typeof value !== 'string') return null
  let s = value.trim()
  if (!s) return null
  if (/^git\+/.test(s)) s = s.slice(4)
  s = s.replace(/\.git$/i, '')
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    // 保留数据源记录的原始路径（含结尾斜杠）——「如实采用来源网址」，
    // 不做会改变 URL 的画蛇添足式归一化。
    return u.toString()
  } catch {
    return null
  }
}

/** 把字符串或数组统一清洗成去重后的干净来源网址数组。 */
export function cleanSourceUrls (value) {
  const arr = Array.isArray(value) ? value : (value ? [value] : [])
  const out = []
  const seen = new Set()
  for (const v of arr) {
    const c = cleanSourceUrl(v)
    if (c && !seen.has(c)) { seen.add(c); out.push(c) }
  }
  return out
}

/** 按网址域名给出如实中文标签，不把非 GitHub 的链接冒充成「GitHub 仓库」。 */
export function labelForUrl (url) {
  let host = ''
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return '来源网址' }
  const map = {
    'github.com': 'GitHub 仓库',
    'npmjs.com': 'npm 包页',
    'awesome-dsh-plugin.com': 'Awesome DSH 目录页',
    'dsh.works': 'dsh.works 目录页',
    'dsh.so': 'dsh.so 索引页',
    'dsh.lanshuagent.com': '蓝书目录页',
  }
  return map[host] || `${host} 来源页`
}

// 允许交给 pnpm 的 # 片段：tag / 分支 / semver / commit SHA / path:/sub。
// 不含空白与 shell 元字符——这个片段会被回显到用户要执行的命令里。
const SPEC_FRAGMENT = /^[A-Za-z0-9._/@:+-]+$/

/** 安装 spec 的 `#…` 部分（源验证过的版本），或 null。 */
export function specFragment (spec) {
  if (typeof spec !== 'string') return null
  const hash = spec.indexOf('#')
  if (hash === -1) return null
  const fragment = spec.slice(hash + 1).trim()
  return SPEC_FRAGMENT.test(fragment) ? fragment : null
}

/** 把任意描述值强制成 `{ en, zh }`。 */
export function normalizeDescription (value) {
  if (value === null || value === undefined) return { en: '', zh: '' }
  if (typeof value === 'string') return textDescription(value)
  return {
    en: typeof value.en === 'string' ? value.en : '',
    zh: typeof value.zh === 'string' ? value.zh : '',
  }
}

/** 单字符串描述按是否含 CJK 归到正确的语言槽。 */
export function textDescription (text) {
  const value = typeof text === 'string' ? text : ''
  return /[\u4e00-\u9fff]/.test(value) ? { en: '', zh: value } : { en: value, zh: '' }
}

/** 优先取更丰富的描述：双语胜过单语。 */
export function betterDescription (a, b) {
  const score = (d) => (d.zh ? 1 : 0) + (d.en ? 1 : 0) + (d.en.length + d.zh.length) / 1000
  return score(b) > score(a) ? b : a
}

/**
 * 按语言槽合并两条描述：各取更长的那个。
 * 多源归并时，一个源常只有英文、另一个只有中文；「二选一」会白白丢掉
 * 一半信息，逐槽合并才能凑出真正完整的双语描述。
 */
export function mergeDescription (a, b) {
  const x = a || { en: '', zh: '' }
  const y = b || { en: '', zh: '' }
  return {
    en: (y.en || '').length > (x.en || '').length ? y.en : (x.en || ''),
    zh: (y.zh || '').length > (x.zh || '').length ? y.zh : (x.zh || ''),
  }
}

/** ISO-8601 字符串按字典序比较；空值排最后。 */
export function latestStamp (a, b) {
  if (!a) return b || null
  if (!b) return a
  return a > b ? a : b
}

/** 归一化条目的唯一构造器，各源都调它。 */
export function entry (fields) {
  const repo = fields.repo || null
  const npm = fields.npm || null
  const sourceId = fields.source
  const cls = SOURCE_CLASS[sourceId] || { rank: 0, evidence: 'topic' }
  const urls = cleanSourceUrls(fields.url)
  return {
    repo,
    // 没有仓库的包依然可能是能装的插件；给它独立的键命名空间，
    // 保证不与仓库键冲突，且下游能识别「npm-only」。
    key: repo ? repo.toLowerCase() : (npm ? `npm:${npm.toLowerCase()}` : null),
    // 只存数据源「真实记录」的网址，不在这里凭空拼 GitHub；
    // 没记录到就留空，由 projectLinks() 兜底（并如实标注兜底来源）。
    // `fields.url` 可为单个字符串或数组（如 catalog 同时记了目录页与 GitHub 源码）。
    url: urls[0] || null,
    urls,
    owner: repo ? repo.split('/')[0] : null,
    name: repo ? repo.split('/')[1] : (fields.name || (npm ? npm.split('/').pop() : null)),
    description: normalizeDescription(fields.description),
    stars: Number.isFinite(fields.stars) ? fields.stars : 0,
    pushedAt: fields.pushedAt || null,
    archived: fields.archived === true,
    license: fields.license || null,
    npm,
    npmVersion: fields.npmVersion || null,
    ref: fields.ref || null,
    path: fields.path || null,
    compat: fields.compat || null,
    category: fields.category || null,
    topics: Array.isArray(fields.topics) ? fields.topics.filter((t) => typeof t === 'string') : [],
    verification: fields.verification || null,
    security: fields.security || null,
    notes: Array.isArray(fields.notes) ? fields.notes : [],
    sources: [sourceId],
    evidence: cls.evidence,
  }
}

/** 把多源条目按 key 去重合并，每个字段取「最好」的那个。 */
export function mergeEntries (entries) {
  const byKey = new Map()
  for (const raw of entries) {
    if (!raw || !raw.key) continue
    const cur = byKey.get(raw.key)
    if (cur === undefined) {
      byKey.set(raw.key, {
        ...raw,
        sources: [...(raw.sources ?? [])],
        notes: [...(raw.notes ?? [])],
        topics: [...(raw.topics ?? [])],
        urls: [...(raw.urls ?? [])],
      })
      continue
    }
    cur.sources = [...new Set([...cur.sources, ...(raw.sources ?? [])])]
    if ((EVIDENCE_RANK[raw.evidence] || 0) > (EVIDENCE_RANK[cur.evidence] || 0)) cur.evidence = raw.evidence
    // 各源记录的真实网址都保留下来，让卡片能列出多个来源页
    cur.urls = cleanSourceUrls([
      ...(cur.urls ?? (cur.url ? [cur.url] : [])),
      ...(raw.urls ?? (raw.url ? [raw.url] : [])),
    ])
    cur.url = cur.urls[0] || cur.url || null
    cur.description = mergeDescription(cur.description, raw.description)
    if (raw.stars > cur.stars) cur.stars = raw.stars
    cur.pushedAt = latestStamp(cur.pushedAt, raw.pushedAt)
    cur.archived = cur.archived || raw.archived === true
    cur.license = cur.license || raw.license
    cur.npm = cur.npm || raw.npm
    cur.npmVersion = cur.npmVersion || raw.npmVersion
    cur.ref = cur.ref || raw.ref
    cur.path = cur.path || raw.path
    cur.compat = cur.compat || raw.compat
    cur.category = cur.category || raw.category
    cur.topics = [...new Set([...cur.topics, ...(raw.topics ?? [])])]
    cur.verification = cur.verification || raw.verification
    cur.security = cur.security || raw.security
    cur.notes = [...new Set([...cur.notes, ...(raw.notes ?? [])])]
  }
  return [...byKey.values()]
}

/**
 * 安装目标，不含 profile 名（profile 是调用方的事，写死会装错地方）。
 * 保留源验证过的 ref 与 monorepo 子路径——降级成裸仓库等于「装当前 HEAD」，
 * 那是未经验证、甚至可能是坏的。
 */
export function installTarget (item) {
  if (item.npm) return item.npm
  if (!item.repo) return null
  const parts = []
  if (item.ref) parts.push(item.ref)
  if (item.path && !String(item.ref ?? '').includes('path:')) parts.push(`path:/${item.path}`)
  return `github:${item.repo}${parts.length > 0 ? `#${parts.join('&')}` : ''}`
}

/**
 * 一个插件的「来源网址」列表：优先用各数据源**真实记录**的网址（目录页、
 * GitHub 源码、npm 包页…），按域名如实标注；只有没记到网址时才用 repo /
 * npm 名兜底拼 GitHub / npm 链接。返回 `[{ label, url }]`，最多 3 条、去重。
 * 只用于展示，不参与排序，也不改变 installTarget。
 */
export function projectLinks (item) {
  if (!item) return []
  const out = []
  const seen = new Set()
  const push = (url, label) => {
    const clean = cleanSourceUrl(url)
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    out.push({ label: label || labelForUrl(clean), url: clean })
  }
  // 1) 数据源真实记录的网址优先，保持记录顺序
  const recorded = Array.isArray(item.urls) && item.urls.length
    ? item.urls
    : (item.url ? [item.url] : [])
  for (const u of recorded) push(u)
  // 2) 有仓库但真实链接里没有指向该仓库的 → 补一条 GitHub 兜底
  if (item.repo && !out.some((l) => {
    const r = repoFromUrl(l.url)
    return r && r.toLowerCase() === item.repo.toLowerCase()
  })) {
    push(`https://github.com/${item.repo}`, 'GitHub 仓库')
  }
  // 3) 有 npm 名但没有任何 npm 包页链接 → 补一条 npm 兜底
  if (item.npm && !out.some((l) => /npmjs\.com/i.test(l.url))) {
    push(`https://www.npmjs.com/package/${item.npm}`, 'npm 包页')
  }
  return out.slice(0, 3)
}

/** 兼容旧调用：返回第一条来源网址（项目主页），没有则 null。 */
export function projectUrl (item) {
  const links = projectLinks(item)
  return links.length ? links[0] : null
}

/** 从源自带的安装命令里抽出目标（要求含 plugin 子命令，避免误匹配散文）。 */
export function targetFromCommand (command) {
  if (typeof command !== 'string') return null
  const m = /\bplugin\b[^\n]*?\sadd\s+(\S+)\s*$/.exec(command.trim())
  return m ? m[1] : null
}

// 合法的 npm 包名：可选 scope，无空格、无 shell 元字符。
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** 裸 npm 包名（不是 git spec / 路径 / URL / 整条命令），否则 null。 */
export function npmNameFromTarget (target) {
  if (typeof target !== 'string') return null
  let t = target.trim()
  if (t === '') return null
  const fromCommand = targetFromCommand(t)
  if (fromCommand !== null) t = fromCommand
  if (/^(github:|git\+|git@|https?:|\.{1,2}\/|\/)/.test(t)) return null
  if (t.includes('#')) return null
  const at = t.lastIndexOf('@') // `name@1.2.3` → `name`
  if (at > 0) t = t.slice(0, at)
  return NPM_NAME.test(t) ? t : null
}

/** `owner/name` 形式的仓库字符串校验（dsh.works 用）。 */
export function cleanRepo (value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : null
}
