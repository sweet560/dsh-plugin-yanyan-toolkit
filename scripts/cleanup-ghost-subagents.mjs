// 一次性清理：把本工作区里残留的 mnemon 虚拟委派幽灵会话彻底清掉。
//
// 背景：用户用「智能体管理」删除子智能体时，旧实现只做 archiveSession；
// subagentCatalog 是父会话日志的 append-only 投影，归档/删目录都不会移除
// 引用，于是列表里仍显示该条目；点进去则报 subagent/not-found。
//
// 本脚本做四件事（全部限定在 DSH_HOME 内，realpath 校验不越界）：
//   ① 删除 sessions/**/<ghost> 与 session-<ghost> 两种拼写的目录；
//   ② 从所有 storages/session_projcache/sessions/*.json 的
//      record.rows.subagentCatalog.val.head.values（含 previous 分片）里
//      剔除 childId 命中的条目；
//   ③ 从 storages/workspace.json 的 global.archivedSessionIds 与各
//      tables.workspaces[*].sessionIds 移除命中 id；
//   ④ 从 dsh-session-archive/archive-ledger.json 与归档台账里移除命中 id；
//   ⑤ 删除 storages/session_projcache/sessions/<id>.json 两种拼写。
//
// 用法：node scripts/cleanup-ghost-subagents.mjs [--dry-run] [--id <id> ...] [--all]
// 默认只清理「已归档但仍残留」的幽灵 id（workspace.json 的
// global.archivedSessionIds 里以 mnemon- 开头的条目）——这正是用户截图里
// 那 3 条；加 --all 才扫描全部历史 mnemon 委派（谨慎，会动别的工作区历史）。
// --id 可多次指定精确 id。

import {
  existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || resolve(HERE, '..', '..', '..');
const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');

function core(id) { return String(id || '').replace(/^session-/, ''); }
function spellings(id) {
  const c = core(id);
  return [c, 'session-' + c];
}
function isInside(root, child) {
  const r = resolve(root), c = resolve(child);
  return c === r || c.startsWith(r + sep);
}
function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function writeJsonAtomic(p, obj) {
  const tmp = p + '.yanyan.tmp';
  writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  renameSync(tmp, p);
}

/** 收集所有要清理的幽灵 id（默认只取已归档残留，--all 才全量，--id 精确指定）。 */
function collectGhostIds() {
  const ids = new Set();
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--id' && process.argv[i + 1]) ids.add(process.argv[i + 1]);
  }
  const hasExplicit = ids.size > 0;
  // 默认范围：workspace.json 里「已归档」的 mnemon 虚拟会话。
  if (!hasExplicit) {
    const wp = join(DSH_HOME, 'storages', 'workspace.json');
    if (existsSync(wp)) {
      try {
        const doc = readJson(wp);
        for (const id of doc?.global?.archivedSessionIds || []) {
          if (typeof id === 'string' && /^mnemon-/.test(core(id))) ids.add(id);
        }
        // 各 workspace 成员里若也残留同样拼写，一并纳入。
        for (const w of Object.values(doc?.tables?.workspaces || {})) {
          for (const id of w?.sessionIds || []) {
            if (typeof id === 'string' && /^mnemon-/.test(core(id)) && ids.size > 0) {
              // 只把与已归档集合里同名（去前缀后相等）的加进来，避免扩大范围。
              const c = core(id);
              if ([...ids].some((g) => core(g) === c)) ids.add(id);
            }
          }
        }
      } catch { /* 损坏文件跳过 */ }
    }
  }
  // 只有 --all 才做全量历史扫描；默认范围与 --id 精确指定都保持窄范围，
  // 避免误删别的工作区的正常历史记录。
  if (!ALL) return [...ids];
  const pdir = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = readJson(join(pdir, f));
        const head = rec?.record?.rows?.subagentCatalog?.val?.head;
        if (!head) continue;
        const chunks = [];
        for (let c = head; c; c = c.previous) chunks.push(c);
        for (const c of chunks) {
          for (const v of c.values || []) {
            const cid = v && (v.childId || v.id);
            if (typeof cid === 'string' && /^mnemon-/.test(core(cid))) ids.add(cid);
          }
        }
      } catch { /* 损坏文件跳过 */ }
    }
  }
  const sroot = join(DSH_HOME, 'sessions');
  if (existsSync(sroot)) {
    for (const proj of readdirSync(sroot)) {
      const pp = join(sroot, proj);
      if (!statSync(pp).isDirectory()) continue;
      for (const seg of readdirSync(pp)) {
        if (/^mnemon-/.test(core(seg))) ids.add(seg);
      }
    }
  }
  return [...ids];
}

function matches(id, ghostSet) {
  const c = core(id);
  return ghostSet.has(c) || ghostSet.has('session-' + c) ||
    [...ghostSet].some((g) => core(g) === c);
}

/** 从 chunked-list head 的 values（含 previous 分片）里剔除命中条目。 */
function stripCatalog(head, ghostSet) {
  let removed = 0;
  for (let c = head; c; c = c.previous) {
    if (!Array.isArray(c.values)) continue;
    const next = c.values.filter((v) => {
      const cid = v && (v.childId || v.id);
      const hit = typeof cid === 'string' && matches(cid, ghostSet);
      if (hit) removed += 1;
      return !hit;
    });
    c.values = next;
  }
  return removed;
}

function cleanSessionsDirs(ghostSet, report) {
  const sroot = join(DSH_HOME, 'sessions');
  if (!existsSync(sroot)) return;
  const rootReal = realpathSync(sroot);
  for (const proj of readdirSync(sroot)) {
    const pp = join(sroot, proj);
    if (!statSync(pp).isDirectory()) continue;
    for (const seg of readdirSync(pp)) {
      if (!matches(seg, ghostSet)) continue;
      const dir = join(pp, seg);
      const real = realpathSync(dir);
      if (!isInside(rootReal, real)) { report.skipped.push(dir + ' (逃逸)'); continue; }
      report.dirs.push(dir);
      if (!DRY) rmSync(real, { recursive: true, force: true });
    }
  }
}

function cleanProjcache(ghostSet, report) {
  const pdir = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  if (!existsSync(pdir)) return;
  for (const f of readdirSync(pdir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(pdir, f);
    const rec = readJson(p);
    const row = rec?.record?.rows?.subagentCatalog;
    if (row && row.val && row.val.head) {
      const n = stripCatalog(row.val.head, ghostSet);
      if (n > 0) {
        report.catalog.push(f + ' (-' + n + ')');
        if (!DRY) writeJsonAtomic(p, rec);
      }
    }
    // 幽灵会话自己的 projcache 文件
    if (matches(f.replace(/\.json$/, ''), ghostSet)) {
      report.files.push(p);
      if (!DRY) unlinkSync(p);
    }
  }
  // 聚合索引（若存在）
  const idx = join(DSH_HOME, 'storages', 'session_projcache.json');
  if (existsSync(idx)) {
    try {
      const doc = readJson(idx);
      const t = doc?.tables?.sessions;
      if (t) {
        let n = 0;
        for (const k of Object.keys(t)) {
          if (matches(k, ghostSet)) { delete t[k]; n += 1; }
        }
        if (n > 0) { report.index = n; if (!DRY) writeJsonAtomic(idx, doc); }
      }
    } catch { /* 损坏索引跳过 */ }
  }
}

function cleanWorkspaceJson(ghostSet, report) {
  const p = join(DSH_HOME, 'storages', 'workspace.json');
  if (!existsSync(p)) return;
  const doc = readJson(p);
  let changed = false;
  const g = doc?.global;
  if (g && Array.isArray(g.archivedSessionIds)) {
    const next = g.archivedSessionIds.filter((id) => !matches(id, ghostSet));
    report.archived += g.archivedSessionIds.length - next.length;
    if (next.length !== g.archivedSessionIds.length) { g.archivedSessionIds = next; changed = true; }
  }
  const tables = doc?.tables?.workspaces;
  if (tables) {
    for (const w of Object.values(tables)) {
      if (!Array.isArray(w.sessionIds)) continue;
      const next = w.sessionIds.filter((id) => !matches(id, ghostSet));
      report.members += w.sessionIds.length - next.length;
      if (next.length !== w.sessionIds.length) { w.sessionIds = next; changed = true; }
    }
  }
  if (changed && !DRY) writeJsonAtomic(p, doc);
}

function cleanLedger(ghostSet, report) {
  const p = join(DSH_HOME, 'dsh-session-archive', 'archive-ledger.json');
  if (!existsSync(p)) return;
  const doc = readJson(p);
  const e = doc?.entries;
  if (!e || typeof e !== 'object') return;
  let n = 0;
  for (const k of Object.keys(e)) {
    if (matches(k, ghostSet)) { delete e[k]; n += 1; }
  }
  if (n > 0) { report.ledger = n; if (!DRY) writeJsonAtomic(p, doc); }
}

const ghosts = collectGhostIds();
const set = new Set(ghosts);
const report = { dirs: [], catalog: [], files: [], archived: 0, members: 0, ledger: 0, index: 0, skipped: [] };
console.log('[清理] DSH_HOME =', DSH_HOME);
console.log('[清理] 模式 =', DRY ? 'dry-run（不写盘）' : '实际执行');
console.log('[清理] 发现幽灵 id ' + set.size + ' 个：', ghosts.slice(0, 20));
if (set.size === 0) { console.log('[清理] 没有需要清理的条目。'); process.exit(0); }
cleanSessionsDirs(set, report);
cleanProjcache(set, report);
cleanWorkspaceJson(set, report);
cleanLedger(set, report);
console.log('[清理] 结果：', JSON.stringify(report, null, 2));
console.log('[清理] 完成。建议重启 DSH 服务后刷新页面，确认列表里不再出现这些条目。');
