// dsh-plugin-yanyan-toolkit — 会话管理中心 · 全文搜索索引（Phase 2）。
//
// 设计纪律（来自用户 m00997 技术方案）：
//   1) 旁路只读：只解压读取 $DSH_HOME/sessions/**/session.v4.jsonl.zstd，绝不写原生会话文件；
//   2) 复用现成解码轮子：packages/dsh-plugin-yanyan-subagent/lib/zstd-frames.js 的 decodeLog(buf)
//      —— DSH 把日志写成多帧 zstd，必须逐帧解码再拼接，直接 zstdDecompressSync 只能解第一帧；
//   3) 内存倒排索引：Map<token, Set<sessionId>>，中文 2-gram + 单字、英文/数字整词；
//   4) 分片异步：setImmediate 每批让出事件循环，绝不阻塞主线程；
//   5) 熔断：单文件压缩 > 10MB 跳过，解压文本/每会话留档有上限，防止 OOM；
//   6) 增量更新：updateSession(logPath) 只重扫单个文件。
//
// 真实日志结构（真机验证 2026-11-17）：
//   event.type === 'user/message'      → data.content 是 [{type:'text',text}, ...]
//   event.type === 'assistant/message' → data.message.content 是 [{type:'reasoning'|'text'|'tool-call',text|...}, ...]
//   只取 type==='text' 的文本，跳过 reasoning / tool-call / tool-result。

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeLog } from '../packages/dsh-plugin-yanyan-subagent/lib/zstd-frames.js';

export const SEARCH_API_PREFIX = '/api/dsh-yanyan-session-hub';

export const SEARCH_DEFAULTS = Object.freeze({
  maxCompressedBytes: 10 * 1024 * 1024,   // 单文件压缩上限 10MB，超过熔断跳过
  maxDecodedChars: 8 * 1024 * 1024,       // 单文件解压文本上限 8M 字符，超过截断
  maxKeptTextPerSession: 200 * 1024,      // 每会话留档文本上限 200K 字符（供片段高亮）
  batchSize: 6,                            // 每批处理的日志文件数，批间 setImmediate 让出
  snippetRadius: 60,                       // 匹配片段上下文半径（字符）
  maxSnippetsPerHit: 3,                    // 每条命中最多返回片段数
  limit: 50,                               // 默认返回条数
});

const NODE_FS = { readFileSync, statSync, readdirSync, existsSync };

/** 把 Unicode 字符串切成分词 token：CJK 用「单字 + 相邻 2-gram」，ASCII 字母数字用整词（小写）。 */
export function tokenize(text) {
  const out = new Set();
  if (typeof text !== 'string' || text.length === 0) return out;
  const lower = text.toLowerCase();
  // 用正则分段：CJK 连续段 / ASCII 单词连续段，其余分隔符忽略。
  const segments = lower.match(/[\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9_]+/g) || [];
  for (const seg of segments) {
    if (/^[\u3400-\u9fff\uf900-\ufaff]+$/.test(seg)) {
      // 中文：单字（便于单字查询）+ 相邻 2-gram（便于词组查询）
      const chars = Array.from(seg);
      for (const ch of chars) out.add(ch);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    } else {
      // 英文/数字：只保留整词（含下划线，如 web_fetch）。
      // 不切 3-gram：常见 3-gram 会把大量无关文档拉进候选，造成「不存在的词命中全部」的误命中。
      out.add(seg);
    }
  }
  return out;
}

/** 从一段日志明文里抽取 (role, text, time) 消息序列；只取真正的对话文本。 */
export function extractMessages(decoded) {
  const messages = [];
  const lines = String(decoded || '').split('\n');
  for (const line of lines) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    let role = null;
    let parts = null;
    if (ev.type === 'user/message') {
      role = 'user';
      parts = ev.data && Array.isArray(ev.data.content) ? ev.data.content : null;
    } else if (ev.type === 'assistant/message') {
      role = 'assistant';
      const msg = ev.data && ev.data.message;
      parts = msg && Array.isArray(msg.content) ? msg.content : null;
    }
    if (!role || !parts) continue;
    const texts = [];
    for (const part of parts) {
      if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text);
      }
    }
    if (texts.length === 0) continue;
    messages.push({ role, text: texts.join('\n'), time: Number(ev.time) || 0 });
  }
  return messages;
}

/**
 * 从日志首行 `type:'session'` 事件提取会话元数据：cwd（工作区路径）/createdAt/
 * parentSession/origin。真机验证这条 header 事件每个会话都有，是最可靠的工作区来源。
 * 只读、fail-closed：解析失败返回空对象。
 */
export function extractSessionHeader(decoded) {
  const out = { cwd: null, createdAt: null, parentSession: null, origin: null };
  try {
    const lines = String(decoded || '').split('\n');
    for (const line of lines) {
      if (!line || line.indexOf('"session"') < 0) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      // header 事件形如 {type:'session', version:4, id, createdAt, cwd, parentSession, origin}
      if (!ev || ev.type !== 'session') continue;
      if (typeof ev.cwd === 'string') out.cwd = ev.cwd;
      if (typeof ev.createdAt === 'number') out.createdAt = ev.createdAt;
      else if (typeof ev.createdAt === 'string') out.createdAt = Date.parse(ev.createdAt) || null;
      if (typeof ev.parentSession === 'string') out.parentSession = ev.parentSession;
      if (typeof ev.origin === 'string') out.origin = ev.origin;
      break;
    }
  } catch { /* fail-closed */ }
  return out;
}

/** 扫描 sessions 根下所有 session.v4.jsonl.zstd 路径（结构与 allSessionLogPaths 一致，避免拉进整个 log-rewrite.js）。 */
export function listLogPaths(dshHome, fs = NODE_FS) {
  const root = join(dshHome, 'sessions');
  const out = [];
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const slug of slugs) {
    let segs = [];
    try { segs = fs.readdirSync(join(root, slug)); } catch { continue; }
    for (const seg of segs) {
      const p = join(root, slug, seg, 'session.v4.jsonl.zstd');
      try { if (fs.existsSync(p)) out.push({ logPath: p, sessionId: seg }); } catch { /* 跳过 */ }
    }
  }
  return out;
}

/**
 * 构造全文搜索索引。返回对象方法：
 *   rebuild()                → Promise<status>  全量冷启动扫描（分片异步）
 *   updateSession(logPath)   → Promise<bool>    增量重扫单个文件
 *   search(query, opts)      → 同步查询结果（索引在内存）
 *   status()                 → 当前索引状态快照
 *   stop()                   → 取消正在进行的扫描
 */
export function createSearchIndex(options = {}) {
  const cfg = { ...SEARCH_DEFAULTS, ...(options.config || {}) };
  const fs = options.fs || NODE_FS;
  const dshHome = options.dshHome;
  const decode = options.decodeLog || decodeLog;
  const yieldFn = options.yieldFn || ((cb) => setImmediate(cb));

  // docs: sessionId -> { id, title, text, tokens:Set, size }
  const docs = new Map();
  // inverted: token -> Set<sessionId>
  const inverted = new Map();
  // pathIndex: logPath -> sessionId（增量更新用）
  const pathIndex = new Map();
  // 扫描状态
  let state = 'idle';       // idle | scanning | ready | stopped
  let scanned = 0;
  let total = 0;
  let skipped = 0;
  let failed = 0;
  let generation = 0;        // cancel token
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  function statusSnapshot() {
    return {
      state,
      sessions: docs.size,
      tokens: inverted.size,
      scanned,
      total,
      skipped,
      failed,
    };
  }

  function clearIndex() {
    docs.clear();
    inverted.clear();
    pathIndex.clear();
  }

  function indexDocument(sessionId, title, messages, updatedAt, meta) {
    // 拼接留档文本（限长）
    let text = '';
    for (const m of messages) {
      if (text.length >= cfg.maxKeptTextPerSession) break;
      text += (m.role === 'user' ? '用户: ' : '助手: ') + m.text + '\n';
    }
    if (text.length > cfg.maxKeptTextPerSession) text = text.slice(0, cfg.maxKeptTextPerSession);
    const tokens = tokenize(title + '\n' + text);
    // 先移除旧文档（增量更新）
    unindexDocument(sessionId);
    const h = meta || {};
    docs.set(sessionId, {
      id: sessionId, title, text, tokens, size: text.length, updatedAt: updatedAt || null,
      // 会话预览/工作区卡片所需元数据（来自日志 header，只读）。
      cwd: h.cwd || null,
      createdAt: h.createdAt || null,
      parentSession: h.parentSession || null,
      origin: h.origin || null,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      empty: h.empty === true,
      oversize: h.oversize === true,
    });
    for (const tok of tokens) {
      let set = inverted.get(tok);
      if (!set) { set = new Set(); inverted.set(tok, set); }
      set.add(sessionId);
    }
  }

  /** 全量会话清单（供会话管理中心列表用）：host 端拿不到 client-only 的 sessions 服务时，
   *  索引本身就扫全了 sessions 目录，这里直接把已索引的会话暴露成列表数据源。 */
  function listSessions() {
    const out = [];
    for (const d of docs.values()) {
      out.push({
        id: d.id, title: d.title, updatedAt: d.updatedAt || null,
        cwd: d.cwd || null, createdAt: d.createdAt || null,
        parentSession: d.parentSession || null, origin: d.origin || null,
        messageCount: d.messageCount || 0, size: typeof d.size === 'number' ? d.size : null,
        empty: d.empty === true, oversize: d.oversize === true,
      });
    }
    return out;
  }

  function unindexDocument(sessionId) {
    const prev = docs.get(sessionId);
    if (prev) {
      for (const tok of prev.tokens) {
        const set = inverted.get(tok);
        if (set) {
          set.delete(sessionId);
          if (set.size === 0) inverted.delete(tok);
        }
      }
      docs.delete(sessionId);
    }
  }

  function titleFromMessages(sessionId, messages, decoded) {
    // 优先从 session/title 事件取标题
    try {
      const lines = String(decoded || '').split('\n');
      for (const line of lines) {
        if (!line || line.indexOf('session/title') < 0) continue;
        const ev = JSON.parse(line);
        if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
          return ev.data.title.trim();
        }
      }
    } catch { /* 回退 */ }
    // 回退：第一条用户消息前 40 字
    const first = messages.find((m) => m.role === 'user');
    if (first) {
      const t = first.text.replace(/\s+/g, ' ').trim();
      return t.length > 40 ? t.slice(0, 40) + '…' : t;
    }
    return sessionId;
  }

  function processLog(entry) {
    const { logPath, sessionId } = entry;
    try {
      const st = fs.statSync(logPath);
      if (st.size > cfg.maxCompressedBytes) {
        // 超大文件不解压（防 OOM），但仍登记一条空文档用于管理清单计数/归档/删除。
        skipped += 1;
        indexDocument(sessionId, sessionId, [], st.mtimeMs ? Math.trunc(st.mtimeMs) : null, { oversize: true, empty: true });
        pathIndex.set(logPath, sessionId);
        return true;
      }
      const buf = fs.readFileSync(logPath);
      if (buf.length > cfg.maxCompressedBytes) {
        skipped += 1;
        indexDocument(sessionId, sessionId, [], st.mtimeMs ? Math.trunc(st.mtimeMs) : null, { oversize: true, empty: true });
        pathIndex.set(logPath, sessionId);
        return true;
      }
      const decoded = decode(buf);
      if (decoded.length > cfg.maxDecodedChars) {
        // 熔断：截断到上限再解析（仍可搜到前面的内容）
      }
      const raw = decoded.length > cfg.maxDecodedChars ? decoded.slice(0, cfg.maxDecodedChars) : decoded;
      const messages = extractMessages(raw);
      const header = extractSessionHeader(raw);
      // 活跃时间优先取最后一条消息自带的时间，回退到日志文件 mtime。
      let updatedAt = null;
      const last = messages[messages.length - 1];
      if (last && typeof last.time === 'number') updatedAt = last.time;
      else if (last && typeof last.time === 'string') updatedAt = Date.parse(last.time) || null;
      if (!updatedAt) {
        try { updatedAt = st.mtimeMs ? Math.trunc(st.mtimeMs) : null; } catch { updatedAt = null; }
      }
      if (messages.length === 0) {
        // 空会话（无 user/assistant 文本）也要纳入管理清单，供归档/删除/打标使用。
        // 索引里保留一条「空文档」：带 header 元数据与 mtime，但不产生内容 token，
        // 只有 sessionId 本身可命中，避免空会话污染全文搜索结果。
        indexDocument(sessionId, sessionId, [], updatedAt, Object.assign({}, header, { empty: true }));
        pathIndex.set(logPath, sessionId);
        return true;
      }
      const title = titleFromMessages(sessionId, messages, raw);
      indexDocument(sessionId, title, messages, updatedAt, header);
      pathIndex.set(logPath, sessionId);
      return true;
    } catch (error) {
      failed += 1;
      return false;
    }
  }

  function rebuild() {
    const myGen = ++generation;
    state = 'scanning';
    scanned = 0; skipped = 0; failed = 0;
    const entries = listLogPaths(dshHome, fs);
    total = entries.length;
    clearIndex();
    return new Promise((resolve) => {
      let cursor = 0;
      function step() {
        if (myGen !== generation) { state = 'stopped'; resolve(statusSnapshot()); return; }
        const end = Math.min(cursor + cfg.batchSize, entries.length);
        for (; cursor < end; cursor++) {
          processLog(entries[cursor]);
          scanned += 1;
        }
        onProgress(statusSnapshot());
        if (cursor < entries.length) {
          yieldFn(step);
        } else {
          state = 'ready';
          onProgress(statusSnapshot());
          resolve(statusSnapshot());
        }
      }
      if (entries.length === 0) {
        state = 'ready';
        resolve(statusSnapshot());
      } else {
        yieldFn(step);
      }
    });
  }

  function updateSession(logPath) {
    const sessionId = pathIndex.get(logPath);
    if (sessionId) unindexDocument(sessionId);
    // 即便是新文件，也尝试从路径推断 sessionId
    const parts = String(logPath).split(/[\\/]/);
    const inferred = sessionId || parts[parts.length - 2] || logPath;
    return Promise.resolve(processLog({ logPath, sessionId: inferred }));
  }

  function makeSnippets(doc, queryTokens, queryRaw) {
    const out = [];
    const lowerRaw = (queryRaw || '').toLowerCase();
    // 标题命中兜底：当查询词只出现在标题里（正文无命中，如 "mn"→"Mnemon..."），
    // 把标题本身作为一个带高亮的片段返回，避免结果面板出现空白片段。
    if (doc.title && lowerRaw && doc.title.toLowerCase().indexOf(lowerRaw) >= 0) {
      const t = lowerRaw;
      const i = doc.title.toLowerCase().indexOf(t);
      out.push({
        text: doc.title,
        ranges: [{ start: i, end: i + t.length }],
      });
    }
    if (!doc.text) return out;
    const paras = doc.text.split('\n');
    for (const para of paras) {
      if (!para.trim()) continue;
      const lower = para.toLowerCase();
      // 命中判定：原文子串 或 任一 query token
      const directIdx = lowerRaw ? lower.indexOf(lowerRaw) : -1;
      let tokenIdx = -1;
      if (directIdx < 0) {
        for (const tok of queryTokens) {
          const i = lower.indexOf(tok);
          if (i >= 0) { tokenIdx = i; break; }
        }
      }
      const hitIdx = directIdx >= 0 ? directIdx : tokenIdx;
      if (hitIdx < 0) continue;
      const start = Math.max(0, hitIdx - cfg.snippetRadius);
      const end = Math.min(para.length, hitIdx + Math.max(lowerRaw.length, 1) + cfg.snippetRadius);
      const snippetText = (start > 0 ? '…' : '') + para.slice(start, end) + (end < para.length ? '…' : '');
      // 计算高亮区间（相对片段文本）
      const ranges = [];
      const highlightTerms = [];
      if (lowerRaw) highlightTerms.push(lowerRaw);
      for (const tok of queryTokens) if (tok.length >= 1) highlightTerms.push(tok);
      const snippetLower = snippetText.toLowerCase();
      const prefixLen = start > 0 ? 1 : 0;
      for (const term of highlightTerms) {
        if (!term) continue;
        let from = 0;
        for (;;) {
          const i = snippetLower.indexOf(term, from);
          if (i < 0) break;
          ranges.push({ start: i, end: i + term.length });
          from = i + Math.max(term.length, 1);
          if (ranges.length > 30) break;
        }
      }
      ranges.sort((a, b) => a.start - b.start);
      out.push({ text: snippetText, ranges });
      if (out.length >= cfg.maxSnippetsPerHit) break;
    }
    return out;
  }

  /**
   * 查询验证词：中文只取 2-gram（单字查询除外），英文取整词。
   * 与 tokenize 不同——查询侧刻意剔除单字与 3-gram，避免「不存在的词命中全部」的误命中。
   */
  function queryTerms(q) {
    const compact = String(q || '').toLowerCase().replace(/\s+/g, '');
    if (!compact) return [];
    const terms = new Set();
    const segments = compact.match(/[\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9_]+/g) || [];
    for (const seg of segments) {
      if (/^[\u3400-\u9fff\uf900-\ufaff]+$/.test(seg)) {
        const chars = Array.from(seg);
        if (chars.length === 1) { terms.add(chars[0]); continue; }
        for (let i = 0; i + 1 < chars.length; i++) terms.add(chars[i] + chars[i + 1]);
      } else {
        terms.add(seg);
      }
    }
    return Array.from(terms);
  }

  function search(query, opts = {}) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return { ok: true, query: q, total: 0, hits: [], status: statusSnapshot() };
    const limit = Math.max(1, Math.min(Number(opts.limit) || cfg.limit, 200));
    const terms = queryTerms(q);
    if (terms.length === 0) return { ok: true, query: q, total: 0, hits: [], status: statusSnapshot() };
    const compact = q.toLowerCase().replace(/\s+/g, '');

    // ① 倒排召回：把含任一查询词的会话拉进候选（这一步只做粗筛，不代表命中）
    const candidates = new Set();
    for (const tok of terms) {
      const set = inverted.get(tok);
      if (!set) continue;
      for (const sid of set) candidates.add(sid);
    }

    // ①b 标题子串兜底召回：前缀/短查询（如 "mn" 匹配 "Mnemon..."）在倒排里没有对应整词，
    //     仅靠 queryTerms 整词召回会漏掉。标题只有几百条短字符串，直接扫一遍成本极低。
    for (const [sid, doc] of docs) {
      if (doc.title && doc.title.toLowerCase().indexOf(compact) >= 0) candidates.add(sid);
    }

    // ② 子串精排：整句子串命中为强命中；否则要求 ≥60% 查询词命中，杜绝误命中
    const ranked = [];
    for (const sid of candidates) {
      const doc = docs.get(sid);
      if (!doc) continue;
      const lowerText = doc.text.toLowerCase();
      const lowerTitle = doc.title.toLowerCase();
      const titleHit = lowerTitle.indexOf(compact) >= 0;
      let score = 0;
      if (lowerText.indexOf(compact) >= 0) {
        score = 1000;
      } else if (titleHit) {
        // 标题子串命中（如 "mn" → "Mnemon skill review"）也算有效命中。
        score = 500;
      } else {
        let hit = 0;
        for (const t of terms) if (lowerText.indexOf(t) >= 0) hit += 1;
        const ratio = hit / terms.length;
        if (ratio < 0.6) continue; // 命中比例不足 → 丢弃（关键：干掉误命中）
        score = Math.round(ratio * 100);
      }
      if (titleHit) score += 500;
      ranked.push({ sid, score, doc });
    }
    ranked.sort((a, b) => b.score - a.score || String(a.sid).localeCompare(String(b.sid)));

    const hits = [];
    for (const r of ranked) {
      if (hits.length >= limit) break;
      const snippets = makeSnippets(r.doc, new Set(terms), q);
      hits.push({
        sessionId: r.sid,
        title: r.doc.title,
        score: r.score,
        matched: snippets.length,
        snippets,
      });
    }
    return { ok: true, query: q, total: ranked.length, hits, status: statusSnapshot() };
  }

  function stop() { generation += 1; if (state === 'scanning') state = 'stopped'; }

  return {
    rebuild,
    updateSession,
    search,
    listSessions,
    status: statusSnapshot,
    stop,
    // 暴露给测试/诊断
    _docs: docs,
    _inverted: inverted,
    _cfg: cfg,
  };
}
