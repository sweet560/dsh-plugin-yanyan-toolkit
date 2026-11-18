// Phase 3 Markdown 批量导出测试：CRC32、ZIP 结构、Markdown 渲染、导出器（含熔断/自定义标题/failed）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  EXPORT_DEFAULTS,
  crc32,
  makeZip,
  formatTime,
  messagesToMarkdown,
  createExporter,
} from '../lib/export-markdown.js';
import { decodeLog } from '../packages/dsh-plugin-yanyan-subagent/lib/zstd-frames.js';

function makeDshHome() {
  const root = mkdtempSync(join(tmpdir(), 'ysh-export-'));
  mkdirSync(join(root, 'sessions'), { recursive: true });
  return root;
}

function writeLog(home, slug, seg, events) {
  const dir = join(home, 'sessions', slug, seg);
  mkdirSync(dir, { recursive: true });
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const header = zstdCompressSync(JSON.stringify({ type: 'header', version: 4 }) + '\n');
  const body = zstdCompressSync(jsonl);
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([header, body]));
  return join(dir, 'session.v4.jsonl.zstd');
}

function evUser(text, time) {
  return { type: 'user/message', time, data: { content: [{ type: 'text', text }] } };
}
function evAssistant(text, time) {
  return { type: 'assistant/message', time, data: { message: { content: [
    { type: 'reasoning', text: '内部思考' },
    { type: 'text', text },
  ] } } };
}
function evTitle(title) {
  return { type: 'session/title', data: { title } };
}

// 从 store-mode ZIP 中按文件名取回内容（用签名/偏移手工定位，零依赖）。
function readZipEntry(zip, name) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, '应有 EOCD');
  const count = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50, 'central dir 签名');
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const compSize = zip.readUInt32LE(p + 20);
    if (entryName === name) {
      assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, 'local 签名');
      const lnLen = zip.readUInt16LE(localOffset + 26);
      const lxLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lnLen + lxLen;
      return zip.subarray(start, start + compSize).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

test('CRC32 标准向量：123456789 → cbf43926', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
});

test('makeZip：可定位 local/central/EOCD，中文名正确', () => {
  const zip = makeZip([
    { name: '会话.md', data: '# 标题' },
    { name: 'a.txt', data: 'hello' },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(zip.readUInt16LE(eocd + 10), 2);
  assert.equal(readZipEntry(zip, '会话.md'), '# 标题');
  assert.equal(readZipEntry(zip, 'a.txt'), 'hello');
});

test('formatTime：时间戳转本地格式', () => {
  assert.match(formatTime(1731000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatTime(0), '未知时间');
});

test('messagesToMarkdown：标题/时间/角色/内容齐全，跳过 reasoning', () => {
  const msgs = [
    { role: 'user', text: '用户问题', time: 1731000000000 },
    { role: 'assistant', text: '助手回答', time: 1731000001000 },
  ];
  const md = messagesToMarkdown('sid', '测试会话', msgs);
  assert.match(md, /^# 测试会话/);
  assert.match(md, /会话 ID：`sid`/);
  assert.match(md, /## \[.*\] 用户/);
  assert.match(md, /## \[.*\] 助手/);
  assert.ok(md.includes('用户问题') && md.includes('助手回答'));
});

test('createExporter.exportSessions：真实 decodeLog → Markdown → ZIP（成功路径）', () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 'sess-A', [
    evTitle('Alpha 会话'),
    evUser('第一句话', 1731000000000),
    evAssistant('回复内容', 1731000001000),
  ]);
  const exporter = createExporter({ dshHome: home, decodeLog });
  const r = exporter.exportSessions(['sess-A']);
  assert.equal(r.ok, true);
  assert.match(r.filename, /\.zip$/);
  assert.equal(r.files.length, 1);
  assert.equal(r.failed.length, 0);
  const zip = Buffer.from(r.base64, 'base64');
  assert.equal(zip.length, r.bytes);
  const md = readZipEntry(zip, r.files[0].name);
  assert.ok(md.includes('# Alpha 会话'));
  assert.ok(md.includes('第一句话') && md.includes('回复内容'));
  assert.ok(!md.includes('内部思考'));
});

test('exportSessions：多个会话 + 自定义标题覆盖 + 未找到计入 failed', () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 's1', [evTitle('原标题'), evUser('内容一')]);
  writeLog(home, 'proj', 's2', [evTitle('第二标题'), evUser('内容二')]);
  const store = { snapshot: () => ({ sessions: { s1: { customTitle: '自定义标题' } } }) };
  const exporter = createExporter({ dshHome: home, decodeLog, store });
  const r = exporter.exportSessions(['s1', 's2', 'missing']);
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 2);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, 'missing');
  const zip = Buffer.from(r.base64, 'base64');
  const customMd = readZipEntry(zip, r.files.find((f) => f.name.includes('自定义')).name);
  assert.ok(customMd.includes('# 自定义标题'), 'customTitle 应覆盖日志标题');
});

test('exportSessions：空选择 / 超限会话数 fail-closed', () => {
  const exporter = createExporter({ dshHome: makeDshHome(), decodeLog });
  assert.equal(exporter.exportSessions([]).ok, false);
  const many = Array.from({ length: EXPORT_DEFAULTS.maxSessions + 1 }, (_, i) => `s${i}`);
  const r = exporter.exportSessions(many);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_many');
});

test('exportSessions：unlimited 跳过 200 上限（exportAll 全量导出用）', () => {
  const exporter = createExporter({ dshHome: makeDshHome(), decodeLog });
  const many = Array.from({ length: EXPORT_DEFAULTS.maxSessions + 1 }, (_, i) => `s${i}`);
  // unlimited=true 不再因数量返回 too_many；因日志不存在会走到 no_exportable。
  const r = exporter.exportSessions(many, { unlimited: true });
  assert.notEqual(r.error, 'too_many');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_exportable');
});

test('exportSessions：超大文件熔断跳过，计入 failed', () => {
  const home = makeDshHome();
  const path = writeLog(home, 'proj', 'big', [evUser('内容')]);
  // 覆写成超大文件（>maxCompressedBytes），decodeLog 不应被调用到成功
  writeFileSync(path, Buffer.alloc(EXPORT_DEFAULTS.maxCompressedBytes + 10));
  const exporter = createExporter({ dshHome: home, decodeLog });
  const r = exporter.exportSessions(['big']);
  assert.equal(r.ok, false);
  assert.equal(r.failed[0].reason.includes('过大'), true);
});

test('exportAll：扫描全部会话导出', () => {
  const home = makeDshHome();
  writeLog(home, 'proj', 'a', [evUser('A内容')]);
  writeLog(home, 'proj', 'b', [evUser('B内容')]);
  const exporter = createExporter({ dshHome: home, decodeLog });
  const r = exporter.exportAll();
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 2);
});
