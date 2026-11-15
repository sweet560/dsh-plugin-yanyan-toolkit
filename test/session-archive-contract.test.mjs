// 会话管理复用包（@linxin666/dsh-session-archive）契约校验。
// 该文件不联网，只校验本聚合包对它的挂载假设：
//   1. 四条 loader 行里存在 name 恰好等于真实包名的行；
//   2. 该行 id 与 npm 包自身 cordis.patch.yml 的 id 一致（避免同名不同 id 重复挂载）；
//   3. 根 package.json 声明了可升级的 ^ 版本范围；
//   4. 本地存在该包的权威 patch 副本用于比对（可选，缺失则跳过）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = dirname(root);
const REAL_NAME = '@linxin666/dsh-session-archive';

function patchRows(file) {
  const text = readFileSync(file, 'utf8');
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
    if (nameMatch && current) current.name = nameMatch[1];
  }
  return rows;
}

test('会话管理行 name 严格等于真实包名，且依赖声明可升级', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const rows = patchRows(join(root, 'cordis.patch.yml'));
  const row = rows.find((r) => r.name === REAL_NAME);
  assert.ok(row, `缺少 name 为 ${REAL_NAME} 的 loader 行`);
  assert.equal(pkg.dependencies[REAL_NAME], '^0.4.18');
  assert.ok(pkg.dependencies[REAL_NAME].startsWith('^'), '必须是可升级范围，才能被检查更新识别');
});

test('会话管理行 id 与真实包自身 patch 的 id 一致', () => {
  const ourRows = patchRows(join(root, 'cordis.patch.yml'));
  const ourRow = ourRows.find((r) => r.name === REAL_NAME);
  const upstream = join(workspace, 'dsh-web-0.4.16', 'packages', 'dsh-session-archive', 'cordis.patch.yml');
  if (!existsSync(upstream)) return; // 工作区无源码副本时跳过此项
  const upstreamRows = patchRows(upstream);
  const upstreamRow = upstreamRows.find((r) => r.name === REAL_NAME);
  assert.ok(upstreamRow, '真实包 patch 里找不到自身行');
  assert.equal(ourRow.id, upstreamRow.id, 'id 必须一致，否则同 name 不同 id 会重复挂载');
});

test('会话管理行带有 name 级防重守卫', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(/disabled:\s*!!js/.test(text), '应有 name 级防重守卫');
  assert.ok(text.includes("e.options.name === '@linxin666/dsh-session-archive'"));
});
