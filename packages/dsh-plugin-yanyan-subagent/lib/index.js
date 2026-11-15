// dsh-plugin-yanyan-subagent — Host half（纯 ESM）。
//
// host 半区职责：
//   ① /health   健康检查；
//   ② /config   回显 normalizeConfig 后的配置；
//   ③ /list     可选兜底数据源：ctx.get('subagents').listDescendants()；
//   ④ /purge    物理删除一个子智能体（/archive 保留为兼容别名）。
// 所有 /__ 路由统一经过 ctx.connection.requestRejection(req) 准入栅栏。
//
// 为什么必须物理删除而不是归档：
//   subagentCatalog 是父会话日志里 `subagent/catalog` 事件的 append-only
//   投影（官方 @deepseek-ai/dsh-chunked-list 只追加、无删除）。archiveSession
//   只是打个标记，既不删会话数据，也移除不了 catalog 引用；对 mnemon 虚拟
//   委派（id 形如 mnemon-run-v1-<uuid>，不是 session-<uuid> 会话）更会直接
//   报 session/not-found。所以这里：真实会话优先复用现成的
//   /api/dsh-session-archive/delete 物理删除管线；无论成功与否，都再做一轮
//   本地清理（会话目录 / projcache / catalog 引用 / workspace 记账 / 台账 /
//   归档标记），并把命中条目的 id 交给 client 的持久化隐藏清单兜底。
//
// 本文件导出的纯函数同时供 test/*.test.mjs 做单元测试，不依赖 DSH 运行时。

import {
  existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  readCatalogEvents, allSessionLogPaths, retireCatalogRow,
  retireCatalogRowsEverywhere, scrubCatalogRows, flushPendingRewrites,
  pendingFilePath, dropProjectionCache, queueCatalogRetire,
} from './log-rewrite.js';

export const name = 'dsh-plugin-yanyan-subagent';
export const VERSION = '1.2.0';

// 顶层硬依赖只保留路由与准入所必需的；模型工具通过可选的 ctx.inject(['tools'])
// 注册，没有该服务时静默降级，绝不影响下面这些 HTTP 路由的加载。
export const inject = ['webServer', 'connection'];

const ROUTE_BASE = '/__dsh-plugin-yanyan-subagent';
export const HEALTH_ROUTE = `${ROUTE_BASE}/health`;
export const CONFIG_ROUTE = `${ROUTE_BASE}/config`;
export const LIST_ROUTE = `${ROUTE_BASE}/list`;
export const CATALOG_ROUTE = `${ROUTE_BASE}/catalog`;
export const ARCHIVE_ROUTE = `${ROUTE_BASE}/archive`;
export const PURGE_ROUTE = `${ROUTE_BASE}/purge`;
export const SCRUB_ROUTE = `${ROUTE_BASE}/scrub`;
export const CLEANUP_ROUTE = `${ROUTE_BASE}/cleanup`;
export const DELETE_API = '/api/dsh-session-archive/delete';

const BODY_LIMIT = 64 * 1024;
export const DEFAULT_TAB_LABEL = '智能体管理';
export const CONFIG_DEFAULTS = Object.freeze({
  tabLabel: DEFAULT_TAB_LABEL,
  autoCleanEnabled: false,
  idleMinutes: 30,
  checkIntervalMin: 1,
  labelMaxLength: 24,
});

// ───────────────── 纯函数：配置归一化（供测试导入） ─────────────────
// profile 覆盖层对同名 id 是整份替换 config、不做深合并，所以每个缺省
// key 都必须在这里兜底。idleMinutes 限制 1..10080，checkIntervalMin
// 限制 1..1440，tabLabel 去首尾空白、超长按 labelMaxLength 截断、空则回落默认。
export function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const maxLength = CONFIG_DEFAULTS.labelMaxLength;

  let tabLabel = typeof c.tabLabel === 'string' ? c.tabLabel.trim() : '';
  if (!tabLabel) tabLabel = DEFAULT_TAB_LABEL;
  else if (tabLabel.length > maxLength) tabLabel = tabLabel.slice(0, maxLength);

  let idleMinutes = Number(c.idleMinutes);
  if (!Number.isFinite(idleMinutes)) idleMinutes = CONFIG_DEFAULTS.idleMinutes;
  idleMinutes = Math.floor(idleMinutes);
  if (idleMinutes < 1 || idleMinutes > 10080) idleMinutes = CONFIG_DEFAULTS.idleMinutes;

  let checkIntervalMin = Number(c.checkIntervalMin);
  if (!Number.isFinite(checkIntervalMin)) checkIntervalMin = CONFIG_DEFAULTS.checkIntervalMin;
  checkIntervalMin = Math.floor(checkIntervalMin);
  if (checkIntervalMin < 1 || checkIntervalMin > 1440) checkIntervalMin = CONFIG_DEFAULTS.checkIntervalMin;

  return {
    tabLabel,
    autoCleanEnabled: c.autoCleanEnabled === true,
    idleMinutes,
    checkIntervalMin,
    labelMaxLength: maxLength,
  };
}

// ───────────────── 纯函数：catalog 兼容解析（供测试导入） ─────────────────
// 官方投影值可能是 SubagentListEntry[] 数组，也可能是 {entries:[...]} /
// {rows:[...]}，还可能为空 / 缺失。统一收敛成条目数组。
function isRow(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
export function parseCatalog(raw) {
  if (Array.isArray(raw)) return raw.filter(isRow);
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.entries)) return raw.entries.filter(isRow);
    if (Array.isArray(raw.rows)) return raw.rows.filter(isRow);
  }
  return [];
}

// ───────────────── 纯函数：空闲清理筛选（供测试导入） ─────────────────
// 规则：仅 activity==='inactive'；排除 diagnostic 行、running 行、rootId 自身；
// idleMs = now - idleSince(id)，idleSince 缺省为 now（即刚观察到，空闲 0）。
// idleMinutes<=0 表示不按阈值过滤（只要空闲就选）。
export function idleFilter(rows, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const rootId = opts.rootId;
  const idleMinutes = typeof opts.idleMinutes === 'number' && Number.isFinite(opts.idleMinutes)
    ? opts.idleMinutes : CONFIG_DEFAULTS.idleMinutes;
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const since = typeof opts.idleSince === 'function' ? opts.idleSince : () => now;
  const threshold = idleMinutes > 0 ? idleMinutes * 60_000 : 0;
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    if (!isRow(row)) continue;
    if (row.kind === 'diagnostic') continue;
    if (row.activity === 'running') continue;
    if (row.activity !== 'inactive') continue;
    if (rootId != null && row.id === rootId) continue;
    const started = since(row.id);
    const base = typeof started === 'number' && Number.isFinite(started) ? started : now;
    const idleMs = now - base;
    if (threshold > 0 && idleMs < threshold) continue;
    out.push(row);
  }
  return out;
}

// ───────────────── 纯函数：删除 id 安全校验（供测试导入） ─────────────────
// sessionId 必须是非空字符串且不含 / \ ..；不做任何路径操作。
export function isSafeSessionId(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.indexOf('/') !== -1) return false;
  if (value.indexOf('\\') !== -1) return false;
  if (value.indexOf('..') !== -1) return false;
  return true;
}

// ───────────────── 纯函数：id 归一化与路径安全（供测试导入） ─────────────────
// 同一会话在父 catalog 里是裸 id，在归档清单里常带 `session-` 前缀。
// 一律用「去前缀后的核心 id」做主键，保证两种拼写都命中。
export function coreId(value) {
  return String(value || '').replace(/^session-/, '');
}
export function spellings(value) {
  const c = coreId(value);
  return [c, 'session-' + c];
}
// mnemon 的虚拟委派（run/task/review 等）都不是真正的 session-<uuid> 会话。
export function isVirtualId(value) {
  return /^mnemon-/i.test(coreId(value));
}
export function isInside(root, child) {
  const r = resolve(root), c = resolve(child);
  return c === r || c.startsWith(r + sep);
}
function matchesId(value, core) {
  return typeof value === 'string' && coreId(value) === core;
}

// 从 projcache 的 chunked-list head（含 previous 分片）里剔除命中条目。
// 返回 {changed, removed}；changed=true 时调用方应把 record 写回磁盘。
export function stripCatalogEntries(record, ids) {
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(coreId));
  const rows = record && record.record && record.record.rows;
  const cat = rows && rows.subagentCatalog;
  const head = cat && cat.val && cat.val.head;
  if (!head) return { changed: false, removed: 0 };
  let removed = 0;
  let changed = false;
  const seen = new Set();
  for (let chunk = head; chunk && !seen.has(chunk); chunk = chunk.previous) {
    seen.add(chunk);
    if (!Array.isArray(chunk.values)) continue;
    const next = chunk.values.filter((v) => {
      const cid = v && (v.childId || v.id);
      const hit = typeof cid === 'string' && set.has(coreId(cid));
      if (hit) removed += 1;
      return !hit;
    });
    if (next.length !== chunk.values.length) {
      chunk.values = next;
      changed = true;
    }
  }
  return { changed, removed };
}

export function catalogFilePath(dshHome, sessionId) {
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');
  const c = coreId(sessionId);
  const name = String(sessionId).startsWith('session-') ? String(sessionId) : 'session-' + c;
  return join(dir, name + '.json');
}

// DSH_HOME：优先环境变量；桌面启动器没有 --profile / DSH_PROFILE，但宿主把
// {name, dir, patchPath} 挂在 profileContext 上。dir 可能是 profile 目录，
// 向上找同时含 storages/ 与 sessions/ 的祖先即为 DSH_HOME。
export function resolveDshHome(ctx) {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  let facts;
  try {
    facts = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
  } catch (error) { facts = undefined; }
  if (facts && typeof facts.dshHome === 'string' && facts.dshHome) return facts.dshHome;
  const dirs = [];
  if (facts && typeof facts.dir === 'string' && facts.dir) dirs.push(facts.dir);
  if (facts && typeof facts.patchPath === 'string' && facts.patchPath) dirs.push(resolve(facts.patchPath, '..'));
  for (const start of dirs) {
    let cur = resolve(start);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(cur, 'storages')) && existsSync(join(cur, 'sessions'))) return cur;
      const parent = resolve(cur, '..');
      if (parent === cur) break;
      cur = parent;
    }
  }
  return '';
}

// ───────────────── 本地物理清理（纯文件操作，可单测） ─────────────────
function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (error) { return null; }
}
function writeJsonAtomic(p, obj) {
  const tmp = p + '.yanyan.tmp';
  writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  renameSync(tmp, p);
}

/**
 * 物理删除一个会话在本机留下的全部痕迹。
 * 限定在 dshHome 内；所有目录删除都做 realpath 校验，防止符号链接越界。
 * 遍历所有 projcache 的 catalog 文件（幽灵条目可能落在任意父会话缓存里，
 * 不一定是 client 传来的 rootSessionId 那个文件）。
 */
export function purgePhysical(dshHome, id, rootSessionId) {
  const out = {
    dirs: [], files: [], archived: 0, members: 0, ledger: 0,
    catalog: [], catalogRemoved: 0, index: 0, skipped: [],
  };
  if (!dshHome) return out;
  const c = coreId(id);

  // ① 会话目录（两种拼写）。
  const sessionsRoot = join(dshHome, 'sessions');
  if (existsSync(sessionsRoot)) {
    let rootReal;
    try { rootReal = realpathSync(sessionsRoot); } catch (error) { rootReal = resolve(sessionsRoot); }
    for (const proj of readdirSync(sessionsRoot)) {
      const pp = join(sessionsRoot, proj);
      let st;
      try { st = statSync(pp); } catch (error) { continue; }
      if (!st.isDirectory()) continue;
      for (const seg of readdirSync(pp)) {
        if (!matchesId(seg, c)) continue;
        // 绝不删父会话目录本身。
        if (rootSessionId && matchesId(seg, coreId(rootSessionId))) {
          out.skipped.push(join(pp, seg) + ' (父会话，跳过)');
          continue;
        }
        const dir = join(pp, seg);
        try {
          const real = realpathSync(dir);
          if (!isInside(rootReal, real)) { out.skipped.push(dir + ' (路径越界)'); continue; }
          out.dirs.push(dir);
          rmSync(real, { recursive: true, force: true });
        } catch (error) {
          out.skipped.push(dir + ' (' + String((error && error.message) || error) + ')');
        }
      }
    }
  }

  // ② projcache：清掉所有 catalog 文件里的命中条目 + 删幽灵自己的缓存文件。
  const pdir = join(dshHome, 'storages', 'session_projcache', 'sessions');
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(pdir, f);
      const rec = readJsonSafe(p);
      if (!rec) continue;
      const strip = stripCatalogEntries(rec, [c]);
      if (strip.changed) {
        out.catalog.push(f + ' (-' + strip.removed + ')');
        out.catalogRemoved += strip.removed;
        try { writeJsonAtomic(p, rec); } catch (error) { out.skipped.push(p); }
      }
      if (matchesId(f.replace(/\.json$/, ''), c)) {
        out.files.push(p);
        try { unlinkSync(p); } catch (error) { /* 已不存在 */ }
      }
    }
  }
  // 聚合索引（若存在）。
  const idxPath = join(dshHome, 'storages', 'session_projcache.json');
  if (existsSync(idxPath)) {
    const doc = readJsonSafe(idxPath);
    const t = doc && doc.tables && doc.tables.sessions;
    if (t) {
      let n = 0;
      for (const k of Object.keys(t)) {
        if (matchesId(k, c)) { delete t[k]; n += 1; }
      }
      if (n > 0) {
        out.index = n;
        try { writeJsonAtomic(idxPath, doc); } catch (error) { /* 只读时忽略 */ }
      }
    }
  }

  // ③ workspace.json：归档标记 + 各 workspace 的 sessionIds 记账。
  const wp = join(dshHome, 'storages', 'workspace.json');
  if (existsSync(wp)) {
    const doc = readJsonSafe(wp);
    if (doc) {
      let changed = false;
      const g = doc.global;
      if (g && Array.isArray(g.archivedSessionIds)) {
        const next = g.archivedSessionIds.filter((x) => !matchesId(x, c));
        out.archived = g.archivedSessionIds.length - next.length;
        if (out.archived > 0) { g.archivedSessionIds = next; changed = true; }
      }
      const ws = doc.tables && doc.tables.workspaces;
      const list = Array.isArray(ws) ? ws : (ws && typeof ws === 'object' ? Object.values(ws) : []);
      for (const w of list) {
        if (!w || !Array.isArray(w.sessionIds)) continue;
        const next = w.sessionIds.filter((x) => !matchesId(x, c));
        out.members += w.sessionIds.length - next.length;
        if (next.length !== w.sessionIds.length) { w.sessionIds = next; changed = true; }
      }
      if (changed) {
        try { writeJsonAtomic(wp, doc); } catch (error) { out.skipped.push(wp); }
      }
    }
  }

  // ④ 归档台账（dsh-session-archive 的 archivedAt 事实源）。
  const lp = join(dshHome, 'dsh-session-archive', 'archive-ledger.json');
  if (existsSync(lp)) {
    const doc = readJsonSafe(lp);
    const e = doc && doc.entries;
    if (e && typeof e === 'object') {
      let n = 0;
      for (const k of Object.keys(e)) {
        if (matchesId(k, c)) { delete e[k]; n += 1; }
      }
      if (n > 0) {
        out.ledger = n;
        try { writeJsonAtomic(lp, doc); } catch (error) { /* 只读时忽略 */ }
      }
    }
  }
  return out;
}

// ───────────────── HTTP 基础 ─────────────────
function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve_) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve_(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, reason: 'body-too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        finish({ ok: false, reason: 'invalid-body' });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'request-error' }));
  });
}

async function parsePayload(req, res, allowedMethods) {
  const method = String(req.method || 'GET').toUpperCase();
  if (allowedMethods.indexOf(method) === -1) {
    respond(res, 405, { ok: false, error: 'method-not-allowed', message: '请求方法不被允许。' });
    return null;
  }
  const read = await readBody(req);
  if (!read.ok) {
    respond(res, 413, { ok: false, error: read.reason, message: '请求体过大或读取失败。' });
    return null;
  }
  try {
    return JSON.parse(read.text || '{}');
  } catch (error) {
    respond(res, 400, { ok: false, error: 'invalid-json', message: '请求体不是合法 JSON。' });
    return null;
  }
}

// 统一准入：仅当 requestRejection 返回 undefined 时放行，不放行一律 403。
function guard(req, res, ctx) {
  if (ctx.connection.requestRejection(req) === undefined) return true;
  respond(res, 403, { ok: false, error: 'forbidden', message: '请求未通过 DSH 准入裁决。' });
  return false;
}

// ───────────────── 路由 handlers ─────────────────
function makeHealthHandler(ctx) {
  return function healthHandler(req, res) {
    if (!guard(req, res, ctx)) return;
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      respond(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    respond(res, 200, { ok: true, version: VERSION });
  };
}

/**
 * 一次性迁移清单：旧版「删除=归档」遗留、已由 cleanup 脚本从磁盘清除、
 * 但会因 append-only catalog 重建而复现的 id。/config 把它们下发给 client，
 * client 在启动时并入持久化隐藏清单。文件不存在/损坏一律返回空数组。
 */
export function legacyHiddenIds() {
  try {
    const url = new URL('./legacy-hidden-ids.json', import.meta.url);
    const doc = JSON.parse(readFileSync(url, 'utf8'));
    const list = doc && Array.isArray(doc.ids) ? doc.ids : [];
    return list.filter((x) => typeof x === 'string' && x).map(coreId);
  } catch (error) {
    return [];
  }
}

function makeConfigHandler(ctx, cfg) {
  return async function configHandler(req, res) {
    if (!guard(req, res, ctx)) return;
    const payload = await parsePayload(req, res, ['POST']);
    if (payload === null) return;
    respond(res, 200, { ok: true, config: cfg, legacyHiddenIds: legacyHiddenIds() });
  };
}

// 可选增强：ctx.get('subagents').listDescendants(rootSessionId) 返回子智能体列表。
// 服务缺失或抛错都收敛成 service-unavailable，绝不抛到外层。
function makeListHandler(ctx) {
  return async function listHandler(req, res) {
    if (!guard(req, res, ctx)) return;
    const payload = await parsePayload(req, res, ['POST']);
    if (payload === null) return;
    const rootSessionId = typeof payload.rootSessionId === 'string' ? payload.rootSessionId : '';
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('subagents') : null;
      if (!service || typeof service.listDescendants !== 'function') {
        respond(res, 200, { ok: false, error: 'service-unavailable', rows: [] });
        return;
      }
      const rows = await service.listDescendants(rootSessionId);
      respond(res, 200, { ok: true, rows: Array.isArray(rows) ? rows : [] });
    } catch (error) {
      respond(res, 200, { ok: false, error: 'service-unavailable', rows: [] });
    }
  };
}

/** 真实会话优先复用现成的 dsh-session-archive 物理删除管线。 */
async function tryOfficialDelete(ctx, id) {
  try {
    const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : null;
    const origin = ws && typeof ws.getOrigin === 'function' ? ws.getOrigin() : '';
    if (!origin || typeof fetch !== 'function') {
      return { ok: false, reason: 'webServer/fetch 不可用' };
    }
    const canonical = String(id).startsWith('session-') ? id : 'session-' + id;
    const resp = await fetch(origin.replace(/\/$/, '') + DELETE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [canonical] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { ok: false, reason: 'HTTP ' + resp.status };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

/**
 * 删除一条子智能体的核心逻辑（HTTP handler 与模型工具共用）。
 *
 * 在 turn 2 物理删除（会话目录 / projcache / 归档标记 / 工作区记账 / 台账）之上，
 * turn 3 增加决定性的一步：把父会话日志里的 `subagent/catalog` 事件「原位退休」。
 * 这是根治 append-only 残留的唯一办法 —— 只清 projcache 缓存，运行中的宿主
 * 下次 refreshProjections 仍会按日志把行 fold 回来（19:57 实证）。改写日志后
 * 再删投影缓存，宿主重建时就再也看不到这一行，侧边栏残留同步消失。
 *
 * @returns 纯 JSON 结果对象（不写 HTTP 响应），供 handler / 工具复用。
 */
export async function performPurge(ctx, sessionId, rootSessionId, stopActivity, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const virtual = isVirtualId(sessionId);
  const dshHome = resolveDshHome(ctx);
  const warnings = [];

  // running 时先停活（尽力而为，两种拼写都试）。
  if (stopActivity) {
    const sub = typeof ctx.get === 'function' ? ctx.get('subagents') : null;
    if (sub && typeof sub.interruptByUser === 'function') {
      for (const s of spellings(sessionId)) {
        try { sub.interruptByUser(s); break; } catch (error) { /* 换拼写再试 */ }
      }
    }
  }

  // 真实会话：优先走现成物理删除管线（会清 sqlite rdb / projcache index）。
  let official = null;
  if (!virtual) official = await tryOfficialDelete(ctx, sessionId);

  // 归档标记：用公开 seam 从 workspaceRegistry 摘掉（比直接改文件更可靠）。
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null;
  let unarchived = 0;
  if (registry && typeof registry.unarchiveSession === 'function') {
    for (const s of spellings(sessionId)) {
      try { await registry.unarchiveSession(s); unarchived += 1; } catch (error) { /* 不在归档集合 */ }
    }
  }

  // 本地兜底清理：会话目录 / projcache / catalog 引用 / workspace 记账 / 台账。
  const report = purgePhysical(dshHome, sessionId, rootSessionId);
  if (!dshHome) warnings.push('未解析到 DSH_HOME，文件级清理已跳过；客户端仍会隐藏该条目。');
  if (official && !official.ok) warnings.push('现成删除管线未生效：' + official.reason);

  // 根治 append-only catalog：把日志里的 catalog 行原位退休（全库扫，父日志优先）。
  // 失败（并发写 / 解码错）会排队到 pending 文件，宿主下次启动补做；本地隐藏
  // 清单仍会立即生效，用户当下不会再看到该行。
  // 批量清理时 skipCatalogRetire=true：由调用方最后统一改写一次日志，避免 N 次全库解压。
  let catalog = { retired: false, removed: 0, queued: false };
  if (dshHome && !opts.skipCatalogRetire) {
    try {
      catalog = retireCatalogRow(dshHome, rootSessionId, sessionId, pendingFilePath(dshHome), true);
      if (catalog.queued) warnings.push('日志改写遇到并发写入，已排队到下次启动补做；本地隐藏清单立即生效。');
      // 删投影缓存，促使宿主按（已改写的）日志重新 fold，而不是复用旧缓存。
      if (rootSessionId) dropProjectionCache(dshHome, rootSessionId);
    } catch (error) {
      warnings.push('日志改写失败：' + String((error && error.message) || error));
    }
  }

  const deleted = report.dirs.length + report.files.length + report.archived
    + report.members + report.ledger + report.catalogRemoved + report.index + unarchived;
  return {
    ok: true,
    sessionId,
    virtual,
    rootSessionId,
    deleted,
    unarchived,
    catalogRemoved: report.catalogRemoved,
    catalogRetired: catalog.removed,
    catalogQueued: catalog.queued,
    official: official ? official.ok : null,
    warnings,
    message: (catalog.removed > 0 || catalog.queued)
      ? '已物理删除并从父会话日志根除该子智能体，侧边栏残留行不会再被重建。'
      : (virtual
        ? '已清理虚拟委派条目（会话目录 / 缓存 / 归档标记），并从列表隐藏。'
        : '已物理删除会话数据，并清理 catalog 引用与工作区记账。'),
    report,
  };
}

/**
 * 物理删除 handler。/purge 是正式入口，/archive 保留为旧 client 的兼容别名。
 * client 传 {sessionId, rootSessionId, stopActivity}。
 */
export function makeDeleteHandler(ctx) {
  return async function deleteHandler(req, res) {
    if (!guard(req, res, ctx)) return;
    const payload = await parsePayload(req, res, ['POST']);
    if (payload === null) return;
    const sessionId = payload.sessionId;
    const rootSessionId = typeof payload.rootSessionId === 'string' ? payload.rootSessionId : '';
    const stopActivity = payload.stopActivity === true;
    if (!isSafeSessionId(sessionId)) {
      respond(res, 200, { ok: false, error: 'invalid-session-id', message: '会话 ID 不合法。' });
      return;
    }
    if (rootSessionId && !isSafeSessionId(rootSessionId)) {
      respond(res, 200, { ok: false, error: 'invalid-root-session-id', message: '父会话 ID 不合法。' });
      return;
    }
    try {
      const result = await performPurge(ctx, sessionId, rootSessionId, stopActivity);
      respond(res, 200, result);
    } catch (error) {
      respond(res, 200, {
        ok: false,
        error: 'purge-failed',
        message: String((error && error.message) || error),
      });
    }
  };
}

/** 从「日志真相源」列出父会话里仍会生成目录行的 catalog 事件（供一键清理 / 模型工具）。 */
export function makeCatalogHandler(ctx) {
  return async function catalogHandler(req, res) {
    if (!guard(req, res, ctx)) return;
    const payload = await parsePayload(req, res, ['POST']);
    if (payload === null) return;
    const rootSessionId = typeof payload.rootSessionId === 'string' ? payload.rootSessionId : '';
    if (rootSessionId && !isSafeSessionId(rootSessionId)) {
      respond(res, 200, { ok: false, error: 'invalid-root-session-id', message: '父会话 ID 不合法。' });
      return;
    }
    const dshHome = resolveDshHome(ctx);
    const rows = dshHome && rootSessionId ? readCatalogEvents(dshHome, rootSessionId) : [];
    respond(res, 200, { ok: true, rootSessionId, rows, count: rows.length });
  };
}

/** 清理残留行：把父会话里「子会话目录已不在、catalog 行还在」的条目全部原位退休。 */
export function makeScrubHandler(ctx) {
  return async function scrubHandler(req, res) {
    if (!guard(req, res, ctx)) return;
    const payload = await parsePayload(req, res, ['POST']);
    if (payload === null) return;
    const rootSessionId = typeof payload.rootSessionId === 'string' ? payload.rootSessionId : '';
    const everywhere = payload.everywhere === true;
    if (!everywhere && !isSafeSessionId(rootSessionId)) {
      respond(res, 200, { ok: false, error: 'invalid-root-session-id', message: '父会话 ID 不合法。' });
      return;
    }
    try {
      const dshHome = resolveDshHome(ctx);
      const result = dshHome ? scrubCatalogRows(dshHome, rootSessionId, everywhere) : { removed: 0, files: [] };
      if (dshHome && rootSessionId) dropProjectionCache(dshHome, rootSessionId);
      respond(res, 200, {
        ok: true,
        rootSessionId,
        everywhere,
        removed: result.removed || 0,
        files: result.files || [],
        message: result.removed > 0
          ? '已根除 ' + result.removed + ' 条残留目录行，侧边栏同步刷新后不会再出现。'
          : '没有发现需要清理的残留行。',
      });
    } catch (error) {
      respond(res, 200, { ok: false, error: 'scrub-failed', message: String((error && error.message) || error) });
    }
  };
}

/** 一键清理：对指定 ids（缺省 = 父会话 catalog 全部条目）逐个执行完整物理删除。 */
/**
 * 批量清理核心（HTTP /cleanup 与模型工具共用）：
 * 逐个做物理删除但跳过日志改写（skipCatalogRetire），最后对齐上游「一键清理只
 * 重写一次日志」—— 一次全库改写退休所有命中 id，避免 N 次全量解压。
 */
export async function runCleanup(ctx, ids, rootSessionId, stopActivity) {
  const dshHome = resolveDshHome(ctx);
  const results = [];
  for (const id of ids) {
    try { results.push(await performPurge(ctx, id, rootSessionId, stopActivity, { skipCatalogRetire: true })); }
    catch (error) { results.push({ ok: false, sessionId: id, error: String((error && error.message) || error) }); }
  }
  // 一次改写：把所有成功删除的 id 的 catalog 行一起原位退休。
  let catalog = { removed: 0, failed: [], files: [] };
  const okIds = results.filter((r) => r.ok).map((r) => r.sessionId);
  if (dshHome && okIds.length > 0) {
    try {
      catalog = retireCatalogRowsEverywhere(dshHome, okIds, rootSessionId);
      for (const f of catalog.files || []) dropProjectionCache(dshHome, f.parentId);
      if (rootSessionId) dropProjectionCache(dshHome, rootSessionId);
      if (catalog.failed && catalog.failed.length > 0) {
        const pp = pendingFilePath(dshHome);
        for (const f of catalog.failed) {
          for (const id of okIds) {
            try { queueCatalogRetire(pp, f.parentId, coreId(id)); } catch (e2) { /* 排队尽力而为 */ }
          }
        }
      }
    } catch (error) {
      catalog = { removed: 0, failed: [{ parentId: rootSessionId, reason: String((error && error.message) || error) }], files: [] };
    }
  }
  return {
    ok: true,
    rootSessionId,
    requested: ids.length,
    succeeded: results.filter((r) => r.ok).length,
    catalogRemoved: catalog.removed || 0,
    results,
    message: '已清理 ' + results.filter((r) => r.ok).length + '/' + ids.length
      + ' 个子智能体，' + (catalog.removed || 0) + ' 条残留目录行已从日志根除。',
  };
}

export function makeCleanupHandler(ctx) {
  return async function cleanupHandler(req, res) {
    if (!guard(req, res, ctx)) return;
    const payload = await parsePayload(req, res, ['POST']);
    if (payload === null) return;
    const rootSessionId = typeof payload.rootSessionId === 'string' ? payload.rootSessionId : '';
    if (!isSafeSessionId(rootSessionId)) {
      respond(res, 200, { ok: false, error: 'invalid-root-session-id', message: '父会话 ID 不合法。' });
      return;
    }
    const dshHome = resolveDshHome(ctx);
    let ids = Array.isArray(payload.ids) ? payload.ids.filter(isSafeSessionId) : [];
    if (ids.length === 0 && dshHome) {
      ids = readCatalogEvents(dshHome, rootSessionId).map((r) => r.childId);
    }
    const result = await runCleanup(ctx, ids, rootSessionId, payload.stopActivity === true);
    respond(res, 200, result);
  };
}

// ───────────────── 模型工具（对应「方法一」：让 Agent 一句话清理） ─────────────────
// 说明：用户建议的 mnemon_forget 删的是 Mnemon 记忆洞察（insight），不是子智能体
// 会话 / catalog 行，按字面调用不对症。其真实意图「让 Agent 也能触发清理」由这里
// 注册的模型工具承接：列清单 → 按标签 / 空闲状态筛选 → 逐个走 performPurge
// （物理删除 + 日志原位退休），与网页端「一键清理」共用同一套逻辑。
//
// 用纯对象注册而非 import defineTool('@deepseek-ai/dsh-tools')：该包是宿主提供的
// peerDependency，在本 profile 解析为 MODULE_NOT_FOUND。静态 bundle 插件拿到的是
// 真实 ToolsService，register(纯对象) 完全可用（仅校验 output.render / output.schema
// / timeoutMs / name，不校验 parameters 与 execute 的类型品牌）。
// 最稳的 output.schema：{type:'object', additionalProperties:true}。

function renderJson(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

function callerSessionId(exec, args) {
  const explicit = args && typeof args.root_session_id === 'string' ? args.root_session_id : '';
  if (explicit) return explicit;
  const id = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : '';
  return id;
}

/** 尽力判断某个子智能体是否仍在运行（用于「只清理空闲」）。取不到就当未运行。 */
function isRunningSubagent(ctx, childId) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    if (!agents || typeof agents.get !== 'function') return false;
    for (const v of spellings(childId)) {
      const a = agents.get(v);
      if (a && a.status === 'running') return true;
    }
  } catch (error) { /* 服务不可用时按未运行处理 */ }
  return false;
}

/** 工具：列出当前会话目录里仍会生成行的子智能体（日志是真相源）。 */
function makeListTool(ctx) {
  return {
    name: 'yanyan_list_subagents',
    description: '列出当前会话（或指定 root_session_id）的子智能体目录行，来源为父会话日志，'
      + '比会被重建的投影缓存可靠。可按标签子串过滤，并标注是否正在运行。'
      + '用返回的 child_id 传给 yanyan_delete_subagent 或 yanyan_cleanup_subagents。',
    parameters: {
      type: 'object',
      properties: {
        root_session_id: { type: 'string', description: '父会话 id；省略时取调用者会话。' },
        label_contains: { type: 'string', description: '只保留标签 / 名称包含该子串的行（不区分大小写）。' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const root = callerSessionId(exec, args);
      const dshHome = resolveDshHome(ctx);
      let rows = dshHome && root ? readCatalogEvents(dshHome, root) : [];
      const needle = args && typeof args.label_contains === 'string' ? args.label_contains.toLowerCase() : '';
      rows = rows.map((r) => ({
        child_id: r.childId, label: r.label, name: r.name, mode: r.mode,
        created_at: r.createdAt, seq: r.seq, running: isRunningSubagent(ctx, r.childId),
      }));
      if (needle) rows = rows.filter((r) => (r.label + ' ' + r.name).toLowerCase().includes(needle));
      return { root_session_id: root, rows, count: rows.length };
    },
  };
}

/** 工具：物理删除单个子智能体（含 append-only catalog 根治）。 */
function makeDeleteTool(ctx) {
  return {
    name: 'yanyan_delete_subagent',
    description: '彻底删除一个子智能体：停止运行（可选）、删除会话数据 / 缓存 / 工作区记账 / 归档标记，'
      + '并把父会话日志里的 subagent/catalog 行原位退休，使侧边栏残留行不再被重建。不可逆。',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: { type: 'string', description: '子智能体 id（裸 id 或 session- 前缀，来自 yanyan_list_subagents）。' },
        root_session_id: { type: 'string', description: '父会话 id；省略时取调用者会话。' },
        stop_activity: { type: 'boolean', description: '先停止正在运行的该子智能体。' },
      },
      required: ['subagent_id'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const id = args && args.subagent_id;
      if (typeof id !== 'string' || !isSafeSessionId(id)) {
        return { ok: false, error: 'invalid-subagent-id', message: 'subagent_id 不合法。' };
      }
      const root = callerSessionId(exec, args);
      return performPurge(ctx, id, root, args && args.stop_activity === true);
    },
  };
}

/** 工具：一句话批量清理（对应「列出所有空闲的 Mnemon idle checkpoint review 并删掉」）。 */
function makeCleanupTool(ctx) {
  return {
    name: 'yanyan_cleanup_subagents',
    description: '批量清理当前会话的子智能体。不传 label_contains 时清理全部目录行；'
      + '传 label_contains（如 "Mnemon idle checkpoint review"）只清理匹配的；'
      + 'idle_only 为 true 时跳过正在运行的；dry_run 为 true 时只返回将要清理的清单而不删除。'
      + '每个目标都走完整物理删除 + 日志原位退休。',
    parameters: {
      type: 'object',
      properties: {
        root_session_id: { type: 'string', description: '父会话 id；省略时取调用者会话。' },
        label_contains: { type: 'string', description: '只清理标签 / 名称包含该子串的行。' },
        idle_only: { type: 'boolean', description: '只清理未在运行的子智能体。' },
        dry_run: { type: 'boolean', description: '只列清单，不执行删除。' },
        limit: { type: 'integer', description: '最多清理的条数（默认全部）。' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const a = args && typeof args === 'object' ? args : {};
      const root = callerSessionId(exec, a);
      const dshHome = resolveDshHome(ctx);
      let rows = dshHome && root ? readCatalogEvents(dshHome, root) : [];
      const needle = typeof a.label_contains === 'string' ? a.label_contains.toLowerCase() : '';
      if (needle) rows = rows.filter((r) => (r.label + ' ' + r.name).toLowerCase().includes(needle));
      if (a.idle_only === true) rows = rows.filter((r) => !isRunningSubagent(ctx, r.childId));
      const limit = Number.isFinite(a.limit) && a.limit > 0 ? Math.floor(a.limit) : rows.length;
      const targets = rows.slice(0, limit).map((r) => r.childId);
      if (a.dry_run === true) {
        return { root_session_id: root, dry_run: true, matched: targets.length, targets };
      }
      const result = await runCleanup(ctx, targets, root, false);
      return {
        root_session_id: root,
        matched: targets.length,
        succeeded: result.succeeded,
        catalog_removed: result.catalogRemoved,
        results: result.results,
      };
    },
  };
}

/** tools 是可选注入：没有该服务时静默降级，绝不让 8 条 HTTP 路由一起加载失败。 */
function registerTools(ctx) {
  const definitions = [makeListTool(ctx), makeDeleteTool(ctx), makeCleanupTool(ctx)];
  const attach = (tools) => {
    if (!tools || typeof tools.register !== 'function') return;
    for (const def of definitions) tools.register(def);
  };
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (sub) => {
        try { attach(sub.tools); } catch (error) { /* 工具注册失败只降级 */ }
      });
    } else {
      attach(typeof ctx.get === 'function' ? ctx.get('tools') : undefined);
    }
  } catch (error) {
    // 可选能力：注册失败不影响 HTTP 路由。
  }
}

/** 尽力采集当前 live 会话 id，供启动重放跳过仍在活动的父会话。取不到返回空集合。 */
function collectLiveIds(ctx) {
  const live = new Set();
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    if (agents) {
      if (typeof agents.keys === 'function') {
        for (const k of agents.keys()) live.add(String(k));
      } else if (agents.sessions && typeof agents.sessions === 'object') {
        for (const k of Object.keys(agents.sessions)) live.add(k);
      }
    }
  } catch (error) { /* 尽力而为 */ }
  return live;
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const deleteHandler = makeDeleteHandler(ctx);
  const routes = [
    { path: HEALTH_ROUTE, handler: makeHealthHandler(ctx) },
    { path: CONFIG_ROUTE, handler: makeConfigHandler(ctx, cfg) },
    { path: LIST_ROUTE, handler: makeListHandler(ctx) },
    { path: CATALOG_ROUTE, handler: makeCatalogHandler(ctx) },
    { path: ARCHIVE_ROUTE, handler: deleteHandler },
    { path: PURGE_ROUTE, handler: deleteHandler },
    { path: SCRUB_ROUTE, handler: makeScrubHandler(ctx) },
    { path: CLEANUP_ROUTE, handler: makeCleanupHandler(ctx) },
  ];
  // register 的返回值直接作为 effect 清理函数，保证禁用 / HMR 时路由自动撤销。
  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `yanyan-subagent: route ${route.path}`,
    );
  }
  // 可选模型工具（方法一：让 Agent 一句话清理空闲 Mnemon review 子代理）。
  registerTools(ctx);
  // 启动时重放上次失败的日志退休（并发写 / 解码错留下的 pending）。
  try {
    const dshHome = resolveDshHome(ctx);
    if (dshHome) flushPendingRewrites(dshHome, collectLiveIds(ctx));
  } catch (error) { /* 重放失败不影响本次运行 */ }
  try {
    ctx.logger?.info?.('[dsh-plugin-yanyan-subagent] host routes ready (v' + VERSION + ')');
  } catch (error) {
    // logger 不可用时不影响路由注册。
  }
}
