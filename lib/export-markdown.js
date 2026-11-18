// dsh-plugin-yanyan-toolkit — 会话管理中心 · Markdown 批量导出（Phase 3）。
//
// 职责（纯函数 + 零外部依赖）：
//   1) 复用 search-index.js 的 extractMessages / listLogPaths 与
//      subagent 子包的 decodeLog（多帧 zstd 解码），不重复造轮子；
//   2) 把会话日志转成干净的 Markdown（标题 + 时间 + 角色 + 内容）；
//   3) 自带极简 store-mode ZIP 打包器（CRC32 + central directory），
//      不依赖 jszip/fflate（发布包不保证环境里有这些库）；
//   4) 全程只读原生会话文件，绝不修改（旁路纪律，与 Phase 1/2 一致）。
// 熔断：单会话解压上限、单文件 Markdown 上限、总导出上限、会话数上限，防 OOM。

import * as NODE_FS from 'node:fs';
import { decodeLog } from '../packages/dsh-plugin-yanyan-subagent/lib/zstd-frames.js';
import { extractMessages, listLogPaths } from './search-index.js';

export const EXPORT_DEFAULTS = Object.freeze({
  maxCompressedBytes: 10 * 1024 * 1024,        // 单个 zstd 压缩文件上限（与 search-index 一致）
  maxDecodedCharsPerSession: 8 * 1024 * 1024,  // 单会话解压明文上限（字符）
  maxMarkdownBytesPerSession: 8 * 1024 * 1024,  // 单会话 Markdown 上限（字节）
  maxTotalBytes: 64 * 1024 * 1024,             // 单次导出 ZIP 总上限（字节，导出前累加）
  maxSessions: 200,                            // 单次「手动选中」导出会话数上限（防误选，exportAll 不受此限）
  unlimitedTotalBytes: 512 * 1024 * 1024,      // exportAll 全量导出的总量熔断（防 OOM，比手动上限宽松）
});

// ——————————————————————————— ZIP 打包器（store mode，无压缩）———————————————————————————

let CRC_TABLE = null;
function getCrcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

/** 标准 CRC-32（IEEE 802.3，多项式 0xEDB88320）。 */
export function crc32(buf) {
  const table = getCrcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

/**
 * 把 [{name, data}] 打成 store-mode ZIP Buffer。
 * 文件名用 UTF-8（general purpose flag 0x0800），中文名可正常显示。
 */
export function makeZip(files, options = {}) {
  const dt = dosDateTime(options.date instanceof Date ? options.date : new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(String(file.name || 'file'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf8');
    const crc = crc32(data);

    // Local file header（30 字节固定头 + 文件名）
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flag: UTF-8 filename
    local.writeUInt16LE(0, 8);             // compression: store
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);  // compressed size
    local.writeUInt32LE(data.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    locals.push(local, nameBuf, data);

    // Central directory file header（46 字节固定头 + 文件名）
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);  // signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0x0800, 8);       // flag
    central.writeUInt16LE(0, 10);           // compression: store
    central.writeUInt16LE(dt.time, 12);
    central.writeUInt16LE(dt.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);           // extra length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);           // disk number start
    central.writeUInt16LE(0, 36);           // internal attrs
    central.writeUInt32LE(0, 38);           // external attrs
    central.writeUInt32LE(offset, 42);      // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);        // signature
  end.writeUInt16LE(0, 4);                  // this disk
  end.writeUInt16LE(0, 6);                  // disk with central dir
  end.writeUInt16LE(files.length, 8);       // entries on this disk
  end.writeUInt16LE(files.length, 10);      // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);            // central dir offset
  end.writeUInt16LE(0, 20);                 // comment length

  return Buffer.concat([...locals, ...centrals, end]);
}

// ——————————————————————————— Markdown 渲染 ———————————————————————————

/** 毫秒时间戳 → 'YYYY-MM-DD HH:mm:ss'（本地时区）。 */
export function formatTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return '未知时间';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function safeName(s, fallback) {
  const t = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return (t || fallback || 'session').slice(0, 80);
}

function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 从日志取标题：session/title 事件 → 首条用户消息前 40 字 → sessionId。 */
function titleFromLog(sessionId, raw, messages) {
  try {
    const lines = String(raw || '').split('\n');
    for (const line of lines) {
      if (!line || line.indexOf('session/title') < 0) continue;
      const ev = JSON.parse(line);
      if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
        return ev.data.title.trim();
      }
    }
  } catch { /* 回退 */ }
  const first = messages.find((m) => m.role === 'user');
  if (first) {
    const t = first.text.replace(/\s+/g, ' ').trim();
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }
  return sessionId;
}

/** 消息数组 → 干净 Markdown 文本（时间 / 角色 / 内容）。 */
export function messagesToMarkdown(sessionId, title, messages, options = {}) {
  const ts = options.exportedAt instanceof Date ? options.exportedAt : new Date();
  const lines = [];
  lines.push(`# ${title || sessionId}`);
  lines.push('');
  lines.push(`> 会话 ID：\`${sessionId}\``);
  lines.push(`> 导出时间：${formatTime(ts.getTime())}`);
  lines.push(`> 消息数：${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of messages) {
    const role = m.role === 'user' ? '用户' : '助手';
    lines.push(`## [${formatTime(m.time)}] ${role}`);
    lines.push('');
    lines.push(m.text);
    lines.push('');
  }
  let out = lines.join('\n');
  const max = options.maxBytes || EXPORT_DEFAULTS.maxMarkdownBytesPerSession;
  if (Buffer.byteLength(out, 'utf8') > max) {
    out = out.slice(0, Math.floor(max / 3)) + '\n\n> 内容过长，已截断。\n';
  }
  return out;
}

// ——————————————————————————— 导出器 ———————————————————————————

/**
 * 创建导出器。options: { dshHome, fs, store, decodeLog, config }
 *   - store 可选：用于读取 customTitle 覆盖日志标题；
 *   - fs / decodeLog 可注入以便单测。
 * 返回 { exportSessions(ids, opts), exportAll(opts) }，结果为
 *   { ok, filename, base64, bytes, files, failed }（base64 为 ZIP 内容）。
 */
export function createExporter(options = {}) {
  const cfg = { ...EXPORT_DEFAULTS, ...(options.config || {}) };
  const fs = options.fs || NODE_FS;
  const dshHome = options.dshHome;
  const decode = options.decodeLog || decodeLog;
  const store = options.store;

  function metaOf(sessionId) {
    try {
      const snap = store && typeof store.snapshot === 'function' ? store.snapshot() : null;
      const m = snap && snap.sessions ? snap.sessions[sessionId] : null;
      return m || null;
    } catch {
      return null;
    }
  }

  function exportSessions(ids, opts = {}) {
    const wanted = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x);
    if (wanted.length === 0) return { ok: false, error: 'empty', message: '未选择会话' };
    const unlimited = opts.unlimited === true;
    if (!unlimited && wanted.length > cfg.maxSessions) {
      return { ok: false, error: 'too_many', message: `单次最多导出 ${cfg.maxSessions} 个会话` };
    }
    const totalLimit = unlimited ? cfg.unlimitedTotalBytes : cfg.maxTotalBytes;

    const entries = listLogPaths(dshHome, fs);
    const byId = new Map(entries.map((e) => [e.sessionId, e]));
    const exportedAt = opts.exportedAt instanceof Date ? opts.exportedAt : new Date();
    const files = [];
    const failed = [];
    let totalBytes = 0;

    for (const id of wanted) {
      const entry = byId.get(id);
      if (!entry) { failed.push({ id, reason: '未找到会话日志' }); continue; }
      try {
        const st = fs.statSync(entry.logPath);
        if (st.size > cfg.maxCompressedBytes) { failed.push({ id, reason: '日志文件过大，已跳过' }); continue; }
        const buf = fs.readFileSync(entry.logPath);
        const decoded = decode(buf);
        const raw = decoded.length > cfg.maxDecodedCharsPerSession
          ? decoded.slice(0, cfg.maxDecodedCharsPerSession)
          : decoded;
        const messages = extractMessages(raw);
        if (messages.length === 0) { failed.push({ id, reason: '无可导出的消息' }); continue; }

        let title = titleFromLog(id, raw, messages);
        const meta = metaOf(id);
        if (meta && typeof meta.customTitle === 'string' && meta.customTitle.trim()) {
          title = meta.customTitle.trim();
        }
        const md = messagesToMarkdown(id, title, messages, {
          maxBytes: cfg.maxMarkdownBytesPerSession,
          exportedAt,
        });
        const mdBytes = Buffer.byteLength(md, 'utf8');
        if (totalBytes + mdBytes > totalLimit) {
          failed.push({ id, reason: '超出单次导出总量上限，请分批导出' });
          continue;
        }
        totalBytes += mdBytes;
        const name = `${safeName(title, 'session')}-${safeName(id.slice(0, 8), 'id')}.md`;
        files.push({ name, data: Buffer.from(md, 'utf8') });
      } catch (e) {
        failed.push({ id, reason: `导出失败：${String((e && e.message) || e)}` });
      }
    }

    if (files.length === 0) {
      return { ok: false, error: 'no_exportable', message: '没有可导出的会话', failed };
    }
    const zip = makeZip(files, { date: exportedAt });
    return {
      ok: true,
      filename: `${safeName(opts.filename || '会话导出', 'sessions')}-${stamp(exportedAt)}.zip`,
      base64: zip.toString('base64'),
      bytes: zip.length,
      files: files.map((f) => ({ name: f.name, size: f.data.length })),
      failed,
    };
  }

  function exportAll(opts = {}) {
    const entries = listLogPaths(dshHome, fs);
    // 全量导出不受 200 会话数上限约束，但保留 512MB 总量熔断防 OOM。
    return exportSessions(entries.map((e) => e.sessionId), Object.assign({}, opts, { unlimited: true }));
  }

  return { exportSessions, exportAll };
}

export default createExporter;
