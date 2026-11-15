// 纯单测：只导入 lib/index.js 的纯函数，模块顶层不得触发任何 DSH ctx 副作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeConfig,
  gt,
  classifySpec,
  parseUpdateResult,
  updateRegistry,
  readEnablement,
  restoreEnablement,
} from '../lib/index.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('normalizeConfig：缺省兜底 / 部分覆盖 / 非法 timeoutMs 回落', () => {
  // 完全缺省：逐键补默认值
  assert.deepEqual(normalizeConfig(undefined), {
    checkOnOpen: false,
    includeLocal: true,
    includeRegistry: true,
    registryUrl: 'https://registry.npmjs.org',
    timeoutMs: 12000,
  });
  assert.deepEqual(normalizeConfig(null), {
    checkOnOpen: false,
    includeLocal: true,
    includeRegistry: true,
    registryUrl: 'https://registry.npmjs.org',
    timeoutMs: 12000,
  });

  // 部分覆盖：只覆盖 includeLocal，其余键仍补默认值（整段覆盖不深合并）
  const partial = normalizeConfig({ includeLocal: false, registryUrl: 'https://registry.example.org/' });
  assert.equal(partial.includeLocal, false);
  assert.equal(partial.includeRegistry, true);
  assert.equal(partial.checkOnOpen, false);
  assert.equal(partial.registryUrl, 'https://registry.example.org');
  assert.equal(partial.timeoutMs, 12000);

  // 非法 timeoutMs 回落默认；越界值限制在 1000..120000
  assert.equal(normalizeConfig({ timeoutMs: 'abc' }).timeoutMs, 12000);
  assert.equal(normalizeConfig({ timeoutMs: NaN }).timeoutMs, 12000);
  assert.equal(normalizeConfig({ timeoutMs: -5 }).timeoutMs, 1000);
  assert.equal(normalizeConfig({ timeoutMs: 999999 }).timeoutMs, 120000);
  assert.equal(normalizeConfig({ timeoutMs: 5000 }).timeoutMs, 5000);
});

test('gt：版本比较', () => {
  assert.equal(gt('0.4.18', '0.4.16'), true);
  assert.equal(gt('1.0.0', '1.0.0-rc.2'), true);
  assert.equal(gt('1.10.0', '1.9.0'), true);
  assert.equal(gt('v2.0.0', '1.9.9'), true);
  assert.equal(gt('1.0.0-rc.2', '1.0.0-rc.1'), true);
  // 相等 / 更小 / 预发布小于正式版
  assert.equal(gt('1.0.0', '1.0.0'), false);
  assert.equal(gt('0.4.16', '0.4.18'), false);
  assert.equal(gt('1.0.0-rc.2', '1.0.0'), false);
  // 非法 / 缺失版本返回 false
  assert.equal(gt('abc', '1.0.0'), false);
  assert.equal(gt('', '1.0.0'), false);
  assert.equal(gt(null, '1.0.0'), false);
});

test('classifySpec：local / github / registry / skip 分类', () => {
  // link: / file: → local，去掉前缀保留原路径
  assert.equal(classifySpec('foo', 'link:F:/plugins/foo').kind, 'local');
  assert.equal(classifySpec('foo', 'link:F:/plugins/foo').dir, 'F:/plugins/foo');
  assert.equal(classifySpec('foo', 'file:../local/foo').kind, 'local');
  assert.equal(classifySpec('foo', 'file:../local/foo').dir, '../local/foo');

  // github: / git+https://github.com/... → github
  assert.equal(classifySpec('foo', 'github:user/repo').kind, 'github');
  assert.equal(classifySpec('foo', 'git+https://github.com/user/repo.git').kind, 'github');
  assert.equal(classifySpec('foo', 'https://github.com/user/repo').kind, 'github');

  // 普通包名 / ^1.2.3 / name@version → registry
  assert.equal(classifySpec('foo', '^1.2.3').kind, 'registry');
  assert.equal(classifySpec('foo', '1.0.0').kind, 'registry');
  assert.equal(classifySpec('foo', 'bar').kind, 'registry');

  // 官方包 / 自身 / 会话归档 → skip
  assert.equal(classifySpec('@deepseek-ai/dsh', '0.4.16').kind, 'skip');
  assert.equal(classifySpec('dsh-plugin-yanyan-foo', '^1.0.0').kind, 'skip');
  assert.equal(classifySpec('dsh-plugin-yanyan-update', '^1.0.0').kind, 'skip');
  assert.equal(classifySpec('@linxin666/dsh-session-archive', '1.2.3').kind, 'skip');
});

test('根包元数据：patch 行一致、locale 合法 JSON、package.json 导出完整', () => {
  const patch = fs.readFileSync(path.join(PKG_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*dsh-plugin-yanyan-update/);
  assert.match(patch, /name:\s*'dsh-plugin-yanyan-update'/);

  for (const lang of ['zh', 'en']) {
    const raw = fs.readFileSync(path.join(PKG_ROOT, 'locale', lang + '.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.meta && typeof parsed.meta.title === 'string' && parsed.meta.title.length > 0);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-plugin-yanyan-update');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.ok(pkg.exports['./locale/*.json']);
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.dsh.client.inject.includes('locale'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

// ───────────── 更新失败路径：安装失败时回滚 / 不卸载 ─────────────
// 全部通过 io 注入 mock，测试绝不触碰真实 pluginManager、npm registry 与 profile 文件。

const CFG = normalizeConfig({ registryUrl: 'https://registry.example.org', timeoutMs: 5000 });
const DEPS = { foo: '1.0.0' };

function mockIo(manager, extra) {
  return Object.assign({
    manager,
    fetchLatest: async () => '2.0.0',
    resolveProfileDir: () => null,
    readDependencies: () => ({}),
  }, extra || {});
}

// 构造仅支持两阶段的 mock：首次覆盖安装被 already-installed 拒绝，
// 二次目标安装失败，随后按 restoreSucceeds 决定回滚装回是否成功。
function twoPhaseManager(restoreSucceeds) {
  const calls = [];
  let targetCalls = 0;
  const manager = {
    removeBundle: async (id) => {
      calls.push(['removeBundle', id]);
      return { application: 'applied', changed: true };
    },
    installBundle: async (spec) => {
      calls.push(['installBundle', spec]);
      if (spec === 'foo@2.0.0') {
        targetCalls += 1;
        if (targetCalls === 1) return { error: { code: 'already-installed' } };
        return { application: 'failed', error: { code: 'ETIMEDOUT' } };
      }
      // restoreSpec('foo@1.0.0')：回滚装回
      return restoreSucceeds
        ? { application: 'applied', changed: true }
        : { application: 'failed', error: { code: 'ETIMEDOUT' } };
    },
  };
  return { manager, calls };
}

test('parseUpdateResult：官方成功态 / 失败态 / 装回结果解析', () => {
  const ok = parseUpdateResult({
    from: '1.0.0', to: '2.0.0', step: 'install',
    result: { application: 'restart-required', changed: true },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.updated, true);
  assert.equal(ok.restartRequired, true);
  assert.match(ok.message, /重启/);

  // 官方 HMR 失败但把被移除版本装回（restore 成功）→ 原版本已保留
  const failedRestored = parseUpdateResult({
    from: '1.0.0', to: '2.0.0', step: 'install',
    result: { application: 'failed', error: { code: 'ETIMEDOUT' } },
    restore: { application: 'applied', changed: true },
  });
  assert.equal(failedRestored.ok, false);
  assert.equal(failedRestored.restored, true);
  assert.match(failedRestored.message, /原版本已保留/);

  // 官方 restore 也失败 → 如实提示手动重装，不谎称已装回
  const failedNotRestored = parseUpdateResult({
    from: '1.0.0', to: '2.0.0', step: 'install',
    result: { application: 'failed', error: { code: 'ETIMEDOUT' } },
    restore: { application: 'failed', error: { code: 'ETIMEDOUT' } },
  });
  assert.equal(failedNotRestored.restored, false);
  assert.match(failedNotRestored.message, /手动重装/);

  // check 阶段拒绝：无 restore 说明原安装从未被移除 → 视为已保留
  const refused = parseUpdateResult({
    from: '1.0.0', to: '2.0.0', step: 'check',
    result: { application: 'failed', error: { code: 'invalid-spec' } },
  });
  assert.equal(refused.restored, true);
  assert.match(refused.message, /原版本已保留/);

  // remote proxy 形态 { ok, value: PluginUpdateResult }
  const proxied = parseUpdateResult({
    ok: true,
    value: { from: '1.0.0', to: '2.0.0', step: 'install', result: { application: 'applied' } },
  });
  assert.equal(proxied.ok, true);
  assert.equal(proxied.restartRequired, false);
});

test('updateRegistry：官方 updateBundle 成功时返回可读中文结果', async () => {
  const manager = {
    updateBundle: async () => ({
      from: '1.0.0', to: '2.0.0', step: 'install',
      result: { application: 'applied', changed: true },
    }),
  };
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.spec, 'foo@2.0.0');
  assert.match(result.message, /已即时生效/);
});

test('updateRegistry：优先复用官方 updateBundle，本包绝不自行 removeBundle', async () => {
  const calls = { removeBundle: 0, installBundle: 0, updateBundle: 0 };
  const manager = {
    updateBundle: async () => {
      calls.updateBundle += 1;
      return {
        from: '1.0.0', to: '2.0.0', step: 'install',
        result: { application: 'failed', error: { code: 'ETIMEDOUT' } },
        restore: { application: 'applied', changed: true },
      };
    },
    removeBundle: async () => { calls.removeBundle += 1; return { application: 'applied' }; },
    installBundle: async () => { calls.installBundle += 1; return { application: 'applied' }; },
  };
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(calls.updateBundle, 1);
  assert.equal(calls.removeBundle, 0, '官方 updateBundle 可用时本包不得卸载插件');
  assert.equal(calls.installBundle, 0);
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.match(result.message, /原版本已保留/);
});

test('updateRegistry：官方 updateBundle 抛异常时原版本未被卸载', async () => {
  const calls = { removeBundle: 0 };
  const manager = {
    updateBundle: async () => { throw new Error('boom'); },
    removeBundle: async () => { calls.removeBundle += 1; return { application: 'applied' }; },
  };
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(calls.removeBundle, 0);
  assert.equal(result.restored, true);
  assert.match(result.message, /未被卸载/);
});

test('updateRegistry：降级覆盖安装失败但从未卸载，原版本保留', async () => {
  const calls = [];
  const manager = {
    removeBundle: async (id) => { calls.push(['removeBundle', id]); return { application: 'applied' }; },
    installBundle: async (spec) => {
      calls.push(['installBundle', spec]);
      return { application: 'failed', error: { code: 'E404' } };
    },
  };
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(calls.filter((c) => c[0] === 'removeBundle').length, 0,
    '非 already-installed 的覆盖安装失败不得卸载插件');
  assert.equal(result.restored, true);
  assert.match(result.message, /未被卸载/);
});

test('updateRegistry：降级两阶段，目标安装失败时回滚装回原版本', async () => {
  const { manager, calls } = twoPhaseManager(true);
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(calls.filter((c) => c[0] === 'removeBundle').length, 1);
  assert.ok(calls.some((c) => c[0] === 'installBundle' && c[1] === 'foo@1.0.0'),
    '失败后必须用 previousSpec 回滚重装');
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.match(result.message, /已装回原版本/);
});

test('updateRegistry：降级回滚失败时以 profile 依赖二次核验兜底', async () => {
  const { manager } = twoPhaseManager(false);
  const result = await updateRegistry({}, 'foo', CFG, DEPS,
    mockIo(manager, { profileDeps: { foo: '1.0.0' } }));
  assert.equal(result.restored, true, 'profile 中仍存在该依赖，应判定原版本已装回');
  assert.match(result.message, /已装回原版本/);
});

test('updateRegistry：降级回滚失败且无法确认时如实提示手动重装', async () => {
  const { manager } = twoPhaseManager(false);
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(result.restored, false);
  assert.match(result.message, /手动重新安装/);
});

test('updateRegistry：无可用官方管理器时提示手动更新且原版本不动', async () => {
  let fetched = 0;
  const io = mockIo({}, {
    fetchLatest: async () => { fetched += 1; return '2.0.0'; },
  });
  const result = await updateRegistry({}, 'foo', CFG, DEPS, io);
  assert.equal(result.error, 'native-manager-unavailable');
  assert.equal(result.restored, true);
  assert.equal(fetched, 0, '应尽早返回，不做任何安装或卸载动作');
  assert.match(result.message, /原版本未改动/);
});

// ───────────── 更新后启用态恢复：修复「更新完默认关闭」 ─────────────
// 对应关系：listPlugins 的 entry 级 enabled = 「已安装插件」页开关本体；
// 官方 updateBundle 只恢复 bundle 选择态，entry 级开关在 remove→install 后丢失。

function enablementManager(overrides) {
  const calls = [];
  const manager = Object.assign({
    listPlugins: async () => ([{ entryId: 'loader/foo', moduleName: 'foo', enabled: true }]),
    setPluginEnabled: async (id, enabled) => { calls.push(['setPluginEnabled', id, enabled]); },
    setBundleEnabled: async (name, enabled) => { calls.push(['setBundleEnabled', name, enabled]); },
    updateBundle: async () => ({
      from: '1.0.0', to: '2.0.0', step: 'install',
      result: { application: 'applied', changed: true },
    }),
  }, overrides || {});
  return { manager, calls };
}

test('readEnablement：优先 listPlugins 的 entry 级 enabled 并携带 entryId', async () => {
  let r = await readEnablement({ listPlugins: async () => ([
    { entryId: 'loader/foo', moduleName: 'foo', enabled: true },
  ]) }, 'foo');
  assert.equal(r.wasDisabled, false);
  assert.equal(r.entryId, 'loader/foo');

  // 用户主动关闭：明确 enabled === false
  r = await readEnablement({ listPlugins: async () => ([
    { entryId: 'loader/foo', moduleName: 'foo', enabled: false },
  ]) }, 'foo');
  assert.equal(r.wasDisabled, true);

  // remote proxy 形态 { value: [...] }
  r = await readEnablement({ listPlugins: async () => ({ value: [
    { entryId: 'loader/foo', moduleName: 'foo', enabled: true },
  ] }) }, 'foo');
  assert.equal(r.entryId, 'loader/foo');
});

test('readEnablement：无 listPlugins 时回退 listBundles，异常/缺失一律按开启', async () => {
  let r = await readEnablement({ listBundles: async () => ([{ name: 'foo', enabled: false }]) }, 'foo');
  assert.equal(r.wasDisabled, true, 'bundle 明确关闭应尊重');

  r = await readEnablement({ listBundles: async () => ([{ name: 'foo', enabled: true }]) }, 'foo');
  assert.equal(r.wasDisabled, false);

  // 读方法抛错 / 完全无方法 → 默认按开启，不阻断更新
  r = await readEnablement({ listPlugins: async () => { throw new Error('boom'); } }, 'foo');
  assert.equal(r.wasDisabled, false);
  r = await readEnablement({}, 'foo');
  assert.equal(r.wasDisabled, false);
  assert.equal(r.entryId, null);
});

test('restoreEnablement：优先 setPluginEnabled(entryId, true)，无则回退 setBundleEnabled', async () => {
  let { manager, calls } = enablementManager();
  await restoreEnablement(manager, 'foo', { wasDisabled: false, entryId: 'loader/foo' });
  assert.deepEqual(calls, [['setPluginEnabled', 'loader/foo', true]]);

  // 无 entryId 时用包名
  ({ manager, calls } = enablementManager());
  await restoreEnablement(manager, 'foo', { wasDisabled: false, entryId: null });
  assert.deepEqual(calls, [['setPluginEnabled', 'foo', true]]);

  // 无 setPluginEnabled → 回退官方同款 setBundleEnabled
  ({ manager, calls } = enablementManager({ setPluginEnabled: undefined }));
  await restoreEnablement(manager, 'foo', { wasDisabled: false, entryId: null });
  assert.deepEqual(calls, [['setBundleEnabled', 'foo', true]]);

  // setPluginEnabled 抛错（如传包名触发 unknown-plugin）→ 回退 setBundleEnabled
  ({ manager, calls } = enablementManager({
    setPluginEnabled: async () => { throw new Error('unknown-plugin'); },
  }));
  await restoreEnablement(manager, 'foo', { wasDisabled: false, entryId: null });
  assert.deepEqual(calls, [['setBundleEnabled', 'foo', true]]);

  // 无任何 set 方法 → 静默跳过，不抛错
  await restoreEnablement({}, 'foo', { wasDisabled: false, entryId: null });
});

test('restoreEnablement：用户主动关闭(wasDisabled)时不恢复；恢复异常被吞掉', async () => {
  let { manager, calls } = enablementManager();
  await restoreEnablement(manager, 'foo', { wasDisabled: true, entryId: 'loader/foo' });
  assert.deepEqual(calls, [], '用户主动关闭的插件不得被强行打开');

  // 两种恢复方法都抛错也不得冒泡
  ({ manager } = enablementManager({
    setPluginEnabled: async () => { throw new Error('x'); },
    setBundleEnabled: async () => { throw new Error('y'); },
  }));
  await restoreEnablement(manager, 'foo', { wasDisabled: false, entryId: null });
});

test('updateRegistry：updateBundle 成功后恢复启用态，且不影响更新结论', async () => {
  const { manager, calls } = enablementManager();
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.match(result.message, /已即时生效/);
  assert.deepEqual(calls, [['setPluginEnabled', 'loader/foo', true]]);
});

test('updateRegistry：用户主动关闭的插件更新后不恢复启用态', async () => {
  const { manager, calls } = enablementManager({
    listPlugins: async () => ([{ entryId: 'loader/foo', moduleName: 'foo', enabled: false }]),
  });
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, []);
});

test('updateRegistry：恢复启用态抛错不影响更新成功结论', async () => {
  const { manager } = enablementManager({
    setPluginEnabled: async () => { throw new Error('unknown-plugin'); },
    setBundleEnabled: async () => { throw new Error('boom'); },
  });
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(result.ok, true, '恢复失败不得把成功更新误报为失败');
  assert.equal(result.updated, true);
  assert.match(result.message, /已即时生效/);
});

test('updateRegistry：旧 mock（无任何 list*/set* 方法）更新成功照常通过', async () => {
  const manager = {
    updateBundle: async () => ({
      from: '1.0.0', to: '2.0.0', step: 'install',
      result: { application: 'applied', changed: true },
    }),
  };
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(result.ok, true, '新方法全部可选，旧形态管理器必须兼容');
});

test('updateRegistry：降级两阶段成功也恢复启用态', async () => {
  const mgr = twoPhaseManager(true);
  // twoPhaseManager 目标二次安装失败，这里改成全成功以走成功出口
  let targetCalls = 0;
  const manager = {
    listPlugins: async () => ([{ entryId: 'loader/foo', moduleName: 'foo', enabled: true }]),
    setPluginEnabled: async (id, enabled) => { mgr.calls.push(['setPluginEnabled', id, enabled]); },
    removeBundle: async (id) => { mgr.calls.push(['removeBundle', id]); return { application: 'applied' }; },
    installBundle: async (spec) => {
      mgr.calls.push(['installBundle', spec]);
      if (spec === 'foo@2.0.0') {
        targetCalls += 1;
        if (targetCalls === 1) return { error: { code: 'already-installed' } };
        return { application: 'applied', changed: true };
      }
      return { application: 'applied', changed: true };
    },
  };
  const result = await updateRegistry({}, 'foo', CFG, DEPS, mockIo(manager));
  assert.equal(result.ok, true);
  assert.ok(mgr.calls.some((c) => c[0] === 'setPluginEnabled' && c[1] === 'loader/foo' && c[2] === true));
});
