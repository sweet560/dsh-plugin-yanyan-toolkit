// dsh-plugin-yanyan-update — Host 半区。
//
// 职责：补齐官方 @linxin666/dsh-client-ui-plugin-manager 唯一没有覆盖的缺口——
// 它只检查 source.kind === 'npm' 且 isDirectRegistrySpec 的行（见
// dsh-web-0.4.16/packages/dsh-plugin-manager/src/host/routes.ts:603）。本插件额外覆盖
// 本地 link: / file: 目录安装的插件（多数是 git 仓库）与 registry 线上源，并提供逐行一键更新。
//
// 形态照抄 dsh-plugin-wechat-session/lib/index.js 的
// respond / readBody / apply / ctx.effect + ctx.webServer.register。
//
// 约束：纯 JavaScript，模块顶层不得访问 document / window / ctx；apply 只在被调用时才
// 执行。所有 git / fetch 都带超时并逐行 try/catch 隔离，单行异常不拖垮整体检查。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const name = 'dsh-plugin-yanyan-update';
export const VERSION = '1.0.0';
export const inject = ['webServer', 'connection'];
export const ROUTE_BASE = '/__dsh-plugin-yanyan-update';

const DEFAULTS = {
  checkOnOpen: false,
  includeLocal: true,
  includeRegistry: true,
  registryUrl: 'https://registry.npmjs.org',
  timeoutMs: 12000,
};

const FORBIDDEN_BODY = {
  ok: false,
  error: 'forbidden',
  message: '请求未通过 DSH 准入裁决。',
};

const BODY_LIMIT = 64 * 1024;

// ───────────────── 配置 ─────────────────
// 整段覆盖、不深合并：只认 DEFAULTS 列出来的键，缺省键逐个补默认值。
export function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  // 整段覆盖、不深合并：先铺默认值，再用 config 的自有键浅覆盖（保留额外键，
  // 但不对嵌套对象递归合并），最后对已知键做类型规范化。
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = DEFAULTS[key];
  for (const key of Object.keys(c)) out[key] = c[key];
  out.checkOnOpen = Boolean(out.checkOnOpen);
  out.includeLocal = Boolean(out.includeLocal);
  out.includeRegistry = Boolean(out.includeRegistry);
  out.registryUrl = typeof out.registryUrl === 'string' && out.registryUrl.trim()
    ? out.registryUrl.trim().replace(/\/+$/, '')
    : DEFAULTS.registryUrl;
  let t = Number(out.timeoutMs);
  if (!Number.isFinite(t)) t = DEFAULTS.timeoutMs; // 非法值回落默认
  else t = Math.min(120000, Math.max(1000, Math.round(t))); // 限制 1000..120000
  out.timeoutMs = t;
  return out;
}

// ───────────────── semver 大于比较 ─────────────────
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  if (/^[vV]/.test(s)) s = s.slice(1); // 允许前导 v
  const plus = s.indexOf('+'); // 忽略 build metadata
  if (plus >= 0) s = s.slice(0, plus);
  let core = s;
  let pre = '';
  const dash = s.indexOf('-');
  if (dash >= 0) {
    core = s.slice(0, dash);
    pre = s.slice(dash + 1);
  }
  const segs = core.split('.');
  if (segs.length === 0 || segs.some((seg) => !/^\d+$/.test(seg))) return null;
  return { nums: segs.map(Number), pre };
}

function comparePre(a, b) {
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = i < as.length ? as[i] : '0';
    const y = i < bs.length ? bs[i] : '0';
    const xn = /^\d+$/.test(x) ? Number(x) : x;
    const yn = /^\d+$/.test(y) ? Number(y) : y;
    if (typeof xn === 'number' && typeof yn === 'number') {
      if (xn > yn) return 1;
      if (xn < yn) return -1;
    } else {
      const xs = String(xn);
      const ys = String(yn);
      if (xs > ys) return 1; // 非数字段按字符串比较
      if (xs < ys) return -1;
    }
  }
  return 0;
}

export function gt(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A || !B) return false; // 非法 / 缺失版本
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i++) {
    const x = i < A.nums.length ? A.nums[i] : 0;
    const y = i < B.nums.length ? B.nums[i] : 0;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x > y) return true;
      if (x < y) return false;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs > ys) return true; // 非数字段按字符串比较
      if (xs < ys) return false;
    }
  }
  // 数字段全相等：预发布视为小于同版本正式版。
  if (!A.pre && !B.pre) return false;
  if (!A.pre && B.pre) return true;
  if (A.pre && !B.pre) return false;
  return comparePre(A.pre, B.pre) > 0;
}

// ───────────────── spec 分类 ─────────────────
export function classifySpec(name, spec) {
  const n = typeof name === 'string' ? name : '';
  const s = typeof spec === 'string' ? spec : '';
  // ① link: / file: → 本地目录（去掉前缀后原样保留路径，解析交给调用方）
  if (/^link:/.test(s) || /^file:/.test(s)) {
    return { kind: 'local', name: n, spec: s, dir: s.replace(/^(link:|file:)/, '') };
  }
  // ② github: / git+ / git: / 含 github.com 的 URL → github
  const gitPrefix = /^(github:|git\+|git:)/i.test(s);
  const githubUrl = /github\.com/i.test(s) &&
    (/^https?:\/\//i.test(s) || /^git@/i.test(s) || /^ssh:/i.test(s) || gitPrefix);
  if (gitPrefix || githubUrl) {
    return { kind: 'github', name: n, spec: s };
  }
  // ③ 官方包与自身 → skip（官方随 DSH 本体升级；禁自更新避免把正在服务的路由一起移除）
  if (/^@deepseek-ai\//.test(n) || n === '@linxin666/dsh-session-archive' ||
      /^dsh-plugin-yanyan-/.test(n) || n === 'dsh-plugin-yanyan-update') {
    return { kind: 'skip', name: n, spec: s };
  }
  // ④ 其余（纯 name@version / ^x.y.z / 普通包名）→ registry
  return { kind: 'registry', name: n, spec: s };
}

// ───────────────── HTTP 工具 ─────────────────
function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, reason: 'body-too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        finish({ ok: false, reason: 'invalid-body' });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'request-error' }));
  });
}

// ───────────────── profile 读取 ─────────────────
// 优先宿主发布的 profileContext.dir；回退 DSH_HOME/profiles/desktop，
// 再遍历 profiles/* 找含 package.json 的目录。
function resolveProfileDir(ctx) {
  let dir = null;
  try {
    const pc = ctx.get('profileContext');
    if (pc && typeof pc.dir === 'string' && pc.dir) dir = pc.dir;
  } catch (error) {
    dir = null;
  }
  if (dir) return dir;
  const home = process.env.DSH_HOME;
  if (!home) return null;
  const direct = path.join(home, 'profiles', 'desktop');
  try {
    if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
  } catch (error) {
    // 继续遍历
  }
  try {
    const profilesRoot = path.join(home, 'profiles');
    const entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const cand = path.join(profilesRoot, ent.name);
      try {
        if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
      } catch (error) {
        // 忽略单个候选
      }
    }
  } catch (error) {
    // 忽略
  }
  return null;
}

function readDependencies(profileDir) {
  const raw = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  return pkg && pkg.dependencies && typeof pkg.dependencies === 'object'
    ? pkg.dependencies
    : {};
}

function readProfile(ctx) {
  const profileDir = resolveProfileDir(ctx);
  if (!profileDir) return { error: 'profileDir-unavailable', message: '无法定位当前 profile 目录。' };
  let deps;
  try {
    deps = readDependencies(profileDir);
  } catch (error) {
    return { error: 'profile-read-failed', message: String((error && error.message) || error) };
  }
  return { profileDir, deps };
}

// fs.realpathSync 找它自己或向上最多 3 层含 .git 的根。
function findGitRoot(startDir) {
  let real;
  try {
    real = fs.realpathSync(startDir);
  } catch (error) {
    return null;
  }
  let cur = real;
  for (let i = 0; i <= 3; i++) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) return cur;
    } catch (error) {
      return null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function git(cwd, args, timeoutMs) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: Math.max(1000, Math.min(timeoutMs, 30000)),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

async function fetchLatest(pkgName, cfg) {
  const url = cfg.registryUrl + '/' + encodeURIComponent(pkgName) + '/latest';
  const resp = await fetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  if (!resp || !resp.ok) throw new Error('registry HTTP ' + (resp && resp.status));
  const data = await resp.json();
  const version = String((data && data.version) || '');
  if (!version) throw new Error('registry 未返回 version');
  return version;
}

// ───────────────── 逐行检查 ─────────────────
async function checkLocal(pkgName, dir, profileDir, cfg) {
  const absDir = path.isAbsolute(dir) ? dir : path.join(profileDir, dir);
  const gitRoot = findGitRoot(absDir);
  if (!gitRoot) {
    return { id: pkgName, kind: 'local', hasUpdate: false, reason: 'localNoGit', dir };
  }
  try {
    const head = git(gitRoot, ['rev-parse', 'HEAD'], cfg.timeoutMs);
    const branch = git(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], cfg.timeoutMs);
    if (!branch || branch === 'HEAD') {
      return { id: pkgName, kind: 'local', hasUpdate: false, reason: 'detachedHead', dir };
    }
    // fetch 失败不阻断：仍可用本地已经存在的 origin/<branch> 引用比较。
    try {
      git(gitRoot, ['fetch', 'origin', branch], cfg.timeoutMs);
    } catch (error) {
      // 网络不可用时退化为本地已有远端引用
    }
    const remote = git(gitRoot, ['rev-parse', 'origin/' + branch], cfg.timeoutMs);
    const short = (sha) => String(sha || '').slice(0, 7);
    return {
      id: pkgName,
      current: short(head),
      latest: short(remote),
      kind: 'local',
      hasUpdate: head !== remote,
      dir,
      branch,
    };
  } catch (error) {
    return {
      id: pkgName,
      kind: 'local',
      hasUpdate: false,
      dir,
      error: String((error && error.message) || error),
    };
  }
}

async function checkRegistry(pkgName, profileDir, cfg) {
  let current = '';
  try {
    const pkgPath = path.join(profileDir, 'node_modules', pkgName, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    current = String((pkg && pkg.version) || '');
  } catch (error) {
    return {
      id: pkgName,
      kind: 'registry',
      hasUpdate: false,
      error: '读取已装版本失败：' + String((error && error.message) || error),
    };
  }
  if (!current) {
    return { id: pkgName, kind: 'registry', hasUpdate: false, error: '已装版本为空' };
  }
  let latest = '';
  try {
    latest = await fetchLatest(pkgName, cfg);
  } catch (error) {
    return {
      id: pkgName,
      kind: 'registry',
      current,
      hasUpdate: false,
      error: String((error && error.message) || error),
    };
  }
  return { id: pkgName, current, latest, kind: 'registry', hasUpdate: gt(latest, current) };
}

async function checkAll(ctx, cfg) {
  const prof = readProfile(ctx);
  if (prof.error) return { updates: [], skipped: 0, rows: [], error: prof.message };
  const rows = [];
  let skipped = 0;
  for (const pkgName of Object.keys(prof.deps)) {
    let cls;
    try {
      cls = classifySpec(pkgName, prof.deps[pkgName]);
    } catch (error) {
      skipped += 1;
      continue;
    }
    if (cls.kind === 'skip') {
      skipped += 1;
      continue;
    }
    if (cls.kind === 'local' && !cfg.includeLocal) {
      skipped += 1;
      continue;
    }
    if (cls.kind === 'registry' && !cfg.includeRegistry) {
      skipped += 1;
      continue;
    }
    let row;
    try {
      if (cls.kind === 'local') {
        row = await checkLocal(pkgName, cls.dir, prof.profileDir, cfg);
      } else if (cls.kind === 'registry') {
        row = await checkRegistry(pkgName, prof.profileDir, cfg);
      } else if (cls.kind === 'github') {
        row = { id: pkgName, kind: 'github', hasUpdate: false, reason: 'githubUnsupported' };
      } else {
        skipped += 1;
        continue;
      }
    } catch (error) {
      row = {
        id: pkgName,
        kind: cls.kind,
        hasUpdate: false,
        error: String((error && error.message) || error),
      };
    }
    if (row) rows.push(row);
  }
  return { updates: rows.filter((r) => r.hasUpdate === true), skipped, rows };
}

// ───────────────── 逐行更新 ─────────────────
function isValidId(id, deps) {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  if (!s) return false;
  if (s.indexOf('..') >= 0) return false;
  if (s.indexOf('\\') >= 0) return false;
  const slashes = (s.match(/\//g) || []).length;
  // 除 scoped 包名的单个 @scope/ 外，禁止任何斜杠（防路径穿越 / 任意 spec）。
  const isScoped = s.charAt(0) === '@' && slashes === 1;
  if (slashes > 0 && !isScoped) return false;
  // 必须在本次 dependencies 名单里。
  return Object.prototype.hasOwnProperty.call(deps, s);
}

function isProtected(id) {
  return /^dsh-plugin-yanyan-/.test(id) ||
    id === '@linxin666/dsh-session-archive' ||
    /^@deepseek-ai\//.test(id);
}

// 兼容三种返回形态：host 服务直接返回 ChangeResult；remote proxy 包成 { ok, value }；
// 官方 updateBundle 返回 PluginUpdateResult（结果在 .result）。
function changeOf(outcome) {
  if (!outcome || typeof outcome !== 'object') return outcome;
  if (outcome.value && typeof outcome.value === 'object') return outcome.value;
  if (outcome.result && typeof outcome.result === 'object') return outcome.result;
  return outcome;
}

// 官方管理器把失败折叠进返回值（application: 'failed' / 'cancelled'），而不是抛错；
// 部分形态只带 error.code（如 already-installed / incompatible），同样视为失败。
function nativeManagerFailure(outcome) {
  if (!outcome || typeof outcome !== 'object') return false;
  if (outcome.ok === false) return true;
  const c = changeOf(outcome);
  const app = c.application || outcome.application;
  if (app === 'failed' || app === 'cancelled') return true;
  const err = c.error || outcome.error;
  if (err && typeof err.code === 'string' && err.code) return true;
  return false;
}

// 读取官方管理器拒绝码：gateway.ts 用 verdict.error?.code 判定 already-installed。
function refusalCode(outcome) {
  if (!outcome || typeof outcome !== 'object') return '';
  const c = changeOf(outcome);
  const err = c.error || outcome.error;
  const code = err && err.code;
  return typeof code === 'string' ? code : '';
}

// 解析官方 pluginManager.updateBundle 的返回值 PluginUpdateResult：
// { from, to, step, result: ChangeResult, restore?: ChangeResult }。
// ChangeResult.application: applied / restart-required / overridden / failed / cancelled。
// 官方在 HMR 下「安装失败或取消会把被移除的版本重新装回」并写入 restore，
// 因此本函数只读结果、绝不在本包层补做 removeBundle。
export function parseUpdateResult(outcome) {
  const base = { ok: false, updated: false, restartRequired: false, restored: false };
  if (!outcome || typeof outcome !== 'object') {
    return Object.assign({}, base, {
      error: 'update-failed',
      message: '更新未返回有效结果，请到插件页确认该插件安装状态。',
    });
  }
  // 兼容 remote proxy 把 PluginUpdateResult 包在 { ok, value } 里的形态。
  const src = outcome.value && typeof outcome.value === 'object' ? outcome.value : outcome;
  const r = src.result && typeof src.result === 'object' ? src.result : {};
  const app = r.application || src.application;
  const step = src.step;
  const successful = app === 'applied' || app === 'restart-required' || app === 'overridden';
  // 官方成功态 step 恒为 install；兼容个别 proxy 省略 step 的情形。
  // outcome.ok === false 是 proxy 层显式失败（此时本包也从未 remove，原版本必在）。
  if (successful && outcome.ok !== false && (!step || step === 'install')) {
    return {
      ok: true,
      updated: true,
      restartRequired: app !== 'applied',
      restored: true,
      message: app === 'applied'
        ? '更新完成，已即时生效。'
        : '更新完成，重启 DSH 服务后生效。',
    };
  }
  // 失败：有 restore 字段则以其结果为准；无 restore 时，官方拒绝在 check 阶段
  // 或非 HMR 覆盖安装失败，原安装均未被移除，一律视为已保留（本包也从不在此分支 remove）。
  const restore = src.restore;
  const restoredByOfficial = restore && typeof restore === 'object'
    ? !nativeManagerFailure(restore)
    : true;
  const reason = r.error && (r.error.diagnostic || r.error.code)
    ? String(r.error.diagnostic || r.error.code)
    : String(app || step || '未知原因');
  return Object.assign({}, base, {
    error: app === 'cancelled' ? 'update-cancelled' : 'update-failed',
    restored: restoredByOfficial,
    message: restoredByOfficial
      ? '更新未完成（' + reason + '），原版本已保留，请稍后重试。'
      : '更新未完成（' + reason + '），请到插件页确认该插件是否缺失，如已缺失请手动重装。',
    detail: JSON.stringify(r.error || {}),
  });
}

async function updateLocal(id, cls, profileDir, cfg) {
  const base = { ok: false, updated: false, restartRequired: false, id };
  const dir = cls.dir || '';
  const absDir = path.isAbsolute(dir) ? dir : path.join(profileDir, dir);
  const gitRoot = findGitRoot(absDir);
  if (!gitRoot) {
    return Object.assign({}, base, { error: 'localNoGit', message: '本地源码，无法自动更新' });
  }
  try {
    const branch = git(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], cfg.timeoutMs);
    if (!branch || branch === 'HEAD') {
      return Object.assign({}, base, { error: 'detachedHead', message: '当前处于游离 HEAD，请手动更新。' });
    }
    git(gitRoot, ['fetch', 'origin', branch], cfg.timeoutMs);
    const head = git(gitRoot, ['rev-parse', 'HEAD'], cfg.timeoutMs);
    const remote = git(gitRoot, ['rev-parse', 'origin/' + branch], cfg.timeoutMs);
    if (head === remote) {
      return { ok: true, updated: false, restartRequired: false, id,
        reason: 'already-latest', message: '已是最新版本，无需更新。' };
    }
    git(gitRoot, ['merge', '--ff-only', 'origin/' + branch], cfg.timeoutMs);
    return { ok: true, updated: true, restartRequired: true, id,
      message: '更新完成，重启 DSH 服务后生效。' };
  } catch (error) {
    return Object.assign({}, base, {
      error: 'git-update-failed',
      message: String((error && error.message) || error),
    });
  }
}

// io 为可选注入点，仅供单测替换 IO（network / fs / manager 来源），生产调用省略。
// 单测据此完全不触碰真实 pluginManager、npm registry 与 profile 文件。
export async function updateRegistry(ctx, id, cfg, deps, io) {
  const ioRef = io || {};
  const fetchLatestFn = ioRef.fetchLatest || fetchLatest;
  const resolveProfileDirFn = ioRef.resolveProfileDir || resolveProfileDir;
  const readDependenciesFn = ioRef.readDependencies || readDependencies;
  const base = { ok: false, updated: false, restartRequired: false, id };
  // 已查证官方契约（dsh-web-0.4.16 ... gateway.ts 与 app.asar）：
  //   pluginManager.updateBundle(name, version, options) 内建原子回滚；
  //   installBundle(spec, { enabled, requestId }) / removeBundle(name) 仅在降级时使用。
  let manager = Object.prototype.hasOwnProperty.call(ioRef, 'manager')
    ? ioRef.manager
    : null;
  if (manager === null) {
    try {
      manager = ctx.get('pluginManager');
    } catch (error) {
      manager = null;
    }
  }
  const hasUpdate = manager && typeof manager.updateBundle === 'function';
  const hasTwoPhase = manager && typeof manager.removeBundle === 'function' &&
    typeof manager.installBundle === 'function';
  if (!hasUpdate && !hasTwoPhase) {
    // 找不到或形态不明时绝不乱调，退化为明确的手动更新提示；此时绝未动过安装状态。
    return Object.assign({}, base, {
      error: 'native-manager-unavailable',
      restored: true,
      message: '未找到可用的官方插件管理器，原版本未改动，请手动更新该插件。',
    });
  }
  let latest;
  try {
    latest = await fetchLatestFn(id, cfg);
  } catch (error) {
    return Object.assign({}, base, {
      error: 'registry-fetch-failed',
      restored: true,
      message: '无法读取最新版本：' + String((error && error.message) || error),
    });
  }
  const previousSpec = deps[id];
  const restoreSpec = id + '@' + previousSpec;
  const targetSpec = id + '@' + latest;
  const requestId = 'yanyan-update-' + id + '-' + Date.now() + '-' +
    Math.random().toString(36).slice(2, 8);

  // 首选：直接复用官方 updateBundle。HMR 下安装失败/取消时官方自动把移除的版本
  // 重新装回（写入 restore 字段）；非 HMR 直接覆盖安装，根本不先卸载。
  // 因此本包绝不自行 removeBundle，从根子上杜绝「已卸载且没装回」。
  if (hasUpdate) {
    let outcome;
    try {
      outcome = await manager.updateBundle(id, latest, { requestId });
    } catch (error) {
      // 调用本身抛错时本包并未卸载任何东西，原安装仍在。
      return Object.assign({}, base, {
        error: 'update-failed',
        restored: true,
        message: '官方更新调用异常（' + String((error && error.message) || error) +
          '），原版本未被卸载，请稍后重试。',
        detail: String((error && error.message) || error),
      });
    }
    return Object.assign({}, base, parseUpdateResult(outcome), {
      id,
      spec: targetSpec,
    });
  }

  // 降级：旧版 DSH 无 updateBundle。对齐官方 gateway.ts 的 runNativeUpdate：
  // 先尝试覆盖式 installBundle(targetSpec)，仅当官方明确以 already-installed 拒绝时，
  // 才不得不进入 removeBundle + installBundle 两阶段。任何失败都 ensureRestore 装回原 spec。
  let removed = false;
  const ensureRestore = async () => {
    if (!removed) return true; // 从未卸载，原安装必然保留
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
      try {
        const rr = await manager.installBundle(restoreSpec, { enabled: true });
        ok = !nativeManagerFailure(rr);
      } catch (error2) {
        ok = false;
      }
    }
    if (ok) return true;
    // 管理器返回被拒也可能是「已装回」的假阴性，再查 profile 依赖兜底二次核验。
    try {
      const after = ioRef.profileDeps || null;
      if (after && Object.prototype.hasOwnProperty.call(after, id)) return true;
      const dir = resolveProfileDirFn(ctx);
      const depsAfter = dir ? readDependenciesFn(dir) : null;
      if (depsAfter && Object.prototype.hasOwnProperty.call(depsAfter, id)) return true;
    } catch (error3) {
      // 无法确认时如实报告未装回，交由用户手动重装。
    }
    return false;
  };
  const failResult = (err, restored) => Object.assign({}, base, {
    error: 'update-failed',
    restored: Boolean(restored),
    message: restored
      ? '更新失败，已装回原版本，请稍后重试。'
      : '更新失败，未能装回原版本，请到插件页手动重新安装该插件。',
    detail: String((err && err.message) || err),
  });

  try {
    const first = await manager.installBundle(targetSpec, { enabled: true });
    if (refusalCode(first) !== 'already-installed') {
      if (nativeManagerFailure(first)) {
        // 覆盖安装失败，但从未卸载，原版本仍在；文案据此如实说明「未被卸载」。
        return Object.assign({}, base, {
          error: 'update-failed',
          restored: true,
          message: '更新失败，原版本未被卸载，请稍后重试。',
          detail: String((first && first.error &&
            (first.error.diagnostic || first.error.code)) || '覆盖安装被拒绝'),
        });
      }
      return { ok: true, updated: true, restartRequired: true, id, spec: targetSpec,
        message: '更新完成，重启 DSH 服务后生效。' };
    }
    // 官方以 already-installed 拒绝，进入两阶段；此后任何异常都必须装回原版本。
    const r1 = await manager.removeBundle(id);
    if (nativeManagerFailure(r1)) {
      return failResult(new Error('removeBundle 被拒绝：' + JSON.stringify(r1)), true);
    }
    removed = true;
    const r2 = await manager.installBundle(targetSpec, { enabled: true });
    if (nativeManagerFailure(r2)) {
      const restored = await ensureRestore();
      return failResult(new Error('installBundle 被拒绝：' + JSON.stringify(r2)), restored);
    }
    return { ok: true, updated: true, restartRequired: true, id, spec: targetSpec,
      message: '更新完成，重启 DSH 服务后生效。' };
  } catch (error) {
    const restored = await ensureRestore();
    return failResult(error, restored);
  }
}

// ───────────────── 路由 handler ─────────────────
function makeHealthHandler(ctx, cfg, fence) {
  return function healthHandler(req, res) {
    if (!fence(req)) {
      respond(res, 403, FORBIDDEN_BODY);
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      respond(res, 405, { ok: false, error: 'method-not-allowed', message: '只接受 GET 或 POST 请求。' });
      return;
    }
    respond(res, 200, { ok: true, name, version: VERSION });
  };
}

function makeCheckHandler(ctx, cfg, fence) {
  return async function checkHandler(req, res) {
    if (!fence(req)) {
      respond(res, 403, FORBIDDEN_BODY);
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      respond(res, 405, { ok: false, error: 'method-not-allowed', message: '只接受 POST 请求。' });
      return;
    }
    try {
      const result = await checkAll(ctx, cfg);
      respond(res, 200, {
        ok: true,
        updates: result.updates,
        skipped: result.skipped,
        checkOnOpen: cfg.checkOnOpen,
        rows: result.rows,
        error: result.error || undefined,
      });
    } catch (error) {
      respond(res, 200, {
        ok: true,
        updates: [],
        skipped: 0,
        error: String((error && error.message) || error),
      });
    }
  };
}

function makeUpdateHandler(ctx, cfg, fence) {
  return async function updateHandler(req, res) {
    if (!fence(req)) {
      respond(res, 403, FORBIDDEN_BODY);
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      respond(res, 405, { ok: false, error: 'method-not-allowed', message: '只接受 POST 请求。' });
      return;
    }
    let payload;
    try {
      const read = await readBody(req);
      payload = read.ok ? JSON.parse(read.text || '{}') : {};
    } catch (error) {
      payload = {};
    }
    const id = payload && typeof payload.id === 'string' ? payload.id.trim() : '';
    const base = { ok: false, updated: false, restartRequired: false, id };
    // 统一的 200 错误体便于前端逐行处理，异常不外抛。
    const prof = readProfile(ctx);
    if (prof.error) {
      respond(res, 200, Object.assign({}, base, { error: prof.error, message: prof.message }));
      return;
    }
    if (!isValidId(id, prof.deps)) {
      respond(res, 200, Object.assign({}, base, {
        error: 'invalid-id',
        message: '插件标识不合法或不在已安装名单中。',
      }));
      return;
    }
    if (isProtected(id)) {
      respond(res, 200, Object.assign({}, base, {
        error: 'forbidden-self-update',
        message: '该插件不允许在此更新。',
      }));
      return;
    }
    let cls;
    try {
      cls = classifySpec(id, prof.deps[id]);
    } catch (error) {
      cls = { kind: 'skip', name: id, spec: prof.deps[id] };
    }
    let result;
    try {
      if (cls.kind === 'local') {
        result = await updateLocal(id, cls, prof.profileDir, cfg);
      } else if (cls.kind === 'registry') {
        result = await updateRegistry(ctx, id, cfg, prof.deps);
      } else if (cls.kind === 'github') {
        result = Object.assign({}, base, {
          error: 'unsupported',
          message: '该来源暂不支持一键更新，请到源码目录手动更新。',
        });
      } else {
        result = Object.assign({}, base, { error: 'skip', message: '该插件不需要在此更新。' });
      }
    } catch (error) {
      result = Object.assign({}, base, {
        error: 'update-exception',
        message: String((error && error.message) || error),
      });
    }
    respond(res, 200, result);
  };
}

// ───────────────── apply ─────────────────
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  // 统一准入：仅当 requestRejection 返回 undefined 时放行（不自建信任例外）。
  const fence = (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined;
    } catch (error) {
      return false;
    }
  };
  const routes = [
    { path: ROUTE_BASE + '/health', handler: makeHealthHandler(ctx, cfg, fence) },
    { path: ROUTE_BASE + '/check', handler: makeCheckHandler(ctx, cfg, fence) },
    { path: ROUTE_BASE + '/update', handler: makeUpdateHandler(ctx, cfg, fence) },
  ];
  // register 的返回值直接作为 effect 的清理函数，禁用 / HMR 时路由自动撤销。
  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-plugin-yanyan-update: route ' + route.path,
    );
  }
  try {
    ctx.logger?.info?.('[dsh-plugin-yanyan-update] host routes ready');
  } catch (error) {
    // 日志服务不可用时不影响路由注册
  }
}
