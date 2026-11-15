// dsh-plugin-yanyan-subagent / lib/zstd-frames.js
//
// 逐帧解码 / 重编码 DSH 的 `session.v4.jsonl.zstd` 会话日志。
//
// 移植自 huajiao1998/dsh-plugin-subagent-clean@0.3.0 的 src/zstd-frames.js，
// 原始实现来自 heiheiha798/dsh-plugin-subagent-delete@0.2.3（MIT）。
// 版权所有 (c) heiheiha798；本文件及其在 dsh-plugin-yanyan-subagent 内的
// 派生改动同样以 MIT 许可发布。详见本包 README 的「许可与致谢」章节。
//
// 为什么需要自己扫帧：DSH 把会话日志按「header 单独一帧、其后每批事件
// 一帧」写成一串独立可解码的 Zstandard 帧，`zstdDecompressSync` 只解第一帧，
// 必须先按 zstd 帧格式逐帧切开再分别解压、拼接。

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;
const SKIP_MASK = 0xfffffff0;
const SKIP_MAGIC = 0x184d2a50;
const NL = String.fromCharCode(10);

/** 枚举一份 artifact 里所有可独立解码的 Zstandard 帧。 */
export function scanZstdFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const magic = buf.readUInt32LE(pos);
    // skippable frame（0x184D2A50..0x184D2A5F）：8 字节头 + size 字节载荷。
    if ((magic & SKIP_MASK) === SKIP_MAGIC) {
      if (pos + 8 > buf.length) break;
      const size = buf.readUInt32LE(pos + 4);
      frames.push({ start: pos, end: pos + 8 + size });
      pos += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) break;
    const start = pos;
    let p = pos + 4;
    const fhd = buf[p];
    p += 1;
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const hasChecksum = (fhd >> 2) & 1;
    const dictIdFlag = fhd & 3;
    if (!singleSegment) p += 1;
    p += [0, 1, 2, 4][dictIdFlag];
    p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];
    for (;;) {
      if (p + 3 > buf.length) return frames;
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      p += 3 + (type === 1 ? 1 : size);
      if (last) break;
    }
    if (hasChecksum) p += 4;
    frames.push({ start, end: p });
    pos = p;
  }
  return frames;
}

/** 解压全部帧并把明文拼回去。 */
export function decodeLog(buf) {
  const frames = scanZstdFrames(buf);
  const parts = frames.map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)));
  return Buffer.concat(parts).toString('utf8');
}

/**
 * 按 DSH 存储层的写法重新编码：header 独占第一帧（加载器对此有断言），
 * 其后每个事件批压一帧。
 */
export function encodeLog(headerLine, eventLines, perFrame = 400) {
  const frames = [zstdCompressSync(Buffer.from(headerLine + NL))];
  for (let i = 0; i < eventLines.length; i += perFrame) {
    const chunk = eventLines.slice(i, i + perFrame).join(NL) + NL;
    frames.push(zstdCompressSync(Buffer.from(chunk)));
  }
  return Buffer.concat(frames);
}
