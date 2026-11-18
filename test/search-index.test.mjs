// Phase 2 全文搜索索引测试：隔离目录 decodeLog→索引、误命中防护、增量更新、熔断、进度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  createSearchIndex,
  tokenize,
  extractMessages,
  listLogPaths,
  SEARCH_DEFAULTS,
} from '../lib/search-index.js';

function makeDshHome() {
  const root = mkdtempSync(join(tmpdir(), 'ysh-search-'));
  mkdirSync(join(root, 'sessions'), { recursive: true });
  return root;
}

// 造一条多帧 zstd 日志（header 帧 + 内容帧），模拟 DSH 真实多帧格式。
function writeLog(home, slug, seg, events) {
  const dir = join(home, 'sessions', slug, seg);
  mkdirSync(dir, { recursive: true });
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  // 用多帧：第一帧是 header（独立 JSON 行），第二帧是内容
  const header = zstdCompressSync(JSON.stringify({ type: 'header', version: 4 }) + '\n');
  const body = zstdCompressSync(jsonl);
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([header, body]));
  return join(dir, 'session.v4.jsonl.zstd');
}

function evUser(text) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }] } };
}
function evAssistant(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } };
}
function evTitle(title) {
  return { type: 'session/title', data: { title } };
}

// 真实 decodeLog（复用现成轮子）
import { decodeLog } from '../packages/dsh-plugin-yanyan-subagent/lib/zstd-frames.js';

test('tokenize：中文单字+2-gram、英文整词（无 3-gram）', () => {
  const t = tokenize('会话管理 OIDC');
  assert.ok(t.has('会'));
  assert.ok(t.has('会话'));
  assert.ok(t.has('oidc'));
  assert.ok(!Array.from(t).some((x) => /^[a-z]{3}$/.test(x)), '英文不应切 3-gram');
});

test('extractMessages：只取 text 段，跳过 reasoning/tool-call', () => {
  const decoded = [
    JSON.stringify(evTitle('测试标题')),
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '用户说的话' }] } }),
    JSON.stringify({ type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '内部思考' },
      { type: 'text', text: '助手回答' },
      { type: 'tool-call', name: 'x' },
    ] } } }),
  ].join('\n');
  const msgs = extractMessages(decoded);
  assert.ok(msgs.some((m) => m.text.includes('用户说的话')));
  assert.ok(msgs.some((m) => m.text.includes('助手回答')));
  assert.ok(!msgs.some((m) => m.text.includes('内部思考')), 'reasoning 不应入索引');
});

test('listLogPaths：定位多层级 session.v4.jsonl.zstd', () => {
  const home = makeDshHome();
  const p = writeLog(home, 'proj', 'seg1', [evUser('hello')]);
  const paths = listLogPaths(home);
  assert.ok(paths.some((x) => x.logPath === p && x.sessionId === 'seg1'));
});

test('rebuild：索引真实内容 + 中文/英文搜索 + 匹配片段', async () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 's1', [
    evTitle('OIDC 发布记录'),
    evUser('我们用 OIDC 走 GitHub Actions 发布了 1.4.2'),
    evAssistant('会话管理中心支持全文搜索能力'),
  ]);
  writeLog(home, 'proj', 's2', [evUser('这是另一个完全无关的会话')]);
  const idx = createSearchIndex({ dshHome: home, decodeLog });
  await idx.rebuild();
  assert.equal(idx.status().sessions, 2);

  const r1 = idx.search('OIDC');
  assert.equal(r1.total, 1);
  assert.equal(r1.hits[0].sessionId, 's1');
  assert.ok(r1.hits[0].snippets.length > 0);

  const r2 = idx.search('全文搜索');
  assert.equal(r2.total, 1);
  assert.equal(r2.hits[0].sessionId, 's1');
  idx.stop();
});

test('误命中防护：不存在的英文词不召回', async () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 's1', [evUser('正常内容')]);
  const idx = createSearchIndex({ dshHome: home, decodeLog });
  await idx.rebuild();
  assert.equal(idx.search('nonexistent_xyz_qwerty').total, 0);
  idx.stop();
});

test('增量更新：updateSession 替换旧文档，删除旧词', async () => {
  const home = makeDshHome();
  const p = writeLog(home, 'proj', 's1', [evUser('苹果香蕉')]);
  const idx = createSearchIndex({ dshHome: home, decodeLog });
  await idx.rebuild();
  assert.equal(idx.search('苹果').total, 1);
  // 改写同一文件
  writeLog(home, 'proj', 's1', [evUser('橘子葡萄')]);
  await idx.updateSession(p);
  assert.equal(idx.search('苹果').total, 0, '旧词应被移除');
  assert.equal(idx.search('橘子').total, 1, '新词应被索引');
  idx.stop();
});

test('熔断：超过 maxCompressedBytes 的大文件跳过', async () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 'big', [evUser('超大内容不应该被索引')]);
  // 人为撑大文件
  const p = join(home, 'sessions', 'proj', 'big', 'session.v4.jsonl.zstd');
  writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.alloc(SEARCH_DEFAULTS.maxCompressedBytes + 10, 0x61)]));
  const idx = createSearchIndex({ dshHome: home, decodeLog });
  await idx.rebuild();
  // 超大会话不解压内容（skipped≥1），但仍登记一条 oversize 空文档用于管理清单计数/归档/删除。
  assert.ok(idx.status().skipped >= 1);
  assert.equal(idx.listSessions().length, 1);
  assert.equal(idx.listSessions()[0].oversize, true);
  assert.equal(idx.listSessions()[0].empty, true);
  idx.stop();
});

test('前缀搜索：短词命中标题（mn → Mnemon...），且正文不误命中', async () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 's1', [evTitle('Mnemon skill review'), evUser('讨论 Mnemon 技能')]);
  writeLog(home, 'proj', 's2', [evTitle('Mnemon skill judge'), evUser('mn 判断')]);
  writeLog(home, 'proj', 's3', [evTitle('其他话题'), evUser('无关内容')]);
  const idx = createSearchIndex({ dshHome: home, decodeLog });
  await idx.rebuild();
  const r = idx.search('mn', { limit: 20 });
  assert.equal(r.total, 2, 'mn 前缀应命中 2 个 Mnemon 会话');
  assert.ok(r.hits.every((h) => h.title.toLowerCase().startsWith('mnemon')));
  assert.ok(r.hits[0].snippets.length > 0, '标题命中应有片段');
  assert.ok(r.hits[0].snippets[0].ranges.length > 0, '片段应有高亮区间');
  idx.stop();
});

test('进度回调：rebuild 报告 scanned', async () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 's1', [evUser('进度')]);
  let reported = false;
  const idx = createSearchIndex({ dshHome: home, decodeLog, onProgress: (s) => { if (s.scanned > 0) reported = true; } });
  await idx.rebuild();
  assert.ok(reported, '应报告扫描进度');
  idx.stop();
});

test('空会话：无文本消息的会话也进 listSessions，带 empty 标记但不污染全文搜索', async () => {
  const home = makeDshHome();
  // s-empty 只有 header，无 user/assistant 文本
  writeLog(home, 'proj', 's-empty', []);
  // s-live 有正常内容
  writeLog(home, 'proj', 's-live', [evUser('有内容的会话')]);
  const idx = createSearchIndex({ dshHome: home, decodeLog });
  await idx.rebuild();

  const sessions = idx.listSessions();
  assert.equal(sessions.length, 2, '空会话和有内容会话都应进清单');
  const empty = sessions.find((s) => s.id === 's-empty');
  assert.ok(empty, '空会话应在清单里');
  assert.equal(empty.empty, true, '空会话应带 empty 标记');
  const live = sessions.find((s) => s.id === 's-live');
  assert.ok(live && live.empty !== true, '有内容会话不应是 empty');

  // 空会话不应出现在普通全文搜索结果里（它的 token 只有自身 id）
  assert.equal(idx.search('有内容的会话').total, 1);
  idx.stop();
});
