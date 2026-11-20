// 「每个组件有自己的独立版本并显示」的结构 / 行为契约测试。
// 不依赖 DSH 运行时，也不依赖浏览器 DOM：
//   - host 半区用纯函数 collectVersions + 假 ctx/假 res 直接跑路由 handler；
//   - 动态读取特性用临时目录注入验证（版本绝不写死）；
//   - client 半区无 DOM 环境，改用源码契约断言其稳定注入标记。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  VERSION, collectVersions, COMPONENTS_ROUTE, HEALTH_ROUTE, apply, name,
} from '../lib/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SEMVER = /^\d+\.\d+\.\d+/;

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}
function readSrc(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

const OWN_PKGS = [
  'dsh-plugin-yanyan-toolkit',
  'dsh-plugin-yanyan-update',
  'dsh-plugin-yanyan-subagent',
  'dsh-plugin-yanyan-icon',
  'dsh-plugin-yanyan-session-hub',
];
const EXTERNAL_PKG = '@linxin666/dsh-session-archive';

test('VERSION 动态等于根包 package.json 版本（不再写死）', () => {
  assert.equal(VERSION, readJson('package.json').version);
  assert.match(VERSION, SEMVER);
});

test('collectVersions 覆盖全部 6 个组件且各自是合法 semver', () => {
  const v = collectVersions();
  for (const pkg of [...OWN_PKGS, EXTERNAL_PKG]) {
    assert.ok(Object.prototype.hasOwnProperty.call(v, pkg), `缺少组件 ${pkg}`);
    assert.match(String(v[pkg]), SEMVER, `${pkg} 版本不合法`);
    assert.ok(!/^[\^~>=<]/.test(String(v[pkg])), `${pkg} 不应残留范围前缀`);
  }
  assert.equal(Object.keys(v).length, 6);
});

test('五个自写组件版本精确等于各自 package.json，且互不强制一致', () => {
  const v = collectVersions();
  assert.equal(v['dsh-plugin-yanyan-toolkit'], readJson('package.json').version);
  assert.equal(
    v['dsh-plugin-yanyan-update'],
    readJson('packages/dsh-plugin-yanyan-update/package.json').version,
  );
  assert.equal(
    v['dsh-plugin-yanyan-subagent'],
    readJson('packages/dsh-plugin-yanyan-subagent/package.json').version,
  );
  assert.equal(
    v['dsh-plugin-yanyan-icon'],
    readJson('packages/dsh-plugin-yanyan-icon/package.json').version,
  );
  // 聚合包 1.4.2 / update 1.2.1 / subagent 1.4.0 / icon 1.0.1 本就不同，正是「独立版本」。
  assert.ok(new Set(OWN_PKGS.map((p) => v[p])).size >= 2);
});

test('外部组件版本干净：读实装优先，未装时回退声明（去掉 ^）', () => {
  const v = collectVersions();
  const got = String(v[EXTERNAL_PKG]);
  assert.match(got, SEMVER);
  assert.notEqual(got, 'unknown');
  const declared = String(readJson('package.json').dependencies[EXTERNAL_PKG])
    .replace(/^[\^~>=<\s]+/, '');
  // 没装该包时等于声明；装了则可能更高，二者都合法，但绝不能是范围串。
  assert.ok(got === declared || SEMVER.test(got));
});

test('collectVersions(rootDir) 动态读取注入目录，六个版本互不串味', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yanyan-ver-'));
  try {
    mkdirSync(join(dir, 'packages', 'dsh-plugin-yanyan-update'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'dsh-plugin-yanyan-subagent'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'dsh-plugin-yanyan-icon'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'dsh-plugin-yanyan-session-hub'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-yanyan-toolkit',
      version: '9.9.9',
      dependencies: { [EXTERNAL_PKG]: '^7.7.7' },
    }));
    writeFileSync(
      join(dir, 'packages', 'dsh-plugin-yanyan-update', 'package.json'),
      JSON.stringify({ version: '2.2.2' }),
    );
    writeFileSync(
      join(dir, 'packages', 'dsh-plugin-yanyan-subagent', 'package.json'),
      JSON.stringify({ version: '3.3.3' }),
    );
    writeFileSync(
      join(dir, 'packages', 'dsh-plugin-yanyan-icon', 'package.json'),
      JSON.stringify({ version: '4.4.4' }),
    );
    writeFileSync(
      join(dir, 'packages', 'dsh-plugin-yanyan-session-hub', 'package.json'),
      JSON.stringify({ version: '6.6.6' }),
    );

    const v = collectVersions(dir);
    assert.equal(v['dsh-plugin-yanyan-toolkit'], '9.9.9');
    assert.equal(v['dsh-plugin-yanyan-update'], '2.2.2');
    assert.equal(v['dsh-plugin-yanyan-subagent'], '3.3.3');
    assert.equal(v['dsh-plugin-yanyan-icon'], '4.4.4');
    assert.equal(v['dsh-plugin-yanyan-session-hub'], '6.6.6');
    // 临时目录没有 node_modules，外部包应回退声明并去掉 ^。
    assert.ok(
      v[EXTERNAL_PKG] === '7.7.7' || SEMVER.test(String(v[EXTERNAL_PKG])),
      '外部包应回退声明 7.7.7（或读到实装版本）',
    );
    assert.equal(Object.keys(v).length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- host 路由：用假 ctx / 假 res 跑真实 handler ----

function harness(rejection) {
  const routes = {};
  const ctx = {
    connection: { requestRejection: () => rejection },
    webServer: {
      register: (route) => {
        routes[route.path] = route.handler;
        return () => { delete routes[route.path]; };
      },
    },
    effect: (setup) => { setup(); },
  };
  return { ctx, routes };
}

function fakeRes() {
  return {
    status: 0,
    head: null,
    body: null,
    writeHead(status, head) { this.status = status; this.head = head; },
    end(payload) { this.body = JSON.parse(payload); },
  };
}

test('apply 注册 health + components 两条 exact 路由', () => {
  const { ctx, routes } = harness(undefined);
  apply(ctx);
  assert.deepEqual(
    Object.keys(routes).sort(),
    [COMPONENTS_ROUTE, HEALTH_ROUTE].sort(),
  );
});

test('components 路由返回 6 个组件版本；health 返回聚合包版本', () => {
  const { ctx, routes } = harness(undefined);
  apply(ctx);

  let res = fakeRes();
  routes[COMPONENTS_ROUTE]({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(Object.keys(res.body.components).length, 6);
  assert.equal(res.body.components['dsh-plugin-yanyan-toolkit'], VERSION);
  assert.equal(res.head['cache-control'], 'no-store');

  res = fakeRes();
  routes[HEALTH_ROUTE]({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, name, version: VERSION });
});

test('准入 fence 拒绝返回 403；方法非 GET/POST 返回 405', () => {
  const blocked = harness(new Error('denied'));
  apply(blocked.ctx);
  let res = fakeRes();
  blocked.routes[COMPONENTS_ROUTE]({ method: 'GET' }, res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden');

  const open = harness(undefined);
  apply(open.ctx);
  res = fakeRes();
  open.routes[HEALTH_ROUTE]({ method: 'DELETE' }, res);
  assert.equal(res.status, 405);
  assert.equal(res.body.error, 'method-not-allowed');
});

test('host 半区源码具备 components 路由与准入契约', () => {
  const src = readSrc('lib/index.js');
  for (const needle of [
    'COMPONENTS_ROUTE',
    'export function collectVersions',
    'readFileSync',
    'createRequire',
    'requestRejection',
    "register({ kind: 'exact'",
    'ctx.effect',
  ]) {
    assert.ok(src.includes(needle), `lib/index.js 缺少契约：${needle}`);
  }
});

test('client 半区源码具备稳定的 DOM 注入与清理契约', () => {
  const src = readSrc('lib/client.js');
  for (const needle of [
    '__ModuleLoader__',
    "id: 'dsh-plugin-yanyan-toolkit'",
    '/__dsh-plugin-yanyan-toolkit/components',
    'data-yanyan-component-version',
    'data-yanyan-component-version-style',
    'section[data-plugin-rows] li[data-plugin-row]',
    "querySelectorAll('code')",
    'hasOwnProperty.call(versions',
    'MutationObserver',
    'ctx.effect',
    'observer.disconnect()',
    'var inject = []',
  ]) {
    assert.ok(src.includes(needle), `lib/client.js 缺少契约：${needle}`);
  }
});
