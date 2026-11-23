// 第三方包彻底剔除契约校验（1.4.13 起）。
// @linxin666/dsh-session-archive 已完全移除，会话管理能力全部由自研
// dsh-plugin-yanyan-session-hub 承担。本文件反向钉死"不得再回归依赖"，
// 防止未来误把外部归档包的 loader 行 / 依赖 / 版本解析加回来。
// 不联网、不依赖第三方 YAML 库。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_NAME = '@linxin666/dsh-session-archive';

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

test('根 package.json 不再声明 dsh-session-archive 依赖/keyword', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!Object.prototype.hasOwnProperty.call(pkg.dependencies, REAL_NAME));
  assert.ok(!(pkg.keywords || []).includes('session-archive'));
});

test('cordis.patch.yml 不再挂载 dsh-session-archive，也无 name 级防重守卫', () => {
  const text = read('cordis.patch.yml');
  // 注释里说明「已彻底剔除第三方包」是合理的历史记录；只在实际 loader 行（非注释）上校验。
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!code.includes(REAL_NAME), 'loader 行不得残留');
  assert.ok(!code.includes('id: session-archive'), 'id: session-archive 行不得残留');
  assert.ok(!/disabled:\s*!!js/.test(code), 'name 级防重守卫应随该行一并删除');
});

test('host 版本收集不再解析/回退 dsh-session-archive', () => {
  const src = read('lib/index.js');
  assert.ok(!src.includes('createRequire'), '外部包解析用的 createRequire 应已移除');
  assert.ok(!/\bEXTERNAL_PKG\b/.test(src), '外部包版本解析常量应已移除');
  assert.ok(!/out\[['"]@linxin666/.test(src), '不得再向版本表写入外部包');
});
