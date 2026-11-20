// dsh-plugin-yanyan-toolkit — 原生会话数据源读取器。
//
// 职责：读取 DSH 原生侧的会话事实源，供会话管理中心补全「已归档清单 / 归档时间 /
// 状态标签（进行中·空白·已归档·子会话·普通）」。这些数据源均由只读调研确认：
//   - 归档事实源：ctx.workspaceRegistry.archivedSessionIds（内存），降级读
//     $DSH_HOME/storages/workspace.json 的 global.archivedSessionIds；
//   - 归档时间：$DSH_HOME/dsh-session-archive/archive-ledger.json 的 entries[id].archivedAt；
//   - 会话状态：ctx.get('sessionController').list() 的 running/blank/origin/parentSessionId；
//   - 会话标题：同一 list 项里的 projections.values.title（DSH 原生无顶层 title 字段，
//     标题藏在 title 投影里；这是纯运行时会话唯一的标题来源）。
//
// 纪律：只读，绝不修改任何原生会话文件 / workspace.json / ledger。全部 fail-closed：
// 读不到、解析失败、能力缺失一律返回空集合，不影响会话中心其余功能。

import { join } from 'node:path';
import { resolveDshHome } from './session-trash.js';

/** 安全读 JSON：失败/损坏返回 null，绝不抛错。 */
function readJsonSafe(fs, p) {
  try {
    if (typeof fs.existsSync === 'function' && !fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 读归档事实源。优先内存属性 registry.archivedSessionIds，
 * 降级读 $DSH_HOME/storages/workspace.json 的 global.archivedSessionIds。
 * 返回 { ids:Set<string>, source:'registry'|'workspace'|'none' }。
 */
export function readArchivedIds(fs, dshHome, registry) {
  const ids = new Set();
  // ① 内存属性（权威，与宿主侧边栏同源）
  try {
    const arr = registry && registry.archivedSessionIds;
    if (Array.isArray(arr)) {
      for (const id of arr) if (typeof id === 'string') ids.add(id);
      if (ids.size > 0) return { ids, source: 'registry' };
    }
  } catch { /* 属性访问失败 → 降级 */ }
  // ② 降级：读 workspace.json
  try {
    const doc = readJsonSafe(fs, join(dshHome, 'storages', 'workspace.json'));
    const arr = doc && doc.global && doc.global.archivedSessionIds;
    if (Array.isArray(arr)) {
      for (const id of arr) if (typeof id === 'string') ids.add(id);
      if (ids.size > 0) return { ids, source: 'workspace' };
    }
  } catch { /* 忽略 */ }
  return { ids, source: ids.size ? 'file' : 'none' };
}

/**
 * 读归档时间台账。返回 Map<sessionId, {archivedAt:number, source:string}>。
 * 路径：$DSH_HOME/dsh-session-archive/archive-ledger.json。
 */
export function readArchiveLedger(fs, dshHome) {
  const times = new Map();
  try {
    const doc = readJsonSafe(fs, join(dshHome, 'dsh-session-archive', 'archive-ledger.json'));
    const entries = doc && doc.entries;
    if (entries && typeof entries === 'object') {
      for (const [id, e] of Object.entries(entries)) {
        if (e && typeof e.archivedAt === 'number') {
          times.set(id, { archivedAt: e.archivedAt, source: e.source || 'observed' });
        }
      }
    }
  } catch { /* 忽略 */ }
  return times;
}

/**
 * 从 sessionController.list() 的单项里提取实时标题。
 * DSH 原生 list 项没有顶层 title，标题存放在 title 投影：
 *   it.projections = { kind, asOfSeq, values: { title?: string|null, ... } }
 * 兼容若干历史/热更新字段：it.title / it.displayTitle / it.projections.values.title。
 * 只接受非空字符串，空串/null 一律视为无标题（fail-closed）。
 */
function feedTitleOf(it) {
  if (!it || typeof it !== 'object') return null;
  const candidates = [];
  // ① 权威：title 投影（sessionController.list 的实际结构）
  const projections = it.projections;
  if (projections && typeof projections === 'object') {
    const values = projections.values;
    if (values && typeof values === 'object') candidates.push(values.title);
  }
  // ② 兼容：部分版本/热更新路径会直接带 title 或 displayTitle
  candidates.push(it.title, it.displayTitle);
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * 读会话状态 feed（async）。用 ctx.get('sessionController').list()。
 * 返回 Map<sessionId, {running:boolean, blank:boolean, title?:string|null,
 *   origin?:string, parentId?:string, updatedAt?:number}>。
 * title 来自 projections.values.title（纯运行时会话唯一的标题来源）。
 */
export async function readFeedStatuses(ctx) {
  const out = new Map();
  let feed = null;
  try { feed = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : null; } catch { feed = null; }
  if (!feed || typeof feed.list !== 'function') return out;
  try {
    const res = await feed.list({});
    const items = res && Array.isArray(res.items) ? res.items : (Array.isArray(res) ? res : []);
    for (const it of items) {
      const id = it && (it.sessionId || it.id);
      if (typeof id !== 'string') continue;
      out.set(id, {
        running: it.running === true,
        blank: it.blank === true,
        title: feedTitleOf(it),
        origin: typeof it.origin === 'string' ? it.origin : null,
        parentId: typeof it.parentSessionId === 'string' ? it.parentSessionId : null,
        updatedAt: typeof it.updatedAt === 'number' ? it.updatedAt : null,
      });
    }
  } catch { /* 忽略：状态标签是增强项，失败不影响列表 */ }
  return out;
}

/**
 * 状态标签映射（与 session-archive 徽章一致 + 用户期望的中文语义）。
 * dsh 原生只有 running/blank 布尔，没有 idle/complete 独立枚举，故按实际字段映射：
 *   running → 进行中；blank → 空白；archived → 已归档；origin=subagent → 子会话；否则 → 普通/空闲。
 */
export function statusLabels(signals) {
  const labels = [];
  if (!signals) return labels;
  if (signals.archived) labels.push('已归档');
  if (signals.running) labels.push('进行中');
  else if (signals.blank) labels.push('空白');
  if (signals.origin === 'subagent') labels.push('子会话');
  if (labels.length === 0) labels.push('空闲');
  return labels;
}

/**
 * 读工作区表（$DSH_HOME/storages/workspace.json 的 tables.workspaces），
 * 返回 { byPath: Map<normalizedPath, {id,title,path}>, list: [{id,title,path,sessionIds}] }。
 * 用途：把会话日志 header 的 cwd 映射成友好工作区名（如「研研工具包 · 插件」）。
 * 只读 fail-closed：读不到返回空。
 */
export function readWorkspaces(fs, dshHome) {
  const byPath = new Map();
  const list = [];
  try {
    const doc = readJsonSafe(fs, join(dshHome, 'storages', 'workspace.json'));
    const tables = doc && doc.tables;
    const ws = tables && tables.workspaces;
    if (ws && typeof ws === 'object') {
      for (const [id, w] of Object.entries(ws)) {
        if (!w || typeof w.path !== 'string') continue;
        const norm = normalizePath(w.path);
        const entry = {
          id: (typeof w.id === 'string' ? w.id : id),
          title: (typeof w.title === 'string' && w.title.trim() ? w.title.trim() : basenameOf(w.path)),
          path: w.path,
          sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
        };
        if (norm) byPath.set(norm, entry);
        list.push(entry);
      }
    }
  } catch { /* 忽略 */ }
  return { byPath, list };
}

/** 路径归一化：统一斜杠 + 去尾部斜杠 + 小写（Windows 大小写不敏感）。 */
function normalizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
function basenameOf(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/**
 * 给定 cwd（日志 header 的工作区路径），返回友好工作区标题。
 * 优先完全匹配，其次最长前缀匹配（cwd 常是工作区下的子目录）。
 */
export function workspaceTitleFor(workspaces, cwd) {
  if (!cwd || !workspaces || !workspaces.byPath) return null;
  const target = normalizePath(cwd);
  if (!target) return null;
  const exact = workspaces.byPath.get(target);
  if (exact) return exact.title;
  let best = null;
  let bestLen = 0;
  for (const [p, entry] of workspaces.byPath.entries()) {
    if (target.startsWith(p + '/') && p.length > bestLen) { best = entry; bestLen = p.length; }
  }
  return best ? best.title : null;
}

/**
 * 读 DSH 原生会话索引（$DSH_HOME/storages/session_projcache/sessions/*.json）。
 * 这是「会话归档管理」显示的会话总数口径（含日志已被清理但索引仍在的会话）。
 * 返回 Map<id, {createdAt, cwd, title, blank}>，供会话管理中心补齐清单与标题：
 *   · title —— record.rows.title.val，即 DSH 侧边栏/底部状态栏展示的会话名（权威标题源）；
 *     缺失时回退 record.rows.titleInput.val.first.text（用户首次输入）。
 *   · blank —— record.rows.sessionListMetadata.val.blank，原生「空白会话」权威标志。
 * 只读 fail-closed：读不到返回空 Map。
 */
/** 会话 id 规范化：无 session- 前缀则补，便于两种拼写互查（借鉴归档插件 canonicalSessionId）。 */
function canonicalSessionId(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.startsWith('session-') ? value : 'session-' + value;
}
/** 会话 id 去前缀拼写。 */
function bareSessionId(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('session-') ? value.slice('session-'.length) : value;
}

export function readSessionIndexIds(fs, dshHome) {
  const out = new Map();
  try {
    const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');
    if (typeof fs.existsSync === 'function' && !fs.existsSync(dir)) return out;
    const names = typeof fs.readdirSync === 'function' ? fs.readdirSync(dir) : [];
    for (const name of names) {
      if (typeof name !== 'string' || !name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!id) continue;
      let createdAt = null;
      let cwd = null;
      let title = null;
      let blank = null;
      try {
        const doc = readJsonSafe(fs, join(dir, name));
        const record = doc && doc.record;
        const identity = record && record.identity;
        if (identity && typeof identity.createdAt === 'number') createdAt = identity.createdAt;
        if (identity && typeof identity.cwd === 'string') cwd = identity.cwd;
        const rows = record && record.rows;
        if (rows) {
          const t = rows.title && rows.title.val;
          if (typeof t === 'string' && t.trim()) title = t.trim();
          if (!title) {
            const ti = rows.titleInput && rows.titleInput.val;
            const first = ti && ti.first && ti.first.text;
            if (typeof first === 'string' && first.trim()) title = first.trim();
          }
          const sm = rows.sessionListMetadata && rows.sessionListMetadata.val;
          if (sm && typeof sm.blank === 'boolean') blank = sm.blank;
        }
      } catch { /* 单条损坏不影响其它 */ }
      const info = { createdAt, cwd, title, blank };
      // 双向拼写都登记：文件名可能是裸 UUID 或带 session- 前缀，而会话行的 id
      // 也可能带/不带前缀。两侧拼写不一致时（如文件名裸 UUID、行 id 带 session-），
      // 必须都能命中，否则标题/blank 丢失，会话被误显示成截断 id + 空会话。
      out.set(id, info);
      const canonical = canonicalSessionId(id);
      if (canonical && canonical !== id) out.set(canonical, info);
      const bare = bareSessionId(id);
      if (bare && bare !== id) out.set(bare, info);
    }
  } catch { /* 忽略 */ }
  return out;
}

/**
 * 扫描 DSH 会话日志目录，返回每个会话的物理目录大小（字节）。
 * 借鉴「会话归档管理」插件的 dirSize + indexSessionDirs：递归 readdir/stat 累加
 * stat.size，一次扫描同时按 canonical id 建索引。只读、fail-closed，异常记 0。
 * 返回 Map<sessionId, bytes>；键同时登记 canonical 与去前缀两种拼写，便于互查。
 */
export function readSessionDirSizes(fs, dshHome) {
  const out = new Map();
  const dirSize = (dir) => {
    let total = 0;
    try {
      const entries = typeof fs.readdirSync === 'function' ? fs.readdirSync(dir, { withFileTypes: true }) : [];
      for (const e of entries) {
        const name = typeof e === 'string' ? e : e.name;
        if (!name) continue;
        const p = join(dir, name);
        let stat = null;
        try { stat = typeof fs.statSync === 'function' ? fs.statSync(p) : null; } catch { continue; }
        if (stat && stat.isDirectory && stat.isDirectory()) total += dirSize(p);
        else if (stat && typeof stat.size === 'number') total += stat.size;
      }
    } catch { /* 目录读不到记 0 */ }
    return total;
  };
  try {
    const root = join(dshHome, 'sessions');
    if (typeof fs.existsSync === 'function' && !fs.existsSync(root)) return out;
    const projects = typeof fs.readdirSync === 'function' ? fs.readdirSync(root) : [];
    for (const project of projects) {
      if (typeof project !== 'string') continue;
      const projectDir = join(root, project);
      let stat = null;
      try { stat = typeof fs.statSync === 'function' ? fs.statSync(projectDir) : null; } catch { continue; }
      if (!stat || !stat.isDirectory || !stat.isDirectory()) continue;
      let segments = [];
      try { segments = typeof fs.readdirSync === 'function' ? fs.readdirSync(projectDir) : []; } catch { continue; }
      for (const seg of segments) {
        if (typeof seg !== 'string') continue;
        const segDir = join(projectDir, seg);
        let segStat = null;
        try { segStat = typeof fs.statSync === 'function' ? fs.statSync(segDir) : null; } catch { continue; }
        if (!segStat || !segStat.isDirectory || !segStat.isDirectory()) continue;
        const id = canonicalSessionId(seg) || seg;
        const bytes = dirSize(segDir);
        out.set(id, bytes);
        const bare = bareSessionId(id);
        if (bare && bare !== id) out.set(bare, bytes);
      }
    }
  } catch { /* 忽略 */ }
  return out;
}

/**
 * 计算 DSH_HOME（供本模块各读取函数使用），转发现成 resolveDshHome。
 */
export function sourceHome(env, home) {
  return resolveDshHome(env, home);
}
