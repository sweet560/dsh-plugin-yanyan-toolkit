// dsh-plugin-yanyan-toolkit — 会话管理中心 · Host 服务层（Phase 1）。
//
// 职责：把 createMetadataStore 包装成可被 HTTP 路由/UI 消费的服务：
//   1) 解析 DSH_HOME → 构造 MetadataStore（复用 session-metadata.js）；
//   2) 从 ctx.get('sessions') 读活跃会话列表（与回收站同款 serviceFace 模式）；
//   3) 提供 list()：活跃会话 × 元数据合并出 UI 列表（标题回退、文件夹、标签）。
// 本层不做任何物理 I/O 决策，也不碰原生会话文件（只读 sessions.list 快照）。

import { createMetadataStore, resolveHome, defaultFs, UNFILED_FOLDER_ID, TRASH_FOLDER_ID } from './session-metadata.js';
import { createSearchIndex } from './search-index.js';
import { createExporter } from './export-markdown.js';
import { createTrashService } from './session-trash-service.js';
import { defaultFs as trashDefaultFs } from './session-trash.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync } from 'node:fs';
import { readArchivedIds, readArchiveLedger, readFeedStatuses, statusLabels, readWorkspaces, workspaceTitleFor, readSessionIndexIds } from './native-session-source.js';

export const METADATA_API_PREFIX = '/api/dsh-yanyan-session-hub';

/** 与回收站同款：从 ctx 动态取服务，取不到返回 undefined，fail-closed 不猜服务名。 */
function serviceFace(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

/** 从 ctx 的 sessions store 读活跃会话行（复用回收站 client 的同构读取逻辑，host 侧等价实现）。 */
export function activeSessionRows(sessions) {
  const rows = [];
  try {
    const store = sessions && sessions.list;
    const snap = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null;
    const byId = snap && (snap.byId || (Array.isArray(snap) ? null : null));
    if (byId && typeof byId === 'object') {
      Object.keys(byId).forEach((key) => {
        const row = byId[key];
        const id = row && (row.id || row.sessionId || key);
        if (typeof id === 'string') rows.push(Object.assign({}, row, { id }));
      });
    } else if (Array.isArray(snap)) {
      snap.forEach((row) => {
        const id = row && (row.id || row.sessionId);
        if (typeof id === 'string') rows.push(Object.assign({}, row, { id }));
      });
    }
  } catch {
    // 读取失败视为无活跃会话，UI 仍可展示元数据账本里的条目。
  }
  return rows;
}

/** 标题回退：customTitle > row.title/label > 短 id。与回收站 displayTitle 同构。 */
export function displayTitle(row, meta) {
  if (meta && typeof meta.customTitle === 'string' && meta.customTitle.trim()) return meta.customTitle.trim();
  if (row) {
    for (const key of ['title', 'label', 'displayTitle', 'sessionTitle', 'name']) {
      const v = row[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  const id = row && (row.id || row.sessionId);
  if (typeof id === 'string') {
    const short = id.replace(/^session-/, '');
    return short.length > 12 ? `${short.slice(0, 8)}…${short.slice(-4)}` : short;
  }
  return '(untitled)';
}

/**
 * 创建会话管理中心服务。options.dshHome / options.fs 可注入以便单测。
 */
export function createSessionHubService(ctx, options = {}) {
  const dshHome = options.dshHome ?? resolveHome();
  // metadata store 只需 5 个 *Sync 原语，保留注入兼容（单测常注入内存 fs）。
  const metadataFs = options.fs ?? defaultFs();
  const store = options.store ?? createMetadataStore(metadataFs, dshHome);
  // 全功能 fs：合并三方契约——
  //   · exporter/searchIndex 需要 statSync/readdirSync/existsSync/readFileSync（metadataFs 缺前两个）
  //   · trashService 需要 lstat/realpath/stat/rename/mkdir/readFile/writeFile/readdir/exists（trashDefaultFs 提供）
  // 注入的 fs 优先，缺失的用 node:fs 真实现兜底。曾因只喂残缺 metadataFs 导致导出/回收站/删除全失效。
  const fs = {
    ...trashDefaultFs(),
    ...metadataFs,
    statSync: metadataFs.statSync ?? statSync,
    readdirSync: metadataFs.readdirSync ?? readdirSync,
  };
  const sessions = options.sessions ?? serviceFace(ctx, 'sessions');

  // —— 原生归档能力（用户三决策之一：归档真正调用 DSH 原生 API，让会话从原生列表消失）——
  // 优先 inject 的 ctx.workspaceRegistry，兜底 ctx.get('workspaceRegistry')（与 trash 同款 serviceFace）。
  const registry = options.registry ?? ctx?.workspaceRegistry ?? serviceFace(ctx, 'workspaceRegistry');
  const nativeArchive = typeof registry?.archiveSession === 'function'
    ? (id) => registry.archiveSession(id)
    : null;
  const nativeUnarchive = typeof registry?.unarchiveSession === 'function'
    ? (id) => registry.unarchiveSession(id)
    : null;

  // —— 回收站融合（用户三决策之三：trash 能力合并进单一 session-hub 子包）——
  // 复用现成的 createTrashService（原子写/串行锁/归档闸门/级联 fail-closed 全在内）。
  // 回收站的可恢复删除/彻底删除/级联不依赖原生归档能力——trash 内部 capabilitiesFromContext
  // 会把缺失的 archiveSession 处理为 archiveSkipped，故无条件创建（此前门控在 native 能力上，
  // 一旦宿主未注入归档服务，整个回收站/删除功能全废）。options.trashService 可注入以便单测。
  // 注意：不传 fs。createTrashService 内部用 makeServiceFs（含 rm / __sessionsRoot / __trashRoot 的
  // 专属包装）。此前误把给 exporter 拼的全功能 fs 传进来，缺 rm 且根路径标记丢失，
  // 导致 trash/purge/deleteArchived 全部失败（会话数减少但回收站无条目 + 裸 request failed）。
  const trashService = options.trashService ?? createTrashService(ctx, { dshHome });

  // —— Phase 2 全文搜索索引 ——
  // options.searchIndex 可注入（单测）；否则构造一个，并在宿主加载后后台异步冷启动重建，
  // 分片 setImmediate 让出事件循环，绝不阻塞主线程。失败不影响 Phase 1 会话管理功能。
  const searchIndex = options.searchIndex ?? createSearchIndex({
    dshHome,
    fs: options.indexFs ?? undefined,
    onProgress: (s) => {
      try { ctx?.effect?.(() => {})?.(); } catch { /* noop */ }
    },
  });

  // —— Phase 3 Markdown 批量导出 ——
  // options.exporter 可注入（单测）；否则构造一个，复用同一个 store 读 customTitle。
  const exporter = options.exporter ?? createExporter({ dshHome, fs, store });
  let rebuildPromise = null;
  function ensureIndexStarted() {
    if (options.autoIndex === false) return rebuildPromise;
    if (!rebuildPromise) {
      try {
        rebuildPromise = searchIndex.rebuild();
      } catch {
        rebuildPromise = Promise.resolve(null);
      }
    }
    return rebuildPromise;
  }
  // 用 setImmediate 后台启动，不阻塞 apply() 返回。
  try { setImmediate(ensureIndexStarted); } catch { ensureIndexStarted(); }

  const list = async () => {
    const meta = store.snapshot();
    // —— 原生数据源（只读）：归档事实源 / 归档时间台账 / 会话状态 feed ——
    // 这三项是「已归档 tab 无数据」「自动状态标签」的根因解法：用户从 DSH 原生侧边栏
    // 归档的会话只改原生 workspace.json，本插件账本不会记录，必须从原生事实源补齐。
    const archivedSrc = readArchivedIds(fs, dshHome, registry);
    const archivedIds = archivedSrc.ids;
    const ledger = readArchiveLedger(fs, dshHome);
    const feed = await readFeedStatuses(ctx);
    // 原生会话索引（projcache）：会话归档管理的总数口径，含日志已清理但索引仍在的会话。
    // 用它补齐索引未覆盖的会话，使会话管理中心与归档管理的会话基数一致。
    const sessionIndex = readSessionIndexIds(fs, dshHome);
    // 工作区映射：把会话 cwd（来自日志 header）映射成友好工作区名。
    const workspaces = readWorkspaces(fs, dshHome);

    // 索引侧的会话元数据（cwd/createdAt/messageCount/origin…）：无论列表是否走兜底，
    // 都用它给每条 item 补工作区/创建时间/消息数。纯内存遍历，成本极低。
    const indexMeta = new Map();
    if (searchIndex && typeof searchIndex.listSessions === 'function') {
      try {
        for (const s of searchIndex.listSessions()) indexMeta.set(s.id, s);
      } catch { /* 忽略 */ }
    }

    let rows = activeSessionRows(sessions);
    // 兜底：host 端通常拿不到 client-only 的 sessions 服务（activeSessionRows 为空），
    // 此时用全文索引已扫描到的全量会话清单作为列表数据源。索引直接扫 sessions 目录，
    // 因此即使在宿主里也能列出所有历史会话（搜索面板正是靠它出结果的）。
    if (rows.length === 0) {
      rows = Array.from(indexMeta.values()).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
    }
    const seen = new Set();
    // 构造单条 item 的公共逻辑：archived 由原生清单或账本共同决定；状态标签来自 feed。
    const buildItem = (row, m, opts) => {
      const id = row.id;
      const archived = archivedIds.has(id) || m.archived === true;
      const st = feed.get(id) || {};
      const ledgerEntry = ledger.get(id) || {};
      const im = indexMeta.get(id) || {};
      // 原生 projcache 事实源（标题/工作区路径/空白标志/创建时间）。
      const si = sessionIndex.get(id) || {};
      // 工作区：cwd 优先取日志 header，缺失时回退 projcache 的 identity.cwd；
      // 友好名由 workspace.json 表映射。避免日志未扫到时误显示「不属于任何工作区」。
      const cwd = im.cwd || si.cwd || null;
      const workspace = workspaceTitleFor(workspaces, cwd);
      const origin = im.origin || st.origin || null;
      const parentSession = im.parentSession || st.parentId || null;
      const createdAt = im.createdAt ?? si.createdAt ?? null;
      const messageCount = typeof im.messageCount === 'number' ? im.messageCount : null;
      // 原生 blank 是「空白会话」权威标志。日志侧的 im.empty 只是「解不出文本消息」的
      // 近似判断，会误杀有真实标题的会话，故优先信任原生 blank；仅当原生没有该字段时
      // 才回退到 im.empty。
      const nativeBlank = typeof si.blank === 'boolean' ? si.blank : null;
      const empty = nativeBlank === true ? true : (nativeBlank === false ? false : im.empty === true);
      // 大小：优先实际留档文本字节数（≈2×字符数），无则 null。
      const size = typeof im.size === 'number' ? im.size * 2 : null;
      // 标题优先级：自定义标题 > 原生 projcache 标题 > 行/日志派生标题 > 截断 id。
      // 关键：原生的 rows.title.val 才是用户看到并保存的会话名，绝不能被日志的空判定覆盖。
      let title;
      if (m.customTitle && String(m.customTitle).trim()) title = String(m.customTitle).trim();
      else if (si.title) title = si.title;
      else title = displayTitle(row, m);
      // 空会话友好标题：仅当完全没有可用标题时才合成，避免「有标题却显示空会话·id」。
      if (empty && !m.customTitle && !si.title) title = "空会话 · " + String(id).slice(0, 8);
      // 自动状态标签（不写入用户 tags，单独字段，UI 以 chip 展示，可与手动标签共存）。
      const statusArr = statusLabels({ archived, running: st.running === true || row.running === true, blank: st.blank === true, origin });
      if (empty) statusArr.unshift("空会话");
      return {
        id,
        title,
        folderId: m.folderId || UNFILED_FOLDER_ID,
        tags: m.tags.slice(),
        customTitle: m.customTitle || '',
        updatedAt: row.updatedAt ?? row.lastActivityAt ?? st.updatedAt ?? im.updatedAt ?? null,
        running: st.running === true || row.running === true,
        blank: st.blank === true,
        empty,
        origin,
        parentSession,
        createdAt,
        messageCount,
        size,
        cwd,
        workspace,
        status: statusArr,
        archived,
        archivedAt: m.archivedAt ?? ledgerEntry.archivedAt ?? null,
        active: opts.active,
      };
    };
    const items = rows.map((row) => {
      seen.add(row.id);
      const m = meta.sessions[row.id] || { tags: [], folderId: null, customTitle: '' };
      return buildItem(row, m, { active: true });
    });
    // 账本里存在、但当前活跃列表里没有的会话（例如刚恢复/被归档）也展示，标记 active=false。
    for (const [id, m] of Object.entries(meta.sessions)) {
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(buildItem({ id, updatedAt: m.archivedAt ?? null }, m, { active: false }));
    }
    // 原生归档清单里有、但扫描/账本都没覆盖的会话也补进来（确保「已归档」tab 不缺项）。
    // 标题回退到 customTitle 或短 id —— 归档会话的日志若已被物理清理也能列出来。
    for (const id of archivedIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = meta.sessions[id] || { tags: [], folderId: null, customTitle: '' };
      const short = id.replace(/^session-/, '');
      const title = m.customTitle || (short.length > 12 ? short.slice(0, 8) + '…' + short.slice(-4) : short);
      items.push(buildItem({ id, title, updatedAt: m.archivedAt ?? null }, m, { active: false }));
    }
    // 原生会话索引里有、但磁盘日志与账本都没覆盖的会话也补进来（与「会话归档管理」总数口径对齐）。
    // 这些会话日志可能已被物理清理，只有 projcache 索引残留；只登记条目供归档/删除/管理，内容不可搜。
    for (const [id, info] of sessionIndex) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = meta.sessions[id] || { tags: [], folderId: null, customTitle: '' };
      const short = String(id).replace(/^session-/, '');
      // 优先用原生 projcache 标题（info.title），其次 customTitle，最后才截断 id。
      const title = m.customTitle || info.title || (short.length > 12 ? short.slice(0, 8) + '…' + short.slice(-4) : short);
      const item = buildItem({ id, title, updatedAt: info.createdAt ?? null }, m, { active: false });
      // 补上 projcache 里的 cwd/createdAt（buildItem 从 indexMeta 取，这里没有）。
      if (!item.cwd && info.cwd) {
        item.cwd = info.cwd;
        item.workspace = workspaceTitleFor(workspaces, info.cwd);
      }
      if (!item.createdAt && info.createdAt) item.createdAt = info.createdAt;
      // 只有原生确认为空白（blank===true）或完全无标题时才标空会话；有真实标题的索引会话不再误杀。
      item.empty = info.blank === true || (!item.title || item.title === short);
      item.indexOnly = true;
      if (item.empty && !item.status.includes('空会话')) item.status.unshift('空会话');
      items.push(item);
    }
    const baseOverview = store.overview() || {};
    return {
      ok: true,
      items,
      folders: store.listFolders(),
      tags: store.allTags(),
      // 会话总数用实际可见列表数（含索引兜底 / 账本归档 / 原生归档清单），避免 host 端账本空时总览卡全 0。
      // 文件夹/标签统计仍来自账本（未打标签确实为 0，符合语义）。
      overview: Object.assign({}, baseOverview, { total: items.length }),
      archivedIds: Array.from(archivedIds),
      nativeSource: archivedSrc.source,
      workspaces: workspaces.list,
      systemFolders: [
        { id: UNFILED_FOLDER_ID, name: '未分类' },
        { id: TRASH_FOLDER_ID, name: '回收站' },
      ],
    };
  };

  return {
    store,
    list,
    searchIndex,
    ensureIndexStarted,
    search: (q, opts) => searchIndex.search(q, opts),
    indexStatus: () => searchIndex.status(),
    exporter,
    exportSessions: (ids, opts) => exporter.exportSessions(ids, opts),
    exportAll: (opts) => exporter.exportAll(opts),
    createFolder: (name) => store.createFolder(name),
    renameFolder: (id, name) => store.renameFolder(id, name),
    deleteFolder: (id) => store.deleteFolder(id),
    setFolder: (sessionId, folderId) => store.setSessionFolder(sessionId, folderId),
    addTag: (sessionId, tag) => store.addTag(sessionId, tag),
    removeTag: (sessionId, tag) => store.removeTag(sessionId, tag),
    setTitle: (sessionId, title) => store.setCustomTitle(sessionId, title),

    // —— 原生归档 / 取消归档 ——
    hasNativeArchive: () => !!(nativeArchive || nativeUnarchive),
    archiveSessions: async (ids) => {
      if (!nativeArchive) return { ok: false, error: 'unsupported', message: '宿主未提供原生归档能力' };
      const done = [];
      const failed = [];
      for (const id of Array.isArray(ids) ? ids : []) {
        try {
          // 先调原生 API 让会话真正从原生列表消失，成功后回写账本（已归档清单的事实源）。
          await nativeArchive(id);
          await store.markArchived(id);
          done.push(id);
        } catch (error) { failed.push({ id, message: String((error && error.message) || error) }); }
      }
      return { ok: failed.length === 0, done, failed };
    },
    unarchiveSessions: async (ids) => {
      if (!nativeUnarchive) return { ok: false, error: 'unsupported', message: '宿主未提供原生解档能力' };
      const done = [];
      const failed = [];
      for (const id of Array.isArray(ids) ? ids : []) {
        try {
          await nativeUnarchive(id);
          await store.markUnarchived(id);
          done.push(id);
        } catch (error) { failed.push({ id, message: String((error && error.message) || error) }); }
      }
      return { ok: failed.length === 0, done, failed };
    },

    // —— 删除已归档会话（图9「删除」按钮）——
    // 组合流程（对标 session-archive janitor）：①原生解档（把 id 从原生归档清单移除，
    // 等价于清 workspace 归档行）②移入回收站（四层路径校验 + manifest 原子写 + 归档闸门）
    // ③物理清除（含级联）。全程复用回收站成熟能力，绝不裸删文件。
    deleteArchived: async (ids) => {
      const arr = Array.isArray(ids) ? ids : [];
      if (!trashService) return { ok: false, error: 'unsupported', message: '宿主未提供回收站能力' };
      if (arr.length === 0) return { ok: true, done: [], failed: [] };
      // ①先逐个原生解档；解档失败不阻断（会话文件仍在 sessions 目录，可被回收站 move 处理）。
      for (const id of arr) {
        try { if (nativeUnarchive) await nativeUnarchive(id); } catch { /* 继续 */ }
      }
      try {
        // ②移入回收站（含归档闸门 + realpath 校验 + manifest 原子写）。
        const moved = await trashService.trash(arr);
        const movedOk = moved && moved.ok !== false;
        // ③物理清除（含级联整族 fail-closed）。
        const purged = movedOk ? await trashService.purge(arr) : { ok: false, failed: arr };
        const done = (purged && Array.isArray(purged.done)) ? purged.done : (movedOk ? arr : []);
        const failed = (purged && Array.isArray(purged.failed)) ? purged.failed : (movedOk ? [] : arr);
        const ok = movedOk && !(purged && purged.ok === false);
        // 失败时附带明确原因，避免前端 request() 抛出裸 "request failed"。
        let message;
        if (!ok) {
          const moveReasons = (moved && Array.isArray(moved.rejected))
            ? moved.rejected.map((r) => `${r.id}: ${r.reason || r.detail || 'rejected'}`) : [];
          const purgeReasons = (purged && purged.ok === false && purged.message)
            ? [String(purged.message)] : [];
          message = moveReasons.concat(purgeReasons).join('; ') || '删除失败（会话可能正在运行或路径校验未通过）';
        }
        return { ok, done, failed, message };
      } catch (error) {
        return { ok: false, error: 'delete_failed', message: String((error && error.message) || error), done: [], failed: arr };
      }
    },

    // —— 回收站融合：直接透传 TrashService 的成熟方法（原子写/锁/闸门/级联均在内）——
    hasTrash: () => !!trashService,
    // 回收站融合：透传 TrashService，并补齐前端筛选所需字段（tags/workspace）。
    // 标题/正文/cwd 由 TrashService.list 一次解压得出；tags 来自旁路账本（回收站 manifest
    // 本无 tags，绝不改其数据模型），workspace 由 cwd 经 workspace.json 表映射成友好名。
    trashList: async () => {
      const res = trashService
        ? await trashService.list()
        : { ok: false, error: 'unsupported', entries: [], count: 0 };
      const ws = readWorkspaces(fs, dshHome);
      const entries = (res.entries || []).map((e) => {
        const meta = store.getSession(e.id);
        const tags = meta && Array.isArray(meta.tags) ? meta.tags.slice() : [];
        const workspace = workspaceTitleFor(ws, e.cwd || null);
        return { ...e, tags, workspace };
      });
      return { ...res, entries, count: typeof res.count === 'number' ? res.count : entries.length };
    },
    trashSnapshot: () => (trashService ? trashService.snapshot() : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashRestore: (id) => (trashService ? trashService.restore(id) : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashMove: (ids) => (trashService ? trashService.trash(ids) : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashPurge: (ids) => (trashService ? trashService.purge(ids) : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashCascade: (ids, reason) => (trashService ? trashService.cascadePurge(ids, reason ?? {}) : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashPurgeExpired: () => (trashService ? trashService.purgeExpired() : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashRecover: () => (trashService ? trashService.recoverPurging() : Promise.resolve({ ok: false, error: 'unsupported' })),
  };
}
