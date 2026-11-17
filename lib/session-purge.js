// dsh-plugin-yanyan-toolkit — 路径 A · 第 2 阶段：回收站物理删除（purge）管线。
//
// 【风险边界 — 写在最前】
// purge 是第 1 阶段「可逆」承诺的终点：一旦 rm 执行，回收站条目不再可逆。因此本模块
// 只接受「已在回收站、manifest 状态有效（非 quarantined、非 restoring、非未清的 purging
// 崩溃残留）」的条目，绝不接受任意 sessionId 直接删会话目录——那是「绕过回收站直接物理
// 删除」，第 1 阶段明确禁止，第 2 阶段也不开这个口子。若未来需要「直接彻底删除」（不经过
// 回收站），那是另一个功能，需单独评估，不在本轮范围。
//
// 范围：独立文件、自声明允许 rm；复用第 1 阶段全部安全底座（withManifestLock / 原子写
// writeManifest / assertSafeTarget / readManifest / locateUnder / safeTargetSegment），
// 不接回 UI 入口（第 4 阶段），不改动 @linxin666/dsh-session-archive。
//
// 三个决策点（用户 m00625 授权）：
//   1) 空 project 目录策略：保留。purge 只删 <trashRoot>/<project>/<segment> 这一层，
//      <project> 目录即使变空也保留——清理空目录本身是第二次 rm，会扩大攻击面；空目录无害，
//      保留期清理任务可后续单独处理。执行时禁止「顺手优化」去删空 project 目录。
//   2) 触发形态：purge(sessionIds) 显式 + purgeExpired() 保留期扫描，两条路径共用同一
//      preflight + assertSafeTarget 目标侧校验 + 整批 fail-closed，不因「自动」而跳过。
//   3) purging 标记与 rm 的锁边界：状态校验 + 写 {status:'purging'} 在同一把
//      withManifestLock 内完成，写完立即释放锁，rm 在锁外执行（Windows 占用重试可能占锁
//      几十秒，不能阻塞其他 manifest 读写），rm 成功后再进锁移除条目。崩溃恢复：
//      purging 且目录存在 → 重试 purge；purging 且目录不存在 → 仅移除条目。
//
// 拒绝重复造轮子：路径四层校验、manifest 原子写、进程内串行锁、目录两段反推全部 import
// 自 lib/session-trash.js（第 1 阶段已在生产验证），不在本文件复制。唯一自建的是「带
// EBUSY/EPERM 重试的 rm」——现成包 purgePhysical（packages/dsh-plugin-yanyan-subagent/
// lib/index.js）的 rmSync 无重试，catch 后只记 skipped，不满足 Windows 占用场景。
//
// 纯逻辑 + 依赖注入：fs / 时钟 / 广播 / 重试延时都从 deps 进入，便于离线单测与真机验证。
// fail-closed：任何一步校验失败都整批拒绝，绝不「跳过坏的这个继续删」。
//
// 事件广播（api-session/purged）：事件名本模块约定。经核实 DSH 与现成包当前均不监听
// session 事件，故广播当前无监听者、实际效果为零；保留顺序纪律是为第 4 阶段对齐宿主，
// 在此之前不可把广播当作「UI 已即时刷新」的依据。

import { rmSync } from 'node:fs';
import {
  canonicalSessionId,
  safeTargetSegment,
  locateUnder,
  assertSafeTarget,
  readManifest,
  writeManifest,
  withManifestLock,
  MANIFEST_NAME,
} from './session-trash.js';

/** 保留期默认值：30 天（保守，给恢复留足窗口）。purgeExpired 从 deps.retentionMs 覆盖。 */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** purge 完成事件名（本模块约定，当前无监听者）。 */
export const PURGED_EVENT = 'api-session/purged';

/** Windows 占用/权限类可重试错误码。其余错误码立即失败，不静默吞。 */
export const RETRYABLE_RM_CODES = new Set([
  'EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EWOULDBLOCK',
]);

/** 保留期扫描的时间基准字段优先级：deletedAt（授权文本）→ trashedAt（第 1 阶段实写）→ archivedAt。 */
function deletedAtOf(entry) {
  for (const key of ['deletedAt', 'trashedAt', 'archivedAt']) {
    if (typeof entry?.[key] === 'number') return entry[key];
  }
  return undefined;
}

/**
 * 给 fs 适配器补上 rm（recursive delete）：第 1 阶段的 defaultFs 不含 rm，
 * purge 单独提供包装，确保「允许 rm」只在 purge 模块显式声明。
 */
export function makePurgeFs(baseFs) {
  return { ...baseFs, rm: (p, opts) => rmSync(p, opts) };
}

/**
 * 带重试的物理删除。仅接受已通过 assertSafeTarget 校验的 realPath（调用方保证），
 * 不在本函数内做路径解析——保证「rm 的参数来源可静态追溯」。
 * 返回 { removed:true, attempts } 便于逐项审计；不可重试错误或重试耗尽则抛出原错误
 * （带 code），由 purgeOne 转成逐项错误码，绝不静默吞。
 */
export async function rmWithRetry(realPath, deps = {}) {
  const {
    fs,
    rmAttempts = 5,
    rmBaseDelayMs = 40,
    rmDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  if (typeof fs?.rm !== 'function') throw new Error('fs.rm is required for purge (use makePurgeFs)');
  let lastError;
  for (let attempt = 0; attempt < rmAttempts; attempt += 1) {
    try {
      fs.rm(realPath, { recursive: true, force: false });
      return { removed: true, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RM_CODES.has(error?.code)) throw error;
      if (attempt < rmAttempts - 1) await rmDelay(rmBaseDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * fail-closed 整批预检。每条都要求：
 *   - id 合法（safeTargetSegment）；
 *   - 不在 quarantined 隔离清单（评审 1.2：隔离项不允许 purge）；
 *   - 在 manifest.entries 里（拒绝非回收站条目——风险边界第一道闸）；
 *   - 状态非 restoring（拒绝正在恢复的条目）；
 *   - 目标侧四层校验：回收站源目录若存在，必须过 assertSafeTarget；
 *     若不存在，仅允许 status==='purging' 的崩溃残留（执行阶段走「仅移除条目」分支）。
 * 返回 { ok, checks, reasons }；ok=false 时一条都不删。
 */
export function preflightPurge(ids, deps, options = {}) {
  const { fs, trashRoot } = deps;
  // 评审 P1（第三轮）：正常 purge / purgeExpired 拒绝 purging 条目（双向互斥另一半），
  // 整批 fail-closed；只有 recoverPurging 传 allowPurging:true 才放行启动恢复重试。
  const { allowPurging = false } = options;
  const manifest = readManifest(fs, trashRoot);
  const quarantinedIds = new Set(
    (Array.isArray(manifest.quarantined) ? manifest.quarantined : [])
      .map((q) => canonicalSessionId(String(q?.segment || q?.id || ''))),
  );
  const checks = [];
  const reasons = [];
  for (const rawId of ids || []) {
    let id;
    try {
      id = safeTargetSegment(rawId);
      if (quarantinedIds.has(id)) throw new Error(`session ${id} is quarantined; refusing to purge`);
      const entry = manifest.entries[id];
      if (!entry) throw new Error(`session ${id} not in manifest (refusing to purge non-trashed session)`);
      if (entry.status === 'restoring') throw new Error(`session ${id} is restoring; refusing to purge`);
      if (entry.status === 'purging' && !allowPurging) {
        throw new Error(`session ${id} is purging; refusing to purge (concurrent purge); recovery is handled by recoverPurging at startup`);
      }
      const candidate = locateUnder(fs, trashRoot, id);
      if (candidate) {
        assertSafeTarget(id, candidate, trashRoot, fs); // 目标侧四层校验
      } else if (entry.status !== 'purging') {
        throw new Error(`session ${id} not found in trash; refusing to purge without a verified target`);
      }
      checks.push({ id, rawId, entry, candidate, dirExists: !!candidate });
    } catch (error) {
      reasons.push({ id: id || String(rawId), reason: String(error?.message || error) });
    }
  }
  return { ok: reasons.length === 0, checks, reasons };
}

/**
 * 单条删除。锁边界严格按决策点 3：
 *   阶段 1（锁内）：二次校验状态非 restoring + 目录存在性；purging 且目录不存在 → 仅移除条目；
 *                   否则写 {status:'purging'} 并释放锁。
 *   阶段 2（锁外）：重新 assertSafeTarget 取 realPath → rmWithRetry（带重试）。
 *   阶段 3（锁内）：从 manifest 移除条目（writeManifest 原子写）。
 * rm 失败时条目保持 purging 状态，供 recoverPurging 在下次启动重试。
 */
async function purgeOne(check, deps, options = {}) {
  const { fs, trashRoot, now = Date.now, emitPurged } = deps;
  // 评审 P1（第 2 阶段第三轮）：双向互斥的另一半。正常 purge / purgeExpired 遇到
  // 已是 purging 的条目一律拒绝（与 restore 的 purge-in-progress 门对称），防止运行时
  // 并发 purge 重复写标记、并发 rm、阶段 3 重复移除条目。只有 recoverPurging（启动恢复
  // 路径）才允许处理 purging 条目——它是唯一合法的「purging + 目录存在」重试入口。
  const { allowPurging = false } = options;
  const id = check.id;

  // ---- 阶段 1：锁内校验 + 写 purging 标记 ----
  let marked;
  try {
    marked = await withManifestLock(() => {
      const manifest = readManifest(fs, trashRoot);
      const entry = manifest.entries[id];
      if (!entry) return { ok: false, reason: 'manifest-entry-disappeared' };
      if (entry.status === 'restoring') return { ok: false, reason: 'restoring-in-progress' };
      if (entry.status === 'purging' && !allowPurging) {
        return {
          ok: false,
          reason: 'purge-in-progress',
          detail: '会话已在物理删除中（purging），并发 purge 被拒绝；启动恢复由 recoverPurging 接管',
        };
      }

      // 二次目录存在性复检（preflight 到此处之间可能有 restore 已完成）。
      const current = locateUnder(fs, trashRoot, id);
      if (entry.status === 'purging' && !current) {
        // 崩溃恢复分支 B：purging 且目录不存在 → 仅移除条目，不触碰 rm。
        delete manifest.entries[id];
        writeManifest(fs, trashRoot, manifest);
        return { ok: true, recovery: 'purging-no-dir', purged: true };
      }
      if (!current) return { ok: false, reason: 'trash-dir-disappeared' };

      // 锁内重新四层校验（restoring 二次复检拒绝 + 防 TOCTOU）。
      assertSafeTarget(id, current, trashRoot, fs);
      manifest.entries[id] = { ...entry, status: 'purging', purgingAt: now() };
      writeManifest(fs, trashRoot, manifest);
      return { ok: true, current };
    });
  } catch (error) {
    return { id, status: 'failed', reason: 'mark-purging', detail: String(error?.message || error) };
  }
  if (!marked.ok) return { id, status: 'failed', reason: marked.reason };
  if (marked.recovery) {
    emitPurged?.(id);
    return { id, status: 'ok', purged: true, recovery: marked.recovery };
  }

  // ---- 阶段 2：锁外 rm（带重试），参数必须来自二次校验后的 realPath ----
  let rmResult;
  try {
    const recheck = assertSafeTarget(id, marked.current, trashRoot, fs);
    rmResult = await rmWithRetry(recheck.realPath, deps);
  } catch (error) {
    return {
      id,
      status: 'failed',
      reason: 'rm-failed',
      code: error?.code || undefined,
      detail: String(error?.message || error),
    };
  }

  // ---- 阶段 3：锁内移除条目（原子写）----
  try {
    await withManifestLock(() => {
      const manifest = readManifest(fs, trashRoot);
      if (manifest.entries[id]) {
        delete manifest.entries[id];
        writeManifest(fs, trashRoot, manifest);
      }
    });
  } catch (error) {
    // 目录已 rm 但 manifest 未清理：条目保持 purging，下次 recoverPurging 会走分支 B 清理。
    return {
      id,
      status: 'failed',
      reason: 'manifest-remove-failed',
      detail: String(error?.message || error),
      note: '目录已删除但 manifest 条目未清理；重启后 recoverPurging 将移除残留条目',
      attempts: rmResult.attempts,
    };
  }

  emitPurged?.(id);
  return { id, status: 'ok', purged: true, attempts: rmResult.attempts };
}

/** 汇总逐条结果，形状与第 1 阶段 runTrashPipeline 对齐。 */
function summarize(ids, results) {
  const ok = results.every((r) => r.status === 'ok');
  return {
    ok,
    purged: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    results,
  };
}

/**
 * 显式删除：purge(sessionIds)。先整批 fail-closed 预检，预检不通过一条都不删；
 * 通过后逐条走 purgeOne。返回 { ok, purged, failed, rejected, results }。
 */
export async function purge(sessionIds, deps) {
  const plan = preflightPurge(sessionIds, deps);
  if (!plan.ok) {
    const results = (sessionIds || []).map((rawId) => {
      let id;
      try { id = safeTargetSegment(rawId); } catch { id = String(rawId); }
      const bad = plan.reasons.find((r) => r.id === id);
      return bad
        ? { id, status: 'rejected', reason: bad.reason }
        : { id, status: 'rejected', reason: 'batch aborted by preflight' };
    });
    return { ok: false, purged: 0, failed: 0, rejected: results.length, results };
  }
  const results = [];
  for (const check of plan.checks) results.push(await purgeOne(check, deps));
  return summarize(sessionIds, results);
}

/**
 * 保留期扫描：purgeExpired()。扫 manifest 中删除时间基准 + retentionMs < now 的条目，
 * 交给 purge() 复用同一套 preflight + purgeOne（自动路径不跳过任何校验）。
 * 无时间基准的条目跳过（fail-safe，不因其误删）。
 */
export async function purgeExpired(deps = {}) {
  const { fs, trashRoot, now = Date.now, retentionMs = DEFAULT_RETENTION_MS } = deps;
  const manifest = readManifest(fs, trashRoot);
  const threshold = (typeof now === 'function' ? now() : now) - retentionMs;
  const expiredIds = [];
  for (const entry of Object.values(manifest.entries)) {
    const at = deletedAtOf(entry);
    if (at !== undefined && at < threshold) expiredIds.push(entry.id ?? entry.sessionId);
  }
  // 过滤掉 undefined（无 id 字段的异常条目），但保留原样交给 preflight 判定。
  const ids = expiredIds.filter((id) => id !== undefined && id !== null);
  return purge(ids, deps);
}

/**
 * 崩溃恢复：recoverPurging()。扫 manifest 中 status==='purging' 的残留条目，逐条走
 * purgeOne——目录存在的走重试删除（崩溃点 A），目录不存在的走「仅移除条目」（崩溃点 B）。
 * 宿主启动时调用一次即可收敛所有未完成的 purge。
 */
export async function recoverPurging(deps = {}) {
  const { fs, trashRoot } = deps;
  const manifest = readManifest(fs, trashRoot);
  const staleIds = Object.values(manifest.entries)
    .filter((entry) => entry?.status === 'purging')
    .map((entry) => entry.id ?? entry.sessionId)
    .filter((id) => id !== undefined && id !== null);
  if (staleIds.length === 0) return { ok: true, purged: 0, failed: 0, rejected: 0, results: [] };
  const plan = preflightPurge(staleIds, deps, { allowPurging: true });
  if (!plan.ok) {
    const results = staleIds.map((rawId) => {
      const id = String(rawId);
      const bad = plan.reasons.find((r) => r.id === id);
      return bad
        ? { id, status: 'rejected', reason: bad.reason }
        : { id, status: 'rejected', reason: 'batch aborted by preflight' };
    });
    return { ok: false, purged: 0, failed: 0, rejected: results.length, results };
  }
  const results = [];
  // 只有启动恢复路径允许处理 purging 条目（唯一合法的「purging + 目录存在」重试入口）。
  for (const check of plan.checks) results.push(await purgeOne(check, deps, { allowPurging: true }));
  return summarize(staleIds, results);
}
