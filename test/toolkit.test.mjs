// 研研工具包聚合根包的结构校验。
// 不依赖 DSH 运行时，也不依赖任何第三方 YAML 库：cordis.patch.yml 是本包自写的
// 简单五行 insert，用逐行正则取出 id / name 即可。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

function patchRows() {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const rows = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    const idMatch = line.match(/^\s*-\s+id:\s*'?([^']+?)'?\s*$/);
    if (idMatch) {
      current = { id: idMatch[1] };
      rows.push(current);
      continue;
    }
    const nameMatch = line.match(/^\s+name:\s*'?([^']+?)'?\s*$/);
    if (nameMatch && current) {
      current.name = nameMatch[1];
    }
  }
  return rows;
}

test('根包 package.json 元数据完整', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.name, 'dsh-plugin-yanyan-toolkit');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.dsh.engines.dsh.includes('0.2.2-rc'));
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.ok(pkg.exports['./package.json']);
  assert.ok(pkg.exports['./icon']);
  assert.ok(pkg.exports['./locale/*.json']);
});

test('根包自身 host / client 半区与图标、双语元数据齐备', () => {
  for (const rel of ['lib/index.js', 'lib/client.js', 'icon.svg']) {
    assert.ok(existsSync(join(root, rel)), `缺少 ${rel}`);
  }
  const zh = readJson('locale/zh.json');
  const en = readJson('locale/en.json');
  assert.equal(zh.meta.title, '研研工具包');
  assert.ok(zh.meta.description.length > 0);
  assert.ok(en.meta.title.length > 0);
  assert.equal(Object.keys(zh.meta).sort().join(','), Object.keys(en.meta).sort().join(','), '中英键集必须一致');
});

test('cordis.patch.yml 恰好五条 insert 行，id 与 name 均唯一', () => {
  const rows = patchRows();
  assert.equal(rows.length, 5, `应为 5 行，实际 ${rows.length}: ${JSON.stringify(rows)}`);
  const ids = rows.map((r) => r.id);
  const names = rows.map((r) => r.name);
  assert.equal(new Set(ids).size, 5, 'id 必须全局唯一');
  assert.equal(new Set(names).size, 5, 'name 必须互不相同（否则 client-modules 重复注册）');
  for (const row of rows) {
    assert.ok(row.id, '每行必须有 id');
    assert.ok(row.name, `行 ${row.id} 缺少 name`);
  }
});

test('五条 loader 行的 name 与包清单一致，四个真实插件都在 dependencies 里', () => {
  const pkg = readJson('package.json');
  const rows = patchRows();
  const byName = new Map(rows.map((r) => [r.name, r]));

  // 自身行：name 严格等于根包名。
  assert.ok(byName.has(pkg.name), '缺少 name 等于根包名的自身行');

  // 其余四行：name 必须是 dependencies 的键（四个真实插件）。
  const deps = pkg.dependencies;
  assert.equal(Object.keys(deps).length, 4, '应聚合 4 个真实插件');
  const functionRows = rows.filter((r) => r.name !== pkg.name);
  assert.equal(functionRows.length, 4);
  for (const row of functionRows) {
    assert.ok(Object.prototype.hasOwnProperty.call(deps, row.name), `行 name ${row.name} 未出现在 dependencies`);
  }

  // 三个自写子包：行 name 必须恰好等于各自 package.json 的 name。
  for (const sub of ['dsh-plugin-yanyan-update', 'dsh-plugin-yanyan-subagent', 'dsh-plugin-yanyan-icon']) {
    const subPkg = readJson(`packages/${sub}/package.json`);
    assert.equal(subPkg.name, sub, `子包 ${sub} 的 package.json name 不匹配`);
    assert.ok(byName.has(sub), `缺少子包 ${sub} 的 loader 行`);
  }

  // 会话管理行 name 必须恰好等于被复用的真实 npm 包名，才能挂上 browser 半区。
  assert.ok(byName.has('@linxin666/dsh-session-archive'));
  assert.equal(deps['@linxin666/dsh-session-archive'], '^0.4.18');
});

test('三个自写子包目录与 cordis.patch.yml 存在，且行 id 沿用约定', () => {
  for (const sub of ['dsh-plugin-yanyan-update', 'dsh-plugin-yanyan-subagent', 'dsh-plugin-yanyan-icon']) {
    assert.ok(existsSync(join(root, 'packages', sub, 'cordis.patch.yml')), `${sub} 缺少 cordis.patch.yml`);
  }
  const ids = new Set(patchRows().map((r) => r.id));
  assert.ok(ids.has('dsh-plugin-yanyan-update'));
  assert.ok(ids.has('dsh-plugin-yanyan-subagent'));
  assert.ok(ids.has('session-archive'));
  assert.ok(ids.has('yanyan-toolkit-compat'));
  assert.ok(ids.has('dsh-plugin-yanyan-icon'));
});
