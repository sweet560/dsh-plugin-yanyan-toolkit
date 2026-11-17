// dsh-plugin-yanyan-toolkit — 路径 A · 第 1 阶段：可逆的会话回收站管线。
//
// 目标：把「会话归档 + 从活跃视图移除」做成一条可逆、fail-closed 的管线，
// 取代直接 rm -rf 的不可逆删除。第 1 阶段只做「归档闸门 + 回收站移动」，
// 物理删除（rm）、子代理级联、批量部分失败、接回设置页入口属于第 2~4 阶段，
// 本模块一概不碰。
//
// 设计原则（与现成 @linxin666/dsh-session-archive 的关系）：
//   - 「拒绝重复造轮子」——路径四层校验、id 规范化、归档闸门的能力探测方式，
//     全部借鉴现成包 src/host/session-files.ts 与 workspace-store.ts 里已被生产
//     验证的实现。现成包内并不存在 encodeSegment / api-session/added 这类 API，
//     故目标段安全采用「拒绝危险字符」的显式校验，不臆造不存在的轮子。
//   - 现成包缺的恰恰是「可逆」：它的 removeSessionDir 直接 rmSync。本模块的
//     增量就是用 fs.rename 把会话目录搬进 $DSH_HOME/session-trash，并写 manifest
//     记录原路径，从而可原样撤销。
//   - 纯逻辑 + 依赖注入：所有 fs / ctx / locate 都从参数进入，便于离线单测。
//   - fail-closed：任何一步的校验失败都让整批拒绝，绝不「跳过坏的这个继续删」。
//   - 不碰 rm / unlink / rmdir：本文件不调用任何物理删除原语（由单测静态断言守护）。
//     manifest 的更新一律用「write temp → rename 原子替换」实现（移除条目=重写不含该条目的
//     JSON 再原子替换），不使用 unlink；因此不存在「manifest 清理被守护挡住」的问题。
//   - 事件广播（api-session/removed / 恢复事件）：【第 4 阶段核实④已推翻第 1 阶段旧结论】
//     DSH 宿主 @deepseek-ai/dsh-api-session-controller/lib/index.js:3923-3941 确实 emit
//     api-session/added / removed / status / error / activity。本模块 emit 的 api-session/removed
//     与宿主原生事件名恰好一致，可被 UI 直接订阅刷新（第 4b 阶段接回入口时使用原生事件，
//     无需轮询兜底）。「广播早于 manifest」的顺序纪律仍然成立：即便有监听者，也要保证 UI
//     收到 removed 时回收站账本已就绪。remove 与 restore 两侧同样适用。
//     （第 1 阶段曾记为「DSH 不暴露 session 事件、广播无监听者、实际效果为零」，该结论基于
//     当时对现成包的核实，现由第 4 阶段对宿主源码的重新核实取代；历史记录保留在 CHANGELOG。）
//   - 中心 manifest 的并发：manifest 是「缓存」，回收站目录两段结构才是「真相」。进程内
//     对 manifest 的读-改-写用串行队列（withManifestLock）；restore 在 manifest 缺条目时
//     自动 fallback 到 rebuild（从目录真相重建），不依赖启动时的一次性 rebuild。
//     【已知限制】该锁只保证单进程串行：它能防同一 host 进程内的并发，但防不了多进程
//     同时挂载插件 host（web 与 CLI 并行、插件被多个宿主实例加载）时的「读-改-写」互相
//     覆盖。当前跨进程一致性依赖 rebuildManifestFromTrash 的目录真相兜底。若第 2 阶段
//     确认 DSH 为单进程 host，可升级为「已验证单进程、无需跨进程锁」；否则 purge 前需
//     引入文件锁（proper-lockfile 类）或明确接受「跨进程期间 manifest 可能 stale、以 rebuild 为准」。
//
// 回收站目录结构（相对会话树同构的两段）：<trashRoot>/<project>/<segment>
//   这样目录名本身就完整编码了原相对路径，即使 manifest 写失败，也能靠扫描回收站
//   目录 100% 反推 originalPath（把 trashRoot 换成 sessionsRoot），落实评审提出的
//   「补偿队列可由目录名反推原路径」要求。segment 原样保留 locate() 返回的实际段名
//   （带/不带 session- 前缀均可）——绝不按 canonicalSessionId 重算，否则无前缀布局会被
//   改写、反推失效（第二轮评审 1.1 命门）。

import {
  lstatSync,
  realpathSync,
  renameSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join, resolve, sep, isAbsolute, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isAbsolute as posixIsAbsolute, join as posixJoin } from 'node:path/posix';

export const TRASH_ROOT_NAME = 'session-trash';
export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_VERSION = 1;

/**
 * 段名安全规则（2026-11-16 真机 bug 修复 m03171）：
 * DSH 的 Windows project key 是 URL 编码形式，例如
 *   `--F-DeepSeek~0020Harness~0020workspace-default-workspace--`
 * 含 `~`、以 `-` 开头，旧的 `^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$` 会误拒，
 * 导致真机 trash 时 assertSafeTarget 抛「illegal project name」。
 * 新规则只拒绝：路径分隔符 / 与 \、空字节、长度越界（沿用 200 上限）；
 * 其余字符（~、URL 编码、空格、前导 - 等）一律允许。
 * 真正的防目录穿越纵深防御在 realpath + isInside 容器校验与 isTwoLevelUnder，
 * 不依赖此命名正则；`.`/`..` 及 `..` 子串由 isValidSessionSegment 额外显式拒绝。
 */
export const SEGMENT_RE = /^[^/\\\0]{1,200}$/;

/** 与现成包 canonicalSessionId 同构：segment -> `session-` 前缀形式。 */
export function canonicalSessionId(segment) {
  return String(segment).startsWith('session-') ? String(segment) : `session-${segment}`;
}

/** 段名是否符合安全命名规则（防路径注入的第一道闸；只拒分隔符/空字节/..，兼容 DSH 编码 project key）。 */
export function isValidSessionSegment(segment) {
  return typeof segment === 'string'
    && SEGMENT_RE.test(segment)
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('..');
}

/**
 * 目标段严格校验（P0-3）：id 来自请求参数，构造回收站路径前先拒绝危险字符。
 * 拒绝：空、非字符串、含 / \ .. 空字节、含分隔符、不匹配 SEGMENT_RE。
 * 规范化后再校验一次（canonical 后仍须合法）。返回规范化段名，否则抛错。
 */
export function safeTargetSegment(rawId) {
  if (typeof rawId !== 'string' || rawId.length === 0) throw new Error('empty session id');
  if (/[\/\\\0]/.test(rawId)) throw new Error(`illegal character in session id '${rawId}'`);
  const pieces = rawId.split(/[\\/]/);
  if (pieces.some((p) => p === '..' || p === '.')) throw new Error(`path traversal in session id '${rawId}'`);
  const canonical = canonicalSessionId(rawId);
  if (!isValidSessionSegment(canonical)) throw new Error(`unsafe session id '${rawId}'`);
  return canonical;
}

/** lexical 相对路径：child 在 root 内则返回相对段，否则 undefined。兼容 win32 大小写与分隔符。 */
export function relativeWithin(root, child) {
  const rootAbs = resolve(root);
  const childAbs = resolve(child);
  if (childAbs === rootAbs) return '';
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (!childAbs.startsWith(prefix)) return undefined;
  return childAbs.slice(prefix.length);
}

/** child 是否为 root 自身或其后代（调用前 root/child 都应已 realpath）。 */
export function isInside(root, child) {
  return relativeWithin(root, child) !== undefined;
}

/** lexical 判断 dirPath 是否恰好是 root 下的两层：<root>/<project>/<segment>。 */
export function isTwoLevelUnder(root, dirPath) {
  const rel = relativeWithin(root, dirPath);
  if (rel === undefined || rel === '') return false;
  const parts = rel.split(sep);
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

/** 解析 DSH_HOME（与现成包 src/dsh-home.ts 同构）：环境变量优先，平台 home 兜底。 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const isPosix = home.startsWith('/');
  const j = isPosix ? posixJoin : join;
  const isAbs = isPosix ? posixIsAbsolute : isAbsolute;
  const raw = env.DSH_HOME;
  if (raw !== undefined && String(raw).trim() !== '') {
    let value = String(raw).trim();
    if (value === '~') value = home;
    else if (value.startsWith('~/') || value.startsWith('~\\')) value = j(home, value.slice(2));
    return isAbs(value) ? value : j(process.cwd(), value);
  }
  return j(home, '.dsh');
}

/** 默认同步 fs 适配器：只暴露本模块需要的原语，便于测试时用内存对象替换。 */
export function defaultFs() {
  return {
    lstat: (p) => lstatSync(p),
    realpath: (p) => realpathSync(p),
    stat: (p) => statSync(p),
    rename: (from, to) => renameSync(from, to),
    mkdir: (p, opts) => mkdirSync(p, opts),
    readFile: (p, enc) => readFileSync(p, enc),
    writeFile: (p, data) => writeFileSync(p, data),
    readdir: (p) => readdirSync(p),
    exists: (p) => existsSync(p),
  };
}

function sessionsRootOf(fs) {
  return fs.__sessionsRoot;
}
function trashRootOf(fs) {
  return fs.__trashRoot;
}

/** 在指定 root/<project>/<segment> 两层内按规范化 id 定位目录（locate 的通用实现）。 */
export function locateUnder(fs, root, id) {
  if (!fs.exists(root)) return undefined;
  const canonical = canonicalSessionId(id);
  let projects;
  try {
    projects = fs.readdir(root);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const projectPath = join(root, project);
    let segments;
    try {
      segments = fs.readdir(projectPath);
    } catch {
      continue;
    }
    for (const segment of segments) {
      if (canonicalSessionId(segment) === canonical) return join(projectPath, segment);
    }
  }
  return undefined;
}

/** 默认 locate：在 sessionsRoot 两层内定位（用于 sessions 树）。 */
export function makeScanner(fs) {
  return function locate(id) {
    return locateUnder(fs, sessionsRootOf(fs), id);
  };
}

/**
 * 四层安全校验（借鉴现成包 indexSessionDirs + removeSessionDir）：
 *   1) 目录层级：dirPath 必须是 root/<project>/<segment> 恰好两层；
 *   2) lstat 非符号链接且确为目录（lstat 不跟随链接，符号链接会被拒）；
 *   3) realpath 落在 root 的 realpath 内（父目录若逃逸也拦住）；
 *   4) 段名符合命名规则，且规范化后等于目标 id。
 * 任一层不满足即抛错（fail-closed）。返回 { dirPath, project, segment, realPath }。
 *
 * root 参数可传 sessionsRoot 或 trashRoot，因此同一函数覆盖「源校验」与「restore 目标校验」。
 */
export function assertSafeTarget(id, dirPath, root, fs, canonical = canonicalSessionId(id)) {
  if (typeof dirPath !== 'string' || !isAbsolute(dirPath)) {
    throw new Error(`invalid session path for ${id}: not absolute`);
  }
  if (!isTwoLevelUnder(root, dirPath)) {
    throw new Error(`unsafe session path for ${id}: not <root>/<project>/<segment>`);
  }
  const segment = basename(dirPath);
  const project = basename(dirname(dirPath));
  if (!isValidSessionSegment(segment)) {
    throw new Error(`unsafe session path for ${id}: illegal segment name '${segment}'`);
  }
  if (!isValidSessionSegment(project)) {
    throw new Error(`unsafe session path for ${id}: illegal project name '${project}'`);
  }
  if (canonicalSessionId(segment) !== canonical) {
    throw new Error(`segment '${segment}' does not match session id ${id}`);
  }
  let lst;
  try {
    lst = fs.lstat(dirPath);
  } catch (error) {
    throw new Error(`cannot lstat session path for ${id}: ${error.message}`);
  }
  if (lst.isSymbolicLink?.() || !lst.isDirectory?.()) {
    throw new Error(`unsafe session path for ${id}: symlink or not a directory`);
  }
  let rootReal;
  let real;
  try {
    rootReal = fs.realpath(root);
    real = fs.realpath(dirPath);
  } catch (error) {
    throw new Error(`cannot realpath session path for ${id}: ${error.message}`);
  }
  if (!isInside(rootReal, real)) {
    throw new Error(`refusing ${id}: resolved path escapes root`);
  }
  return { dirPath, project, segment, realPath: real };
}

/** 校验回收站根与会话根不重叠（否则 rename 的目标可能落回会话树内）。 */
export function assertDisjointRoots(sessionsRoot, trashRoot) {
  if (isInside(sessionsRoot, trashRoot) || isInside(trashRoot, sessionsRoot)) {
    throw new Error('session-trash root must be disjoint from sessions root');
  }
}

/**
 * P1-5 同卷探测：fs.rename 跨文件系统会抛 EXDEV。第 1 阶段不引入 copy+delete，
 * 故 preflight 阶段直接拒绝不同卷。trashRoot 可能尚不存在，取其最近存在祖先的 dev。
 */
export function assertSameVolume(sessionsRoot, trashRoot, fs) {
  const stat = fs.stat || ((p) => ({ dev: 0 }));
  const devOf = (p) => {
    let cur = resolve(p);
    for (;;) {
      try {
        return stat(cur).dev;
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return undefined;
        cur = parent;
      }
    }
  };
  const a = devOf(sessionsRoot);
  const b = devOf(trashRoot);
  if (a !== undefined && b !== undefined && a !== b) {
    throw new Error('EXDEV: session-trash and sessions are on different volumes; rename would fail');
  }
}

/** 从 ctx 提取归档闸门（能力探测），返回可调用的 archiveSession(id) 或 null。 */
export function archiveGateFromContext(ctx) {
  const registry = ctx?.workspaceRegistry;
  if (typeof registry?.archiveSession === 'function') {
    return (id) => registry.archiveSession(id);
  }
  return null;
}

/** 从 ctx 提取广播函数（能力探测），无则 no-op。事件名由调用方传入。 */
export function emitterFromContext(ctx) {
  if (typeof ctx?.emit === 'function') return (event, id) => ctx.emit(event, id);
  return () => {};
}

/** 读取回收站 manifest；不存在或损坏时返回空文档（fail-closed）。 */
export function readManifest(fs, trashRoot) {
  const file = join(trashRoot, MANIFEST_NAME);
  try {
    if (!fs.exists(file)) return { version: MANIFEST_VERSION, entries: {} };
    const parsed = JSON.parse(fs.readFile(file, 'utf8'));
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { version: MANIFEST_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { version: MANIFEST_VERSION, entries: {} };
  }
}

/**
 * 原子写 manifest（评审第三轮第 1 点）：write temp → rename 覆盖，
 * 避免直接 writeFile 截断导致「写一半崩溃、整个中心 manifest 全丢」。
 * 不用 unlink（符合静态守护）：temp 被 rename 覆盖进最终路径，无临时文件残留。
 *
 * 第 2 阶段加固（收口记录项 2）：temp 名加 <pid>.<random> 唯一化。固定名
 * `${finalPath}.tmp` 在崩溃残留或多进程写时会互相踩踏；唯一名让每次写入的
 * 临时文件彼此独立，崩溃残留也不会阻塞后续写。残留 temp 文件无害（rebuild
 * 会跳过，见 rebuildManifestFromTrash），无需 unlink 清理。
 *
 * 导出供第 2 阶段 purge 复用同一写路径——purge 不得另起原子写实现。
 */
export function writeManifest(fs, trashRoot, manifest) {
  fs.mkdir(trashRoot, { recursive: true });
  const finalPath = join(trashRoot, MANIFEST_NAME);
  const nonce = `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const tmpPath = `${finalPath}.${nonce}.tmp`;
  fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2));
  fs.rename(tmpPath, finalPath); // 原子替换
}

/**
 * 进程内 manifest 串行锁（评审第三轮第 1 点）：所有对中心 manifest 的
 * 「读-改-写」都经此排队，避免两个客户端并发时后写覆盖先写导致条目丢失。
 * 导出供第 2 阶段 purge 复用同一策略——purge 不得另起一套写路径。
 */
let manifestChain = Promise.resolve();
export function withManifestLock(task) {
  const run = manifestChain.then(task, task);
  manifestChain = run.then(() => undefined, () => undefined);
  return run;
}

// 补偿队列（P0-1）：manifest 写失败时，原路径信息在此暂存，供宿主 drain 后持久化。
// 即便进程崩溃，因回收站目录为两段结构，rebuildManifestFromTrash 也能从目录名反推原路径。
const compensationQueue = [];

/** 取走并清空补偿队列（宿主可在写 manifest 失败后调用，持久化到可靠存储）。 */
export function drainCompensationQueue() {
  return compensationQueue.splice(0);
}

/**
 * 兜底重建 manifest：扫描 <trashRoot>/<project>/<segment>，按目录结构反推 originalPath。
 * 用于进程重启后修复「有目录、无 manifest 条目」的不一致（P0-1 补偿的第二道保险）。
 */
export function rebuildManifestFromTrash(fs, sessionsRoot, trashRoot) {
  const manifest = { version: MANIFEST_VERSION, entries: {}, quarantined: [] };
  let projects = [];
  try {
    projects = fs.readdir(trashRoot);
  } catch {
    return manifest;
  }
  for (const project of projects) {
    if (project === MANIFEST_NAME) continue;
    // 跳过原子写的残留 temp（manifest.json.<pid>.<random>.tmp），不当作 project 扫描。
    if (project.startsWith(MANIFEST_NAME) && project.endsWith('.tmp')) continue;
    const projectPath = join(trashRoot, project);
    let segments = [];
    try {
      segments = fs.readdir(projectPath);
    } catch {
      continue;
    }
    for (const segment of segments) {
      const dirPath = join(projectPath, segment);
      // 评审 1.2：project 与 segment 都必须是单层合法目录名，且 realpath 仍在 trashRoot 内；
      // 反推的 sessions 目标也必须落在 sessionsRoot 内。校验不过的进隔离清单，不重建、不允许 restore/purge。
      const reject = (why) => manifest.quarantined.push({ project, segment, dirPath, why });
      if (!isValidSessionSegment(project)) { reject('illegal project segment'); continue; }
      if (!isValidSessionSegment(segment)) { reject('illegal segment name'); continue; }
      try {
        const rootReal = fs.realpath(trashRoot);
        const real = fs.realpath(dirPath);
        if (!isInside(rootReal, real)) { reject('trash entry escapes trashRoot'); continue; }
      } catch {
        reject('cannot realpath trash entry'); continue;
      }
      const originalPath = join(sessionsRoot, project, segment);
      if (!isTwoLevelUnder(sessionsRoot, originalPath)) { reject('rebuilt original path not two levels'); continue; }
      const id = canonicalSessionId(segment);
      manifest.entries[id] = {
        id,
        originalPath,
        trashedPath: dirPath,
        archivedAt: null,
        trashedAt: null,
        rebuilt: true,
      };
    }
  }
  writeManifest(fs, trashRoot, manifest);
  return manifest;
}

/**
 * 计算回收站目标两段路径。评审 1.1（命门）：两段必须来自 locate() 返回的实际路径，
 * 而不是用 safeTargetSegment(id) 重新构造——现成包 canonicalSessionId 注释明确
 * DSH 存在「带 session- 前缀」与「不带前缀」两种段名布局。若用 canonical 构造，
 * 无前缀布局下 rename 会把目录名改写，restore 拼回时路径与 DSH locate 不一致。
 * safeTargetSegment 在此只做防御性校验（拒绝逃逸 id），不承担路径构造职责。
 */
export function trashTargetFor(rawId, dirPath, sessionsRoot, trashRoot) {
  safeTargetSegment(rawId); // 仅校验 id 合法性，不用于构造路径
  const project = basename(dirname(dirPath));
  const actualSegment = basename(dirPath); // 唯一权威：locate 返回的实际段名
  if (!isValidSessionSegment(project)) throw new Error(`illegal project segment '${project}'`);
  if (!isValidSessionSegment(actualSegment)) throw new Error(`illegal segment name '${actualSegment}'`);
  if (canonicalSessionId(actualSegment) !== canonicalSessionId(rawId)) {
    throw new Error(`actual segment '${actualSegment}' does not match id ${rawId}`);
  }
  return { target: join(trashRoot, project, actualSegment), project, segment: actualSegment };
}

/**
 * fail-closed 整批预检：定位 + 四层校验 + 归档闸门能力探测 + 同卷探测 +
 * 回收站目标安全构造 + 占用检查 + 可选运行态复检。
 * 返回 { ok, checks, reasons }；ok=false 时 pipeline 整批拒绝，不做任何移动。
 */
export function preflight(ids, deps) {
  const { fs, sessionsRoot, trashRoot, locate, archiveSession, isSessionActive } = deps;
  assertDisjointRoots(sessionsRoot, trashRoot);
  assertSameVolume(sessionsRoot, trashRoot, fs);
  const checks = [];
  const reasons = [];
  for (const rawId of ids) {
    try {
      const id = safeTargetSegment(rawId);
      const dirPath = locate(rawId);
      if (!dirPath) throw new Error(`session ${id} not found by locate()`);
      const safe = assertSafeTarget(id, dirPath, sessionsRoot, fs);
      const { target, segment } = trashTargetFor(rawId, dirPath, sessionsRoot, trashRoot);
      if (fs.exists(target)) throw new Error(`trash target already exists for ${id}`);
      if (typeof archiveSession !== 'function') throw new Error('archive gate unavailable (missing workspaceRegistry.archiveSession)');
      if (typeof isSessionActive === 'function' && isSessionActive(rawId)) {
        throw new Error(`session ${id} is still running; refusing to move`);
      }
      checks.push({ id, rawId, dirPath, target, segment, ...safe });
    } catch (error) {
      reasons.push({ id: (() => { try { return safeTargetSegment(rawId); } catch { return String(rawId); } })(), reason: error.message });
    }
  }
  return { ok: reasons.length === 0, checks, reasons };
}

/**
 * 单条移动：归档闸门 → 二次运行态复检 → rename → 立即广播 removed → 写 manifest。
 * 广播早于 manifest（P0-1）：广播语义是「目录已不在原位置」，不依赖 manifest；
 * manifest 仅用于恢复，写失败进补偿队列，不让 UI 说谎。
 */
export async function moveOneToTrash(check, deps) {
  const { fs, archiveSession, emitRemoved, now = Date.now, manifest, sessionsRoot, trashRoot, isSessionActive } = deps;
  const archivedAt = now();
  // 归档闸门（真机 bug m05087 修复）：
  //   DSH archiveSession → sessionKnown(id) 按【原始 id 精确匹配】。canonical id 会给
  //   mnemon-task-v1-<uuid> 这类非 session- 前缀会话强加 session- 前缀，导致
  //   WorkspaceUnknownSessionError（"live sessions and session persistence hold no such session"）。
  //   策略：先按 canonical 归档（普通 session-* 会话行为不变）；若是「未知会话」错误，用原始 id
  //   重试一次（DSH 认识 header.id 原始形式）；仍不认识则降级跳过归档、继续 move——回收站 move
  //   本身可逆（manifest 记录原路径、emitRemoved 刷新侧栏），mnemon- 后台任务会话本就不在 registry。
  //   WorkspaceActiveSessionError（运行中保护）与其它未知错误一律 fail-closed，绝不静默放行。
  let archiveOutcome = 'ok';
  const isActiveErr = (e) => String(e?.name || '') === 'WorkspaceActiveSessionError' || /is active \(/.test(String(e?.message || e));
  const isUnknownErr = (e) => String(e?.name || '') === 'WorkspaceUnknownSessionError' ||
    (/cannot archive session/.test(String(e?.message || e)) && /no such session/.test(String(e?.message || e)));
  try {
    await archiveSession(check.id);
  } catch (error) {
    if (isActiveErr(error)) {
      return { id: check.id, status: 'failed', reason: 'archive-active', detail: String(error?.message || error) };
    }
    if (isUnknownErr(error) && check.rawId && check.rawId !== check.id) {
      try {
        await archiveSession(check.rawId);
      } catch (retryError) {
        if (isActiveErr(retryError)) {
          return { id: check.id, status: 'failed', reason: 'archive-active', detail: String(retryError?.message || retryError) };
        }
        if (isUnknownErr(retryError)) {
          archiveOutcome = 'skipped';
        } else {
          return { id: check.id, status: 'failed', reason: 'archive-gate', detail: String(retryError?.message || retryError) };
        }
      }
    } else if (isUnknownErr(error)) {
      archiveOutcome = 'skipped';
    } else {
      return { id: check.id, status: 'failed', reason: 'archive-gate', detail: String(error?.message || error) };
    }
  }
  // P2 二次运行态复检：preflight 到 rename 之间可能有新回合启动。
  if (typeof isSessionActive === 'function') {
    try {
      if (isSessionActive(check.rawId)) {
        return { id: check.id, status: 'failed', reason: 'session-running', detail: 'session became active before rename' };
      }
    } catch {
      // 复检能力自身异常按 fail-closed 处理
      return { id: check.id, status: 'failed', reason: 'active-check-error', detail: 'isSessionActive threw' };
    }
  }
  // 并发原子检查（P2）：rename 前再 lstat 目标，避免两个客户端同时删同一 id。
  if (fs.exists(check.target)) {
    return { id: check.id, status: 'failed', reason: 'target-race', detail: 'trash target occupied by concurrent move' };
  }
  try {
    fs.mkdir(dirname(check.target), { recursive: true });
    fs.rename(check.dirPath, check.target);
  } catch (error) {
    const code = error?.code;
    if (code === 'EXDEV') {
      return { id: check.id, status: 'failed', reason: 'exdev', detail: 'sessions and trash are on different volumes' };
    }
    return { id: check.id, status: 'failed', reason: 'move', detail: String(error?.message || error) };
  }
  // 广播紧跟 rename，UI 立即得到正确状态。
  emitRemoved?.(check.id);
  const entry = {
    id: check.id,
    originalPath: check.dirPath,
    trashedPath: check.target,
    archivedAt,
    trashedAt: now(),
  };
  // 归档降级（m05087）：mnemon- 等非标准会话 DSH 不认识、未真正归档；记录此标志，
  // 让 UI/恢复路径知道该条目无需 unarchive，也便于审计哪些条目走了降级。
  if (archiveOutcome === 'skipped') entry.archiveSkipped = true;
  try {
    manifest.entries[check.id] = entry;
    writeManifest(fs, trashRoot, manifest);
  } catch (error) {
    compensationQueue.push({ ...entry, error: String(error?.message || error), at: now() });
    return { id: check.id, status: 'ok', entry, manifestWriteFailed: true, detail: 'enqueued compensation' };
  }
  return { id: check.id, status: 'ok', entry };
}

/**
 * 编排整条第 1 阶段管线：预检（整批 fail-closed）→ 逐条归档+移动 → 汇总结果。
 * 预检不通过时一条都不动。返回 { ok, moved, failed, rejected, results }。
 */
export async function runTrashPipeline(ids, deps) {
  const plan = preflight(ids, deps);
  if (!plan.ok) {
    return {
      ok: false,
      moved: 0,
      failed: 0,
      rejected: plan.reasons,
      results: ids.map((rawId) => {
        let id;
        try { id = safeTargetSegment(rawId); } catch { id = String(rawId); }
        const bad = plan.reasons.find((r) => r.id === id);
        return bad ? { id, status: 'rejected', reason: bad.reason } : { id, status: 'rejected', reason: 'batch aborted by preflight' };
      }),
    };
  }
  // 评审第三轮第 1 点：整段的「读 manifest → 逐条改 → 写回」在同一串行锁内进行，
  // 避免两个并发 pipeline 各自读同一份、后写覆盖先写导致条目丢失。
  return withManifestLock(async () => {
    const manifest = readManifest(deps.fs, deps.trashRoot);
    const results = [];
    for (const check of plan.checks) {
      results.push(await moveOneToTrash(check, { ...deps, manifest }));
    }
    const moved = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    return { ok: failed === 0, moved, failed, rejected: [], results };
  });
}

/**
 * 撤销单条（P0-2 强化）：不信任 manifest 里的路径，只信任 id + 回收站两段目录结构。
 * 对「回收站源目录」与「原路径目标」都重新执行四层校验；原路径被占用则安全失败。
 * unarchive：【第 4 阶段核实⑥已更新】当前宿主 @deepseek-ai/dsh-workspace/lib/index.js:559
 * 已提供 unarchiveSession(sessionId)，restore 可直接调用完成解档。partial=true 分支保留为
 * 防御性降级——仅当注入的 unarchiveSession 能力缺失/失败时触发（P1-6），当前正常宿主路径
 * 不会走到；它仍广播恢复事件并给出手动解档提示。
 */
export async function restoreFromTrash(id, deps) {
  // 评审第三轮第 1 点：manifest 的读-改-写经进程内串行队列，避免并发覆盖。
  return withManifestLock(() => restoreFromTrashLocked(id, deps));
}

async function restoreFromTrashLocked(id, deps) {
  const { fs, sessionsRoot, trashRoot, unarchiveSession, emitAdded } = deps;
  let canonical;
  try {
    canonical = safeTargetSegment(id);
  } catch (error) {
    return { ok: false, id: String(id), reason: error.message };
  }
  // 评审第三轮第 4 点：restore 也是跨 trashRoot→sessionsRoot 的 rename，卷挂载点可能在两次
  // 操作间变化（可移动磁盘/网络卷重连）。复用同卷探测，失败返回明确错误而非裸 EXDEV。
  try {
    assertSameVolume(sessionsRoot, trashRoot, fs);
  } catch (error) {
    return { ok: false, id: canonical, reason: 'exdev', detail: error.message };
  }
  let manifest = readManifest(fs, trashRoot);
  let entry = manifest.entries[canonical];
  if (!entry) {
    // 评审第三轮第 1 点：manifest 是缓存、回收站目录两段结构才是真相。缺条目时自动
    // fallback 到 rebuild（从目录真相重建），不依赖启动时的一次性 rebuild。元数据可能
    // 退化，但以目录真相为准总比拒绝恢复好；rebuild 会把条目写回中心 manifest。
    const rebuilt = rebuildManifestFromTrash(fs, sessionsRoot, trashRoot);
    if (rebuilt.entries[canonical]) {
      manifest = rebuilt;
      entry = rebuilt.entries[canonical];
    }
  }
  if (!entry) return { ok: false, id: canonical, reason: 'no manifest entry (try rebuildManifestFromTrash)' };

  // 评审 P0（第 2 阶段）：restore 状态门必须与 purge 对称——purge 阶段 1 在锁内写了
  // {status:'purging'} 后释放锁、阶段 2 在锁外执行 rm（Windows 重试可能持续数秒）。
  // 若该窗口内 restore 照常搬运：restore 把目录 rename 回 sessions → purge 的 rm 命中旧
  // 路径 ENOENT → 条目保持 purging → recover 见「purging + 目录不存在」误判为已 purge，
  // 状态说谎（数据其实已恢复）。故 purging 条目一律拒绝恢复，提示等待/重试。
  // 注意：rebuild fallback 从目录结构反推的条目无 status 字段，不会被此处误伤。
  // 评审 P1（第 2 阶段第三轮）：quarantined 隔离项的承诺是「既不重建、也不 restore/purge」。
  // 正常路径下隔离项不在 entries 里（rebuild 会把逃逸条目移到 quarantined），但矛盾态残留
  // （条目同时出现在 entries 与 quarantined）时必须在 restore 侧闭合，否则第 1 阶段的隔离
  // 承诺在恢复路径上落空。与 preflightPurge 的 quarantinedIds 判定保持一致。
  const quarantineIds = new Set(
    (Array.isArray(manifest.quarantined) ? manifest.quarantined : [])
      .map((q) => canonicalSessionId(String(q?.segment || q?.id || ''))),
  );
  if (quarantineIds.has(canonical)) {
    return {
      ok: false,
      id: canonical,
      reason: 'quarantined',
      detail: '会话已被隔离（quarantined），不允许恢复；请先核实隔离原因',
    };
  }

  if (entry.status === 'purging') {
    return {
      ok: false,
      id: canonical,
      reason: 'purge-in-progress',
      detail: '会话正在物理删除中（purging），无法恢复；请等待 purge 完成或重试',
    };
  }

  // 源：完全不信任 manifest 里的任何路径字段，按 id 在回收站里重新 locate。
  let sourceSafe;
  try {
    const candidate = locateUnder(fs, trashRoot, canonical);
    if (!candidate) throw new Error('session not found in trash by id');
    sourceSafe = assertSafeTarget(canonical, candidate, trashRoot, fs);
  } catch (error) {
    return { ok: false, id: canonical, reason: `unsafe trash source: ${error.message}` };
  }

  // 【恢复侧无级联——情况 A 的设计约定，勿「加固」成情况 B】
  // 这里**故意不检查 parentSession 父会话是否在 sessions 侧存在**。会话进回收站后，父可能
  // 已先被单独恢复（或从未进回收站），子代理仍在 trash；此时子代理必须能被单独恢复（情况 A：
  // 数据不丢、体验断裂）。若在此加「恢复前确认父存在，避免产生孤儿」之类校验，会把情况 A
  // 静默变成情况 B（子代理无法单独恢复），且不会触发任何现有测试——所以由
  // test/session-trash.test.mjs「父已恢复、子代理仍可独立恢复」用例锁定此行为。
  // buildRows 中此类子代理会成为树孤儿（parentId 指向快照外），但 origin==='subagent' 合法、
  // 不触发 invalid-origin，仍可正常恢复；父重新进 trash 后树关系自动重建（见 VERIFICATION.md 往返场景）。
  // 相关已知限制与后续评估方向见 CHANGELOG「恢复侧无级联」条。
  // 目标：按源段反推原路径，重新校验（不信任 entry.originalPath）。
  let targetSafe;
  const originalPath = join(sessionsRoot, sourceSafe.project, sourceSafe.segment);
  const projectPath = dirname(originalPath);
  // 评审第三轮第 3 点：会话移入回收站后 <sessionsRoot>/<project> 可能被删（项目删除/工作区
  // 移除），rename 会 ENOENT。保守拒绝（fail-closed）：不臆造 DSH 对「空 project 目录=项目
  // 存在」的语义，返回结构化错误码与引导，而不是让调用方拿到裸 ENOENT。
  if (!fs.exists(projectPath)) {
    return {
      ok: false,
      id: canonical,
      reason: 'original-project-missing',
      detail: `原项目目录 ${projectPath} 已不存在，无法恢复；请先恢复项目或选择其他位置`,
      manualAction: {
        kind: 'restore-project-first',
        sessionId: canonical,
        target: projectPath,
        instruction: 'recreate or restore the original project/workspace before restoring this session',
      },
    };
  }
  try {
    if (fs.exists(originalPath)) throw new Error(`original path occupied: ${originalPath}`);
    // 目标尚未存在，无法 lstat；用「父目录存在 + 段名合法 + lexical 两层 + realpath 父目录在 root 内」替代。
    if (!isValidSessionSegment(sourceSafe.project) || !isValidSessionSegment(sourceSafe.segment)) {
      throw new Error('illegal segment/project in trash source');
    }
    if (canonicalSessionId(sourceSafe.segment) !== canonical) {
      throw new Error('trash source segment does not match id');
    }
    if (!isTwoLevelUnder(sessionsRoot, originalPath)) {
      throw new Error('reconstructed original path is not two levels under sessions root');
    }
    const rootReal = fs.realpath(sessionsRoot);
    const projectReal = fs.realpath(projectPath);
    if (!isInside(rootReal, projectReal)) throw new Error('reconstructed project escapes sessions root');
    targetSafe = { originalPath, project: sourceSafe.project, segment: sourceSafe.segment };
  } catch (error) {
    return { ok: false, id: canonical, reason: `unsafe restore target: ${error.message}` };
  }

  try {
    fs.mkdir(dirname(targetSafe.originalPath), { recursive: true });
    fs.rename(sourceSafe.dirPath, targetSafe.originalPath);
  } catch (error) {
    return { ok: false, id: canonical, reason: String(error?.message || error) };
  }

  let unarchiveOk = false;
  if (typeof unarchiveSession === 'function') {
    try {
      await unarchiveSession(canonical);
      unarchiveOk = true;
    } catch {
      // 目录已恢复但解档失败：记为部分成功，不改变已移动的事实。
    }
  }

  // 移除 manifest 条目：整文件覆盖写，不调用 unlink。
  delete manifest.entries[canonical];
  try {
    writeManifest(fs, trashRoot, manifest);
  } catch (error) {
    compensationQueue.push({ id: canonical, op: 'manifest-remove', error: String(error?.message || error), at: Date.now() });
  }

  // 广播恢复事件，让已连接客户端刷新侧栏（事件名本模块约定，第 4 阶段对齐宿主）。
  emitAdded?.(canonical);

  return {
    ok: true,
    id: canonical,
    restoredTo: targetSafe.originalPath,
    partial: !unarchiveOk,
    // P1-6 / 评审 1.4：partial 必须带结构化 manualAction，UI 应渲染成可见提示条，
    // 不停留在「返回 partial 但没人处理」的中间态。
    ...(unarchiveOk ? {} : {
      note: '目录已恢复，但 unarchive 能力缺失或失败，需手动解档 archivedSessionIds',
      manualAction: {
        kind: 'unarchive-required',
        sessionId: canonical,
        target: 'workspace.global.archivedSessionIds',
        instruction: 'remove the session id from archivedSessionIds so it reappears in the sidebar',
      },
    }),
  };
}

/** 列出回收站中当前记录（只读）。 */
export function listTrash(fs, trashRoot) {
  return Object.values(readManifest(fs, trashRoot).entries);
}
