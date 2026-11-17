/**
 * lib/session-cascade.js — 路径 A 第 3 阶段：子代理树级联删除 + 批量部分失败结果模型
 *
 * 【风险边界】
 * 1. 本模块是纯编排：自身不含任何 rm / rename / writeFile 等物理 I/O，物理删除全部委托给
 *    注入的 purgeFn（默认 session-purge.js 的 purge）。静态守护测试会断言这一点。
 * 2. 只处理「已在回收站、由调用方显式传入 rows 快照」的会话，绝不根据任意 sessionId 直接
 *    删除活跃 sessions 目录——那是绕过回收站的物理直删，第 1/2 阶段明令禁止，本阶段不开口子。
 * 3. 级联 = 直接选中的父会话 + 其所有后代（origin:subagent）。整族 fail-closed：家族内任一
 *    成员受保护则整族跳过，绝不出现「半删的家族」。
 *    【origin 过滤（评审 P0，防数据丢失）】现成包 inventory.ts:323-329 构建 childIds 只看
 *    parentId、不检查 origin，故照搬 descendantsOf 会误删 fork（有 parentId、origin:'fork'
 *    的独立对话）。本模块 descendantsOf 只跟随 origin==='subagent' 的后代，fork 及其整条
 *    分支全部剪掉；直接选中的 id 不受此过滤（显式删除），过滤只作用于向下派生的后代。
 * 4. 不接回 UI（第 4 阶段），不改 @linxin666/dsh-session-archive。
 *
 * 【保护态取值域与前向兼容（评审 P1/P2 核实）】hostProtectedReason 当前取值域为
 * 'attached'|'in-flight'（现成包 janitor.ts:330-333），均在 PROTECTION_RANK 枚举内。
 * clientProtectedReason 对其按 rank 合并；**未知值（如未来新增 'pinned'/'shared'）一律按最高保护
 * rank=Infinity 处理**，绝不回退成 rank 0——否则宿主新增保护态时会静默失去保护、整族被误删。
 * 这与 purgeExpired 对无 deletedAt 条目「fail-safe 跳过」的纪律一致。
 *
 * 【origin 语义（评审 P1，防静默孤儿）】
 * - 'subagent'：子代理，参与级联。
 * - 'fork'：独立对话，不参与向下级联（显式选中除外，见下）。
 * - 缺失或未知值：视为非子代理、**不级联**——可能产生「删除成功但在磁盘留孤儿」的静默不一致。
 *   为避免该行为成为隐式约定，cascadePurge 用 detectInvalidOrigins 自检：rows 中任一 parentId
 *   非空、origin 不在 ['subagent','fork'] 的行，判为快照异常、整批拒绝 reason:'invalid-origin'。
 *   第 4 阶段快照构建方必须保证每个有 parentId 的行都带合法 origin。
 *
 * 【显式删除 fork 的级联语义（评审 P2）】直接选中一个 fork 时，它自身会被删（显式删除不受
 * origin 过滤），且它的 origin==='subagent' 后代会照常级联；但 fork 的 fork（嵌套 fork）在入口边
 * 被剪掉、不级联。即「删 fork = 删 fork 本体 + 其 subagent 子树，不穿透嵌套 fork」。
 *
 * 【rows 快照契约（评审 P1/P1' 收窄，第 4 阶段构建者必读）】
 * - 仅回收站：rows 只应包含已在回收站的会话。cascade 是纯函数、不查 manifest，无法自行判断
 *   「是否在回收站」；若混入活跃会话，purgeFn(即 session-purge) 的 preflight 会因「不在 manifest」
 *   整批拒绝——fail-closed，但表现为删除失败而非「跳过活跃」。故快照构建方须保证只传回收站条目。
 * - 【自检能力边界——务必读清】cascade 只做 **childIds 引用完整性** 检查（detectDanglingChildIds）：
 *   发现某 row.childIds 指向了 rows 里不存在的 id 时整批拒绝 reason:'child-ids-dangling'。
 *   它与 descendantsOf **同源**（都读 rows 自带 childIds），因此**只能发现「childIds 引用了 rows
 *   外的 id」，发现不了「childIds 本身漏掉了某个子代理」（快照整体不完整）**。后者 cascade 无法
 *   自证——任何纯函数内的自检都是自我参照。**快照完整性的真正保证责任在第 4 阶段快照构建方**：
 *   必须用独立于 rows 的对照源（回收站 manifest 条目列表 / 磁盘扫描 / 实时 feed 快照）构建完整
 *   childIds，不得误以为 cascade 已兜底。本模块仅作第二道（引用一致性）防线。
 * - sizeBytes：仅用于汇总 totalBytes 供 UI 估算，不参与任何删除决策。
 *
 * 【第 4 阶段承接（评审 P2）】本模块 results 的 reason 码（purging / child-ids-dangling /
 * invalid-origin / family-protected 等）接回 UI 时须映射成用户可读提示（如 child-ids-dangling →
 * 「会话树数据不完整，请刷新后重试」；invalid-origin → 「会话树数据异常，请刷新后重试」）。
 *
 * 【算法来源：借鉴而非重造】
 * descendantsOf / planDelete / clientProtectedReason / selectionFullyProtected 逐行移植自
 * @linxin666/dsh-session-archive@0.4.18 的 src/core/cascade.ts（host 权威计划与浏览器预览共用、
 * 生产验证），保持整族防半删、保护态优先级（PROTECTION_RANK）、部分失败视图语义一致。
 * 批量部分失败结果模型借鉴同包 src/host/janitor.ts 的 deleteSessions / executeDelete。
 * 这些函数在现成包里是内联私有函数、未导出 JS 产物，故以「移植已验证算法」而非 import 复用。
 *
 * 【树数据来源（用户第 3 阶段决策）】
 * rows 由调用方显式传入（含 id / parentId / origin / childIds / sizeBytes / running /
 * hostProtectedReason），本模块不查实时 feed、不碰已收口的第 1 阶段 manifest。会话进回收站后
 * 从 feed 消失，树快照的构建留给第 4 阶段接回入口时解决。
 *
 * 【allowPurging 纪律（承接第 2 阶段评审）】
 * cascadePurge 只调 purge(ids, deps)，绝不调 recoverPurging、绝不传 allowPurging。
 * 级联是显式操作、非启动恢复：遇 purging 条目由 purge 的整批 fail-closed 拒绝。
 * allowPurging 是 recoverPurging 专用；本模块从调用侧接口就杜绝其传递路径。
 * （是否把 allowPurging 从 preflightPurge 的公开 API 收紧为私有，属第 2 阶段模块后续，
 *   本阶段不动已收口代码，改以调用约束保证。）
 *
 * 【结果诚实性（承接第 2 阶段评审）】
 * 父会话删除成功、子代理删除失败时，ok 必须为 false——绝不因「主要意图（父）完成」而宣称
 * 成功。message 明确区分父会话失败、子代理失败、保护跳过，逐条可见。
 */

import { purge as defaultPurgeFn } from './session-purge.js';

/** 保护态优先级：与现成包 cascade.ts:105 完全一致（in-flight > current > attached > running）。 */
export const PROTECTION_RANK = Object.freeze({
  running: 1,
  attached: 2,
  current: 3,
  'in-flight': 4,
});

/**
 * 一个 id 的所有后代（经 childIds 边），不含自身。移植自 cascade.ts:12-26。
 * BFS/栈 + seen 去重，天然容忍环与重复边。
 *
 * 【第 3 阶段评审 P0：origin 过滤】现成包 inventory.ts:323-329 构建 childIds 时只看
 * parentId、不检查 origin，descendantsOf 若照搬会把 fork（有 parentId 但 origin!=='subagent'）
 * 当作子代理。fork 是独立对话，删源会话不得波及——这是第 1 阶段既定边界。故此处追加过滤：
 * 只有 row.origin === 'subagent' 的子节点才纳入级联；fork 及其整条分支都不进入 targets。
 * 注意：直接选中的 id 不受此过滤（调用方显式要求的删除），过滤只作用于「沿树向下派生的后代」。
 */
export function descendantsOf(rows, id) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childIds = new Map();
  for (const row of rows) childIds.set(row.id, row.childIds);
  const seen = new Set();
  // 入口边也要过 origin 门：父的直接子节点里非 subagent 的一律不入队。
  const queue = [...(childIds.get(id) ?? [])].filter((childId) => byId.get(childId)?.origin === 'subagent');
  while (queue.length > 0) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of childIds.get(current) ?? []) {
      // 递归边同样只跟随 subagent，fork 分支整条剪掉。
      if (!seen.has(child) && byId.get(child)?.origin === 'subagent') queue.push(child);
    }
  }
  return [...seen];
}

/**
 * 权威删除计划。移植自 cascade.ts:39-95，规则逐条保持：
 * - 直接 id 不在 rows 中 → skipped 'not-found'。
 * - 直接 id 本身受保护 → skipped 用自己的 reason，家族不动。
 * - 家族（直接 id + 全部后代）含任一受保护成员 → 整族 skipped 'family-protected'，绝不半删。
 * - 每个 id 在 skipped 中最多出现一次；直接选中的受保护成员保留自己的 reason，不被家族条目抢先认领。
 * - 其余安全家族的并集全部进入 targets。
 * 返回 { direct, descendants, skipped, targets, totalBytes }。
 */
export function planDelete(rows, directIds, protectedReason) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const targets = new Set();
  const skipped = [];
  const skippedIds = new Set();
  const directSet = new Set(directIds);
  const seenDirect = new Set();
  /** 一个 id 只记一次 skip：经多个家族可达时保持单条。 */
  const pushSkipped = (entry) => {
    if (skippedIds.has(entry.id)) return;
    skippedIds.add(entry.id);
    skipped.push(entry);
  };
  for (const id of directIds) {
    if (seenDirect.has(id)) continue;
    seenDirect.add(id);
    const row = byId.get(id);
    if (row === undefined) {
      pushSkipped({ id, status: 'skipped', reason: 'not-found' });
      continue;
    }
    const ownReason = protectedReason.get(id);
    if (ownReason !== undefined) {
      pushSkipped({ id, status: 'skipped', reason: ownReason });
      continue;
    }
    const family = [id, ...descendantsOf(rows, id)];
    const blocker = family.find((member) => protectedReason.has(member));
    if (blocker !== undefined) {
      for (const member of family) {
        if (targets.has(member) || skippedIds.has(member)) continue;
        // 直接选中的受保护成员在自己的迭代里报自己的 reason，粗粒度的家族条目不得抢先认领。
        if (directSet.has(member) && protectedReason.has(member)) continue;
        pushSkipped({
          id: member,
          status: 'skipped',
          reason: 'family-protected',
          detail: `${blocker}:${protectedReason.get(blocker)}`,
        });
      }
      continue;
    }
    for (const member of family) targets.add(member);
  }
  let totalBytes = 0;
  for (const id of targets) {
    const size = byId.get(id)?.sizeBytes;
    if (typeof size === 'number') totalBytes += size;
  }
  return {
    direct: [...seenDirect],
    descendants: [...targets].filter((id) => !seenDirect.has(id)),
    skipped,
    targets: [...targets],
    totalBytes,
  };
}

/**
 * 预览用的保护原因表，移植自 cascade.ts:114-130。
 * running / current 由本模块观察；attached / in-flight 来自 row.hostProtectedReason。
 * 冲突时按 PROTECTION_RANK 取最高优先级（后写不覆盖更高优先级）。
 */
export function clientProtectedReason(rows, currentSessionId) {
  const map = new Map();
  // 未知保护态 fail-safe：不在 PROTECTION_RANK 枚举内的值按最高保护 Infinity 处理，
  // 而非回退 0——否则宿主未来新增 'pinned'/'shared' 时会静默失去保护、整族被误删。
  const rankOf = (reason) => PROTECTION_RANK[reason] ?? Number.POSITIVE_INFINITY;
  const mark = (id, reason) => {
    const held = map.get(id);
    if (held !== undefined && rankOf(held) >= rankOf(reason)) return;
    map.set(id, reason);
  };
  for (const row of rows) {
    if (row.running) mark(row.id, 'running');
    if (row.hostProtectedReason !== undefined) mark(row.id, row.hostProtectedReason);
  }
  if (currentSessionId !== undefined && currentSessionId !== '') mark(currentSessionId, 'current');
  return map;
}

/** 选中项是否全部被保护（批量删除入口禁用条件）。移植自 cascade.ts:137-142。 */
export function selectionFullyProtected(ids, protectedReason) {
  return ids.length > 0 && ids.every((id) => protectedReason.has(id));
}

/**
 * 【第 3 阶段评审 P1'：childIds 引用完整性自检（能力边界已收窄，勿误用）】
 * 检查 plan.targets 里任一 id 的 childIds 是否指向了 rows 里不存在的 id。
 *
 * 【这不是「快照完整性」保证】本函数与 descendantsOf 同源（都读 rows 自带 childIds），
 * 只能发现「childIds 引用了 rows 外的 id」（悬挂引用 / 数据损坏），**发现不了「childIds 本身
 * 漏掉某个子代理」**——那种情况遍历和自检都看不见。快照整体完整性的保证责任在第 4 阶段构建方
 * （须用独立对照源），本函数仅作第二道引用一致性防线。命名与 reason 已据此从
 * incomplete-snapshot 收窄为 child-ids-dangling，避免误导下游。
 *
 * 缺失节点无法读 origin 时保守视为潜在 subagent 并计入（宁可拒绝，不可放过悬挂引用）；
 * rows 里明确标 fork 的后代缺失则不计（fork 不参与级联）。
 * 返回悬挂 id 列表（空表示引用一致）；cascadePurge 据此整批拒绝，reason:'child-ids-dangling'。
 */
export function detectDanglingChildIds(rows, targets) {
  const present = new Set(rows.map((row) => row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = new Set();
  for (const id of targets) {
    const row = byId.get(id);
    if (row === undefined) continue;
    for (const childId of row.childIds ?? []) {
      // 只关心 subagent 后代：fork 不参与级联，缺失无害。
      const childRow = byId.get(childId);
      const isSubagent = childRow ? childRow.origin === 'subagent' : true; // 不在 rows 里时按潜在 subagent 处理，保守拒绝
      if (isSubagent && !present.has(childId)) missing.add(childId);
    }
  }
  return [...missing];
}

/**
 * 【第 3 阶段评审 P1：origin 合法性自检】
 * origin 缺失/未知会导致子代理被静默剪掉（不级联）而留孤儿。为避免隐式约定，扫描 rows：
 * 任一 parentId 非空、但 origin 不在 ['subagent','fork'] 的行，视为快照异常。
 * 返回违规 id 列表（空表示合法）；cascadePurge 据此整批拒绝，reason:'invalid-origin'。
 * 注意：孤立行（parentId 为空）的 origin 不参与级联、无需校验。
 */
export function detectInvalidOrigins(rows) {
  const valid = new Set(['subagent', 'fork']);
  return rows
    .filter((row) => typeof row.parentId === 'string' && row.parentId !== '' && !valid.has(row.origin))
    .map((row) => row.id);
}

/**
 * 级联删除编排：planDelete 产出权威目标集 → 交给注入的 purgeFn 物理删除 → 合并成统一
 * 部分失败视图。不直接执行任何 rm。
 *
 * deps:
 *   purgeFn   —— 实际删除函数，签名 (ids, deps) => { ok, purged, failed, rejected, results }。
 *                默认 session-purge.js 的 purge。测试注入 mock。注意：本模块只传两个参数，
 *                不传任何 options，从接口上杜绝 allowPurging 误传。
 *   purgeDeps —— 透传给 purgeFn 的依赖（fs/trashRoot 等）。
 *
 * 返回统一结果模型，关键字段：
 *   ok             —— 所有 targets 成功、无 skipped、无失败才算 true（子代理失败也必须 false）。
 *   primaryOk / descendantsOk —— 父 / 子代理各自是否全成功，供调用方细分判断。
 *   succeeded / failed / skipped / results —— 逐条可追溯。
 *   message        —— 人类可读总结，子代理失败会明确点名。
 */
export async function cascadePurge(rows, directIds, protectedReason = new Map(), deps = {}) {
  const { purgeFn = defaultPurgeFn, purgeDeps = {} } = deps;
  const plan = planDelete(rows, directIds, protectedReason);

  // 自检 1：origin 合法性——parentId 非空但 origin 缺失/未知，静默剪枝会留孤儿，整批拒绝。
  const invalidOrigins = detectInvalidOrigins(rows);
  if (invalidOrigins.length > 0) {
    const results = invalidOrigins.map((id) => ({ id, status: 'rejected', reason: 'invalid-origin' }));
    return {
      ok: false,
      requested: [...(directIds ?? [])],
      direct: plan.direct,
      descendants: plan.descendants,
      targets: [],
      totalBytes: 0,
      primaryOk: false,
      descendantsOk: false,
      succeeded: [],
      failed: [],
      skipped: [],
      results,
      message: `级联删除拒绝：rows 快照存在非法 origin（缺失或未知）的会话 ${invalidOrigins.join(', ')}；请补全快照后重试`,
    };
  }

  // 自检 2：childIds 引用完整性——发现指向 rows 外的悬挂 id 时整批拒绝。
  // 注意能力边界：这只能查出「引用了 rows 外的 id」，查不出「childIds 本身漏了子代理」；
  // 后者由第 4 阶段快照构建方用独立对照源保证（见模块头契约）。
  const dangling = detectDanglingChildIds(rows, plan.targets);
  if (dangling.length > 0) {
    const results = dangling.map((id) => ({ id, status: 'rejected', reason: 'child-ids-dangling' }));
    return {
      ok: false,
      requested: [...(directIds ?? [])],
      direct: plan.direct,
      descendants: plan.descendants,
      targets: [],
      totalBytes: 0,
      primaryOk: false,
      descendantsOk: false,
      succeeded: [],
      failed: [],
      skipped: [],
      results,
      message: `级联删除拒绝：rows 快照存在悬挂 childIds 引用 ${dangling.join(', ')}（指向 rows 外的会话）；请补全快照后重试`,
    };
  }

  const purgeResult = plan.targets.length > 0
    ? await purgeFn(plan.targets, purgeDeps)
    : { ok: true, purged: 0, failed: 0, rejected: 0, results: [] };
  const purgeResults = Array.isArray(purgeResult?.results) ? purgeResult.results : [];

  const allResults = [...plan.skipped, ...purgeResults];
  const succeededIds = new Set(purgeResults.filter((r) => r?.status === 'ok').map((r) => r.id));
  const failedResults = purgeResults.filter((r) => r?.status === 'failed' || r?.status === 'rejected');

  const primaryIds = new Set(plan.direct);
  const descendantIds = new Set(plan.descendants);
  const primaryOk = plan.direct.every((id) => succeededIds.has(id));
  const descendantsOk = plan.descendants.every((id) => succeededIds.has(id));
  const targetsAllSucceeded = plan.targets.every((id) => succeededIds.has(id));
  const ok = failedResults.length === 0 && plan.skipped.length === 0 && targetsAllSucceeded;

  const failedPrimary = failedResults.filter((r) => primaryIds.has(r.id)).map((r) => r.id);
  const failedSubagents = failedResults.filter((r) => descendantIds.has(r.id)).map((r) => r.id);
  const otherFailed = failedResults
    .filter((r) => !primaryIds.has(r.id) && !descendantIds.has(r.id))
    .map((r) => r.id);

  let message;
  if (ok) {
    message = `级联删除完成：${plan.targets.length} 个会话已彻底删除`
      + (plan.descendants.length > 0 ? `（含 ${plan.descendants.length} 个子代理）` : '');
  } else {
    const parts = [];
    if (failedPrimary.length) parts.push(`父会话删除失败：${failedPrimary.join(', ')}`);
    if (failedSubagents.length) parts.push(`子代理删除失败：${failedSubagents.join(', ')}`);
    if (plan.skipped.length) parts.push(`${plan.skipped.length} 个会话受保护被跳过`);
    if (otherFailed.length) parts.push(`其他失败：${otherFailed.join(', ')}`);
    message = `级联删除未完全完成：${parts.join('；') || '存在未达成目标'}`;
  }

  return {
    ok,
    requested: [...(directIds ?? [])],
    direct: plan.direct,
    descendants: plan.descendants,
    targets: plan.targets,
    totalBytes: plan.totalBytes,
    primaryOk,
    descendantsOk,
    succeeded: [...succeededIds],
    failed: failedResults.map((r) => r.id),
    skipped: plan.skipped,
    results: allResults,
    message,
  };
}
