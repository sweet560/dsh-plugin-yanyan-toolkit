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
  'packages/dsh-plugin-yanyan-trash',
  'packages/dsh-plugin-yanyan-session-hub',
];

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

test('每个自写子包 package.json 具备完整装载契约', () => {
  for (const dir of CHILDREN) {
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

test('每个功能插件的 host / client 半区与展示元数据齐备', () => {
  for (const dir of CHILDREN) {
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
  assert.equal(names.length, 7, '应有 7 行 name');
  assert.equal(readJson('package.json').name, 'dsh-plugin-yanyan-toolkit');
  assert.ok(names.includes('dsh-plugin-yanyan-toolkit'), '自身行 name');
  for (const dir of CHILDREN) {
    const n = readJson(`${dir}/package.json`).name;
    assert.ok(names.includes(n), `${n} 应出现在 patch 行`);
    const childPatch = readFileSync(join(root, dir, 'cordis.patch.yml'), 'utf8');
    assert.ok(childPatch.includes(`name: '${n}'`), `${dir} 自身 patch 的 name 必须等于包名`);
  }
  assert.ok(names.includes('@linxin666/dsh-session-archive'), '会话管理行');
});

test('源码不含装饰性 emoji（功能符号与箭头除外）', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  const allowed = new Set([0x2715, 0x2192, 0x2190, 0x2026, 0x2713, 0x2714, 0x1f6a8, 0x26a0]); // ✕ → ← … ✓ ✔ 🚨 ⚠️(危险警示，用于彻底删除确认)
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
