// dsh-plugin-yanyan-toolkit — 路径 A · 第 4a 阶段：树快照构建（Host 半）。
//
// 责任边界（承接第 3 阶段移交的「快照完整性真正责任」）：
//   第 3 阶段 cascade.js 的 detectDanglingChildIds 只能查「childIds 引用了 rows 外的 id」，
//   查不出「childIds 本身漏了子树代理」——那是自我参照、纯函数无法自证。本模块承担真正的
//   完整性责任：用独立于 rows 的对照源（回收站磁盘目录扫描）与 manifest 双向对账来构建快照，
//   任何不一致都 fail-closed 整批拒绝，绝不把不完整的 rows 喂给 cascade。
//
// 数据源选择（关键洞察）：
//   会话进回收站后从 feed / sessionPersistence.list() 消失（目录被 rename 出 sessionsRoot），
//   但 rename 保留目录内 session.v4.jsonl.zstd 文件的 header（含 origin / parentSession）。
//   核实①已验证 Node 26 内置 zlib.zstdDecompressSync 可读该 header。故本模块数据源 =
//   回收站目录内 session 文件 header；独立对照源 = manifest 条目 vs 磁盘目录扫描（二者互照，
//   都不依赖 rows 自身）。这是第 3 阶段诚实写明的第一道真正完整性防线。
//
// 设计原则：
//   - 纯数据构建 + 校验：不执行任何物理删除（由单测静态断言守护，rm/unlink/rmdir 零调用）。
//     物理删除仍全部委托 cascadePurge → session-purge.purge，本模块不碰。
//   - 权威 id 来自 header.id，不依赖目录段名（规避第 1 阶段「两种段名布局」命门）。
//   - 依赖注入：fs / decompress / readHeader / runningOf / protectedReasonOf / cascadeFn 都可替换，
//     便于离线单测；默认路径走真实 zstd 解压。
//   - fail-closed：三层校验（集合一致 / childIds 无悬挂 / origin 合法）任一失败整批拒绝。
//     但「单条目损坏」（解压失败 / header 字段缺失 / 版本不匹配）只隔离该条目、不阻塞整批，
//     与第 1 阶段 quarantined 粒度一致：结构性失败整批拒，单条目损坏局部隔离。
//
// 前置结论修订（核实推翻第 1 阶段旧结论，本阶段同步）：
//   - 广播不再是「空操作」：宿主原生 emit api-session/removed（payload = session.id 字符串，
//     dsh-api-session-controller/lib/index.js:3926）、api-session/added（payload = summary，:3923/:3929）。
//     本模块 emitRemoved/emitAdded 传的也是 canonical id 字符串，与原生 removed 的 payload schema 对齐（P1-4 核实）。
//   - restore 不再 partial 降级：宿主已提供 workspaceRegistry.unarchiveSession（核实⑥）。
//
// 运行时兼容性（P0/P2 评审核实，2026-11-16）：
//   - P0-1：zstd 在 Node 22.15.0 引入（Stability 2 Stable），实测 Node 22.19.0 无标志即可
//     zstdDecompressSync 解压真实 session.v4.jsonl.zstd（含 header.id/origin/parentSession/version）。
//     engines 下界 ^22.19.0 安全，无需收紧或 fallback；Node 24/26 线 API 一致（均 Stable）。
//   - P0-2：权威 id = canonicalSessionId(header.id)。真实 header.id 已是 session-<uuid> 形式。
//     manifest 键（moveOneToTrash 写 check.id=canonical）、buildRows id、reconcile 对账键三者
//     都经 canonicalSessionId 归一，恒等；目录段名由 trashTargetFor 取 locate 实际 basename
//     并断言 canonical(段名)==canonical(rawId)。三条路径对齐，1.1 命门未被绕过。
//     【第六轮确认】canonicalSessionId 是本模块自实现（session-trash.js:68-70），但与现成包
//     @linxin666/dsh-session-archive/src/host/session-files.ts:20-22 逐字节一致；外部锚点 =
//     P0-1 实测真实 DSH 目录（段名=header.id=session-<uuid>，逐字节一致），非凭空自证。
//     【第七轮确认·1.1 命门最后一道闸】canonical 只用于「比较/查找/校验」，绝不参与「路径构造」：
//     moveOneToTrash 写 manifest 的路径字段用 check.dirPath/check.target（locate 实际段名，session-trash.js:485-486），
//     entry.id 才是 canonical（:484，仅作键）；restore 拼回路径用 sourceSafe.segment=basename(locate 结果)
//     （:620/:661，原始未归一段名），canonical 只在 :611 查找、:645 校验；trashTargetFor 用实际 basename
//     （:403/:409）。故无前缀布局下 'abc' 全程保持 'abc'，不会被改写成 'session-abc'。新增 move→restore
//     往返测试（无前缀段名）钉死此行为。
//   - P0-3：当前 readFile + zstdDecompressSync 全解（zstd 单帧无法流式只解首行）。
//     性能边界：真实会话文件压缩态约几百字节、解压约数百字节，量级极小；默认 maxDecompressedBytes
//     = 8 MiB 内存保护（解压「后」字节上限），超限条目按单条目损坏隔离（不阻塞整批）——
//     超高压缩比会话（压缩态小但解压超 8 MiB）会被隔离为 corrupt。超大文件场景 4b 前评估。
//   - P2-1：依赖 session header v4 schema；header.version 存在且 !==4 的条目按单条目损坏隔离。
//     【第七轮核实】当前 DSH 硬性要求 session header version===4（dsh-session/lib/index.js:1089），
//     v3 及更早的 session header 根本不会被 DSH 接受/读到。评审担心的「v3」实为 subagent descriptor
//     版本（SUBAGENT_DESCRIPTOR_VERSION=3，与 session header 无关，且 descriptor 不含父子字段——
//     父子关系只在 header.parentSession/origin）。故本模块对 header 缺失 origin/parentSession 的
//     宽容处理（originOf 返回 undefined → 视普通会话）只针对异常/手工 header，不是真实 v3 兼容路径。
//   - P1-3：running/hostProtectedReason 读不到时 fail-safe 视为「受保护」（hostProtectedReason='read-error'），
//     与第 3 阶段 ?? Infinity 纪律一致，绝不把读不到的会话当非运行而误删。
//
// 数据流与下游消费（第六轮确认）：
//   - reconcile 是 buildSnapshot 的内部对账步骤（buildSnapshot:306 消费其输出，传 knownDiskIds
//     隔离 corrupt 目录），结构性失败判定建立在 reconcile 的 mismatch 分类上；它不是需要
//     4b 单独调用的独立诊断接口——调用方只需 cascadePurgeFromTrash/buildSnapshot。
//   - corrupt 清单已接入 cascade：corrupt 条目不进 rows → cascade 天然跳过；显式删 corrupt
//     条目在 buildSnapshot:311-315 返回 corrupt-target fail-closed。单条目隔离真实生效。
//   - 广播 payload schema：宿主 api-session/removed 的 session.id 本身即 session-<uuid>
//     canonical 形式（真机实锤），本模块 emitRemoved(check.id) 同为 canonical id，schema 与值都对齐。

import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import {
  readManifest,
  MANIFEST_NAME,
  canonicalSessionId,
  isValidSessionSegment,
  isInside,
  isTwoLevelUnder,
} from './session-trash.js';
import {
  cascadePurge,
  detectDanglingChildIds,
  detectInvalidOrigins,
} from './session-cascade.js';

/** 会话文件在目录内的文件名（核实①真实日志实锤）。 */
export const SESSION_FILE_NAME = 'session.v4.jsonl.zstd';

/** 解压后字节上限（P0-3 内存保护）：超限即拒绝该条目，防止超大日志全解打爆内存。 */
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

/** 支持的 session header schema 版本（P2-1）：仅 v4；升级需回归并更新此常量。 */
export const SUPPORTED_HEADER_VERSION = 4;

/**
 * 拼接帧（concatenated-frame）结构扫描：找完整 zstd 帧边界，不做解压。
 *
 * 【真机 bug m03899 / 2026-11-17】会话日志不是单个 zstd 帧，而是「拼接帧容器」——
 * DSH 每次追加事件就写一个独立帧（dsh-session-persistence-jsonl/src/zstd.ts:4-6）。
 * 旧版 defaultDecompress 用整文件一次性 zstdDecompressSync：shell 的 Node 26 能解全部帧，
 * 但宿主 Electron 内置 Node 版本较老，一次性解压多帧只能拿到首帧（header 在第 1 帧故 A6 正常，
 * 标题在末尾帧故读到 null → 裸 id）。这正是 A2 标题子项真机失败的根因。
 *
 * 此扫描逐字节移植 DSH 已生产验证的 scanZstdFrames（zstd.ts），属「拒绝重复造轮子」——
 * 复用同一套帧边界算法，仅改为 JS（无 TS 类型、无 import 依赖）。返回完整帧 {start,end}
 * 与可选 tornStart（EOF 截断的残帧起点）。
 */
const ZSTD_MAGIC = 0xFD2FB528;
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 默认 zstd 解压：Node 22.15+ 内置，无第三方依赖（拒绝重复造轮子）。带字节上限保护。
 *
 * 【真机修复】改为「逐帧解压后拼接」，与 DSH 的 PublicZstdFrameDecoder 同构：
 * 先 scanZstdFrames 找帧边界，再对每个完整帧 zstdDecompressSync(source.subarray(start,end))，
 * 拼接各帧明文。单帧文件行为不变（一帧覆盖全文件）；多帧文件在老 Node 上也能全解。
 * tornStart（截断残帧）忽略——已完整帧的数据可用，符合单条目隔离纪律。
 */
export function defaultDecompress(input, deps = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const max = deps.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const { frames } = scanZstdFrames(buf);
  // 无有效帧（空 buffer / 全残帧）→ 回退一次性解压，保留对非常规输入的兼容。
  if (!frames.length) {
    const out = zstdDecompressSync(buf);
    if (out.length > max) {
      throw new Error(`decompressed session too large: ${out.length} > ${max}`);
    }
    return out;
  }
  const parts = [];
  let total = 0;
  for (const { start, end } of frames) {
    const part = zstdDecompressSync(buf.subarray(start, end));
    total += part.length;
    if (total > max) {
      throw new Error(`decompressed session too large: ${total} > ${max}`);
    }
    parts.push(part);
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts, total);
}

/**
 * 从解压后的 jsonl 文本取首行 header 并解析。header 是 jsonl 第一行 JSON。
 * 解析失败（损坏 / 不是 session header / 版本不支持）抛错，由调用方隔离该条目。
 */
export function parseSessionHeader(decompressed, deps = {}) {
  const text = Buffer.isBuffer(decompressed) ? decompressed.toString('utf8') : String(decompressed);
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  if (firstLine.trim() === '') throw new Error('empty session header line');
  const header = JSON.parse(firstLine);
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('session header is not an object');
  }
  if (typeof header.id !== 'string' || header.id === '') {
    throw new Error('session header missing id');
  }
  // P2-1：版本存在且不匹配 → 拒绝该条目（单条目隔离，不阻塞整批）。
  const expected = deps.supportedVersion ?? SUPPORTED_HEADER_VERSION;
  if (header.version !== undefined && header.version !== expected) {
    throw new Error(`unsupported session header version: ${header.version} (expected ${expected})`);
  }
  return header;
}

/** 默认 readHeader：解压 + 解析首行 header。测试可整体注入以模拟损坏 / 特殊布局。 */
export function defaultReadHeader(fs, filePath, deps = {}) {
  const decompress = deps.decompress ?? defaultDecompress;
  return parseSessionHeader(decompress(fs.readFile(filePath), deps), deps);
}

/**
 * 从回收站会话日志读取最新标题（真机 A2 标题子项修复，m03612）。
 * 标题不在首行 header，而在中间的 `session/title` 事件里（末条即最新）；
 * projcache 的 title 是过期旧值，不能作为来源。复用 defaultDecompress 的 8 MiB 上限。
 * 任何异常（损坏 / 无标题 / 读不到）都返回 null，由调用方 fallback 成 id，绝不影响 list。
 */
export function readSessionTitle(fs, dirPath, deps = {}) {
  try {
    const decompress = deps.decompress ?? defaultDecompress;
    const fileName = deps.sessionFileName ?? SESSION_FILE_NAME;
    const filePath = join(dirPath, fileName);
    if (!fs.exists || !fs.exists(filePath)) return null;
    const text = decompress(fs.readFile(filePath), deps).toString('utf8');
    let title = null;
    for (const line of text.split('\n')) {
      if (line.indexOf('session/title') === -1) continue; // 快速跳过无关行
      let evt;
      try { evt = JSON.parse(line); } catch (e) { continue; }
      if (evt && evt.type === 'session/title') {
        const candidate = evt.data && typeof evt.data.title === 'string' ? evt.data.title
          : (typeof evt.title === 'string' ? evt.title : null);
        if (candidate) title = candidate; // 末条匹配即最新标题
      }
    }
    return title;
  } catch (e) {
    return null;
  }
}

/**
 * 从回收站会话日志一次性抽取「最新标题 + 对话正文摘要」（回收站增强 m00234）。
 * 与 readSessionTitle 同源同构，但把逐行扫描的结果一次返回，避免为 title 与 content
 * 各解压一次大文件。正文只取 user/message 与 assistant/message 的 type=text part，
 * 拼接后截取前 maxChars 字（默认 4000），足够前端做「按内容搜索」而不过度占内存。
 * 任何异常都返回 {title:null,content:"",cwd:null,origin:null}，单条目隔离绝不影响整批 list。
 */
export function readSessionTitleAndContent(fs, dirPath, deps = {}) {
  var out = { title: null, content: "", cwd: null, origin: null };
  try {
    var decompress = deps.decompress ?? defaultDecompress;
    var fileName = deps.sessionFileName ?? SESSION_FILE_NAME;
    var filePath = join(dirPath, fileName);
    if (!fs.exists || !fs.exists(filePath)) return out;
    var text = decompress(fs.readFile(filePath), deps).toString('utf8');
    var maxChars = deps.maxContentChars ?? 4000;
    var textParts = [];
    var used = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      var quick = line.indexOf('session/title') !== -1 || line.indexOf('user/message') !== -1 || line.indexOf('assistant/message') !== -1 || line.indexOf('"session"') !== -1;
      if (!quick) continue;
      var evt;
      try { evt = JSON.parse(line); } catch (e) { continue; }
      if (!evt || typeof evt !== 'object') continue;
      if (evt.type === 'session') {
        if (typeof evt.cwd === 'string') out.cwd = evt.cwd;
        if (typeof evt.origin === 'string') out.origin = evt.origin;
        continue;
      }
      if (evt.type === 'session/title') {
        var candidate = evt.data && typeof evt.data.title === 'string' ? evt.data.title
          : (typeof evt.title === 'string' ? evt.title : null);
        if (candidate) out.title = candidate; // 末条匹配即最新标题
        continue;
      }
      if (used >= maxChars) continue;
      var parts = null;
      if (evt.type === 'user/message') {
        parts = evt.data && Array.isArray(evt.data.content) ? evt.data.content : null;
      } else if (evt.type === 'assistant/message') {
        var msg = evt.data && evt.data.message;
        parts = msg && Array.isArray(msg.content) ? msg.content : null;
      }
      if (!parts) continue;
      for (const part of parts) {
        if (used >= maxChars) break;
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          var take = part.text.slice(0, maxChars - used);
          textParts.push(take);
          used += take.length;
        }
      }
    }
    out.content = textParts.join('\n');
    return out;
  } catch (e) {
    return out;
  }
}

/**
 * 磁盘真相扫描：遍历 <trashRoot>/<project>/<segment>/<sessionFile>，读 header。
 * 返回 { found, unsafe, corrupt }：
 *   found —— [{ project, segment, dirPath, filePath, header, sizeBytes }]
 *   unsafe —— 层级/命名/逃逸校验不过的目录（结构性失败，fail-closed 整批拒绝）
 *   corrupt —— 单条目损坏（解压失败 / header 字段缺失 / 版本不匹配）：隔离该条目，不阻塞整批
 * 只扫描合法两层目录，不跟随符号链接逃逸（复用 session-trash 的安全原语）。
 */
export function scanTrashDisk(fs, trashRoot, deps = {}) {
  const found = [];
  const unsafe = [];
  const corrupt = [];
  const readHeader = deps.readHeader ?? defaultReadHeader;
  let projects;
  try {
    projects = fs.readdir(trashRoot);
  } catch {
    return { found, unsafe };
  }
  for (const project of projects) {
    // manifest 与原子写残留 temp 不是 project 目录，直接跳过（真机 readdir 会返回文件）。
    if (project === MANIFEST_NAME) continue;
    if (project.startsWith(MANIFEST_NAME) && project.endsWith('.tmp')) continue;
    if (!isValidSessionSegment(project)) {
      unsafe.push({ project, segment: null, why: 'illegal project segment' });
      continue;
    }
    const projectPath = join(trashRoot, project);
    let segments;
    try {
      segments = fs.readdir(projectPath);
    } catch {
      continue;
    }
    for (const segment of segments) {
      const dirPath = join(projectPath, segment);
      if (!isValidSessionSegment(segment) || !isTwoLevelUnder(trashRoot, dirPath)) {
        unsafe.push({ project, segment, dirPath, why: 'illegal segment or not two levels' });
        continue;
      }
      // realpath 校验防符号链接逃逸（与第 1 阶段 assertSafeTarget 同构）。
      try {
        const rootReal = fs.realpath(trashRoot);
        const real = fs.realpath(dirPath);
        if (!isInside(rootReal, real)) {
          unsafe.push({ project, segment, dirPath, why: 'entry escapes trashRoot' });
          continue;
        }
      } catch {
        unsafe.push({ project, segment, dirPath, why: 'cannot realpath entry' });
        continue;
      }
      const filePath = join(dirPath, deps.sessionFileName ?? SESSION_FILE_NAME);
      if (!fs.exists(filePath)) {
        unsafe.push({ project, segment, dirPath, why: 'session file missing' });
        continue;
      }
      let header;
      try {
        header = readHeader(fs, filePath, deps);
      } catch (error) {
        // P1-1：单条目损坏只隔离，不整批拒绝（与第 1 阶段 quarantined 粒度一致）。
        corrupt.push({ project, segment, dirPath, filePath, why: `header read failed: ${error.message}` });
        continue;
      }
      let sizeBytes = 0;
      try {
        sizeBytes = fs.stat(filePath)?.size ?? 0;
      } catch {
        sizeBytes = 0;
      }
      found.push({ project, segment, dirPath, filePath, header, sizeBytes });
    }
  }
  return { found, unsafe, corrupt };
}

/** header.origin → row.origin；缺失且带 parentSession 视为 fork（真实 fork 语义），否则普通会话。 */
function originOf(header) {
  if (header.origin === 'subagent' || header.origin === 'fork') return header.origin;
  if (typeof header.origin === 'string' && header.origin !== '') return header.origin; // 未知值保留，交 detectInvalidOrigins 拦
  return header.parentSession ? 'fork' : undefined;
}

/**
 * 构建 rows（字段映射）+ 反向聚合 childIds。
 *   id ← canonicalSessionId(header.id)（权威，不依赖段名）
 *   parentId ← canonicalSessionId(header.parentSession)（若有）
 *   origin ← originOf(header)
 *   childIds ← 扫描 rows 内 parentSession 反向聚合（不用文件自带字段，避免自检循环依赖）
 *   running / hostProtectedReason ← deps 注入（默认 false / undefined）
 */
export function buildRows(found, deps = {}) {
  const rows = found.map((entry) => {
    const id = canonicalSessionId(entry.header.id);
    const parentId = typeof entry.header.parentSession === 'string' && entry.header.parentSession !== ''
      ? canonicalSessionId(entry.header.parentSession)
      : undefined;
    const runningOf = deps.runningOf;
    const protectedReasonOf = deps.protectedReasonOf;
    let running = false;
    let readFailed = false;
    if (typeof runningOf === 'function') {
      try { running = Boolean(runningOf(id)); } catch { running = false; readFailed = true; }
    }
    let hostProtectedReason;
    if (typeof protectedReasonOf === 'function') {
      try { hostProtectedReason = protectedReasonOf(id); } catch { hostProtectedReason = undefined; readFailed = true; }
    }
    // P1-3 fail-safe：读不到活跃态时视为受保护，绝不把未知状态当非运行而误删
    // （与第 3 阶段 clientProtectedReason ?? Infinity 纪律一致）。
    if (readFailed && hostProtectedReason === undefined) {
      hostProtectedReason = 'read-error';
    }
    return {
      id,
      parentId,
      origin: originOf(entry.header),
      childIds: [],
      sizeBytes: entry.sizeBytes ?? 0,
      trashedPath: entry.trashedPath ?? entry.dirPath,
      running: Boolean(running),
      hostProtectedReason,
    };
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.parentId === undefined) continue;
    const parent = byId.get(row.parentId);
    // 父不在快照里 → 该子代理成为孤儿；此处不塞进任何 childIds（由 reconcile 的孤立检查处理）。
    if (parent && !parent.childIds.includes(row.id)) parent.childIds.push(row.id);
  }
  return rows;
}

/**
 * 双向对账：manifest 条目 vs 磁盘 found。
 *   - manifest 有、磁盘无：悬挂条目。status==='purging' → purgingPending（交 recoverPurging，
 *     不进 rows）；否则 → mismatch（整批拒绝）。
 *   - 磁盘有、manifest 无：孤儿目录 → orphans，记录但不进 rows（不删、不喂 cascade）。
 * 返回 { usable, orphans, purgingPending, mismatches }，usable = 两方都有的 found 项。
 */
export function reconcile(entries, found, deps = {}) {
  const manifestById = new Map();
  for (const [key, entry] of Object.entries(entries ?? {})) {
    manifestById.set(canonicalSessionId(entry?.id ?? key), entry);
  }
  const foundById = new Map();
  for (const item of found) foundById.set(canonicalSessionId(item.header.id), item);

  const usable = [];
  const orphans = [];
  const purgingPending = [];
  const mismatches = [];

  for (const [id, item] of foundById) {
    if (manifestById.has(id)) usable.push(item);
    else orphans.push({ id, dirPath: item.dirPath, trashedPath: item.dirPath });
  }
  for (const [id, entry] of manifestById) {
    if (foundById.has(id)) continue;
    // knownDiskIds：header 损坏但目录确实存在的条目，不当「磁盘缺失」整批拒绝（P1-1 单条目隔离）。
    if (deps.knownDiskIds?.has(id)) continue;
    if (entry?.status === 'purging') purgingPending.push({ id, entry });
    else mismatches.push({ id, reason: 'manifest-disk-mismatch', detail: 'manifest entry has no disk directory' });
  }
  return { usable, orphans, purgingPending, mismatches };
}

/**
 * 构建完整快照 + 三层完整性校验（4a 核心）。
 * 返回 { ok, rows, orphans, purgingPending, corrupt, reasons }。
 * ok=false 时 rows 为空、reasons 列出全部失败原因，调用方不得喂给 cascade。
 *
 * 三层（结构性失败，整批拒绝）：
 *   1) 集合一致：磁盘 unsafe + manifest/disk 双向 mismatch（reconcile）+ directIds 全在 rows。
 *   2) origin 合法：detectInvalidOrigins（复用第 3 阶段）。
 *   3) childIds 无悬挂：detectDanglingChildIds(rows, 全部 rows id)（复用第 3 阶段）。
 * 单条目损坏（corrupt：解压失败 / header 缺字段 / 版本不匹配）不进三层、不整批拒绝，
 * 只隔离上报；但若损坏条目正被 directIds 显式要求删除，则 fail-closed 拒绝（无法确定其树关系）。
 */
export function buildSnapshot(fs, trashRoot, deps = {}) {
  const reasons = [];
  const manifest = readManifest(fs, trashRoot);
  const { found, unsafe, corrupt } = scanTrashDisk(fs, trashRoot, deps);
  for (const item of unsafe) {
    reasons.push({ reason: 'disk-unsafe', detail: `${item.project}/${item.segment ?? ''}: ${item.why}` });
  }
  // corrupt 条目的权威 id 无法从 header 读，用目录段名 canonical 归一（P0-2 三者恒等）。
  const corruptIds = new Set(corrupt.map((c) => canonicalSessionId(c.segment)));
  // 告知 reconcile：这些目录在磁盘上确实存在（只是 header 损坏），别误判为「manifest 有磁盘无」。
  const { usable, orphans, purgingPending, mismatches } = reconcile(manifest.entries, found, {
    ...deps,
    knownDiskIds: corruptIds,
  });
  for (const m of mismatches) reasons.push(m);
  for (const rawId of deps.directIds ?? []) {
    if (corruptIds.has(canonicalSessionId(rawId))) {
      reasons.push({ id: canonicalSessionId(rawId), reason: 'corrupt-target', detail: 'requested target has a damaged session header; refusing to delete' });
    }
  }

  const rows = buildRows(usable, deps);

  // 层 2：origin 合法性
  for (const id of detectInvalidOrigins(rows)) {
    reasons.push({ id, reason: 'invalid-origin', detail: 'row has parentId but origin is missing or unknown' });
  }
  // 层 3：childIds 引用完整性（对全部 rows 检查：任一 childIds 指向 rows 外即拒绝）
  for (const id of detectDanglingChildIds(rows, rows.map((r) => r.id))) {
    reasons.push({ id, reason: 'child-ids-dangling', detail: 'childIds references an id outside the snapshot' });
  }
  // 层 1 补充：用户显式要求的删除目标必须都在快照里（孤儿/悬挂目标不得静默 not-found 跳过）
  for (const rawId of deps.directIds ?? []) {
    const id = canonicalSessionId(rawId);
    if (!rows.some((r) => r.id === id)) {
      reasons.push({ id, reason: 'target-not-in-snapshot', detail: 'requested target is not a usable snapshot row' });
    }
  }

  const corruptOut = corrupt.map((c) => ({ id: canonicalSessionId(c.segment), dirPath: c.dirPath, why: c.why }));
  if (reasons.length > 0) {
    return { ok: false, rows: [], orphans, purgingPending, corrupt: corruptOut, reasons };
  }
  return { ok: true, rows, orphans, purgingPending, corrupt: corruptOut, reasons: [] };
}

/**
 * 完整编排：buildSnapshot → cascadePurge。
 * 构建阶段（三层校验）失败时整批拒绝、cascadeFn 一次都不调用。
 * deps.cascadeFn 可注入（测试断言「未调用」）；默认 session-cascade.cascadePurge。
 */
export async function cascadePurgeFromTrash(fs, trashRoot, directIds, deps = {}) {
  const snapshot = buildSnapshot(fs, trashRoot, { ...deps, directIds });
  if (!snapshot.ok) {
    return {
      ok: false,
      stage: 'snapshot',
      reasons: snapshot.reasons,
      orphans: snapshot.orphans,
      purgingPending: snapshot.purgingPending,
      corrupt: snapshot.corrupt,
      cascadeCalled: false,
      message: `快照构建失败：${snapshot.reasons.map((r) => r.reason).join(', ')}；已拒绝级联删除`,
    };
  }
  const cascadeFn = deps.cascadeFn ?? cascadePurge;
  const protectedReason = deps.protectedReason ?? new Map();
  const cascadeDeps = deps.cascadeDeps ?? {};
  const result = await cascadeFn(snapshot.rows, directIds, protectedReason, cascadeDeps);
  return {
    ...result,
    stage: 'cascade',
    snapshot: {
      rows: snapshot.rows.length,
      orphans: snapshot.orphans,
      purgingPending: snapshot.purgingPending,
      corrupt: snapshot.corrupt,
    },
    cascadeCalled: true,
  };
}
