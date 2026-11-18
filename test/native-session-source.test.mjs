// 原生会话数据源测试：归档事实源降级 / 归档时间台账 / 状态标签映射。
// 全部 fail-closed，只读，不碰真实文件系统（内存 fs 注入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readArchivedIds, readArchiveLedger, statusLabels, readSessionIndexIds } from '../lib/native-session-source.js';

function memFs(files = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p)
      || Object.keys(files).some((f) => f.startsWith(p + '/') || f.startsWith(p + '\\')),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT ' + p);
      return files[p];
    },
    readdirSync: (p) => {
      const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
      const prefix = norm(p) + '/';
      const names = new Set();
      for (const f of Object.keys(files)) {
        const nf = norm(f);
        if (nf.startsWith(prefix)) {
          const rest = nf.slice(prefix.length);
          if (rest && !rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

test('readArchivedIds 优先用内存 registry.archivedSessionIds', () => {
  const fs = memFs({
    [join('/home', 'storages', 'workspace.json')]: JSON.stringify({ global: { archivedSessionIds: ['session-from-file'] } }),
  });
  const res = readArchivedIds(fs, '/home', { archivedSessionIds: ['session-a', 'session-b'] });
  assert.equal(res.source, 'registry');
  assert.deepEqual([...res.ids].sort(), ['session-a', 'session-b']);
});

test('readArchivedIds 无 registry 时降级读 workspace.json', () => {
  const fs = memFs({
    [join('/home', 'storages', 'workspace.json')]: JSON.stringify({ global: { archivedSessionIds: ['session-from-file', 42, null] } }),
  });
  const res = readArchivedIds(fs, '/home', null);
  assert.equal(res.source, 'workspace');
  assert.deepEqual([...res.ids], ['session-from-file']);
});

test('readArchivedIds 全都读不到时返回空集合（fail-closed）', () => {
  const res = readArchivedIds(memFs({}), '/home', null);
  assert.equal(res.source, 'none');
  assert.equal(res.ids.size, 0);
});

test('readArchiveLedger 读 entries[id].archivedAt（epoch ms）+ source', () => {
  const fs = memFs({
    [join('/home', 'dsh-session-archive', 'archive-ledger.json')]: JSON.stringify({
      version: 1,
      entries: {
        'session-a': { archivedAt: 1794716215920, source: 'manual' },
        'session-b': { archivedAt: 1794716215999, source: 'observed' },
        'session-bad': { archivedAt: 'not-a-number' },
      },
    }),
  });
  const m = readArchiveLedger(fs, '/home');
  assert.equal(m.get('session-a').archivedAt, 1794716215920);
  assert.equal(m.get('session-a').source, 'manual');
  assert.equal(m.get('session-b').source, 'observed');
  assert.equal(m.has('session-bad'), false);
});

test('readArchiveLedger 文件损坏时返回空 Map（fail-closed）', () => {
  const fs = memFs({ [join('/home', 'dsh-session-archive', 'archive-ledger.json')]: '{bad json' });
  assert.equal(readArchiveLedger(fs, '/home').size, 0);
});

test('statusLabels 按 running/blank/archived/origin 映射，缺省为「空闲」', () => {
  assert.deepEqual(statusLabels({ archived: true }), ['已归档']);
  assert.deepEqual(statusLabels({ running: true }), ['进行中']);
  assert.deepEqual(statusLabels({ blank: true }), ['空白']);
  assert.deepEqual(statusLabels({ origin: 'subagent' }), ['子会话']);
  assert.deepEqual(statusLabels({ archived: true, running: true, origin: 'subagent' }), ['已归档', '进行中', '子会话']);
  assert.deepEqual(statusLabels({}), ['空闲']);
  assert.deepEqual(statusLabels(null), []);
});

test('readSessionIndexIds 读取原生标题 rows.title.val / titleInput 回退 / blank 标志', () => {
  const proj = join('/home', 'storages', 'session_projcache', 'sessions');
  const fs = memFs({
    [join(proj, 'session-a.json')]: JSON.stringify({
      version: 7,
      record: {
        identity: { createdAt: 1794996907221, cwd: '/work/a' },
        rows: {
          title: { ver: 1, seq: 210, val: '会话显示实时更新修复' },
          sessionListMetadata: { ver: 1, seq: 210, val: { blank: false, lastPromptAt: 1 } },
        },
      },
    }),
    [join(proj, 'session-b.json')]: JSON.stringify({
      version: 7,
      record: {
        identity: { createdAt: 1794996907222, cwd: '/work/b' },
        rows: {
          titleInput: { ver: 1, seq: 16, val: { first: { seq: 16, text: '首次输入的标题' }, count: 1 } },
          sessionListMetadata: { ver: 1, seq: 1, val: { blank: true } },
        },
      },
    }),
    [join(proj, 'session-c.json')]: JSON.stringify({
      version: 7,
      record: { identity: { createdAt: 1 }, rows: {} },
    }),
    [join(proj, 'broken.json')]: '{bad json',
  });
  const m = readSessionIndexIds(fs, '/home');
  assert.equal(m.get('session-a').title, '会话显示实时更新修复');
  assert.equal(m.get('session-a').blank, false);
  assert.equal(m.get('session-a').createdAt, 1794996907221);
  assert.equal(m.get('session-a').cwd, '/work/a');
  assert.equal(m.get('session-b').title, '首次输入的标题');
  assert.equal(m.get('session-b').blank, true);
  assert.equal(m.get('session-c').title, null);
  assert.equal(m.get('session-c').blank, null);
  assert.equal(m.has('broken'), true); // 损坏文件仍登记条目，只是字段为 null
  assert.equal(m.get('broken').title, null);
});

test('readSessionIndexIds 目录不存在时返回空 Map（fail-closed）', () => {
  assert.equal(readSessionIndexIds(memFs({}), '/home').size, 0);
});
