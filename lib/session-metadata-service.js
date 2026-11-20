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
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readArchivedIds, readArchiveLedger, readFeedStatuses, statusLabels, readWorkspaces, workspaceTitleFor, readSessionIndexIds, readSessionDirSizes } from './native-session-source.js';

export const METADATA_API_PREFIX = '/api/dsh-yanyan-session-hub';

/**
 * 会话 id 规范化为「带 session- 前缀」的唯一形式，用于跨数据源去重。
 * 根因（m02649）：projcache 文件名多为裸 UUID，readSessionIndexIds 为兼容查询把
 * 裸 UUID 与 session- 前缀两个拼写都登记进 Map；而 list() 的 seen 用原始字符串去重，
 * 导致同一会话被算两次（231 = 34 + 6 + 191，重复 113）。改用 canonical key 后为 118。
 */
function canonicalId(value) {
  if (typeof value !== 'string' || !value) return value;
  return value.startsWith('session-') ? value : 'session-' + value;
}

/**
 * 从 workspace.json 的 global.archivedSessionIds 移除给定 id 的所有拼写（m04242「删两次」兜底）。
 * 仅归档幽灵常以「裸 id」留在归档清单，原生 unarchiveSession 可能因拼写不匹配而清不掉；
 * 这里在文件级再兜底移除一次（双拼写 + nonce temp + rename 原子写，复用 writeMetadata 纪律）。
 * 注意：readArchivedIds 内存优先，故主修复仍是多拼写 nativeUnarchive；本函数覆盖降级/重启后场景。
 * 全程 fail-closed：任一读写失败都不影响删除主流程；只移除命中的 spellings，绝不重建整个数组。
 */
function unarchiveInWorkspaceFile(fs, dshHome, spellings) {
  try {
    const p = join(dshHome, 'storages', 'workspace.json');
    const read = typeof fs.readFileSync === 'function' ? fs.readFileSync : readFileSync;
    const write = typeof fs.writeFileSync === 'function' ? fs.writeFileSync : writeFileSync;
    const ren = typeof fs.renameSync === 'function' ? fs.renameSync : renameSync;
    const ex = typeof fs.existsSync === 'function' ? fs.existsSync : existsSync;
    if (!ex(p)) return false;
    const doc = JSON.parse(read(p, 'utf8'));
    const arr = doc && doc.global && doc.global.archivedSessionIds;
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const drop = new Set((spellings || []).filter(Boolean));
    const next = arr.filter((x) => !drop.has(x));
    if (next.length === arr.length) return false; // 未命中，无需写
    doc.global.archivedSessionIds = next;
    const nonce = `${process.pid}.${Math.random().toString(36).slice(2)}`;
    const tmp = `${p}.${nonce}.tmp`;
    write(tmp, JSON.stringify(doc, null, 2), 'utf8');
    ren(tmp, p);
    return true;
  } catch {
    return false;
  }
}

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
    // 会话日志目录的物理大小（字节）：借鉴「会话归档管理」插件，一次目录扫描拿到
    // 每个会话的磁盘占用，供 UI 显示（如 1.2 MB）。比索引的文本字符数更贴近真实大小。
    const dirSizes = readSessionDirSizes(fs, dshHome);
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
    // 幽灵会话判定（m03995）：磁盘四路（物理日志/projcache/账本/归档清单）全无、且 feed
    // 无实时标题或运行状态的会话，是物理已删除但宿主运行时内存残留的幽灵。
    // 这类会话显示出来只会被勾选、删除时报 not found by locate() 且反复删不掉。
    // 主列表路径必须和两条兜底路径一样过滤掉它们；正在使用的会话（feed 有 title/running）
    // 绝不会被误判。
    const isGhostSession = (id) => {
      const canon = canonicalId(id);
      const bare = String(id).replace(/^session-/, '');
      const fe = feed.get(id) || feed.get(canon) || {};
      const inDir = dirSizes.has(id) || dirSizes.has(canon) || dirSizes.has(bare);
      const inIndex = sessionIndex.has(id) || sessionIndex.has(canon) || sessionIndex.has(bare);
      const inLedger = !!(meta.sessions[id] || meta.sessions[canon] || meta.sessions[bare]);
      const inArchived = archivedIds.has(id) || archivedIds.has(canon) || archivedIds.has(bare);
      const live = !!(fe.title || fe.running);
      return !inDir && !inIndex && !inLedger && !inArchived && !live;
    };
    // 回收站会话过滤（m00490）：会话被 trashMove 移入回收站时会写入归档清单，
    // 主路径/账本/归档清单/projcache 四条列表路径都可能把它重新列出并标成「已归档」。
    // 但这些会话只应出现在回收站 tab 的独立数据源里，不应混进会话/归档列表。
    // 只读 fail-closed：trashService 未实现 isTrashed 时（多数单测 mock）不过滤。
    const isInTrash = (id) => {
      try {
        return typeof trashService === 'object' && trashService !== null
          && typeof trashService.isTrashed === 'function'
          && trashService.isTrashed(id) === true;
      } catch { return false; }
    };
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
      // 大小：优先物理日志目录大小（真实磁盘占用，与「会话归档管理」一致），
      // 回退到索引留档文本字节数（≈2×字符数），都没有则 null。
      // 注意旧代码只读 im.size，而 search-index.listSessions 曾不带 size → 全部 null。
      const dirBytes = dirSizes.get(id);
      const size = typeof dirBytes === 'number'
        ? dirBytes
        : (typeof im.size === 'number' ? im.size * 2 : null);
      // 标题优先级：自定义标题 > feed 实时标题 > 原生 projcache 标题 > 行/日志派生标题 > 截断 id。
      // 关键：feed 的 projections.values.title 是纯运行时会话（projcache/日志均无磁盘记录）
      // 唯一的标题来源，也是最实时的；绝不能被日志/blank 的空判定覆盖。
      let title;
      if (m.customTitle && String(m.customTitle).trim()) title = String(m.customTitle).trim();
      else if (st.title) title = st.title;
      else if (si.title) title = si.title;
      else title = displayTitle(row, m);
      // 只要 feed 报出实时标题，用户就正在使用该会话，不能标记为空会话。
      const effectiveEmpty = st.title ? false : empty;
      // 空会话友好标题：仅当完全没有可用标题时才合成，避免「有标题却显示空会话·id」。
      if (effectiveEmpty && !m.customTitle && !st.title && !si.title) title = "空会话 · " + String(id).slice(0, 8);
      // 自动状态标签（不写入用户 tags，单独字段，UI 以 chip 展示，可与手动标签共存）。
      const statusArr = statusLabels({ archived, running: st.running === true || row.running === true, blank: st.blank === true, origin });
      if (effectiveEmpty) statusArr.unshift("空会话");
      return {
        id,
        title,
        folderId: m.folderId || UNFILED_FOLDER_ID,
        tags: m.tags.slice(),
        customTitle: m.customTitle || '',
        updatedAt: row.updatedAt ?? row.lastActivityAt ?? st.updatedAt ?? im.updatedAt ?? null,
        running: st.running === true || row.running === true,
        blank: st.blank === true,
        empty: effectiveEmpty,
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
    const items = [];
    for (const row of rows) {
      // m03995：主路径过滤磁盘四路全无的幽灵会话（运行时内存残留，删不掉）。
      if (isGhostSession(row.id)) continue;
      // m00490：已在回收站的会话不出现在会话/归档列表（只应见于回收站 tab）。
      if (isInTrash(row.id)) continue;
      seen.add(canonicalId(row.id));
      const m = meta.sessions[row.id] || { tags: [], folderId: null, customTitle: '' };
      items.push(buildItem(row, m, { active: true }));
    }
    // 账本里存在、但当前活跃列表里没有的会话（例如刚恢复/被归档）也展示，标记 active=false。
    for (const [id, m] of Object.entries(meta.sessions)) {
      // m00490：已在回收站的会话不出现在会话/归档列表。
      if (isInTrash(id)) continue;
      if (seen.has(canonicalId(id))) continue;
      seen.add(canonicalId(id));
      items.push(buildItem({ id, updatedAt: m.archivedAt ?? null }, m, { active: false }));
    }
    // 原生归档清单里有、但扫描/账本都没覆盖的会话也补进来（确保「已归档」tab 不缺项）。
    // 标题回退到 customTitle 或短 id —— 归档会话的日志若已被物理清理也能列出来。
    // 口径对齐（m04137）：会话归档管理把「仅存在于归档清单、物理已无」的会话也计入
    // （buildInventory 的 archivedSet 兜底，标 no-data 供清理）。这里同样全部保留，
    // 使本插件总数与归档管理一致（physical ∪ archived）。这类会话的删除由 deleteArchived
    // 的 isPhysicalGhost 分支直接解档清理，不会触发 not found by locate()。
    for (const id of archivedIds) {
      // m00490：归档清单兜底是「未归档会话被 trashMove 后仍显示为已归档」的主泄漏路径。
      if (isInTrash(id)) continue;
      if (seen.has(canonicalId(id))) continue;
      const canon = canonicalId(id);
      seen.add(canon);
      const m = meta.sessions[id] || { tags: [], folderId: null, customTitle: '' };
      const short = id.replace(/^session-/, '');
      const title = m.customTitle || (short.length > 12 ? short.slice(0, 8) + '…' + short.slice(-4) : short);
      items.push(buildItem({ id, title, updatedAt: m.archivedAt ?? null }, m, { active: false }));
    }
    // 原生会话索引里有、但磁盘日志与账本都没覆盖的会话也补进来（与「会话归档管理」总数口径对齐）。
    // 这些会话日志可能已被物理清理，只有 projcache 索引残留；只登记条目供归档/删除/管理，内容不可搜。
    for (const [id, info] of sessionIndex) {
      // m00490：已在回收站的索引会话同样不出现在会话/归档列表。
      if (isInTrash(id)) continue;
      if (seen.has(canonicalId(id))) continue;
      // 幽灵空壳过滤（m03137 根治）：仅存在于 projcache 索引、但物理日志/账本/归档清单/
      // 回收站四路都没有的会话，是历史遗留的幽灵残留——显示出来只会让归档/删除报
      // request failed / not found by locate()。这里直接跳过，从源头不再显示、不再报错。
      // 注意：feed（运行时会话）有标题或状态的会话绝不过滤——它们是正在使用的真实会话。
      const canon = canonicalId(id);
      const feedEntry = feed.get(id) || feed.get(canon) || {};
      const inDirSizes = dirSizes.has(id) || dirSizes.has(canon) || dirSizes.has(String(id).replace(/^session-/, ''));
      const inLedger = !!(meta.sessions[id] || meta.sessions[canon]);
      const inArchived = archivedIds.has(id) || archivedIds.has(canon);
      if (!inDirSizes && !inLedger && !inArchived && !feedEntry.title && !feedEntry.running) continue;
      seen.add(canon);
      const m = meta.sessions[id] || { tags: [], folderId: null, customTitle: '' };
      const short = String(id).replace(/^session-/, '');
      const feedTitle = (feed.get(id) || {}).title;
      // 优先用 feed 实时标题，其次原生 projcache 标题（info.title），再 customTitle，最后截断 id。
      const title = feedTitle || m.customTitle || info.title || (short.length > 12 ? short.slice(0, 8) + '…' + short.slice(-4) : short);
      const item = buildItem({ id, title, updatedAt: info.createdAt ?? null }, m, { active: false });
      // 补上 projcache 里的 cwd/createdAt（buildItem 从 indexMeta 取，这里没有）。
      if (!item.cwd && info.cwd) {
        item.cwd = info.cwd;
        item.workspace = workspaceTitleFor(workspaces, info.cwd);
      }
      if (!item.createdAt && info.createdAt) item.createdAt = info.createdAt;
      // 只有原生确认为空白（blank===true）或完全无标题时才标空会话；有真实标题的索引会话不再误杀。
      // feed 报出实时标题时视为正在使用，强制不标空会话。
      item.empty = feedTitle ? false : (info.blank === true || (!item.title || item.title === short));
      item.indexOnly = true;
      if (item.empty && !item.status.includes('空会话')) item.status.unshift('空会话');
      if (!item.empty) item.status = item.status.filter((s) => s !== '空会话');
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

  // 用闭包变量承载服务面，便于 deleteAny 复用同一对象里的 deleteArchived / trashMove
  // （箭头函数在运行期才求值，此时 service 已赋值完成）。
  const service = {
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
    deleteSession: (sessionId) => store.deleteSession(sessionId),

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
      // ①按物理状态分组（真机 m01591 / m03440）：
      //   · 已在回收站的 → 直接 purge（purge 只认 manifest 有条目者）；
      //   · 无物理目录的「归档幽灵」→ trash() 的 preflight locate() 必然找不到目标而整批失败，
      //     对它们只做解档/清账本/清索引引用并视作 done（无物理可删）；
      //   · 其余真实会话 → 原 trash→purge 流程。
      //   preflight 是整批 fail-closed —— 一条幽灵会话就能拖垮整批删除。
      // 幽灵判定所需的只读事实源（fail-closed，任一读取失败按"无"处理，交给常规流程兜底）。
      let ghostDirSizes = new Map();
      let ghostIndex = new Map();
      let ghostFeed = new Map();
      let ghostArchivedIds = new Set();
      try { ghostDirSizes = readSessionDirSizes(fs, dshHome); } catch { /* 空 Map */ }
      try { ghostIndex = readSessionIndexIds(fs, dshHome); } catch { /* 空 Map */ }
      try { ghostFeed = await readFeedStatuses(ctx); } catch { /* 空 Map */ }
      try { ghostArchivedIds = readArchivedIds(fs, dshHome, registry).ids; } catch { /* 空 Set */ }
      const isPhysicalGhost = (id) => {
        const canon = canonicalId(id);
        const bare = String(id).replace(/^session-/, '');
        // 「归档幽灵」必须本身在归档清单里（deleteArchived 的入参语义），否则一条 trash
        // 失败的真实会话也可能因内存 fs 无物理目录而被误判，破坏"失败进 failed"契约。
        const inArchived = ghostArchivedIds.has(id) || ghostArchivedIds.has(canon) || ghostArchivedIds.has(bare);
        if (!inArchived) return false;
        const inDir = ghostDirSizes.has(id) || ghostDirSizes.has(canon) || ghostDirSizes.has(bare);
        const inIndex = ghostIndex.has(id) || ghostIndex.has(canon) || ghostIndex.has(bare);
        const fe = ghostFeed.get(id) || ghostFeed.get(canon) || {};
        const live = !!(fe.title || fe.running); // 运行中的真实会话绝不当幽灵
        return !inDir && !inIndex && !live;
      };
      const alreadyTrashed = [];
      const ghostArchived = [];
      const notTrashed = [];
      for (const id of arr) {
        let inTrash = false;
        try {
          inTrash = typeof trashService.isTrashed === 'function' && trashService.isTrashed(id);
        } catch { inTrash = false; }
        if (inTrash) alreadyTrashed.push(id);
        else if (isPhysicalGhost(id)) ghostArchived.push(id);
        else notTrashed.push(id);
      }
      const done = [];
      const failed = [];
      const reasons = [];
      const absorbPurge = (purged, fallbackIds) => {
        const results = (purged && Array.isArray(purged.results)) ? purged.results : [];
        if (results.length === 0) {
          if (purged && purged.ok === false) {
            for (const id of fallbackIds) {
              failed.push({ id, message: (purged && purged.message) || 'purge 预检未通过' });
              reasons.push(`${id}: ${(purged && purged.message) || 'purge preflight rejected'}`);
            }
          } else {
            done.push(...fallbackIds);
          }
          return;
        }
        results.forEach((r, i) => {
          const rid = r.id ?? r.rawId ?? fallbackIds[i];
          if (r.status === 'ok') done.push(rid);
          else {
            failed.push({ id: rid, message: r.reason || r.detail || r.status });
            reasons.push(`${rid}: ${r.reason || r.detail || r.status}`);
          }
        });
      };
      try {
        // 归档幽灵（m03440）：无物理目录、无 projcache、不在回收站，只是归档清单里的残留标记。
        // 没有物理可删，直接计入 done —— 后置循环会解档（从归档清单移除）+ 清账本 + 清索引引用。
        if (ghostArchived.length > 0) done.push(...ghostArchived);
        // 已在回收站：直接物理清除（含级联整族 fail-closed），跳过 trash 阶段。
        if (alreadyTrashed.length > 0) {
          absorbPurge(await trashService.purge(alreadyTrashed), alreadyTrashed);
        }
        // 不在回收站：原 trash→purge 流程。
        if (notTrashed.length > 0) {
          const moved = await trashService.trash(notTrashed);
          if (moved && moved.ok !== false) {
            absorbPurge(await trashService.purge(notTrashed), notTrashed);
          } else {
            const moveReasons = (moved && Array.isArray(moved.rejected))
              ? moved.rejected.map((r) => `${r.id}: ${r.reason || r.detail || 'rejected'}`) : [];
            reasons.push(...moveReasons);
            for (const id of notTrashed) failed.push({ id, message: moveReasons.join('; ') || 'trash 预检未通过' });
          }
        }
        // ③解档 + 清账本后置（真机 m02120 / m03137）：只对已成功物理删除的会话执行，
        //   失败/超时的会话保持归档状态，避免「已解档但没删掉」变成原生列表里的未命名幽灵。
        //   - 原生解档：把 id 从原生归档清单移除；解档失败不阻断。
        //   - 清账本：物理删除后删掉账本条目，根治「删了会话却留下账本孤儿」（两手拼写都尝试）。
        for (const id of done) {
          // 原生解档（m04242「删两次」根因）：仅归档幽灵常以「裸 id」存在于归档清单
          // （readArchivedIds 原样 add，不规范化），而宿主 unarchiveSession 内部按
          // session- 前缀规范化匹配；只传裸 id 会解档失败 → 归档标记清不掉 → 下次
          // list() 归档兜底又把它列出来，表现为「删一次没消失，要删两次」。
          // 三种拼写都尝试（与下方账本/projcache 清理同构），任一命中即更新宿主内存归档态。
          try {
            if (nativeUnarchive) {
              for (const sp of new Set([String(id), String(id).replace(/^session-/, ''), canonicalId(id)])) {
                if (!sp) continue;
                try { await nativeUnarchive(sp); } catch { /* 单拼写失败，继续下一个拼写 */ }
              }
            }
          } catch { /* 删除已完成，解档失败不影响结果 */ }
          // 归档幽灵文件级兜底（m04242）：裸 id 解档可能因拼写在宿主内存里清不掉，
          // 这里对归档清单文件再兜底移除一次（双拼写+原子写），确保重启后也不会复活。
          if (ghostArchived.includes(id)) {
            unarchiveInWorkspaceFile(fs, dshHome, [String(id), String(id).replace(/^session-/, ''), canonicalId(id)]);
          }
          try {
            await store.deleteSession(id);
            const bare = String(id).replace(/^session-/, '');
            if (bare !== id) await store.deleteSession(bare);
          } catch { /* 账本清理失败不影响物理删除结果 */ }
          // 清 projcache 空壳（真机 m03137）：物理会话已删，projcache/*.json 是 DSH 原生
          // 投影缓存，插件不主动维护；不删会留下「幽灵会话」继续出现在列表并触发归档/删除报错。
          // 两种拼写（裸 UUID / session- 前缀）都尝试，存在才删，fail-closed。
          try {
            const cacheDir = join(dshHome, 'storages', 'session_projcache', 'sessions');
            const unlink = typeof fs.unlinkSync === 'function' ? fs.unlinkSync : unlinkSync;
            const exists = typeof fs.existsSync === 'function' ? fs.existsSync : existsSync;
            const spellings = new Set([String(id), String(id).replace(/^session-/, ''), canonicalId(id)]);
            for (const sp of spellings) {
              if (!sp) continue;
              const p = join(cacheDir, sp + '.json');
              try { if (exists(p)) unlink(p); } catch { /* 单个清理失败不影响其它 */ }
            }
          } catch { /* projcache 清理失败不影响物理删除结果 */ }
        }
        const ok = failed.length === 0;
        const message = ok ? undefined : (reasons.join('; ') || '删除失败（会话可能正在运行或路径校验未通过）');
        return { ok, done, failed, message };
      } catch (error) {
        return { ok: false, error: 'delete_failed', message: String((error && error.message) || error), done, failed: failed.length ? failed : arr };
      }
    },

    // —— 回收站融合：直接透传 TrashService 的成熟方法（原子写/锁/闸门/级联均在内）——
    hasTrash: () => !!trashService,
    // 回收站融合：透传 TrashService，并补齐前端筛选所需字段（tags/workspace/status）。
    // 标题/正文/cwd/origin 由 TrashService.list 一次解压得出；tags 来自旁路账本（回收站 manifest
    // 本无 tags，绝不改其数据模型），workspace 由 cwd 经 workspace.json 表映射成友好名。
    // status 与会话栏共用 statusLabels：回收站条目天然 archived=true、running=false，
    // blank 用标题缺失近似（回收站已无 projcache blank 标志），origin 取日志 header。
    trashList: async () => {
      const res = trashService
        ? await trashService.list()
        : { ok: false, error: 'unsupported', entries: [], count: 0 };
      const ws = readWorkspaces(fs, dshHome);
      const entries = (res.entries || []).map((e) => {
        const meta = store.getSession(e.id);
        const tags = meta && Array.isArray(meta.tags) ? meta.tags.slice() : [];
        const workspace = workspaceTitleFor(ws, e.cwd || null);
        const blank = !e.title;
        const status = statusLabels({ archived: true, running: false, blank, origin: e.origin || null });
        if (blank) status.unshift('空会话');
        return { ...e, tags, workspace, status };
      });
      return { ...res, entries, count: typeof res.count === 'number' ? res.count : entries.length };
    },
    trashSnapshot: () => (trashService ? trashService.snapshot() : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashRestore: (id) => (trashService ? trashService.restore(id) : Promise.resolve({ ok: false, error: 'unsupported' })),
    // m03928：trash() 失败只返回 {rejected,results} 无 message/error，前端 request() 遇到
    // ok:false 取不到原因就抛通用 "request failed"。这里把拒绝明细拼成 message 带出来。
    trashMove: async (ids) => {
      if (!trashService) return { ok: false, error: 'unsupported', message: '宿主未提供回收站能力' };
      const res = await trashService.trash(ids);
      if (res && res.ok === false && !res.message && !res.error) {
        const parts = [];
        if (Array.isArray(res.rejected)) {
          res.rejected.forEach((r) => parts.push(`${r.id}: ${r.reason || r.detail || 'rejected'}`));
        }
        if (parts.length === 0 && Array.isArray(res.results)) {
          res.results.filter((r) => r && r.status !== 'ok')
            .forEach((r) => parts.push(`${r.id}: ${r.reason || r.detail || r.status}`));
        }
        return { ...res, message: parts.join('; ') || '移入回收站失败（会话可能正在运行或路径校验未通过）' };
      }
      return res;
    },
    trashPurge: (ids) => (trashService ? trashService.purge(ids) : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashCascade: (ids, reason) => (trashService ? trashService.cascadePurge(ids, reason ?? {}) : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashPurgeExpired: () => (trashService ? trashService.purgeExpired() : Promise.resolve({ ok: false, error: 'unsupported' })),
    trashRecover: () => (trashService ? trashService.recoverPurging() : Promise.resolve({ ok: false, error: 'unsupported' })),

    // —— 统一删除入口（原生会话右键菜单「删除」，m04502）——
    // 后端自行按归档状态分流，client 只传 id 列表、不感知归档态：
    //   · 已归档会话 → deleteArchived（解档 → 回收站 → 物理清除，即"直接删除"）；
    //   · 未归档会话 → trashMove（移入回收站）。
    // 与前端 batchDelete 的分组语义一致；归档清单读取 fail-closed（读不到则全部按未归档处理）。
    deleteAny: async (ids) => {
      const arr = Array.isArray(ids) ? ids.slice() : (ids ? [ids] : []);
      if (arr.length === 0) return { ok: true, done: [], failed: [] };
      let archived = new Set();
      try { archived = readArchivedIds(fs, dshHome, registry).ids; } catch { /* 空集：全部按未归档处理 */ }
      const archivedIds = [];
      const activeIds = [];
      for (const id of arr) {
        const canon = canonicalId(id);
        const bare = String(id).replace(/^session-/, '');
        const isArchived = archived.has(id) || archived.has(canon) || archived.has(bare);
        (isArchived ? archivedIds : activeIds).push(id);
      }
      const done = [];
      const failed = [];
      const reasons = [];
      if (archivedIds.length > 0) {
        const r = await service.deleteArchived(archivedIds);
        if (Array.isArray(r && r.done)) done.push(...r.done);
        if (Array.isArray(r && r.failed)) failed.push(...r.failed);
        if (r && r.message) reasons.push(String(r.message));
        else if (r && r.error) reasons.push(String(r.error));
      }
      if (activeIds.length > 0) {
        const r = await service.trashMove(activeIds);
        if (r && r.ok === false) {
          const rf = Array.isArray(r.failed) ? r.failed
            : activeIds.map((id) => ({ id, message: String((r && r.message) || (r && r.error) || '移入回收站失败') }));
          failed.push(...rf);
          reasons.push(String((r && r.message) || (r && r.error) || '移入回收站失败'));
        } else {
          // 未归档会话成功进入回收站即视为完成。
          done.push(...activeIds);
        }
      }
      const ok = failed.length === 0;
      return { ok, done, failed, message: ok ? undefined : (reasons.join('; ') || '删除失败（会话可能正在运行或路径校验未通过）') };
    },
  };
  return service;
}
