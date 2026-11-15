// dsh-plugin-yanyan-subagent / lib/log-rewrite.js
//
// 根治 append-only `subagentCatalog` 残留：把父会话日志里的
// `subagent/catalog` 事件「原位退休」成 `subagent-delete/retired`。
//
// 移植自 huajiao1998/dsh-plugin-subagent-clean@0.3.0 的 rewriteCatalogRows /
// retireCatalogRow / pending 队列 / scrubCatalogRows，原始实现来自
// heiheiha798/dsh-plugin-subagent-delete@0.2.3（MIT）。
// 版权所有 (c) heiheiha798；派生改动同样以 MIT 许可发布。
//
// 为什么必须「原位替换」而不是删行 / 重编号：
//   ① 会话日志的 `seq` 必须从 0 连续，删行会留洞；
//   ② `compaction/summary` 压缩事件会引用更早的 seq 区间，重编号会错位。
// 把命中行改成「未知类型 + ignorable:true」，seq/time 原样保留，其余事件
// 逐字节不动；目录投影只在 `type === "subagent/catalog"` 时生成行，于是
// 该行从父目录 / 侧边栏彻底消失，而日志的连续性与压缩引用都不受影响。
// `ignorable` 的放行规则来自 dsh-session-format-v3-to-v4（未知类型 +
// ignorable 才被保留）。
//
// 本模块全部为纯文件操作，`dshHome` 显式传参，不读 process.env，方便单测。

import {
  existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
  renameSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { decodeLog, encodeLog } from './zstd-frames.js';

/** 与 index.js 的 coreId 保持一致：去 `session-` 前缀后的核心 id。 */
export function logCoreId(value) {
  return String(value || '').replace(/^session-/, '');
}

/** 会话 id 的两种拼写（裸 uuid 与 `session-` 前缀）。 */
export function logVariants(sessionId) {
  const c = logCoreId(sessionId);
  return [c, 'session-' + c];
}

/** 扫 `<dshHome>/sessions/<slug>/<variant>` 找会话目录。 */
export function findSessionDirs(dshHome, sessionId) {
  const root = join(dshHome, 'sessions');
  let slugs = [];
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    return [];
  }
  const variants = logVariants(sessionId);
  const found = [];
  for (const slug of slugs) {
    for (const variant of variants) {
      const candidate = join(root, slug, variant);
      try {
        if (statSync(candidate).isDirectory()) found.push(candidate);
      } catch (error) { /* 继续扫 */ }
    }
  }
  return found;
}

/** 列出 sessions 根下所有 `session.v4.jsonl.zstd` 的路径。 */
export function allSessionLogPaths(dshHome) {
  const root = join(dshHome, 'sessions');
  let slugs = [];
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    let segs = [];
    try { segs = readdirSync(join(root, slug)); } catch (error) { continue; }
    for (const seg of segs) {
      const p = join(root, slug, seg, 'session.v4.jsonl.zstd');
      if (existsSync(p)) out.push({ logPath: p, parentId: seg, dir: join(root, slug, seg) });
    }
  }
  return out;
}

/** 一遍扫全 sessions 根，收集所有已落盘的会话目录名。 */
export function storedSessionDirNames(dshHome) {
  const ids = new Set();
  for (const entry of allSessionLogPaths(dshHome)) ids.add(entry.parentId);
  // 目录存在但没有日志的会话也算「还在」。
  const root = join(dshHome, 'sessions');
  let slugs = [];
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) { return ids; }
  for (const slug of slugs) {
    try {
      for (const e of readdirSync(join(root, slug), { withFileTypes: true })) {
        if (e.isDirectory()) ids.add(e.name);
      }
    } catch (error) { /* 继续扫 */ }
  }
  return ids;
}

/** 删掉某会话的投影缓存文件，让宿主下次重新按（已改写的）日志 fold。 */
export function dropProjectionCache(dshHome, sessionId) {
  const root = join(dshHome, 'storages', 'session_projcache', 'sessions');
  let n = 0;
  for (const variant of logVariants(sessionId)) {
    try {
      const p = join(root, variant + '.json');
      if (existsSync(p)) { rmSync(p, { force: true }); n += 1; }
    } catch (error) { /* 尽力而为 */ }
  }
  return n;
}

/**
 * 从父会话日志读出「仍会生成目录行」的 catalog 事件。
 * 已退休的 `subagent-delete/retired` 不再计入 —— 返回的正是宿主重建投影后
 * 还会显示、也就是用户想清理的那些行。日志是真相源，比会被重建的 projcache
 * 缓存可靠。
 */
export function readCatalogEvents(dshHome, parentSessionId) {
  const out = [];
  for (const dir of findSessionDirs(dshHome, parentSessionId)) {
    const logPath = join(dir, 'session.v4.jsonl.zstd');
    if (!existsSync(logPath)) continue;
    let text;
    try { text = decodeLog(readFileSync(logPath)); } catch (error) { continue; }
    const lines = text.split('\n').filter((line) => line.length > 0);
    for (const line of lines.slice(1)) {
      let event = null;
      try { event = JSON.parse(line); } catch (error) { continue; }
      if (event === null || event.type !== 'subagent/catalog') continue;
      const data = event.data;
      if (data === null || typeof data !== 'object' || typeof data.childId !== 'string') continue;
      out.push({
        childId: data.childId,
        label: String(data.label || ''),
        name: String(data.name || ''),
        mode: String(data.mode || ''),
        createdAt: Number(data.childCreatedAt || 0),
        seq: event.seq,
        time: event.time,
      });
    }
    break; // 同一父会话只可能有一份日志，命中即用。
  }
  return out;
}

/**
 * 改写一份明确指定的父会话日志：把 shouldDrop(childId) 命中的
 * `subagent/catalog` 事件原位退休。写临时文件 → 前后各 stat 一次 → 一致才
 * rename，绝不在并发写入时覆盖宿主刚追加的事件（丢事件会破坏 seq 连续性）。
 *
 * @returns {{ok:boolean, removed:number, kept?:number, reason?:string}}
 */
export function rewriteCatalogRowsInFile(logPath, shouldDrop) {
  if (!logPath || !existsSync(logPath)) return { ok: false, removed: 0, reason: 'no-log' };
  let before;
  let text;
  try {
    before = statSync(logPath);
    text = decodeLog(readFileSync(logPath));
  } catch (error) {
    return { ok: false, removed: 0, reason: 'decode-failed: ' + String((error && error.message) || error) };
  }
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length < 2) return { ok: false, removed: 0, reason: 'empty-log' };
  const header = lines[0];
  const kept = [];
  let removed = 0;
  for (const line of lines.slice(1)) {
    let event = null;
    try { event = JSON.parse(line); } catch (error) { kept.push(line); continue; }
    if (event !== null && event.type === 'subagent/catalog') {
      const childId = event.data && event.data.childId;
      if (typeof childId === 'string' && shouldDrop(childId) === true) {
        kept.push(JSON.stringify({
          type: 'subagent-delete/retired',
          seq: event.seq,
          time: event.time,
          ignorable: true,
          data: { childId, retiredAt: Date.now() },
        }));
        removed += 1;
        continue;
      }
    }
    kept.push(line);
  }
  if (removed === 0) return { ok: true, removed: 0 };

  const encoded = encodeLog(header, kept);
  // ① 读完后第一次 stat：若日志在解码期间被写过，放弃。
  let after;
  try { after = statSync(logPath); } catch (error) {
    return { ok: false, removed: 0, reason: 'stat-failed' };
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    return { ok: false, removed: 0, reason: 'concurrent-write' };
  }
  const tmp = logPath + '.rewrite-' + String(process.pid);
  try {
    writeFileSync(tmp, encoded, { mode: before.mode });
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    return { ok: false, removed: 0, reason: 'write-failed: ' + String((error && error.message) || error) };
  }
  // ② rename 前再 stat 一次：第一次检查之后追加的单个事件也不能被覆盖。
  let last;
  try { last = statSync(logPath); } catch (error) { last = null; }
  if (last === null || last.size !== before.size || last.mtimeMs !== before.mtimeMs) {
    try { rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    return { ok: false, removed: 0, reason: 'concurrent-write' };
  }
  try {
    renameSync(tmp, logPath);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    return { ok: false, removed: 0, reason: 'rename-failed: ' + String((error && error.message) || error) };
  }
  return { ok: true, removed, kept: kept.length };
}

/** 按父会话 id 找到它的日志并改写。 */
export function rewriteCatalogRows(dshHome, parentSessionId, shouldDrop) {
  for (const dir of findSessionDirs(dshHome, parentSessionId)) {
    const candidate = join(dir, 'session.v4.jsonl.zstd');
    if (existsSync(candidate)) {
      const result = rewriteCatalogRowsInFile(candidate, shouldDrop);
      if (result.ok === true && result.removed > 0) dropProjectionCache(dshHome, parentSessionId);
      return result;
    }
  }
  return { ok: false, removed: 0, reason: 'no-log' };
}

/**
 * 扫全部会话日志，退休所有 childId 命中 coreIds 的 catalog 行。
 * 这样既能命中 rootSessionId 那条父日志，也能命中「孙辈 / 幽灵条目散落在
 * 其它历史会话」的情况。返回每个被改写文件的明细。
 */
export function retireCatalogRowsEverywhere(dshHome, coreIds, parentHint) {
  const set = new Set((Array.isArray(coreIds) ? coreIds : [coreIds]).map(logCoreId));
  const shouldDrop = (id) => set.has(logCoreId(id));
  const out = { files: [], removed: 0, failed: [], scanned: 0 };
  let entries = allSessionLogPaths(dshHome);
  // 优先处理父会话日志（用户当下看的那个），其余按路径顺序。
  if (parentHint) {
    const hintCore = logCoreId(parentHint);
    entries = entries.slice().sort((a, b) => {
      const ah = logCoreId(a.parentId) === hintCore ? 0 : 1;
      const bh = logCoreId(b.parentId) === hintCore ? 0 : 1;
      return ah - bh;
    });
  }
  for (const entry of entries) {
    out.scanned += 1;
    let result;
    try { result = rewriteCatalogRowsInFile(entry.logPath, shouldDrop); }
    catch (error) { result = { ok: false, reason: String((error && error.message) || error) }; }
    if (result.ok === true && result.removed > 0) {
      out.files.push({ parentId: entry.parentId, removed: result.removed });
      out.removed += result.removed;
      dropProjectionCache(dshHome, entry.parentId);
    } else if (result.ok === false && result.reason && result.reason !== 'no-log') {
      out.failed.push({ parentId: entry.parentId, reason: result.reason });
    }
  }
  return out;
}

/**
 * 退休单个子智能体的 catalog 行。命中 id 用 coreId 比较，兼容 catalog 里的
 * 裸 childId 与调用方传来的 `session-` 前缀写法。失败时排队到 pending 文件，
 * 宿主下次启动补做。
 */
export function retireCatalogRow(dshHome, parentSessionId, childId, pendingPath, everywhere = true) {
  const core = logCoreId(childId);
  const result = everywhere
    ? retireCatalogRowsEverywhere(dshHome, [core], parentSessionId)
    : rewriteCatalogRows(dshHome, parentSessionId, (id) => logCoreId(id) === core);
  // 全库模式下某份历史日志若因并发写失败，按它自己的 parentId 精确排队，
  // 宿主下次启动用 gone 谓词补做（不能只靠父会话的 key，否则补不到那份日志）。
  if (pendingPath && Array.isArray(result.failed)) {
    for (const f of result.failed) {
      if (f && typeof f.parentId === 'string') queueCatalogRetire(pendingPath, f.parentId, core);
    }
  }
  if (result.removed > 0) return { retired: true, queued: false, removed: result.removed, result };
  // 没删到行：可能是日志里本来就没有（幽灵只存在于缓存），不算失败、不排队。
  // 明确失败的判定：单文件模式看 result.ok===false；全库模式看 failed 非空。
  const hardFailed = everywhere
    ? (Array.isArray(result.failed) && result.failed.length > 0)
    : (result.ok === false);
  if (!hardFailed) return { retired: false, queued: false, removed: 0, result };
  if (pendingPath) queueCatalogRetire(pendingPath, parentSessionId, core);
  return { retired: false, queued: true, removed: 0, result };
}

export function pendingFilePath(dshHome) {
  return join(dshHome, 'yanyan-subagent-pending.json');
}

export function readPending(pendingPath) {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

export function queueCatalogRetire(pendingPath, parentSessionId, childCoreId) {
  try {
    const pending = readPending(pendingPath);
    const list = Array.isArray(pending[parentSessionId]) ? pending[parentSessionId] : [];
    if (list.includes(childCoreId) !== true) list.push(childCoreId);
    pending[parentSessionId] = list;
    mkdirSync(dirname(pendingPath), { recursive: true });
    writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8');
  } catch (error) { /* 排队是尽力而为 */ }
}

/**
 * 宿主启动时重放排队的退休。只在父会话「冷」（无 live agent）时改写；
 * 用 shouldDrop=「子会话目录已不在」的谓词，保证只退休确实已删除的行。
 * liveAgentIds 为当前存活会话 id 的 Set（由调用方从 ctx.agents 采集）。
 */
export function flushPendingRewrites(dshHome, liveAgentIds) {
  const pendingPath = pendingFilePath(dshHome);
  const pending = readPending(pendingPath);
  const parents = Object.keys(pending);
  if (parents.length === 0) return { ok: true, parents: 0, removed: 0 };
  const stored = storedSessionDirNames(dshHome);
  const live = liveAgentIds instanceof Set ? liveAgentIds : new Set();
  const gone = (id) => !stored.has(id) && !stored.has('session-' + id);
  let removed = 0;
  let cleared = 0;
  for (const parentId of parents) {
    if (live.has(parentId) || live.has(logCoreId(parentId)) || live.has('session-' + logCoreId(parentId))) continue;
    try {
      const result = rewriteCatalogRows(dshHome, parentId, gone);
      if (result.ok === true) removed += result.removed;
      else continue; // 保持队列，下次再试
    } catch (error) { continue; }
    delete pending[parentId];
    cleared += 1;
  }
  try { writeFileSync(pendingPath, JSON.stringify(pending, null, 2), 'utf8'); } catch (error) { /* ignore */ }
  return { ok: true, parents: parents.length, cleared, removed };
}

/** 扫父会话里所有「子会话目录已不在、catalog 行还在」的残留并退休。 */
export function scrubCatalogRows(dshHome, parentSessionId, everywhere = false) {
  const stored = storedSessionDirNames(dshHome);
  const gone = (id) => !stored.has(id) && !stored.has('session-' + id);
  if (everywhere) {
    const out = { files: [], removed: 0, failed: [], scanned: 0 };
    for (const entry of allSessionLogPaths(dshHome)) {
      out.scanned += 1;
      let result;
      try { result = rewriteCatalogRowsInFile(entry.logPath, gone); }
      catch (error) { result = { ok: false, reason: String((error && error.message) || error) }; }
      if (result.ok === true && result.removed > 0) {
        out.files.push({ parentId: entry.parentId, removed: result.removed });
        out.removed += result.removed;
        dropProjectionCache(dshHome, entry.parentId);
      }
    }
    return out;
  }
  const result = rewriteCatalogRows(dshHome, parentSessionId, gone);
  return { files: result.removed > 0 ? [{ parentId: parentSessionId, removed: result.removed }] : [], removed: result.removed, ok: result.ok, reason: result.reason };
}

/**
 * 扫全库 zstd 会话日志，收集所有已被「原位退休」的 childId（核心 id）。
 *
 * 用途：官方「N 个子智能体」浮层读的是宿主进程内存里的 live 投影 fold state，
 * 改磁盘日志 / 删 projcache 都不会让已经加载的父会话重算，残留行因此「删不掉」。
 * host 把这份「全库已退休清单」经 /config 下发给 client，client 据此持续过滤
 * 内存投影 projectionsBySession，才能真正让官方浮层里的幽灵行消失。
 * 日志是 append-only 真相源：凡 `type === 'subagent-delete/retired'` 的 data.childId
 * 都曾被此插件删除过，重开 GUI 后也必须继续隐藏。
 */
export function collectRetiredIds(dshHome) {
  const ids = new Set();
  for (const entry of allSessionLogPaths(dshHome)) {
    let text;
    try { text = decodeLog(readFileSync(entry.logPath)); } catch (error) { continue; }
    // 预筛：整份日志里没有退休标记就跳过逐行 JSON.parse，省掉绝大多数开销。
    if (text.indexOf('subagent-delete/retired') === -1) continue;
    for (const line of text.split('\n')) {
      if (line.indexOf('"subagent-delete/retired"') === -1) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (error) { continue; }
      if (ev && ev.type === 'subagent-delete/retired' && ev.data && ev.data.childId) {
        ids.add(logCoreId(ev.data.childId));
      }
    }
  }
  return [...ids];
}
