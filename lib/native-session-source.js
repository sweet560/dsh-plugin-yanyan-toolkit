// dsh-plugin-yanyan-toolkit — 原生会话数据源读取器。
//
// 职责：读取 DSH 原生侧的会话事实源，供会话管理中心补全「已归档清单 / 归档时间 /
// 状态标签（进行中·空白·已归档·子会话·普通）」。这些数据源均由只读调研确认：
//   - 归档事实源：ctx.workspaceRegistry.archivedSessionIds（内存），降级读
//     $DSH_HOME/storages/workspace.json 的 global.archivedSessionIds；
//   - 归档时间：$DSH_HOME/dsh-session-archive/archive-ledger.json 的 entries[id].archivedAt；
//   - 会话状态：ctx.get('sessionController').list() 的 running/blank/origin/parentSessionId。
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
 * 读会话状态 feed（async）。用 ctx.get('sessionController').list()。
 * 返回 Map<sessionId, {running:boolean, blank:boolean, origin?:string, parentId?:string, updatedAt?:number}>。
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
      out.set(id, { createdAt, cwd, title, blank });
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
