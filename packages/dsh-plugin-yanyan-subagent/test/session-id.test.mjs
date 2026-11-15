import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSessionId } from '../lib/index.js';

test('isSafeSessionId 拒绝危险字符（路径分隔符与父目录穿越）', () => {
  const bad = [
    'a/b', 'a\\b', '..', 'a/../b', '../etc', 'a..b', '/', '\\',
    '', 0, 123, null, undefined, {}, [], true,
  ];
  for (const v of bad) {
    assert.equal(isSafeSessionId(v), false, '应拒绝: ' + String(v));
  }
});

test('isSafeSessionId 接受安全 id（含单个点、连字符、下划线、中文）', () => {
  for (const v of ['agent-1', 'abc_123', 'a.b', '会话-1', 'A']) {
    assert.equal(isSafeSessionId(v), true, '应接受: ' + v);
  }
});
