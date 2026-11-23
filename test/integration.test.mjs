// 跨包集成校验：六个功能插件 + 自身行的装载前提逐项核对。
// 不联网、不依赖第三方 YAML 库；只用 node 内置模块。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHILDREN = [
  'packages/dsh-plugin-yanyan-update',
  'packages/dsh-plugin-yanyan-subagent',
  'packages/dsh-plugin-yanyan-icon',
  'packages/dsh-plugin-yanyan-session-hub',
  'packages/dsh-find-right-plugin',
];
// 找对插件是纯 host 工具插件（inject=['tools']，无 client 半区 / icon / locale），
// 不走下面「UI 功能插件」的通用装载与展示元数据契约，单独按工具插件契约校验。
const TOOL_PLUGIN = 'packages/dsh-find-right-plugin';
const UI_CHILDREN = CHILDREN.filter((dir) => dir !== TOOL_PLUGIN);

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(p));
    else if (/\.(js|mjs|json|md|yml|yaml|svg)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('每个 UI 自写子包 package.json 具备完整装载契约', () => {
  for (const dir of UI_CHILDREN) {
    const pkg = readJson(`${dir}/package.json`);
    assert.equal(pkg.type, 'module', `${dir} 必须是 ESM`);
    assert.equal(pkg.main, 'lib/index.js', `${dir} main`);
    assert.equal(pkg.exports['.'], './lib/index.js', `${dir} exports["."]`);
    assert.equal(pkg.exports['./client'], './lib/client.js', `${dir} exports["./client"]`);
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', `${dir} dsh.bundle.patch`);
    assert.equal(pkg.dsh.client.platform, 'web', `${dir} dsh.client.platform`);
    assert.ok(Array.isArray(pkg.dsh.client.inject), `${dir} dsh.client.inject`);
    assert.ok(/0\.2\.2-rc/.test(pkg.dsh.engines.dsh), `${dir} dsh.engines.dsh`);
  }
});

test('找对插件子包按纯 host 工具插件契约装载', () => {
  const pkg = readJson(`${TOOL_PLUGIN}/package.json`);
  assert.equal(pkg.name, 'dsh-find-right-plugin');
  assert.equal(pkg.version, '1.0.0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '^0.1.5-rc.2 || ^0.2.0-rc.1');
  // 注入 tools 而非 client，不声明 client 半区。
  const src = readFileSync(join(root, TOOL_PLUGIN, 'lib/index.js'), 'utf8');
  assert.ok(src.includes("inject = ['tools']"), '必须注入 tools 服务');
  assert.ok(src.includes("name: 'find_dsh_plugins'"), '必须注册 find_dsh_plugins 工具');
});

test('每个 UI 功能插件的 host / client 半区与展示元数据齐备', () => {
  for (const dir of UI_CHILDREN) {
    for (const f of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg',
      'locale/zh.json', 'locale/en.json', 'README.zh.md', 'README.md']) {
      assert.ok(existsSync(join(root, dir, f)), `${dir}/${f} 缺失`);
    }
    const zh = readJson(`${dir}/locale/zh.json`);
    const en = readJson(`${dir}/locale/en.json`);
    assert.ok(zh.meta && zh.meta.title && zh.meta.description, `${dir} zh meta`);
    assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort(), `${dir} 中英 meta 键集一致`);
  }
});

test('各行 name 严格等于对应包 package.json 的 name', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const names = [...text.matchAll(/^\s+name:\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
  assert.equal(names.length, 6, '应有 6 行 name');
  assert.equal(readJson('package.json').name, 'dsh-plugin-yanyan-toolkit');
  assert.ok(names.includes('dsh-plugin-yanyan-toolkit'), '自身行 name');
  for (const dir of CHILDREN) {
    const n = readJson(`${dir}/package.json`).name;
    assert.ok(names.includes(n), `${n} 应出现在 patch 行`);
    const childPatch = readFileSync(join(root, dir, 'cordis.patch.yml'), 'utf8');
    assert.ok(childPatch.includes(`name: '${n}'`), `${dir} 自身 patch 的 name 必须等于包名`);
  }
  // 第三方 dsh-session-archive 已于 1.4.13 彻底剔除，不得再出现在任何 loader 行。
  assert.ok(!names.includes('@linxin666/dsh-session-archive'));
});

test('源码不含装饰性 emoji（功能符号与箭头除外）', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  const allowed = new Set([0x2715, 0x2192, 0x2190, 0x2026, 0x2713, 0x2714, 0x1f6a8, 0x26a0, 0x2605, 0x2717]); // ✕ → ← … ✓ ✔ 🚨 ⚠️(危险警示) ★(GitHub 星数) ✗(数据源失败标记)
  const hits = [];
  for (const f of collect(root)) {
    for (const ch of readFileSync(f, 'utf8')) {
      const cp = ch.codePointAt(0);
      if (cp < 0x2000 || allowed.has(cp)) continue;
      if (emoji.test(ch)) { hits.push(`${f}: U+${cp.toString(16)}`); break; }
    }
  }
  assert.deepEqual(hits, [], `发现装饰性 emoji: ${hits.join(', ')}`);
});
