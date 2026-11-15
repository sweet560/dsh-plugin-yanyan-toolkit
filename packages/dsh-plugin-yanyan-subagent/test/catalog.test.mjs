import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog } from '../lib/index.js';

const a = { kind: 'child', id: 'agent-1', activity: 'inactive', mode: 'continuable' };
const b = { kind: 'child', id: 'agent-2', activity: 'running', mode: 'one-shot' };

test('parseCatalog 直接数组：原样保留合法行', () => {
  assert.deepEqual(parseCatalog([a, b]), [a, b]);
});

test('parseCatalog {entries:[]} 兼容解析', () => {
  assert.deepEqual(parseCatalog({ entries: [a, b] }), [a, b]);
});

test('parseCatalog {rows:[]} 兼容解析', () => {
  assert.deepEqual(parseCatalog({ rows: [b] }), [b]);
});

test('parseCatalog 空 / 非对象 / 含非法项时收敛成数组', () => {
  for (const raw of [null, undefined, 0, '', false, {}, { entries: 'x' }, { rows: 5 }]) {
    assert.deepEqual(parseCatalog(raw), []);
  }
  assert.deepEqual(parseCatalog([null, undefined, 1, 'x', [], a]), [a]);
});
