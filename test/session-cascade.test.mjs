// 路径 A · 第 3 阶段（子代理树级联删除 + 批量部分失败结果模型）契约测试。
// 纯编排模块：descendantsOf/planDelete 逐行移植现成包已验证算法；cascadePurge 只编排、
// 不含任何 rm。静态守护断言模块内无物理 I/O 调用，且 cascadePurge 不传 allowPurging。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  PROTECTION_RANK, descendantsOf, planDelete, clientProtectedReason,
  selectionFullyProtected, detectDanglingChildIds, detectInvalidOrigins, cascadePurge,
} from '../lib/session-cascade.js';

const here = dirname(fileURLToPath(import.meta.url));
const moduleSrc = readFileSync(resolve(here, '../lib/session-cascade.js'), 'utf8');

// ---------- 测试辅助 ----------
// 默认带 origin:'subagent'：级联只跟随子代理，现有用例里的 child 节点语义均为子代理。
// 需要模拟 fork / 活跃会话时显式覆盖 origin。
const row = (id, extra = {}) => ({ id, childIds: [], sizeBytes: 1, origin: 'subagent', ...extra });

/** 注入的 purge mock：记录收到的 ids 与 deps，按配置返回逐条结果。 */
function makePurgeMock({ failIds = [], rejectIds = [], okIds = null, calls = [], seenDeps = [] } = {}) {
  return {
    calls,
    seenDeps,
    fn: async (ids, deps) => {
      calls.push([...ids]);
      seenDeps.push(deps);
      const results = ids.map((id) => {
        if (rejectIds.includes(id)) return { id, status: 'rejected', reason: 'purging' };
        if (failIds.includes(id)) return { id, status: 'failed', reason: 'rm-error' };
        return { id, status: 'ok' };
      });
      const ok = results.every((r) => r.status === 'ok');
      return { ok, purged: results.filter((r) => r.status === 'ok').length, results };
    },
  };
}

// ---------- PROTECTION_RANK ----------
test('PROTECTION_RANK 与现成包一致（in-flight > current > attached > running）', () => {
  assert.deepEqual({ ...PROTECTION_RANK }, {
    running: 1, attached: 2, current: 3, 'in-flight': 4,
  });
});

// ---------- descendantsOf ----------
test('descendantsOf 沿 childIds 收集全部后代，不含自身', () => {
  const rows = [
    row('root', { childIds: ['a', 'b'] }),
    row('a', { childIds: ['a1'] }),
    row('b', { childIds: ['b1'] }),
    row('a1'), row('b1'),
  ];
  assert.deepEqual(new Set(descendantsOf(rows, 'root')), new Set(['a', 'b', 'a1', 'b1']));
});

test('descendantsOf 容忍环与重复边（seen 去重，不死循环）', () => {
  const rows = [
    row('a', { childIds: ['b', 'b'] }),
    row('b', { childIds: ['a'] }),
  ];
  assert.deepEqual(new Set(descendantsOf(rows, 'a')), new Set(['b', 'a']));
});

test('descendantsOf 对不存在的 id 返回空', () => {
  assert.deepEqual(descendantsOf([row('a')], 'missing'), []);
});

test('descendantsOf 排除 fork：只跟随 origin===subagent 的后代，整条 fork 分支剪掉', () => {
  // root 的直接子节点里混有 fork（独立对话）与 subagent；fork 的整条下游也不得进入级联。
  const rows = [
    row('root', { childIds: ['sub', 'fork'] }),
    row('sub', { childIds: ['sub2'] }),              // subagent 分支，应纳入
    row('sub2'),                                     // subagent 后代，应纳入
    row('fork', { origin: 'fork', childIds: ['fork2'] }), // fork 分支，整条排除
    row('fork2', { origin: 'fork' }),                // fork 的后代，排除
  ];
  assert.deepEqual(new Set(descendantsOf(rows, 'root')), new Set(['sub', 'sub2']));
});

test('descendantsOf 入口边过滤：直接子节点中的 fork 不入队，其后代也不可达', () => {
  const rows = [
    row('root', { childIds: ['fork'] }),
    row('fork', { origin: 'fork', childIds: ['grandchild'] }),
    row('grandchild', { origin: 'subagent' }), // 即使后代标 subagent，父是 fork 也不可达
  ];
  assert.deepEqual(descendantsOf(rows, 'root'), []);
});

// ---------- planDelete：整族 fail-closed ----------
test('planDelete 安全家族：直接 id + 后代全部进 targets，skipped 为空', () => {
  const rows = [
    row('root', { childIds: ['sub1', 'sub2'], sizeBytes: 10 }),
    row('sub1', { sizeBytes: 5 }),
    row('sub2', { sizeBytes: 3 }),
  ];
  const plan = planDelete(rows, ['root'], new Map());
  assert.deepEqual(new Set(plan.targets), new Set(['root', 'sub1', 'sub2']));
  assert.deepEqual(plan.direct, ['root']);
  assert.deepEqual(new Set(plan.descendants), new Set(['sub1', 'sub2']));
  assert.equal(plan.totalBytes, 18);
  assert.equal(plan.skipped.length, 0);
});

test('planDelete not-found：不存在的直接 id 被跳过', () => {
  const plan = planDelete([row('a')], ['ghost'], new Map());
  assert.deepEqual(plan.skipped, [{ id: 'ghost', status: 'skipped', reason: 'not-found' }]);
  assert.deepEqual(plan.targets, []);
});

test('planDelete fork 隔离：有 parentId 但非 subagent 的对话不进 targets（P0 数据丢失防线）', () => {
  const rows = [
    row('root', { childIds: ['fork', 'sub'] }),
    row('fork', { origin: 'fork', parentId: 'root' }), // fork：独立对话，不得随源会话删除
    row('sub', { origin: 'subagent', parentId: 'root' }),
  ];
  const plan = planDelete(rows, ['root'], new Map());
  assert.deepEqual(new Set(plan.targets), new Set(['root', 'sub']), 'fork 不得进入删除目标');
  assert.ok(!plan.targets.includes('fork'));
  assert.ok(!plan.descendants.includes('fork'));
});

test('planDelete 直接选中的 fork 仍可删（origin 过滤只作用于派生后代，不作用于显式选中）', () => {
  const rows = [row('fork', { origin: 'fork' })];
  const plan = planDelete(rows, ['fork'], new Map());
  assert.deepEqual(plan.targets, ['fork']);
});

test('planDelete 直接 id 自身受保护：用自己的 reason，家族不动', () => {
  const rows = [row('root', { childIds: ['sub'] }), row('sub')];
  const plan = planDelete(rows, ['root'], new Map([['root', 'running']]));
  assert.deepEqual(plan.skipped, [{ id: 'root', status: 'skipped', reason: 'running' }]);
  assert.deepEqual(plan.targets, []); // 连后代 sub 也不进 targets
});

test('planDelete 家族含受保护成员：整族 family-protected 跳过，绝不半删', () => {
  const rows = [
    row('root', { childIds: ['sub1', 'sub2'] }),
    row('sub1'),
    row('sub2', { running: true }), // 受保护的后代
  ];
  const plan = planDelete(rows, ['root'], new Map([['sub2', 'running']]));
  // root / sub1 被 family-protected 跳过；sub2 是 blocker，也进 skipped（不进 targets）
  assert.equal(plan.targets.length, 0, '整族不得有任何成员进入 targets');
  const skippedById = new Map(plan.skipped.map((s) => [s.id, s]));
  assert.equal(skippedById.get('root').reason, 'family-protected');
  assert.equal(skippedById.get('sub1').reason, 'family-protected');
  assert.ok(skippedById.get('sub2'), 'blocker 自身也出现在 skipped');
  assert.match(skippedById.get('root').detail, /sub2:running/);
});

test('planDelete 直接选中的受保护成员保留自己的 reason，不被家族条目抢先', () => {
  // 同时直接选中 root(安全) 和 sub(受保护)；sub 家族含受保护的 sub 自身。
  const rows = [row('root', { childIds: ['sub'] }), row('sub', { running: true })];
  const plan = planDelete(rows, ['root', 'sub'], new Map([['sub', 'running']]));
  const sub = plan.skipped.find((s) => s.id === 'sub');
  assert.equal(sub.reason, 'running', 'sub 必须报自己的 reason 而非 family-protected');
});

test('planDelete 每个 id 在 skipped 中最多一次', () => {
  // 两个家族都覆盖 sub（sub 同时是 root1 与 root2 的后代），且 sub 受保护。
  const rows = [
    row('root1', { childIds: ['sub'] }),
    row('root2', { childIds: ['sub'] }),
    row('sub', { running: true }),
  ];
  const plan = planDelete(rows, ['root1', 'root2'], new Map([['sub', 'running']]));
  const subCount = plan.skipped.filter((s) => s.id === 'sub').length;
  assert.equal(subCount, 1);
});

test('planDelete 重复 directId 只处理一次', () => {
  const rows = [row('a')];
  const plan = planDelete(rows, ['a', 'a'], new Map());
  assert.deepEqual(plan.direct, ['a']);
  assert.deepEqual(plan.targets, ['a']);
});

// ---------- clientProtectedReason ----------
test('clientProtectedReason 合并 running / hostProtectedReason / current，按优先级取最高', () => {
  const rows = [
    row('a', { running: true }),
    row('b', { hostProtectedReason: 'attached' }),
    row('c', { running: true, hostProtectedReason: 'in-flight' }), // in-flight 胜 running
    row('d', { hostProtectedReason: 'attached' }), // 与 current 冲突
  ];
  const map = clientProtectedReason(rows, 'd'); // d 是 current，应胜过 attached
  assert.equal(map.get('a'), 'running');
  assert.equal(map.get('b'), 'attached');
  assert.equal(map.get('c'), 'in-flight');
  assert.equal(map.get('d'), 'current');
});

test('clientProtectedReason 高优先级不被低优先级覆盖（顺序无关）', () => {
  const rows = [row('a', { running: true, hostProtectedReason: 'in-flight' })];
  const map = clientProtectedReason(rows, 'a'); // current(3) 不应覆盖 in-flight(4)
  assert.equal(map.get('a'), 'in-flight');
});

test('clientProtectedReason 未知保护态 fail-safe：按最高保护，不被已知低优先级覆盖', () => {
  // 未来宿主新增 'pinned' 等保护态时，rank 兜底 Infinity——绝不能回退成 0 而静默失去保护。
  const rows = [row('a', { running: true, hostProtectedReason: 'pinned' })];
  const map = clientProtectedReason(rows, 'a'); // current(3) 也不应覆盖未知态(Infinity)
  assert.equal(map.get('a'), 'pinned', '未知保护态必须胜过一切已知优先级');

  // 两个未知态相遇时先写者保留（rank 相等，mark 不覆盖），但仍是非 0 的高保护。
  const rows2 = [row('b', { hostProtectedReason: 'shared' })];
  assert.equal(clientProtectedReason(rows2, undefined).get('b'), 'shared');
});

test('selectionFullyProtected 空选为 false，全选受保护为 true', () => {
  const prot = new Map([['a', 'running'], ['b', 'current']]);
  assert.equal(selectionFullyProtected([], prot), false);
  assert.equal(selectionFullyProtected(['a', 'b'], prot), true);
  assert.equal(selectionFullyProtected(['a', 'c'], prot), false);
});

// ---------- cascadePurge 编排 ----------
test('cascadePurge 安全家族：父+子全部交给 purgeFn，ok=true，结果聚合正确', async () => {
  const rows = [row('root', { childIds: ['sub1', 'sub2'] }), row('sub1'), row('sub2')];
  const mock = makePurgeMock();
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, true);
  assert.deepEqual(new Set(out.targets), new Set(['root', 'sub1', 'sub2']));
  assert.equal(out.primaryOk, true);
  assert.equal(out.descendantsOk, true);
  assert.deepEqual(new Set(out.succeeded), new Set(['root', 'sub1', 'sub2']));
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(new Set(mock.calls[0]), new Set(['root', 'sub1', 'sub2']));
  assert.match(out.message, /3 个会话已彻底删除/);
  assert.match(out.message, /2 个子代理/);
});

test('cascadePurge cascades 只删子代理、父会话失败 → ok=false（结果诚实性）', async () => {
  const rows = [row('root', { childIds: ['sub'] }), row('sub')];
  const mock = makePurgeMock({ failIds: ['root'] });
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, false, '父会话失败时不得宣称成功');
  assert.equal(out.primaryOk, false);
  assert.equal(out.descendantsOk, true);
  assert.deepEqual(out.failed, ['root']);
  assert.match(out.message, /父会话删除失败：root/);
});

test('cascadePurge 子代理失败 → ok=false，message 明确点名子代理', async () => {
  const rows = [row('root', { childIds: ['sub1', 'sub2'] }), row('sub1'), row('sub2')];
  const mock = makePurgeMock({ failIds: ['sub2'] });
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, false, '子代理失败时不得因父成功而宣称成功');
  assert.equal(out.primaryOk, true);
  assert.equal(out.descendantsOk, false);
  assert.deepEqual(out.failed, ['sub2']);
  assert.match(out.message, /子代理删除失败：sub2/);
  assert.doesNotMatch(out.message, /未完全完成的父会话删除失败/);
});

test('cascadePurge 保护家族：skipped 透出，purgeFn 不被调用，ok=false', async () => {
  const rows = [row('root', { childIds: ['sub'] }), row('sub', { running: true })];
  const mock = makePurgeMock();
  const out = await cascadePurge(rows, ['root'], new Map([['sub', 'running']]), { purgeFn: mock.fn });
  assert.equal(out.ok, false);
  assert.equal(mock.calls.length, 0, '受保护家族不应调用物理删除');
  assert.equal(out.skipped.length, 2);
  assert.match(out.message, /受保护被跳过/);
});

test('cascadePurge 委托 purgeFn 时只传两参数，绝不传 allowPurging', async () => {
  const mock = makePurgeMock();
  const purgeDeps = { fs: 'fake', trashRoot: '/t' };
  await cascadePurge([row('a')], ['a'], new Map(), { purgeFn: mock.fn, purgeDeps });
  assert.deepEqual(mock.seenDeps[0], purgeDeps);
  // 第二次参数（deps 对象）不存在——fn 只被调用为 fn(ids, deps)，无第三个 options 参数。
  // 通过 fn 定义签名固定为 (ids, deps) 保证：若代码误传第三参，JS 会忽略，故这里用源码守护补强（见静态守护测试）。
});

test('cascadePurge 无 targets（全 not-found）时不调用 purgeFn，ok=false，message 说明', async () => {
  const mock = makePurgeMock();
  const out = await cascadePurge([row('a')], ['ghost'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, false);
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(out.targets, []);
  assert.equal(out.skipped[0].reason, 'not-found');
});

test('cascadePurge 空 directIds → 无操作，ok=true', async () => {
  const mock = makePurgeMock();
  const out = await cascadePurge([], [], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, true);
  assert.equal(mock.calls.length, 0);
});

test('cascadePurge fork 隔离：源会话级联不删 fork，purgeFn 只收到父+subagent', async () => {
  const rows = [
    row('root', { childIds: ['fork', 'sub'] }),
    row('fork', { origin: 'fork', parentId: 'root' }),
    row('sub', { origin: 'subagent', parentId: 'root' }),
  ];
  const mock = makePurgeMock();
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, true);
  assert.deepEqual(new Set(out.targets), new Set(['root', 'sub']));
  assert.ok(!out.targets.includes('fork'));
  assert.deepEqual(new Set(mock.calls[0]), new Set(['root', 'sub']), 'fork 不得传给物理删除');
});

test('cascadePurge purgeFn 整批拒绝 → ok=false，逐条 rejected 原因与 id 传播', async () => {
  // 模拟 session-purge 整批 fail-closed：含 purging 条目时全部 rejected。
  const rejectAll = async (ids) => ({
    ok: false,
    purged: 0,
    results: ids.map((id) => ({ id, status: 'rejected', reason: 'purge-in-progress' })),
  });
  const rows = [row('root', { childIds: ['sub'] }), row('sub')];
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: rejectAll });
  assert.equal(out.ok, false);
  assert.equal(out.primaryOk, false, '被拒时父也不算成功');
  assert.equal(out.descendantsOk, false, '被拒时子代理也不算成功');
  assert.deepEqual(new Set(out.failed), new Set(['root', 'sub']));
  // 被拒 id 与原因逐条可见（results 里含 reason）。
  const rejected = out.results.filter((r) => r.status === 'rejected');
  assert.deepEqual(new Set(rejected.map((r) => r.id)), new Set(['root', 'sub']));
  assert.ok(rejected.every((r) => r.reason === 'purge-in-progress'));
  assert.match(out.message, /root/);
  assert.match(out.message, /sub/);
});

test('cascadePurge 悬挂 childIds 引用（指向 rows 外会话）→ 整批拒绝 reason=child-ids-dangling', async () => {
  // root.childIds 指向 sub2，但 rows 里没有 sub2——childIds 引用了 rows 外的 id。
  // 注意：这只能查出「引用悬挂」，查不出「childIds 本身漏了子代理」（那是第4阶段构建方责任）。
  const rows = [row('root', { childIds: ['sub2'] })];
  const mock = makePurgeMock();
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, false, '悬挂引用时绝不谎报成功');
  assert.equal(mock.calls.length, 0, '悬挂引用时不得调用物理删除');
  assert.deepEqual(out.results, [{ id: 'sub2', status: 'rejected', reason: 'child-ids-dangling' }]);
  assert.match(out.message, /悬挂 childIds/);
  assert.match(out.message, /sub2/);
});

test('cascadePurge 快照中明确标 fork 的后代不被级联（fork 不参与级联）', async () => {
  const rows = [
    row('root', { childIds: ['fork'] }),
    row('fork', { origin: 'fork', parentId: 'root' }), // fork 有 parentId、origin 合法、在 rows 内
  ];
  const mock = makePurgeMock();
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, true);
  assert.deepEqual(out.targets, ['root']); // fork 不进 targets
  assert.deepEqual(new Set(mock.calls[0]), new Set(['root']));
});

test('detectDanglingChildIds 缺失未知 origin 的引用时保守计入', () => {
  const rows = [row('root', { childIds: ['ghost'] })]; // ghost 不在 rows，无法判断 origin
  assert.deepEqual(detectDanglingChildIds(rows, ['root']), ['ghost']);
});

test('detectDanglingChildIds 能力边界：childIds 自身漏子代理时查不出（返回空）', () => {
  // 这是评审的核心质疑点：遍历与自检同源，childIds 里没写 sub2 时两者都看不见。
  // 快照整体完整性的保证责任在第4阶段构建方，本函数只查引用悬挂。
  const rows = [
    row('root', { childIds: [] }),  // 构建方漏写了 sub2
    row('sub2', { parentId: 'root' }),
  ];
  assert.deepEqual(detectDanglingChildIds(rows, ['root']), [], '同源自检查不出 childIds 自身漏项');
});

test('detectInvalidOrigins 检出 parentId 非空但 origin 缺失/未知的行', () => {
  const rows = [
    row('root'),                                    // 无 parentId，不校验
    row('a', { parentId: 'root' }),                  // origin 被 row() 默认填了 subagent，合法
    { id: 'b', childIds: [], sizeBytes: 1, parentId: 'root' }, // origin 缺失 → 违规
    row('c', { parentId: 'root', origin: 'weird' }), // 未知 origin → 违规
    row('fork', { parentId: 'root', origin: 'fork' }), // fork 合法
  ];
  assert.deepEqual(new Set(detectInvalidOrigins(rows)), new Set(['b', 'c']));
});

test('cascadePurge origin 缺失的行 → 整批拒绝 reason=invalid-origin', async () => {
  const rows = [
    row('root', { childIds: ['sub'] }),
    { id: 'sub', childIds: [], sizeBytes: 1, parentId: 'root' }, // origin 缺失
  ];
  const mock = makePurgeMock();
  const out = await cascadePurge(rows, ['root'], new Map(), { purgeFn: mock.fn });
  assert.equal(out.ok, false);
  assert.equal(mock.calls.length, 0, '非法 origin 时不得调用物理删除');
  assert.deepEqual(out.results, [{ id: 'sub', status: 'rejected', reason: 'invalid-origin' }]);
  assert.match(out.message, /非法 origin/);
});

// ---------- 静态守护 ----------
test('静态守护：session-cascade.js 不含任何物理 I/O（rm/rename/write/unlink）', () => {
  // 本模块是纯编排，物理删除全部委托注入的 purgeFn。
  assert.doesNotMatch(moduleSrc, /\b(rmSync|rmdirSync|unlinkSync|renameSync|writeFileSync)\s*\(/);
});

test('静态守护：cascadePurge 不引用 allowPurging / recoverPurging（杜绝启动恢复路径误用）', () => {
  // allowPurging 是 recoverPurging 专用；级联是显式操作，不得接触。
  // 模块头注释里有说明性文字，故只断言可执行代码中未调用 recoverPurging。
  assert.doesNotMatch(moduleSrc, /\brecoverPurging\s*\(/);
  assert.doesNotMatch(moduleSrc, /allowPurging\s*:/);
  // 注入的 purgeFn 调用只传两个实参（ids, purgeDeps），无第三 options。
  assert.match(moduleSrc, /purgeFn\(plan\.targets, purgeDeps\)/);
});
