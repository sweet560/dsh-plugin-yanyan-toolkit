// dsh-plugin-yanyan-toolkit — 回收站 Host 服务层。
//
// 职责：把前四阶段的四个纯函数模块（session-trash / purge / cascade / snapshot）
// 组装成「一个可被 HTTP 路由与 UI 消费的服务」。本文件不做物理 I/O 决策，
// 只负责三件事：
//   1) 解析 DSH_HOME → sessionsRoot / trashRoot；
//   2) 构造统一的 fs 适配器（带 __sessionsRoot / __trashRoot / rm）；
//   3) 把 ctx 的宿主能力（workspaceRegistry / agent / connection）
//      适配成四个模块需要的 deps 回调，并做能力探测（缺失即降级，不猜）。
//
// 设计纪律（全程沿用路径 A）：
//   - 拒绝重复造轮子：归档闸门/广播/活跃态/unarchive 全部走 ctx 已有能力，
//     fs 原语复用 session-trash.defaultFs，rm 复用 session-purge.makePurgeFs，
//     不新写任何原子写、锁、路径校验逻辑。
//   - 重大改变先核实：DSH_HOME 解析与现成包逐字节一致（lib/session-trash.js:116）；
//     unarchiveSession 已核实当前宿主存在（dsh-workspace/lib/index.js:559）。
//   - fail-closed：能力缺失时该操作返回明确错误，绝不静默放行。

import { join } from 'node:path';
import {
  defaultFs,
  resolveDshHome,
  readManifest,
  listTrash,
  makeScanner,
  runTrashPipeline,
  restoreFromTrash,
  archiveGateFromContext,
  emitterFromContext,
} from './session-trash.js';
import { makePurgeFs, purge, purgeExpired, recoverPurging } from './session-purge.js';
import { cascadePurge } from './session-cascade.js';
import { buildSnapshot, cascadePurgeFromTrash, readSessionTitle } from './session-snapshot.js';

export const TRASH_API_PREFIX = '/api/dsh-yanyan-trash';
export const REMOVED_EVENT = 'api-session/removed';
export const ADDED_EVENT = 'api-session/added';
export const PURGED_EVENT = 'api-session/purged';

/** 回收站根目录：复用第 1 阶段约定的 TRASH_ROOT_NAME（session-trash）。 */
export function rootsFor(dshHome) {
  const sessionsRoot = join(dshHome, 'sessions');
  const trashRoot = join(dshHome, 'session-trash');
  return { sessionsRoot, trashRoot };
}

/**
 * 构造 fs 适配器：defaultFs 的同步原语 + 第 2 阶段的 rm + 两个 root 字段。
 * 独立导出便于测试注入自定义 fs。
 */
export function makeServiceFs(sessionsRoot, trashRoot, baseFs = defaultFs()) {
  return { ...makePurgeFs(baseFs), __sessionsRoot: sessionsRoot, __trashRoot: trashRoot };
}

/**
 * 从 ctx 适配四个模块需要的运行时能力。每个能力都能力探测，缺失返回 null，
 * 由各模块自行 fail-closed（例如 archive gate 缺失时 preflight 直接拒绝）。
 */
/**
 * 从 ctx 按需取服务（serviceFace 模式，照抄现成包 lib/index.js:2070-2076）：
 * inject 只声明 webServer/workspaceRegistry，其余服务用 ctx.get 动态取，
 * 取不到返回 undefined，由调用方 fail-closed，绝不猜服务名硬取属性。
 */
function serviceFace(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

export function capabilitiesFromContext(ctx) {
  // 注册中心：优先 inject 的 ctx.workspaceRegistry，兜底 ctx.get（兼容两种注入形态）。
  const registry = ctx?.workspaceRegistry ?? serviceFace(ctx, 'workspaceRegistry');

  // 归档闸门：注册中心有 archiveSession 才可用。
  const archiveSession = typeof registry?.archiveSession === 'function'
    ? (id) => registry.archiveSession(id)
    : null;

  // 解档：当前宿主已提供 unarchiveSession（核实⑥）；缺失时 restore 会走 partial 降级。
  const unarchiveSession = typeof registry?.unarchiveSession === 'function'
    ? (id) => registry.unarchiveSession(id)
    : null;

  // 广播：宿主原生 emit（核实④）。
  // - removed/purged：payload 是字符串 session.id，与宿主 session/disposed 对齐（已真机验证）。
  // - added【真机 bug m03612/m03616 修复】：绝不能伪造。宿主原生 api-session/added 的 payload
  //   是 summaryFor(session) 对象（{sessionId, title, running, updatedAt, ...}，字段是 sessionId
  //   而非 id），监听方按对象取 .title/.sessionId；此前本插件发字符串 id，导致取值为 undefined，
  //   侧栏生成"未命名 / NaN / id=undefined"幽灵会话（点击报 session-undefined not found by locate）。
  //   现成包 @linxin666 恢复会话也不 emit added，而是由 client 调 sessions.refresh() 让宿主自行发现。
  //   故此处 emitAdded 恒为 null（session-trash.js 的 emitAdded?.() 成为 no-op）；UI 刷新交给 client refresh。
  const emit = typeof ctx?.emit === 'function' ? ctx.emit.bind(ctx) : null;
  const emitRemoved = emit ? (id) => emit(REMOVED_EVENT, id) : null;
  const emitAdded = null;
  const emitPurged = emit ? (id) => emit(PURGED_EVENT, id) : null;

  // 运行态：照抄现成包 liveSessionIds（ctx.get('sessions').list()）——回收站会话通常
  // 已不在 live store；读不到时视为「无活跃会话」，但 protectedReasonOf 读态异常
  // 走 throw（fail-safe），与第 4a 阶段 read-error 保护纪律一致。
  const liveIdsOf = () => {
    const store = serviceFace(ctx, 'sessions');
    const ids = new Set();
    if (typeof store?.list !== 'function') return ids;
    try {
      for (const session of store.list() ?? []) {
        if (typeof session?.id === 'string') ids.add(session.id);
      }
    } catch (error) {
      throw new Error('session live-store read failed');
    }
    return ids;
  };
  const isLive = (id) => {
    const ids = liveIdsOf();
    return ids.has(id) || ids.has(`session-${id}`);
  };
  // 真运行态：照现成包 hostProtectedReasons 的权威语义（janitor.d.ts:121-122 注释
  // "running (feed flag) ... travel on their own"；lib/index.js:2108 row.running），
  // running 来自 agent.status，独立于 attached（live store 成员）。
  // 【真机 bug m03443 修复】旧实现 return isLive(id) 把「在 sessions.list() 中」（attached）
  // 误当 running；空闲会话仍 attached，于是被 preflight 判为「is still running」而拒绝删除，
  // 但 move 从未发生、manifest 始终为空。宿主 agents 服务（cordis_inspect_list 实测）
  // get(id: SessionId): Agent | undefined，status === 'running' 才是真运行。
  // 能力缺失时返回 false（不误伤删除）；读态异常仍 throw（fail-safe）。
  const runningOf = (id) => {
    try {
      const agents = serviceFace(ctx, 'agents');
      if (typeof agents?.get !== 'function') return false;
      const agent = agents.get(id) ?? agents.get(`session-${id}`);
      return agent?.status === 'running';
    } catch {
      throw new Error('agent status read failed');
    }
  };
  // attached 保护：live store 中的会话（现成包 hostProtectedReasons 的 attached 来源）。
  const protectedReasonOf = (id) => {
    try {
      return isLive(id) ? 'attached' : undefined;
    } catch {
      throw new Error('workspace activity read failed');
    }
  };

  return {
    archiveSession,
    unarchiveSession,
    emitRemoved,
    emitAdded,
    emitPurged,
    runningOf,
    protectedReasonOf,
  };
}

/**
 * TrashService：按 ctx 组装全部 deps，暴露 list/restore/purge/cascade/recover。
 * 所有方法均为 async，返回「逐条结果 + ok」的统一形状，供路由直接序列化。
 */
export class TrashService {
  constructor(options = {}) {
    this.fs = options.fs ?? makeServiceFs(options.sessionsRoot, options.trashRoot);
    this.sessionsRoot = options.sessionsRoot ?? this.fs.__sessionsRoot;
    this.trashRoot = options.trashRoot ?? this.fs.__trashRoot;
    this.caps = options.caps ?? capabilitiesFromContext(options.ctx ?? {});
    this.retentionMs = options.retentionMs;
  }

  /** 统一 deps 基底：fs/roots + 全部 ctx 能力。 */
  baseDeps() {
    return {
      fs: this.fs,
      sessionsRoot: this.sessionsRoot,
      trashRoot: this.trashRoot,
      archiveSession: this.caps.archiveSession,
      unarchiveSession: this.caps.unarchiveSession,
      emitRemoved: this.caps.emitRemoved,
      emitAdded: this.caps.emitAdded,
      emitPurged: this.caps.emitPurged,
      runningOf: this.caps.runningOf,
      protectedReasonOf: this.caps.protectedReasonOf,
      locate: makeScanner(this.fs),
      isSessionActive: this.caps.runningOf,
    };
  }

  /**
   * 列出回收站条目（manifest 真相）。
   * 真机 A2 标题子项修复（m03612）：manifest 无 title、projcache 是过期旧值，
   * 唯一可靠来源是回收站会话日志里的 session/title 事件（末条最新）。逐条补 entry.title，
   * 读不到 fallback null，由 client 显示 title||id；绝不让单条读失败影响整批 list。
   */
  async list() {
    const entries = listTrash(this.fs, this.trashRoot).map((entry) => {
      let title = null;
      try {
        const dirPath = entry.trashedPath || entry.originalPath;
        if (dirPath) title = readSessionTitle(this.fs, dirPath);
      } catch (e) { title = null; }
      return { ...entry, title };
    });
    return { ok: true, entries, count: entries.length };
  }

  /** 撤销：把会话从回收站搬回原位置并解档。 */
  async restore(id) {
    return restoreFromTrash(id, this.baseDeps());
  }

  /** 移入回收站（显式删除入口：归档闸门 + rename + manifest）。 */
  async trash(ids) {
    return runTrashPipeline(ids, this.baseDeps());
  }

  /** 物理删除（显式彻底删除）：只接受已在回收站的条目。 */
  async purge(ids) {
    return purge(ids, this.baseDeps());
  }

  /** 保留期扫描：清理超过 retentionMs 的条目。 */
  async purgeExpired() {
    const deps = this.baseDeps();
    if (this.retentionMs !== undefined) deps.retentionMs = this.retentionMs;
    return purgeExpired(deps);
  }

  /** 崩溃恢复：收敛未完成的 purging 残留。宿主启动时调用一次。 */
  async recoverPurging() {
    return recoverPurging(this.baseDeps());
  }

  /** 构建完整会话树快照（供 UI 预览删除影响范围）。 */
  async snapshot() {
    return buildSnapshot(this.fs, this.trashRoot, {
      runningOf: this.caps.runningOf,
      protectedReasonOf: this.caps.protectedReasonOf,
    });
  }

  /**
   * 树级联物理删除：从回收站磁盘构建完整快照（独立对照源校验），
   * 再按 origin=subagent 关系级联，父成功子失败则 ok=false。
   * protectedReason 由 UI 侧传入（clientProtectedReason 已算好的 map，plain object）。
   */
  async cascadePurge(ids, protectedReason = {}) {
    const deps = this.baseDeps();
    deps.protectedReason = new Map(Object.entries(protectedReason));
    // 透传链（逐行核实）：cascadePurgeFromTrash 把 deps.cascadeDeps 作为第 4 参数传给
    // session-cascade.cascadePurge；后者取 cascadeDeps.purgeDeps（不是整个 cascadeDeps）
    // 作为第 2 参数传给默认 purgeFn（=session-purge.purge）。故必须显式提供 purgeDeps 键，
    // 且其中需含 fs/trashRoot/emitPurged，级联才能真正执行物理删除。
    const purgeDeps = { ...deps }; // 无循环引用：purgeDeps 自身不含 cascadeDeps
    deps.cascadeDeps = { purgeDeps };
    return cascadePurgeFromTrash(this.fs, this.trashRoot, ids, deps);
  }
}

/** 便捷工厂：从 ctx 直接建服务（路由层使用）。 */
export function createTrashService(ctx, options = {}) {
  const dshHome = options.dshHome ?? resolveDshHome();
  const { sessionsRoot, trashRoot } = rootsFor(dshHome);
  return new TrashService({
    ctx,
    sessionsRoot,
    trashRoot,
    fs: options.fs,
    retentionMs: options.retentionMs,
  });
}
