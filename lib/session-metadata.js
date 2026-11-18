// dsh-plugin-yanyan-toolkit — 会话管理中心 · 元数据旁路存储（Phase 1 数据层）。
//
// 设计纪律（全程沿用路径 A / 回收站的成熟轮子）：
//   - 绝对不碰 DSH 原生会话文件：本模块只在 $DSH_HOME/session-metadata.json
//     读写一份旁路账本，记录 sessionId -> { tags, folderId, customTitle } 与
//     文件夹定义。所有原生 sessions/ 目录只读不写。
//   - 拒绝重复造轮子：原子写照抄 lib/session-trash.js:323 writeManifest
//     （nonce temp + rename 覆盖），并发锁照抄 lib/session-trash.js:338
//     withManifestLock（Promise 链串行），DSH_HOME 解析复用 resolveDshHome。
//   - 纯逻辑 + 依赖注入：fs / dshHome 都可注入，便于离线单测（内存 fs）。
//   - fail-closed：所有写方法先校验入参（sessionId/folderId/tag 必须是合法字符串），
//     损坏的 JSON 账本按空账本处理而非抛错，绝不静默产生脏数据。
//   - 幂等：重复打同一标签、重命名成同名、删除不存在的条目均返回成功且不产生副作用。

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveDshHome } from './session-trash.js';

/** 账本文件名与版本（落在 $DSH_HOME 根，与 session-trash/ 平级）。 */
export const METADATA_FILE_NAME = 'session-metadata.json';
export const METADATA_VERSION = 1;

/** 回收站作为特殊「系统文件夹」的逻辑 id（不出现在用户文件夹列表的可删除项里）。 */
export const TRASH_FOLDER_ID = '@trash';
export const UNFILED_FOLDER_ID = '@unfiled';

/** Node 默认 fs 适配器（与 session-trash 的 defaultFs 同构，供 service 层注入）。 */
export function defaultFs() {
  return { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync };
}

/** 解析账本绝对路径：$DSH_HOME/session-metadata.json。env/home 可注入以便测试。 */
export function metadataPath(dshHome) {
  return join(dshHome, METADATA_FILE_NAME);
}

/** 解析 DSH_HOME 的便捷包装（转发到现成 resolveDshHome，不重复实现）。 */
export function resolveHome(env, home) {
  return resolveDshHome(env, home === undefined ? homedir() : home);
}

/** 空账本结构。folders: { [folderId]: { id, name, createdAt } }；sessions: { [sessionId]: {...} }。 */
export function emptyMetadata() {
  return { version: METADATA_VERSION, folders: {}, sessions: {} };
}

/** 校验并规范化账本：损坏/旧版本/字段缺失一律回填成合法结构，绝不抛错。 */
export function normalizeMetadata(raw) {
  const out = emptyMetadata();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (raw.folders && typeof raw.folders === 'object' && !Array.isArray(raw.folders)) {
    for (const [id, folder] of Object.entries(raw.folders)) {
      if (!isValidId(id) || !folder || typeof folder !== 'object') continue;
      out.folders[id] = {
        id,
        name: typeof folder.name === 'string' && folder.name.trim() ? folder.name.trim() : id,
        createdAt: typeof folder.createdAt === 'string' ? folder.createdAt : new Date(0).toISOString(),
      };
    }
  }
  if (raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)) {
    for (const [id, entry] of Object.entries(raw.sessions)) {
      if (!isValidSessionId(id) || !entry || typeof entry !== 'object') continue;
      const tags = Array.isArray(entry.tags)
        ? [...new Set(entry.tags.filter((x) => isValidId(x)))]
        : [];
      const folderId = typeof entry.folderId === 'string' && entry.folderId ? entry.folderId : null;
      out.sessions[id] = {
        tags,
        folderId,
        customTitle: typeof entry.customTitle === 'string' ? entry.customTitle : '',
        // 归档状态：原生 API 归档后会话从活跃列表消失，账本是「已归档」清单的唯一事实源。
        archived: entry.archived === true,
        archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : null,
      };
    }
  }
  return out;
}

/** id 合法性：非空字符串、无路径分隔符/空字节、长度上限 200（沿用 SEGMENT_RE 思路，但不强制 session- 前缀）。 */
export function isValidId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[\\/\\\0]/.test(value)
    && value !== '.'
    && value !== '..'
    && !value.includes('..');
}

/** sessionId 合法性：允许带或不带 session- 前缀，其余同 isValidId。 */
export function isValidSessionId(value) {
  return isValidId(value);
}

/** 读账本：不存在或损坏都返回空账本（fail-closed，不抛错）。 */
export function readMetadata(fs, dshHome) {
  try {
    const path = metadataPath(dshHome);
    if (!fs.existsSync(path)) return emptyMetadata();
    const raw = fs.readFileSync(path, 'utf8');
    return normalizeMetadata(JSON.parse(raw));
  } catch {
    return emptyMetadata();
  }
}

/**
 * 原子写账本（复用 session-trash writeManifest 的 nonce temp + rename 纪律）：
 * write temp → rename 覆盖，避免写一半崩溃导致整个账本丢失；不用 unlink。
 */
export function writeMetadata(fs, dshHome, metadata) {
  fs.mkdirSync(dshHome, { recursive: true });
  const finalPath = metadataPath(dshHome);
  const nonce = `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const tmpPath = `${finalPath}.${nonce}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2), 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

/** 进程内串行锁（复用 withManifestLock 的 Promise 链策略）：所有读-改-写排队。 */
let metadataChain = Promise.resolve();
export function withMetadataLock(task) {
  const run = metadataChain.then(task, task);
  metadataChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 生成文件夹 id：基于名字 slug + 时间戳 + 随机后缀，避免中文名直接做 key 的不确定性。 */
export function makeFolderId(name, now = Date.now(), rand = Math.random) {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'folder';
  return `${slug}-${now.toString(36)}-${rand().toString(36).slice(2, 8)}`;
}

/**
 * 创建 MetadataStore：所有写操作都经 withMetadataLock 串行，读操作取当前快照。
 * 每次写都基于「锁内最新账本」重新读盘，避免多实例并发时后写覆盖先写。
 */
export function createMetadataStore(fs, dshHome) {
  const read = () => readMetadata(fs, dshHome);
  const write = (m) => writeMetadata(fs, dshHome, m);
  const mutate = (fn) => withMetadataLock(() => {
    const m = read();
    const result = fn(m);
    write(m);
    return result;
  });

  return {
    read,
    /** 返回账本的深拷贝快照，供 UI 渲染。 */
    snapshot: () => normalizeMetadata(read()),

    // ---- 文件夹 ----
    listFolders() {
      return Object.values(read().folders).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    createFolder(name, options = {}) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('folder name required');
      return mutate((m) => {
        const id = options.id && isValidId(options.id) ? options.id : makeFolderId(name);
        if (m.folders[id]) throw new Error(`folder exists: ${id}`);
        const folder = { id, name: name.trim(), createdAt: new Date().toISOString() };
        m.folders[id] = folder;
        return folder;
      });
    },
    renameFolder(id, newName) {
      if (!isValidId(id)) throw new Error('invalid folder id');
      if (typeof newName !== 'string' || !newName.trim()) throw new Error('folder name required');
      return mutate((m) => {
        if (!m.folders[id]) throw new Error(`folder not found: ${id}`);
        m.folders[id].name = newName.trim();
        return m.folders[id];
      });
    },
    deleteFolder(id) {
      if (!isValidId(id)) throw new Error('invalid folder id');
      if (id === TRASH_FOLDER_ID || id === UNFILED_FOLDER_ID) throw new Error('system folder cannot be deleted');
      return mutate((m) => {
        if (!m.folders[id]) return { ok: true, moved: 0 };
        delete m.folders[id];
        // 归入该文件夹的会话退回「未分类」，原生会话文件不受影响。
        let moved = 0;
        for (const entry of Object.values(m.sessions)) {
          if (entry.folderId === id) { entry.folderId = null; moved++; }
        }
        return { ok: true, moved };
      });
    },

    // ---- 会话元数据 ----
    getSession(sessionId) {
      if (!isValidSessionId(sessionId)) return null;
      return read().sessions[sessionId] || null;
    },
    ensureSession(sessionId) {
      if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
      return mutate((m) => {
        if (!m.sessions[sessionId]) {
          m.sessions[sessionId] = { tags: [], folderId: null, customTitle: '' };
        }
        return m.sessions[sessionId];
      });
    },
    setSessionFolder(sessionId, folderId) {
      if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
      if (folderId !== null && folderId !== TRASH_FOLDER_ID && folderId !== UNFILED_FOLDER_ID && !isValidId(folderId)) {
        throw new Error('invalid folder id');
      }
      return mutate((m) => {
        if (!m.sessions[sessionId]) m.sessions[sessionId] = { tags: [], folderId: null, customTitle: '' };
        m.sessions[sessionId].folderId = folderId;
        return m.sessions[sessionId];
      });
    },
    addTag(sessionId, tag) {
      if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
      if (!isValidId(tag)) throw new Error('invalid tag');
      return mutate((m) => {
        if (!m.sessions[sessionId]) m.sessions[sessionId] = { tags: [], folderId: null, customTitle: '' };
        const tags = m.sessions[sessionId].tags;
        if (!tags.includes(tag)) tags.push(tag);
        return m.sessions[sessionId];
      });
    },
    removeTag(sessionId, tag) {
      if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
      if (!isValidId(tag)) throw new Error('invalid tag');
      return mutate((m) => {
        if (!m.sessions[sessionId]) return { tags: [], folderId: null, customTitle: '' };
        m.sessions[sessionId].tags = m.sessions[sessionId].tags.filter((t) => t !== tag);
        return m.sessions[sessionId];
      });
    },
    setCustomTitle(sessionId, title) {
      if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
      if (typeof title !== 'string') throw new Error('invalid title');
      return mutate((m) => {
        if (!m.sessions[sessionId]) m.sessions[sessionId] = { tags: [], folderId: null, customTitle: '' };
        m.sessions[sessionId].customTitle = title;
        return m.sessions[sessionId];
      });
    },
    /** 标记会话为已归档（原生 API 归档成功后调用；账本是已归档清单的事实源）。 */
    markArchived(sessionId, archivedAt) {
      if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
      return mutate((m) => {
        if (!m.sessions[sessionId]) m.sessions[sessionId] = { tags: [], folderId: null, customTitle: '' };
        m.sessions[sessionId].archived = true;
        m.sessions[sessionId].archivedAt = archivedAt || new Date().toISOString();
        return m.sessions[sessionId];
      });
    },
    /** 取消归档标记（原生 API 解档成功后调用）。 */
    markUnarchived(sessionId) {
      if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
      return mutate((m) => {
        if (!m.sessions[sessionId]) return { tags: [], folderId: null, customTitle: '' };
        m.sessions[sessionId].archived = false;
        m.sessions[sessionId].archivedAt = null;
        return m.sessions[sessionId];
      });
    },
    /** 汇总「所有标签」及其使用次数，供左侧导航标签过滤列表。 */
    allTags() {
      const counts = new Map();
      for (const entry of Object.values(read().sessions)) {
        for (const tag of entry.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },
    /** 概览：统计各文件夹/标签下的会话数，供 UI 徽标。 */
    overview() {
      const m = read();
      const folderCounts = {};
      const tagCounts = {};
      for (const entry of Object.values(m.sessions)) {
        const f = entry.folderId || UNFILED_FOLDER_ID;
        folderCounts[f] = (folderCounts[f] || 0) + 1;
        for (const tag of entry.tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
      return { folderCounts, tagCounts, total: Object.keys(m.sessions).length };
    },
  };
}
