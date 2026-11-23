// dsh-plugin-yanyan-subagent — Client half（纯 JavaScript，无 JSX、无构建工具）。
//
// 装载方式照抄 dsh-plugin-wechat-session/lib/client.js:47-60：通过 __ModuleLoader__
// 注册一个 factory，宿主用 require('react') / require('react-dom') 提供运行时。
// 拿不到 react 就降级成纯 DOM 注入；拿不到 react-dom 就把浮层 div 直接 append
// 到 document.body（官方 header.actions 槽会裁剪溢出内容，浮层必须脱离该容器）。
//
// 所有 UI 文案固定走内部中文（UI_zh）；en 字典只用于满足 ctx.locale.register
// 「zh 为 key 源、en 键集完整」的注册契约，不参与实际显示，保证中文 UI。
//
// 行尾删除按钮文字使用 U+2715（乘号，普通 Unicode 数学符号，非 emoji），
// 并带中文 aria-label / title；语义属性 data-dsh-plugin + data-dsh-part 全局覆盖。

(function (root) {
  if (!root) return;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-plugin-yanyan-subagent',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var React = null;
      try { React = require('react') || null; } catch (e) { React = null; }
      var ReactDOM = null;
      try { ReactDOM = require('react-dom') || null; } catch (e) { ReactDOM = null; }

      var doc = root.document || null;
      var NS = 'yanyan-subagent';
      var ROUTE_BASE = '/__dsh-plugin-yanyan-subagent';
      var DEFAULT_TAB_LABEL = '智能体管理';
      var X_MARK = '\u2715'; // U+2715 MULTIPLICATION X，非 emoji

      // localStorage 键（改名 / 自动清理设置持久化）。
      var LS_LABEL = 'yanyan-subagent.tabLabel';
      var LS_AUTO = 'yanyan-subagent.autoCleanEnabled';
      var LS_IDLE = 'yanyan-subagent.idleMinutes';
      var LS_INTERVAL = 'yanyan-subagent.checkIntervalMin';
      // 空闲起点持久化：重启后继续累计空闲时长，不再从零开始计时。
      var LS_FIRST_SEEN = 'yanyan-subagent.firstSeen';
      // 已彻底删除的 id 清单。subagentCatalog 由父会话日志的 subagent/catalog
      // 事件 append-only 重建（官方 dsh-chunked-list 仅追加），删目录/归档都
      // 无法移除引用：宿主下次 refreshProjections 会把条目带回来。只有把 id
      // 记在浏览器本地、在渲染与清理时持续过滤，才能让删除真正生效。
      var LS_DELETED = 'yanyan-subagent.deletedIds';

      // ───────────────── 字典（zh 为 key 源，en 键集完整对照） ─────────────────
      var UI_zh = {
        tab: '智能体管理',
        title: '子智能体管理',
        empty: '当前会话暂无子智能体',
        idle: '空闲',
        running: '运行中',
        delete: '删除',
        deleting: '删除中…',
        deleted: '已删除',
        cleanIdle: '清理全部空闲',
        cleaning: '清理中…',
        cleanDone: '已清理 {count} 个空闲子智能体',
        cleanNoIdle: '当前没有可清理的空闲子智能体',
        manualCleanHint: '手动清理不受空闲阈值限制；阈值仅用于定时自动清理',
        failed: '失败',
        close: '关闭',
        rename: '重命名标签',
        save: '保存',
        autoClean: '自动清理空闲子智能体',
        idleMinutes: '空闲超过（分钟）',
        confirmDelete: '确定彻底删除该子智能体？此操作不可逆，将删除其会话数据并从列表移除。',
        cancel: '取消',
        settings: '设置',
        refresh: '刷新',
        refreshing: '正在刷新…',
        refreshed: '已刷新',
        tabRenameHint: '输入新的标签名称',
        unknown: '未知',
        unsupported: '浏览器数据不可用',
        // 扩展键（en 必须逐键对照）。
        confirmDeleteRunning: '该子智能体正在运行，将停止并彻底删除（不可逆）。确定继续？',
        idleThreshold: '空闲阈值',
        minutes: '分钟',
        saved: '已保存',
        diagnostic: '诊断',
        root: '根会话',
        noRoot: '未找到当前会话',
        stopHint: '运行中，删除将停止该子智能体',
        checkInterval: '巡检间隔（分钟）',
        autoCleanHint: '开启后按巡检间隔自动清理超过阈值的空闲子智能体',
        scrubResidual: '清理残留行',
        scrubbing: '正在根除残留行…',
        scrubDone: '已根除 {count} 条残留目录行，侧边栏已同步刷新',
        scrubNoResidual: '没有发现需要清理的残留行',
        scrubFailed: '清理残留行失败',
        catalogRetired: '已彻底删除，残留目录行已从会话日志根除',
        catalogQueued: '已删除；日志改写遇到并发写入，已排队下次启动补做',
      };
      var UI_en = {
        tab: 'Agent Manager',
        title: 'Subagent Management',
        empty: 'No subagents in this session',
        idle: 'Idle',
        running: 'Running',
        delete: 'Delete',
        deleting: 'Deleting...',
        deleted: 'Deleted',
        cleanIdle: 'Clean All Idle',
        cleaning: 'Cleaning...',
        cleanDone: 'Cleaned {count} idle subagents',
        cleanNoIdle: 'No idle subagents to clean',
        manualCleanHint: 'Manual clean ignores the idle threshold; the threshold applies to auto-clean only',
        failed: 'Failed',
        close: 'Close',
        rename: 'Rename Tab',
        save: 'Save',
        autoClean: 'Auto-clean idle subagents',
        idleMinutes: 'Idle over (minutes)',
        confirmDelete: 'Delete this subagent permanently? This is irreversible: its session data is removed and it disappears from the list.',
        cancel: 'Cancel',
        settings: 'Settings',
        refresh: 'Refresh',
        refreshing: 'Refreshing...',
        refreshed: 'Refreshed',
        tabRenameHint: 'Enter a new tab name',
        unknown: 'Unknown',
        unsupported: 'Browser data unavailable',
        confirmDeleteRunning: 'This subagent is running and will be stopped and deleted permanently (irreversible). Continue?',
        idleThreshold: 'Idle threshold',
        minutes: 'min',
        saved: 'Saved',
        diagnostic: 'Diagnostic',
        root: 'Root session',
        noRoot: 'Current session not found',
        stopHint: 'Running; deletion will stop this subagent',
        checkInterval: 'Check interval (minutes)',
        autoCleanHint: 'When enabled, idle subagents over the threshold are cleaned at each check',
        scrubResidual: 'Clean residual rows',
        scrubbing: 'Removing residual rows...',
        scrubDone: 'Removed {count} residual catalog rows; sidebar refreshed',
        scrubNoResidual: 'No residual rows to clean',
        scrubFailed: 'Failed to clean residual rows',
        catalogRetired: 'Deleted permanently; residual catalog row removed from the session log',
        catalogQueued: 'Deleted; log rewrite hit a concurrent write and is queued for next start',
      };

      // 固定中文翻译；支持 {name} 占位符替换（cleanDone 的 {count}）。
      function t(key, params) {
        var s = Object.prototype.hasOwnProperty.call(UI_zh, key) ? UI_zh[key] : key;
        if (params) {
          for (var k in params) {
            if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
            s = s.split('{' + k + '}').join(String(params[k]));
          }
        }
        return s;
      }

      // ───────────────── 纯 helpers ─────────────────
      function clampInt(v, min, max, fallback) {
        var n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        n = Math.floor(n);
        if (n < min || n > max) return fallback;
        return n;
      }

      // catalog 兼容解析：数组 / {entries:[]} / {rows:[]} / 空。
      // 磁盘 projcache 里的 chunked-list 条目字段是 `childId`，而客户端
      // session store 的投影通常已转成 `id`；这里统一补齐 id，保证删除按钮、
      // 隐藏清单过滤、根会话判定在任何数据源下都拿到同一个主键。
      function parseCatalogLocal(raw) {
        var isRow = function (x) { return !!x && typeof x === 'object' && !Array.isArray(x); };
        var list;
        if (Array.isArray(raw)) list = raw.filter(isRow);
        else if (raw && typeof raw === 'object') {
          if (Array.isArray(raw.entries)) list = raw.entries.filter(isRow);
          else if (Array.isArray(raw.rows)) list = raw.rows.filter(isRow);
          else list = [];
        } else list = [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          if (!r.id && r.childId) r.id = r.childId;
          if (!r.childId && r.id) r.childId = r.id;
          out.push(r);
        }
        return out;
      }

      // 空闲清理筛选（与 host 的 idleFilter 同逻辑，供自动清理 / 批量清理复用）。
      function idleFilterLocal(rows, options) {
        var opts = options || {};
        var rootId = opts.rootId;
        var idleMinutes = typeof opts.idleMinutes === 'number' && Number.isFinite(opts.idleMinutes)
          ? opts.idleMinutes : 30;
        var now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
        var since = typeof opts.idleSince === 'function' ? opts.idleSince : function () { return now; };
        var threshold = idleMinutes > 0 ? idleMinutes * 60 * 1000 : 0;
        var out = [];
        var list = Array.isArray(rows) ? rows : [];
        for (var i = 0; i < list.length; i++) {
          var row = list[i];
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          if (row.kind === 'diagnostic') continue;
          // 与列表「空闲」标签、manualCleanTargets 口径一致：只排除运行中。
          // 官方 catalog 行没有 activity 字段，不能要求 activity==='inactive'，
          // 否则定时自动清理永远筛不到目标（这正是「自动删除不触发」的根因）。
          // 运行中既可能是 host /running 标的 row.running，也可能是旧行的 activity。
          if (row.running === true || row.activity === 'running') continue;
          if (rootId != null && row.id === rootId) continue;
          var started = since(row.id);
          var base = typeof started === 'number' && Number.isFinite(started) ? started : now;
          if (threshold > 0 && (now - base) < threshold) continue;
          out.push(row);
        }
        return out;
      }

      // 手动「清理全部空闲」的目标筛选：与 renderRow 的「空闲」标签、host /cleanup
      // 的「清理所有非 running」语义对齐。列表里显示为空闲（非运行中）的条目都应能
      // 被一键清掉，而不是要求 activity==='inactive' 且空闲满 idleMinutes —— 官方
      // catalog 行根本没有 idleSince / lastActiveAt 字段，客户端 firstSeen 又是打开
      // 浮层后才起步，套阈值会让按钮几乎永远「已清理 0 个空闲子智能体」。
      // 排除：非对象、无 id、diagnostic、running、rootId 自身、已在隐藏清单里的 id。
      // 不套 idleMinutes 阈值：阈值只约束定时自动清理（autoCleanTick）。
      function manualCleanTargets(rows, options) {
        var opts = options || {};
        var rootId = opts.rootId;
        var isHidden = typeof opts.isHidden === 'function' ? opts.isHidden : function () { return false; };
        var out = [];
        var list = Array.isArray(rows) ? rows : [];
        for (var i = 0; i < list.length; i++) {
          var row = list[i];
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          if (row.kind === 'diagnostic') continue;
          // 内联判定（不调用 isRowRunning）：本函数被 portal-interaction 测试单独提取
          // 到 vm 执行，函数体内不可依赖外部符号。running 既可能来自 host /running
          // 标的 row.running，也可能是旧行的 activity==='running'。
          if (row.running === true || row.activity === 'running') continue;
          // 主键统一用 row.id：parseCatalogLocal 已给每行补齐 id，且与 renderRow /
          // deleteOne / onRowDelete 用同一个主键，避免「选中了却删不掉」。
          var id = row.id;
          if (!id || typeof id !== 'string') continue;
          if (rootId != null && (id === rootId || coreId(id) === coreId(rootId))) continue;
          if (isHidden(id) || (row.childId && isHidden(row.childId))) continue;
          out.push(row);
        }
        return out;
      }

      function readLS(key) {
        try { return root.localStorage.getItem(key); } catch (e) { return null; }
      }
      function writeLS(key, val) {
        try { root.localStorage.setItem(key, String(val)); } catch (e) {}
      }

      // 空闲起点持久化：内存 Map 重启即清零，导致重启后空闲时长从零重算、
      // 30 分钟阈值迟迟不满足。落到 localStorage 后跨重启继续累计。
      // key 统一用 coreId 归一化，兼容 catalog 行带/不带 session- 前缀两种写法。
      function loadFirstSeen() {
        var map = new Map();
        try {
          var raw = readLS(LS_FIRST_SEEN);
          var obj = raw ? JSON.parse(raw) : null;
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            var now = Date.now();
            for (var k in obj) {
              var ts = obj[k];
              // 丢弃非法或超过 30 天的陈旧记录，避免历史垃圾导致误删。
              if (typeof ts === 'number' && isFinite(ts) && ts > 0 && now - ts < 30 * 24 * 60 * 60 * 1000) {
                map.set(coreId(k), ts);
              }
            }
          }
        } catch (e) {}
        return map;
      }
      function persistFirstSeen() {
        try {
          var obj = {};
          var n = 0;
          shared.firstSeen.forEach(function (ts, id) {
            if (n++ < 1000) obj[id] = ts; // 上限，避免 localStorage 无限增长
          });
          writeLS(LS_FIRST_SEEN, JSON.stringify(obj));
        } catch (e) {}
      }

      // ───────────────── 已删除 id 的持久化隐藏清单 ─────────────────
      // catalog 的 childId 可能带或不带 `session-` 前缀（同一会话在父 catalog
      // 里是裸 uuid，在归档清单里是 session-uuid）。用「去前缀后的核心 id」
      // 做主键，保证两种写法都命中。
      function coreId(id) {
        return String(id || '').replace(/^session-/, '');
      }
      // 统一的「运行中」判定：官方 catalog 行没有 activity 字段，真实状态由
      // host /running 路由按 ctx.get('agents') 标到 row.running 上；同时兼容旧的
      // activity==='running' 行。所有「是否运行中」的判断都走这里，避免各处口径不一。
      function isRowRunning(row) {
        return !!row && (row.running === true || row.activity === 'running');
      }
      function readDeletedIds() {
        try {
          var raw = readLS(LS_DELETED);
          var arr = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(arr)) return [];
          return arr.filter(function (x) { return typeof x === 'string' && x; }).map(coreId);
        } catch (e) { return []; }
      }
      function writeDeletedIds(list) {
        // 去重 + 限定上限，避免 localStorage 无限增长。
        var seen = {}, out = [];
        for (var i = 0; i < list.length; i++) {
          var c = coreId(list[i]);
          if (!c || seen[c]) continue;
          seen[c] = true; out.push(c);
        }
        if (out.length > 500) out = out.slice(out.length - 500);
        writeLS(LS_DELETED, JSON.stringify(out));
      }
      function markDeleted(id) {
        var list = readDeletedIds();
        var c = coreId(id);
        if (c && list.indexOf(c) === -1) { list.push(c); writeDeletedIds(list); }
      }
      function isDeleted(id) {
        var c = coreId(id);
        if (!c) return false;
        return readDeletedIds().indexOf(c) !== -1;
      }
      // 从 catalog 行集合里剔除已删除条目，供渲染 / 批量清理 / 自动清理复用。
      function filterDeleted(rows) {
        var list = Array.isArray(rows) ? rows : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          if (!r || typeof r !== 'object') continue;
          if (r.id && isDeleted(r.id)) continue;
          if (r.childId && isDeleted(r.childId)) continue;
          out.push(r);
        }
        return out;
      }

      // 当前会话是否检测到子智能体 —— 顶部「子智能体管理」按钮显隐的唯一判据。
      // rows 是 loadRows 读到的当前会话 catalog：排除诊断行 / 已删除行 / 根会话行后
      // 仍有行，才算「有子智能体」。数据源不支持（unsupported）时保守返回 true，
      // 避免探测失败把管理入口永久藏掉；真正"没有"只在数据成功加载且确认为空时判定。
      function hasSubagents() {
        if (shared.unsupported) return true;
        var rows = Array.isArray(shared.rows) ? shared.rows : [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || typeof r !== 'object') continue;
          if (r.kind === 'diagnostic') continue;
          var id = r.id || r.childId;
          if (id && isDeleted(id)) continue;
          if (id && shared.rootId && id === shared.rootId) continue;
          return true;
        }
        return false;
      }

      // 根治「删不掉」：官方「N 个子智能体」浮层 SubagentHeaderLineage 只读
      // client 内存 store `projectionsBySession[*].values.subagentCatalog`。宿主对
      // 已加载的 live 父会话复用内存 fold state，改磁盘日志 / 删 projcache 都不会
      // 让它重算 —— 这正是残留行「磁盘已干净却仍显示」的真正原因。本函数把
      // 持久化隐藏清单（LS_DELETED）同样应用到这份内存投影：命中已删除 id 的
      // catalog 条目直接剔除，并用 list.set 写回同一个 store（宿主的 projectList /
      // publishRetention 自己就用 list.set，是合法写入口）。
      // 幂等收敛：写回后再触发 subscribe 时已无命中，不再 set，不会自激循环；
      // manager 的 projectList 若把旧值重新 set 回来，紧随的 subscribe 会再次剔除。
      function patchProjections(ctx) {
        try {
          var hidden = readDeletedIds();
          if (!hidden.length) return;
          var list = ctx.sessions && ctx.sessions.list;
          if (!list || typeof list.getSnapshot !== 'function' || typeof list.set !== 'function') return;
          var snap = list.getSnapshot();
          var projections = snap && snap.projectionsBySession;
          if (!projections || typeof projections !== 'object') return;
          var merged = null;
          for (var sid in projections) {
            if (!Object.prototype.hasOwnProperty.call(projections, sid)) continue;
            var proj = projections[sid];
            var values = proj && proj.values;
            var catalog = values && values.subagentCatalog;
            if (!Array.isArray(catalog)) continue;
            var kept = [], changed = false;
            for (var i = 0; i < catalog.length; i++) {
              var e = catalog[i];
              var cid = e && coreId(e.id || e.childId);
              if (cid && hidden.indexOf(cid) !== -1) { changed = true; continue; }
              kept.push(e);
            }
            if (!changed) continue;
            if (!merged) {
              merged = {};
              for (var k in projections) {
                if (Object.prototype.hasOwnProperty.call(projections, k)) merged[k] = projections[k];
              }
            }
            // 浅拷贝：保留 state/error 等字段与 values 里其它投影键。
            merged[sid] = Object.assign({}, proj, {
              values: Object.assign({}, values, { subagentCatalog: kept }),
            });
          }
          if (!merged) return; // 本轮无命中，不写回（幂等收敛）
          list.set(Object.assign({}, snap, { projectionsBySession: merged }));
        } catch (e) {}
      }

      // 服务懒查：一律走 ctx.get / ctx.reflect.get / ctx[name]，不读未 inject 的属性。
      var rootCtx = null;
      function lookup(name) {
        if (!rootCtx) return null;
        try { var v = rootCtx.get(name); if (v) return v; } catch (e) {}
        try {
          if (rootCtx.reflect && typeof rootCtx.reflect.get === 'function') {
            var v2 = rootCtx.reflect.get(name); if (v2) return v2;
          }
        } catch (e2) {}
        try { var v3 = rootCtx[name]; if (v3) return v3; } catch (e3) {}
        return null;
      }

      function postJson(path, body) {
        var f = root.fetch || (typeof fetch !== 'undefined' ? fetch : null);
        if (!f) return Promise.reject(new Error('fetch-unavailable'));
        return f.call(root, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json(); });
      }

      // ───────────────── 共享状态 ─────────────────
      var shared = {
        tabLabel: DEFAULT_TAB_LABEL,
        autoCleanEnabled: true,
        idleMinutes: 30,
        checkIntervalMin: 10,
        renameDraft: null,
        autoDraft: { autoCleanEnabled: true, idleMinutes: 30, checkIntervalMin: 10 },
        rows: [],
        rootId: '',
        unsupported: false,
        // 空闲起点从 localStorage 恢复，重启后继续累计空闲时长；不再从零开始。
        firstSeen: loadFirstSeen(), // id -> 首次观察到空闲的时刻（coreId 归一化）
        rowStatus: {},        // id -> {state:'deleting'|'deleted'|'failed', message?}
        cleanStatus: '',
        settingsStatus: '',
      };

      // 已挂载的浮层 view 列表；renderAll 统一刷新。
      var views = [];
      var nativeOverlay = null;
      var nativeView = null;
      var officialObserver = null;
      var officialButtons = [];
      var autoTimer = null;
      // 打开浮层时的触发按钮，作为浮层定位锚点（见 positionOverlay）。
      var overlayAnchor = null;
      // hover 模式：鼠标移开后延迟关闭，留出跨越按钮↔浮层间隙的时间。
      var HOVER_CLOSE_DELAY = 200;
      var hoverCloseTimer = null;

      function makeEmitter() {
        var subs = [];
        return {
          subscribe: function (fn) {
            subs.push(fn);
            return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
          },
          emit: function (v) {
            for (var i = 0; i < subs.length; i++) { try { subs[i](v); } catch (e) {} }
          },
        };
      }
      var labelEmitter = makeEmitter();  // 改名后通知顶部按钮刷新文字
      var closeEmitter = makeEmitter();  // React 浮层关闭通知
      // 当前会话是否检测到子智能体：refresh 拿到 rows 后 emit(bool)，
      // 顶部按钮据此显隐（无子智能体时隐藏，检测到再出现）。
      var visibilityEmitter = makeEmitter();

      function readTabLabel() { return shared.tabLabel || DEFAULT_TAB_LABEL; }

      function renderAll() {
        for (var i = 0; i < views.length; i++) { try { views[i].update(); } catch (e) {} }
      }

      // ───────────────── 数据面 ─────────────────
      // rootId 推导：snap.byId 里 retainedBy.mainView > 0 的会话（照抄
      // dsh-session-archive 的 mainViewSessionId 思路）；找不到时遍历
      // projectionsBySession 取有 subagentCatalog 的那个。
      function deriveRootId(ctx) {
        try {
          var snap = ctx.sessions.list.getSnapshot();
          var byId = snap && snap.byId;
          if (byId) {
            for (var k in byId) {
              var row = byId[k];
              if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id || k;
            }
          }
          var pbs = snap && snap.projectionsBySession;
          if (pbs) {
            for (var sid in pbs) {
              var p = pbs[sid];
              if (p && p.values && p.values.subagentCatalog != null) return sid;
            }
          }
        } catch (e) {}
        return '';
      }

      // 自动清理用：枚举所有含 subagentCatalog 投影的会话，而非只看当前主视图。
      // 主视图会话排最前（去重），其余会话依次纳入，确保切到别的会话时，
      // 留在原会话的空闲子智能体依然能被巡检到。
      function deriveAllRootIds(ctx) {
        var ids = [];
        try {
          var snap = ctx.sessions.list.getSnapshot();
          var byId = snap && snap.byId;
          if (byId) {
            for (var k in byId) {
              var row = byId[k];
              if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) {
                var main = row.id || k;
                if (main) ids.push(main);
                break;
              }
            }
          }
          var pbs = snap && snap.projectionsBySession;
          if (pbs) {
            for (var sid in pbs) {
              var p = pbs[sid];
              if (p && p.values && p.values.subagentCatalog != null && ids.indexOf(sid) < 0) {
                ids.push(sid);
              }
            }
          }
        } catch (e) {}
        return ids;
      }

      // 返回 null 表示本地投影里没有 subagentCatalog 键（需回退 host /list）；
      // 返回数组（含空数组）表示投影存在、数据可用。
      function readLocalCatalog(ctx, rootId) {
        try {
          var list = ctx.sessions && ctx.sessions.list;
          if (!list || typeof list.getSnapshot !== 'function') return null;
          var snap = list.getSnapshot();
          var pbs = snap && snap.projectionsBySession;
          if (!pbs) return null;
          var proj = rootId ? pbs[rootId] : null;
          if (proj && proj.values && proj.values.subagentCatalog != null) {
            return parseCatalogLocal(proj.values.subagentCatalog);
          }
          for (var sid in pbs) {
            var p = pbs[sid];
            if (p && p.values && p.values.subagentCatalog != null) {
              return parseCatalogLocal(p.values.subagentCatalog);
            }
          }
          return null;
        } catch (e) { return null; }
      }

      // 把 host 判定的真实 running 状态打到行上：官方 catalog 行没有 activity 字段，
      // 单靠 client 判不出「运行中」，必须先问 host（/running），否则「清理全部空闲」
      // 会误删正在运行的子智能体。请求失败时保持原样（保守：不把任何行误标为空闲）。
      function applyRunningState(ctx, rows) {
        var candidates = (rows || []).filter(function (r) {
          return r && typeof r === 'object' && (r.childId || r.id);
        });
        if (!candidates.length) {
          return Promise.resolve({ rootId: '', rows: rows, unsupported: false });
        }
        var ids = candidates.map(function (r) { return r.childId || r.id; });
        return postJson(ROUTE_BASE + '/running', { ids: ids })
          .then(function (data) {
            if (data && data.ok && Array.isArray(data.runningIds)) {
              var running = {};
              for (var i = 0; i < data.runningIds.length; i++) {
                running[coreId(data.runningIds[i])] = true;
              }
              for (var j = 0; j < rows.length; j++) {
                var row = rows[j];
                if (row && typeof row === 'object' && running[coreId(row.childId || row.id)]) {
                  row.running = true;
                } else if (row && typeof row === 'object') {
                  row.running = false;
                }
              }
            }
            return { rootId: '', rows: rows, unsupported: false };
          })
          .catch(function () {
            return { rootId: '', rows: rows, unsupported: false };
          });
      }

      // overrideRootId：自动清理逐会话巡检时显式指定要读哪个会话的 catalog；
      // 不传则沿用旧行为（当前主视图会话），供渲染/手动刷新使用。
      function loadRows(ctx, overrideRootId) {
        var rootId = overrideRootId || deriveRootId(ctx);
        var local = readLocalCatalog(ctx, rootId);
        var result;
        if (local !== null) {
          // append-only catalog 会被宿主重建，这里持续过滤已删除 id。
          result = Promise.resolve({ rootId: rootId, rows: filterDeleted(local), unsupported: false });
        } else {
          // 本地投影读不到：回退 host 侧兜底数据源。
          result = postJson(ROUTE_BASE + '/list', { rootSessionId: rootId })
            .then(function (data) {
              if (data && data.ok && Array.isArray(data.rows)) {
                return { rootId: rootId, rows: filterDeleted(parseCatalogLocal(data.rows)), unsupported: false };
              }
              return { rootId: rootId, rows: [], unsupported: true };
            })
            .catch(function () {
              return { rootId: rootId, rows: [], unsupported: true };
            });
        }
        // 统一叠加 host 的实时 running 状态（成功/失败都不改变数据源的 unsupported 语义）。
        return result.then(function (res) {
          return applyRunningState(ctx, res.rows).then(function () { return res; });
        });
      }

      // 空闲起点：官方没有 idleSince / lastActiveAt 字段，记首次观察到空闲的时刻；
      // 变回 running 就删除该记录。key 用 coreId 归一化，兼容 catalog 行的
      // session- 前缀写法，保证自动清理（遍历多会话）与渲染（单会话）口径一致。
      // 记录持久化到 localStorage，重启后跨会话继续累计空闲时长。
      function updateIdleTracking(rows) {
        var changed = false;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || !r.id || r.kind === 'diagnostic') continue;
          var key = coreId(r.id);
          // 用统一判定：官方 catalog 行没有 activity 字段，旧逻辑只认
          // activity==='inactive' 会导致官方行从不记录 firstSeen，idleSince
          // 回退成 Date.now()，空闲阈值永远无法满足、定时清理筛不到目标。
          if (isRowRunning(r)) {
            if (shared.firstSeen.delete(key)) changed = true;
          } else if (!shared.firstSeen.has(key)) {
            shared.firstSeen.set(key, Date.now());
            changed = true;
          }
        }
        // 注意：这里刻意不做「本批 rows 里没出现就删起点」的清理。自动清理会
        // 逐会话巡检，每次只传一个会话的行，基于单批做消失清理会误删其他会话
        // 仍在空闲的子智能体的起点。无限增长由 persistFirstSeen 上限与
        // loadFirstSeen 的 30 天过期裁剪兜底。
        if (changed) persistFirstSeen();
      }
      function idleSince(id) {
        var key = coreId(id);
        return shared.firstSeen.has(key) ? shared.firstSeen.get(key) : Date.now();
      }
      function idleMs(id) { return Date.now() - idleSince(id); }

      // 侧边栏同步刷新：只调 refreshProjections 不足以让「已归档 / 会话列表」里
      // 的残留行消失，必须补 sessions.refresh()（借鉴 subagent-clean 的
      // refreshParents），再 refreshProjections 让本会话目录按新日志重新 fold。
      function refreshSidebar(ctx, rootId) {
        try {
          if (ctx.sessions && typeof ctx.sessions.refresh === 'function') {
            ctx.sessions.refresh();
          }
        } catch (e) {}
        try {
          if (rootId && ctx.sessions && typeof ctx.sessions.refreshProjections === 'function') {
            ctx.sessions.refreshProjections(rootId);
          }
        } catch (e2) {}
      }

      // trigger=false 表示「数据变化订阅回调」只重读快照并重渲染，不再主动请求
      // 投影刷新：refreshProjections 本身会让 list 再次 fire，若在订阅回调里
      // 无条件调用会形成自激循环。启动 / 打开浮层 / 手动刷新 / 删除后仍会
      // 调用 refreshProjections(rootId) 触发刷新（存在则调，不存在跳过）。
      function refresh(ctx, trigger) {
        return loadRows(ctx).then(function (res) {
          shared.rootId = res.rootId;
          shared.rows = res.rows;
          shared.unsupported = res.unsupported;
          updateIdleTracking(res.rows);
          // 数据到位后同步按钮显隐：无子智能体时隐藏「子智能体管理」，
          // 检测到再出现。用 emitter 通知 React 与原生降级两条路径。
          try { visibilityEmitter.emit(hasSubagents()); } catch (e) {}
          if (trigger !== false) {
            try {
              if (ctx.sessions && typeof ctx.sessions.refreshProjections === 'function') {
                ctx.sessions.refreshProjections(res.rootId);
              }
            } catch (e) {}
          }
          renderAll();
        });
      }

      function loadSettings(ctx) {
        var label = readLS(LS_LABEL);
        shared.tabLabel = label || DEFAULT_TAB_LABEL;
        var auto = readLS(LS_AUTO);
        shared.autoCleanEnabled = auto === null ? true : (auto === 'true');
        var idle = readLS(LS_IDLE);
        shared.idleMinutes = idle === null ? 30 : clampInt(idle, 1, 10080, 30);
        var interval = readLS(LS_INTERVAL);
        shared.checkIntervalMin = interval === null ? 10 : clampInt(interval, 1, 1440, 10);
        shared.autoDraft = {
          autoCleanEnabled: shared.autoCleanEnabled,
          idleMinutes: shared.idleMinutes,
          checkIntervalMin: shared.checkIntervalMin,
        };
        // 读取 host /config 补齐本地从未存过的缺省值（标签文字等配置可读）。
        return postJson(ROUTE_BASE + '/config', {})
          .then(function (data) {
            // host 下发的隐藏清单：一次性迁移（legacyHiddenIds）+ 全库已退休
            // （hiddenIds，扫全库 zstd 日志里的 subagent-delete/retired 得到）。
            // 并入持久化隐藏清单 LS_DELETED；随后 patchProjections 会据此持续
            // 过滤官方浮层所读的内存投影。放在 cfg 检查之前，保证即便 /config
            // 只回清单也能生效。
            if (data) {
              var hidden = [];
              if (Array.isArray(data.hiddenIds)) hidden = hidden.concat(data.hiddenIds);
              if (Array.isArray(data.legacyHiddenIds)) hidden = hidden.concat(data.legacyHiddenIds);
              for (var k = 0; k < hidden.length; k++) {
                if (typeof hidden[k] === 'string' && hidden[k]) markDeleted(hidden[k]);
              }
            }
            var cfg = data && data.config;
            if (!cfg) return;
            if (label === null && typeof cfg.tabLabel === 'string' && cfg.tabLabel) shared.tabLabel = cfg.tabLabel;
            if (auto === null && typeof cfg.autoCleanEnabled === 'boolean') {
              shared.autoCleanEnabled = cfg.autoCleanEnabled;
              shared.autoDraft.autoCleanEnabled = cfg.autoCleanEnabled;
            }
            if (idle === null && Number.isFinite(cfg.idleMinutes)) {
              shared.idleMinutes = clampInt(cfg.idleMinutes, 1, 10080, 30);
              shared.autoDraft.idleMinutes = shared.idleMinutes;
            }
            if (interval === null && Number.isFinite(cfg.checkIntervalMin)) {
              shared.checkIntervalMin = clampInt(cfg.checkIntervalMin, 1, 1440, 10);
              shared.autoDraft.checkIntervalMin = shared.checkIntervalMin;
            }
          })
          .catch(function () {});
      }

      // ───────────────── 删除 ─────────────────
      // 单个删除改为「物理删除」：调 host /purge，由 host 本地清理会话目录、
      // projcache 与 catalog 投影引用 / workspace 记账 / 归档台账 / mnemon 虚拟目录
      // （第三方 dsh-session-archive 已于 1.4.13 剔除，不再依赖其 /delete 管线）。
      // 成功后把 id 写入本地隐藏清单并从列表移除，
      // 因为 append-only catalog 会在下次刷新时被宿主从日志重建。
      // 每行独立 try/catch 隔离；root 会话绝不删；running 传 stopActivity:true。
      // rootIdOverride：自动清理逐会话巡检时传入该行所属会话的 rootId，
      // 让 host 把 catalog 行从正确的父会话日志里退休；不传则沿用当前视图的
      // shared.rootId（手动删除 / 批量清理路径不变）。
      function deleteOne(ctx, row, stopActivity, rootIdOverride) {
        var id = row && row.id;
        if (!id || id === shared.rootId || !row || row.kind === 'diagnostic') return Promise.resolve();
        var rootForPurge = rootIdOverride || shared.rootId;
        shared.rowStatus[id] = { state: 'deleting' };
        renderAll();
        var body = {
          sessionId: id,
          rootSessionId: rootForPurge || '',
          stopActivity: !!stopActivity,
        };
        return postJson(ROUTE_BASE + '/purge', body)
          .then(function (data) {
            if (!data || !data.ok) {
              throw new Error((data && (data.message || data.error)) || 'purge-failed');
            }
            // 删除已落地：写入持久化隐藏清单，并从当前列表立即移除该行。
            markDeleted(id);
            // 立即把该 id 从官方浮层所读的内存投影里抹掉（不等 refreshProjections，
            // 因为 live 父会话不会重算磁盘；幂等收敛，见 patchProjections 注释）。
            patchProjections(ctx);
            shared.rows = filterDeleted(shared.rows);
            shared.rowStatus[id] = { state: 'deleted' };
            // host 已把父会话日志里的 catalog 行原位退休（append-only 根治），
            // 用状态提示把这一结果反馈给用户，区别于「仅本地隐藏」。
            if (data.catalogQueued) shared.rowStatus[id].hint = t('catalogQueued');
            else if (data.catalogRetired > 0) shared.rowStatus[id].hint = t('catalogRetired');
          })
          .catch(function (e) {
            shared.rowStatus[id] = { state: 'failed', message: String((e && e.message) || e) };
          })
          .then(function () {
            renderAll();
            // 侧边栏残留行同步消失：refresh() + refreshProjections() 一起调。
            refreshSidebar(ctx, rootForPurge);
          });
      }

      function onRowDelete(ctx, row) {
        if (!row || !row.id || row.id === shared.rootId || row.kind === 'diagnostic') return;
        var running = isRowRunning(row);
        var msg = running ? t('confirmDeleteRunning') : t('confirmDelete');
        var ok = true;
        try { ok = root.confirm(msg); } catch (e) { ok = true; }
        if (!ok) return;
        deleteOne(ctx, row, running);
      }

      // 清理残留行：host /scrub 把「子会话目录已不在、catalog 行还在」的引用
      // 从父会话日志原位退休；这是 append-only 根治后的一次性兜底，专治旧版
      // 归档 / 重建遗留的幽灵行（对应图2/图3 里删不掉的条目）。
      function scrubResidual(ctx) {
        if (!shared.rootId) return Promise.resolve();
        shared.cleanStatus = t('scrubbing');
        renderAll();
        return postJson(ROUTE_BASE + '/scrub', {
          rootSessionId: shared.rootId,
          everywhere: false,
        }).then(function (data) {
          if (!data || !data.ok) {
            throw new Error((data && (data.message || data.error)) || 'scrub-failed');
          }
          var n = Number(data.removed) || 0;
          shared.cleanStatus = n > 0 ? t('scrubDone', { count: n }) : t('scrubNoResidual');
          // 残留目录行已从日志根除，刷新侧边栏令其同步消失。
          refreshSidebar(ctx, shared.rootId);
          return refresh(ctx, true);
        }).catch(function (e) {
          shared.cleanStatus = t('scrubFailed') + ': ' + String((e && e.message) || e);
          renderAll();
        });
      }

      function cleanAllIdle(ctx) {
        // 手动清理：清掉列表里所有显示为空闲（非运行中）的条目，不套 idleMinutes
        // 阈值（阈值只用于定时自动清理）。见 manualCleanTargets 注释：旧实现要求
        // activity==='inactive' 且空闲 ≥30 分钟，而官方 catalog 无 idleSince 字段、
        // 客户端 firstSeen 刚起步，导致按钮几乎永远「已清理 0 个」。
        var targets = manualCleanTargets(filterDeleted(shared.rows), {
          rootId: shared.rootId,
          isHidden: isDeleted,
        });
        if (!targets.length) {
          shared.cleanStatus = t('cleanNoIdle');
          renderAll();
          return Promise.resolve();
        }
        shared.cleanStatus = t('cleaning');
        renderAll();
        var chain = Promise.resolve();
        var count = 0;
        targets.forEach(function (r) {
          chain = chain.then(function () {
            return deleteOne(ctx, r, false).then(function () {
              var st = shared.rowStatus[r.id];
              if (st && st.state === 'deleted') count += 1;
            });
          });
        });
        return chain.then(function () {
          shared.cleanStatus = t('cleanDone', { count: count });
          renderAll();
          // 批量清理后同样补 sessions.refresh()，侧边栏残留行同步消失。
          refreshSidebar(ctx, shared.rootId);
        });
      }

      // 自动清理巡检：live check 失败（unsupported）时 fail-closed 不删；
      // running 绝不碰（idleFilterLocal 只排除运行中）。
      // 遍历所有含 subagentCatalog 投影的会话，而非只看当前主视图——否则切到
      // 别的会话后，留在原会话的空闲子智能体永远巡检不到（用户实测过的缺陷）。
      function autoCleanTick(ctx) {
        if (!shared.autoCleanEnabled) return;
        var rootIds = deriveAllRootIds(ctx);
        if (!rootIds.length) rootIds = ['']; // 兜底：仍尝试旧的单会话路径
        var chain = Promise.resolve();
        rootIds.forEach(function (rid) {
          chain = chain.then(function () {
            return loadRows(ctx, rid).then(function (res) {
              if (res.unsupported || !res.rows.length) return; // fail-closed
              updateIdleTracking(res.rows);
              var targets = idleFilterLocal(res.rows, {
                rootId: res.rootId,
                idleMinutes: shared.idleMinutes,
                now: Date.now(),
                idleSince: idleSince,
              });
              var delChain = Promise.resolve();
              targets.forEach(function (r) {
                delChain = delChain.then(function () { return deleteOne(ctx, r, false, res.rootId); });
              });
              // 每个会话清完同步刷新该会话侧边栏（与手动删除 / 批量清理一致）。
              return delChain.then(function () {
                refreshSidebar(ctx, res.rootId);
              });
            });
          });
        });
        // 不写 shared.rows/rootId：巡检是后台行为，多会话数据不应污染当前浮层；
        // 删除行的隐藏清单已更新，数据变化订阅回调会自然重绘当前视图。
        return chain.then(function () { renderAll(); }).catch(function () {});
      }

      function reconfigureInterval(ctx) {
        if (autoTimer) { try { root.clearInterval(autoTimer); } catch (e) {} autoTimer = null; }
        var ms = Math.max(1, shared.checkIntervalMin) * 60 * 1000;
        autoTimer = root.setInterval(function () { autoCleanTick(ctx); }, ms);
      }

      function saveSettings(ctx) {
        var d = shared.autoDraft || {};
        shared.autoCleanEnabled = !!d.autoCleanEnabled;
        shared.idleMinutes = clampInt(d.idleMinutes, 1, 10080, shared.idleMinutes);
        shared.checkIntervalMin = clampInt(d.checkIntervalMin, 1, 1440, shared.checkIntervalMin);
        writeLS(LS_AUTO, shared.autoCleanEnabled);
        writeLS(LS_IDLE, shared.idleMinutes);
        writeLS(LS_INTERVAL, shared.checkIntervalMin);
        shared.settingsStatus = t('saved');
        reconfigureInterval(ctx); // 配置变更即时重排 interval
        renderAll();
      }

      function saveTabLabel() {
        var raw = (shared.renameDraft == null ? shared.tabLabel : shared.renameDraft);
        var v = String(raw || '').trim().slice(0, 24) || DEFAULT_TAB_LABEL;
        writeLS(LS_LABEL, v);
        shared.tabLabel = v;
        labelEmitter.emit(v); // 立即更新顶部按钮文字
        renderAll();
      }

      // ───────────────── DOM helpers ─────────────────
      function el(cls, tag) {
        var e = doc.createElement(tag || 'div');
        if (cls) e.className = cls;
        return e;
      }
      function button(text, cls, part, onClick) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = cls || 'yanyan-btn';
        b.setAttribute('data-dsh-plugin', 'yanyan-subagent');
        if (part) b.setAttribute('data-dsh-part', part);
        if (text != null) b.textContent = text;
        if (onClick) b.addEventListener('click', onClick);
        return b;
      }
      function lineText(text, cls, part) {
        var s = el(cls, 'span');
        if (part) s.setAttribute('data-dsh-part', part);
        s.textContent = text;
        return s;
      }
      function formatIdle(row) {
        if (!row || row.kind === 'diagnostic' || isRowRunning(row)) return '';
        var ms = idleMs(row.id);
        var mins = Math.floor(ms / 60000);
        return mins > 0 ? (mins + ' ' + t('minutes')) : ('0 ' + t('minutes'));
      }
      function statusText(st) {
        if (!st) return '';
        if (st.state === 'deleting') return t('deleting');
        if (st.state === 'deleted') return t('deleted') + (st.hint ? (' · ' + st.hint) : '');
        if (st.state === 'failed') return t('failed') + (st.message ? (': ' + st.message) : '');
        return '';
      }
      // 图2（官方「N 个子智能体」浮层）行布局：token 数 + 耗时。
      // 本插件的 subagentCatalog 不保证带这些字段，故防御性探测多种命名，
      // 取不到时用客户端空闲估算兜底；不臆造数据。
      function formatTokenCount(n) {
        if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K tok';
        return n + ' tok';
      }
      function formatDuration(ms) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
        if (ms < 1000) return Math.round(ms) + 'ms';
        if (ms < 60000) return Math.round(ms / 1000) + '秒';
        var mins = Math.floor(ms / 60000);
        var secs = Math.round((ms % 60000) / 1000);
        return mins + '分' + (secs ? secs + '秒' : '');
      }
      function rowTokenText(row) {
        var u = row && row.tokenUsage;
        var n = row && (row.totalTokens || row.tokenCount || row.tokens
          || (u && (u.totalTokens || u.total || u.inputTokens + u.outputTokens)));
        return formatTokenCount(n);
      }
      function rowDurationText(row) {
        var ms = row && (row.durationMs || row.elapsedMs || row.duration);
        var s = formatDuration(ms);
        if (s) return s;
        // 无稳定耗时字段时用空闲时长（客户端 firstSeen 估算）兜底。
        if (row && !isRowRunning(row) && row.kind !== 'diagnostic') {
          return formatDuration(idleMs(row.id));
        }
        return '';
      }

      // ───────────────── 浮层定位（贴触发按钮下方，带边界收拢） ─────────────────
      // 浮层通过 createPortal 挂到 document.body（脱离 header.actions 槽，
      // 见文件头注释），因此不能靠 CSS 静态 top/right，必须按锚点按钮的实时
      // 位置计算 left/top。原实现写死 top:64px;right:24px 浮在对话区右上角，
      // 离左上角的按钮很远，正是用户所说「界面太远」。
      var ANCHOR_GAP = 6;   // 浮层与按钮之间的垂直间距（px）
      var VIEWPORT_PAD = 8; // 浮层距视口边缘的最小留白（px）

      function positionOverlay(view) {
        if (!view || !view.container) return;
        var c = view.container;
        var anchor = overlayAnchor;
        var av = (anchor && typeof anchor.getBoundingClientRect === 'function')
          ? anchor.getBoundingClientRect() : null;
        var vw = root.innerWidth || (doc.documentElement && doc.documentElement.clientWidth) || 0;
        var vh = root.innerHeight || (doc.documentElement && doc.documentElement.clientHeight) || 0;
        var cw = c.offsetWidth || 380;
        var ch = c.offsetHeight || 0;
        var left, top;

        if (av && vw && vh) {
          // 水平：左边缘与按钮左边缘平齐，朝右展开；右侧空间不够时再向左收拢。
          left = av.left;
          if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
          if (left + cw > vw - VIEWPORT_PAD) left = Math.max(VIEWPORT_PAD, vw - cw - VIEWPORT_PAD);
          // 垂直：优先放按钮下方；下方空间不足则翻到按钮上方。
          var below = av.bottom + ANCHOR_GAP;
          var above = av.top - ANCHOR_GAP - ch;
          if (below + ch <= vh - VIEWPORT_PAD || below <= av.top) top = below;
          else if (above >= VIEWPORT_PAD) top = above;
          else top = Math.max(VIEWPORT_PAD, Math.min(below, vh - ch - VIEWPORT_PAD));
        } else {
          // 锚点不可得时的回退：仍贴在视口右上，但用实时视口宽度收拢。
          left = Math.max(VIEWPORT_PAD, vw - cw - VIEWPORT_PAD);
          top = 64;
        }
        c.style.left = Math.round(left) + 'px';
        c.style.top = Math.round(top) + 'px';
      }

      function positionAllViews() {
        for (var i = 0; i < views.length; i++) positionOverlay(views[i]);
      }

      // ───────────────── 浮层骨架（只建一次，后续只增量刷新列表/状态） ─────────────────
      function createView(container, ctx, isPortal) {
        var view = { container: container, ctx: ctx, refs: {}, expandedSettings: false };
        container.setAttribute('data-dsh-plugin', 'yanyan-subagent');
        container.setAttribute('data-dsh-part', 'overlay');

        // 头部：标题 + 关闭。
        var header = el('yanyan-header');
        header.setAttribute('data-dsh-part', 'header');
        header.appendChild(lineText(t('title'), 'yanyan-title', 'title'));
        header.appendChild(button(t('close'), 'yanyan-close', 'close', function () {
          if (isPortal) closeEmitter.emit();
          else closeNativeOverlay();
        }));

        // 工具栏：刷新 + 设置开关。
        var toolbar = el('yanyan-toolbar');
        toolbar.setAttribute('data-dsh-part', 'toolbar');
        toolbar.appendChild(button(t('refresh'), 'yanyan-btn', 'refresh', function () {
          // 刷新后数据可能不变（读本地投影），若不给反馈用户会以为按钮失效。
          // 立即显示「正在刷新…」，完成后显示「已刷新」，失败显示「失败」。
          shared.settingsStatus = '';
          shared.cleanStatus = t('refreshing');
          view.update();
          return refresh(ctx).then(function () {
            shared.cleanStatus = t('refreshed');
            view.update();
          }, function () {
            shared.cleanStatus = t('failed');
            view.update();
          });
        }));
        toolbar.appendChild(button(t('settings'), 'yanyan-btn', 'settings-toggle', function () {
          view.expandedSettings = !view.expandedSettings;
          view.update();
        }));

        // 重命名标签：输入框 + 保存。
        var rename = el('yanyan-rename');
        rename.setAttribute('data-dsh-part', 'rename');
        var renameLabel = el('yanyan-label', 'label'); renameLabel.textContent = t('rename');
        var renameInput = doc.createElement('input');
        renameInput.type = 'text'; renameInput.className = 'yanyan-input';
        renameInput.setAttribute('data-dsh-part', 'rename-input');
        renameInput.setAttribute('placeholder', t('tabRenameHint'));
        renameInput.value = shared.tabLabel;
        renameInput.addEventListener('input', function () { shared.renameDraft = renameInput.value; });
        var renameSave = button(t('save'), 'yanyan-btn-primary', 'rename-save', saveTabLabel);
        rename.appendChild(renameLabel); rename.appendChild(renameInput); rename.appendChild(renameSave);

        // 设置区：自动清理开关 + 空闲分钟 + 巡检间隔 + 保存（默认折叠）。
        var settings = el('yanyan-settings');
        settings.setAttribute('data-dsh-part', 'settings');
        var autoWrap = el('yanyan-check', 'label');
        var autoCheck = doc.createElement('input');
        autoCheck.type = 'checkbox';
        autoCheck.setAttribute('data-dsh-part', 'auto-clean');
        autoCheck.checked = shared.autoCleanEnabled;
        autoCheck.addEventListener('change', function () { shared.autoDraft.autoCleanEnabled = autoCheck.checked; });
        autoWrap.appendChild(autoCheck);
        autoWrap.appendChild(doc.createTextNode(' ' + t('autoClean')));
        var idleLabel = el('yanyan-label', 'label'); idleLabel.textContent = t('idleMinutes');
        var idleInput = doc.createElement('input');
        idleInput.type = 'number'; idleInput.min = '1'; idleInput.max = '10080';
        idleInput.className = 'yanyan-input yanyan-small';
        idleInput.setAttribute('data-dsh-part', 'idle-minutes');
        idleInput.value = String(shared.idleMinutes);
        idleInput.addEventListener('input', function () { shared.autoDraft.idleMinutes = idleInput.value; });
        var intervalLabel = el('yanyan-label', 'label'); intervalLabel.textContent = t('checkInterval');
        var intervalInput = doc.createElement('input');
        intervalInput.type = 'number'; intervalInput.min = '1'; intervalInput.max = '1440';
        intervalInput.className = 'yanyan-input yanyan-small';
        intervalInput.setAttribute('data-dsh-part', 'check-interval');
        intervalInput.value = String(shared.checkIntervalMin);
        intervalInput.addEventListener('input', function () { shared.autoDraft.checkIntervalMin = intervalInput.value; });
        var hint = el('yanyan-hint'); hint.textContent = t('autoCleanHint');
        var settingsSave = button(t('save'), 'yanyan-btn-primary', 'settings-save', function () { saveSettings(ctx); });
        var settingsStatus = el('yanyan-hint'); settingsStatus.setAttribute('data-dsh-part', 'settings-status');
        var grid = el('yanyan-grid');
        grid.appendChild(autoWrap); grid.appendChild(idleLabel); grid.appendChild(idleInput);
        grid.appendChild(intervalLabel); grid.appendChild(intervalInput);
        settings.appendChild(grid); settings.appendChild(hint);
        settings.appendChild(settingsSave); settings.appendChild(settingsStatus);

        // 列表容器（增量重建，行内无输入框，不会丢焦点）。
        var listEl = el('yanyan-list'); listEl.setAttribute('data-dsh-part', 'list');

        // 底部：阈值提示 + 清理全部空闲 + 清理残留行 + 结果。
        var footer = el('yanyan-footer'); footer.setAttribute('data-dsh-part', 'footer');
        var threshold = lineText('', 'yanyan-threshold', 'idle-threshold');
        var cleanBtn = button(t('cleanIdle'), 'yanyan-btn-primary', 'clean-idle', function () { cleanAllIdle(ctx); });
        var scrubBtn = button(t('scrubResidual'), 'yanyan-btn', 'scrub-residual', function () { scrubResidual(ctx); });
        var result = lineText('', 'yanyan-result', 'clean-result');
        footer.appendChild(threshold); footer.appendChild(cleanBtn); footer.appendChild(scrubBtn); footer.appendChild(result);

        container.appendChild(header);
        container.appendChild(toolbar);
        container.appendChild(rename);
        container.appendChild(settings);
        container.appendChild(listEl);
        container.appendChild(footer);

        view.refs = {
          settings: settings, list: listEl, threshold: threshold, result: result,
          cleanBtn: cleanBtn, scrubBtn: scrubBtn, autoCheck: autoCheck, idleInput: idleInput,
          intervalInput: intervalInput, settingsStatus: settingsStatus, renameInput: renameInput,
        };

        view.update = function () { updateView(view); };
        return view;
      }

      function updateView(view) {
        var refs = view.refs;
        refs.settings.style.display = view.expandedSettings ? '' : 'none';
        // 阈值只约束定时自动清理，手动「清理全部空闲」不受其限制，明确告知用户，
        // 避免误以为「空闲 0 分钟 / 未满阈值」就是清理按钮没反应的原因。
        refs.threshold.textContent = t('idleThreshold') + ' ' + shared.idleMinutes + ' '
          + t('minutes') + ' · ' + t('manualCleanHint');
        refs.result.textContent = shared.cleanStatus || '';
        refs.settingsStatus.textContent = shared.settingsStatus || '';
        // 回填设置输入（骨架不重建，避免覆盖用户正在输入的值时丢焦点）。
        if (document.activeElement !== refs.autoCheck) refs.autoCheck.checked = shared.autoCleanEnabled;
        if (document.activeElement !== refs.idleInput) refs.idleInput.value = String(shared.idleMinutes);
        if (document.activeElement !== refs.intervalInput) refs.intervalInput.value = String(shared.checkIntervalMin);
        if (document.activeElement !== refs.renameInput && shared.renameDraft == null) {
          refs.renameInput.value = shared.tabLabel;
        }
        refs.cleanBtn.disabled = false;

        var list = refs.list;
        list.innerHTML = '';
        if (shared.unsupported) {
          list.appendChild(lineText(t('unsupported'), 'yanyan-empty', 'unsupported'));
          return;
        }
        if (!shared.rows.length) {
          list.appendChild(lineText(t('empty'), 'yanyan-empty', 'empty'));
          return;
        }
        for (var i = 0; i < shared.rows.length; i++) {
          var r = shared.rows[i];
          if (!r || r.kind === 'diagnostic') continue;
          // 双保险：即便 refresh 之后写入了新数组，渲染前再过滤一次隐藏清单。
          if ((r.id && isDeleted(r.id)) || (r.childId && isDeleted(r.childId))) continue;
          list.appendChild(renderRow(view.ctx, r));
        }
      }

      function renderRow(ctx, row) {
        // 图2 布局：绿点状态 +（名称 / id + token·耗时）+ 状态徽标 + 删除 X。
        // 保留 data-dsh-part 标记与删除回调，不触碰顶部工具栏 / 底部清理功能。
        var line = el('yanyan-row yanyan-row-official');
        line.setAttribute('data-dsh-part', 'row');
        var running = isRowRunning(row);
        var isDiag = row.kind === 'diagnostic';

        // 状态圆点：running=蓝/动态，其余=绿点（对齐官方空闲绿点）。
        var dot = el('yanyan-row-dot' + (running ? ' is-running' : ''), 'span');
        dot.setAttribute('data-dsh-part', 'row-dot');
        line.appendChild(dot);

        // 单行：仅名称（用户要求删除第二行 id + token · 耗时）。
        var main = el('yanyan-row-main');
        var name = (row.label || row.name || row.id || t('unknown'));
        main.appendChild(lineText(name, 'yanyan-row-name', 'row-name'));
        // 诊断 / 运行状态补充提示、删除状态，作为轻量徽标并入该行。
        if (running) main.appendChild(lineText(t('stopHint'), 'yanyan-row-note', 'row-stop-hint'));
        var st = shared.rowStatus[row.id];
        if (st) main.appendChild(lineText(statusText(st), 'yanyan-row-note', 'row-state'));
        if (isDiag) main.appendChild(lineText(t('diagnostic'), 'yanyan-row-note', 'row-status'));
        line.appendChild(main);

        // 明确的状态文字徽标：让「空闲 / 运行中」一眼可辨（复用已有 .yanyan-status 样式）。
        // 放在行右侧（main 之后、删除 X 之前），配合 align-self:flex-start 靠顶部对齐，
        // 视觉上落在第一行右端——即用户箭头指向的位置。
        if (!isDiag && row.id !== shared.rootId) {
          if (running) {
            line.appendChild(lineText(t('running'), 'yanyan-status yanyan-running', 'row-status-badge'));
          } else {
            line.appendChild(lineText(t('idle'), 'yanyan-status yanyan-idle', 'row-status-badge'));
          }
        }

        // 已移除右箭头：它只是对齐官方列表的纯装饰（不参与交互），点击无反应，
        // 徒增视觉噪音。列表保留状态、信息与删除 X。
        // 根会话 / 诊断行不显示删除按钮；其余（含 running）允许删除。
        var isRoot = row.id === shared.rootId;
        if (!isDiag && !isRoot && row.id) {
          var del = button(X_MARK, 'yanyan-x', 'row-delete', function () {
            onRowDelete(ctx, row);
          });
          del.setAttribute('aria-label', t('delete'));
          del.title = t('delete');
          if (st && st.state === 'deleted') del.disabled = true;
          line.appendChild(del);
        } else if (isRoot) {
          line.appendChild(lineText(t('root'), 'yanyan-root-tag', 'row-root'));
        }
        return line;
      }

      // ───────────────── React 路径（slots + createPortal） ─────────────────
      // React.Fragment 是 Fix 1 的前提：用它把 <button> 与 portal 并列成兄弟，
      // 断开「浮层点击 → fiber 上溯到 button → toggle 关闭」的事件链。
      // 缺少 Fragment 时直接走纯 DOM 降级（native overlay），不复发该 bug。
      var canReact = !!(React && React.createElement && React.useState && React.useEffect && React.useRef && React.Fragment);
      var canPortal = !!(ReactDOM && ReactDOM.createPortal);

      function PortalHost(props) {
        var ref = React.useRef(null);
        React.useEffect(function () {
          if (!ref.current) return;
          var view = createView(ref.current, props.ctx, true);
          views.push(view);
          view.update();
          positionOverlay(view);
          refresh(props.ctx);
          return function () {
            var i = views.indexOf(view); if (i >= 0) views.splice(i, 1);
            try { if (ref.current) ref.current.innerHTML = ''; } catch (e) {}
          };
        }, []);
        // 双保险：浮层内所有事件都不再向外冒泡。即便宿主换了 React 版本或把
        // portal 重新挂成 <button> 的后代，合成事件沿 fiber 上溯时也会在这里被
        // 截断，不会触发顶部按钮的 onClick toggle。只用 stopPropagation、绝不
        // preventDefault，输入框聚焦 / 勾选 / 按钮点击等原生行为完全不受影响。
        var swallow = function (ev) {
          if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        };
        return React.createElement('div', {
          ref: ref,
          className: 'yanyan-portal-host',
          onClick: swallow,
          onMouseDown: swallow,
          onPointerDown: swallow,
          onTouchStart: swallow,
          // hover 模式：鼠标进入浮层取消延迟关闭，移出则重新计时。
          onMouseEnter: function () { if (props.onEnter) props.onEnter(); },
          onMouseLeave: function () { if (props.onLeave) props.onLeave(); },
        });
      }

      // ActionButton 组件只创建一次：槽的 render 工厂每次返回新组件类型会反复
      // 卸载重挂丢 state。label 用 readTabLabel() 支持改名即时生效。
      function makeActionButton(ctx) {
        return function ActionButton() {
          var openState = React.useState(false);
          var open = openState[0], setOpen = openState[1];
          var labelState = React.useState(readTabLabel());
          var lbl = labelState[0], setLbl = labelState[1];
          // 按钮显隐：当前会话无子智能体时隐藏。初始隐藏，首屏 refresh 数据到位后
          // visibilityEmitter 会推送实际判定，避免先显示再消失的闪烁。
          var visibleState = React.useState(false);
          var visible = visibleState[0], setVisible = visibleState[1];
          React.useEffect(function () {
            var u1 = labelEmitter.subscribe(function (v) { setLbl(v); });
            var u2 = closeEmitter.subscribe(function () { setOpen(false); });
            var u3 = visibilityEmitter.subscribe(function (v) {
              setVisible(!!v);
              if (!v) setOpen(false); // 子智能体消失时一并关闭浮层，避免悬空浮层
            });
            return function () { u1(); u2(); u3(); };
          }, []);
          var btnRef = React.useRef(null);
          // hover 模式：移入按钮即打开，移开延迟关闭；浮层内移入/移出由 PortalHost
          // 的 onEnter/onLeave 协调，跨越按钮↔浮层间隙时不会误关。
          var onEnter = function () {
            cancelHoverClose();
            if (btnRef.current) overlayAnchor = btnRef.current;
            if (canPortal) { if (!open) setOpen(true); }
            else ensureNativeOpen(ctx, btnRef.current);
          };
          var onLeave = function () { scheduleHoverClose(); };
          // click 保留为无障碍/键盘兜底：hover 已打开时不再 toggle 关闭。
          var onClick = function () {
            if (btnRef.current) overlayAnchor = btnRef.current;
            cancelHoverClose();
            if (canPortal) { if (!open) setOpen(true); }
            else ensureNativeOpen(ctx, btnRef.current);
          };
          // 关键：portal 必须与 <button> 是「兄弟」，不能是它的 children。
          // 旧实现把 createPortal(...) 塞进 <button> 的 kids，React 合成事件沿
          // fiber 树（不是 DOM 树）冒泡时，浮层内任意点击都会上溯到这个 button，
          // 触发 onClick → setOpen(!v) → 浮层被 toggle 卸载：点「设置」/「重命名」
          // 输入框「直接退出」，点「清理全部空闲」清完却立刻关闭看不见结果。
          // 用 Fragment 并列后，portal 的 fiber 父级是 Fragment，链路不再经过 button；
          // DOM 上浮层依旧 createPortal 到 document.body，位置与样式完全不变。
          // 当前会话无子智能体时 visible=false：按钮不渲染，浮层也不挂载，
          // 但保留 Fragment 并列结构（Fix 1 的事件链前提不变）。
          var tabBtn = visible ? React.createElement('button', {
            ref: btnRef,
            'data-dsh-plugin': 'yanyan-subagent',
            'data-dsh-part': 'session-tab',
            className: 'yanyan-tab-btn',
            title: t('title'),
            onClick: onClick,
            onMouseEnter: onEnter,
            onMouseLeave: onLeave,
          }, React.createElement('span', null, lbl || t('tab'))) : null;
          var portal = null;
          if (visible && open && canPortal) {
            portal = ReactDOM.createPortal(
              React.createElement(PortalHost, { ctx: ctx, onEnter: onEnter, onLeave: onLeave }),
              doc.body);
          }
          return React.createElement(React.Fragment, null, tabBtn, portal);
        };
      }

      // ───────────────── 纯 DOM 浮层（无 react-dom 时） ─────────────────
      function toggleOverlayNative(ctx) {
        if (nativeOverlay) { closeNativeOverlay(); return; }
        try {
          var div = doc.createElement('div');
          div.className = 'yanyan-native-overlay';
          nativeOverlay = div;
          doc.body.appendChild(div);
          var view = createView(div, ctx, false);
          views.push(view);
          nativeView = view;
          view.update();
          positionOverlay(view);
          refresh(ctx);
          // hover 模式：鼠标进入浮层取消延迟关闭，移出重新计时。
          div.addEventListener('mouseenter', function () { cancelHoverClose(); });
          div.addEventListener('mouseleave', function () { scheduleHoverClose(); });
        } catch (e) {
          try { if (nativeOverlay) nativeOverlay.remove(); } catch (e2) {}
          nativeOverlay = null; nativeView = null;
        }
      }
      function closeNativeOverlay() {
        if (nativeView) {
          var i = views.indexOf(nativeView); if (i >= 0) views.splice(i, 1);
          nativeView = null;
        }
        if (nativeOverlay) { try { nativeOverlay.remove(); } catch (e) {} nativeOverlay = null; }
      }
      function closeAllViews() {
        closeNativeOverlay();
        try { closeEmitter.emit(); } catch (e) {}
        for (var i = 0; i < views.length; i++) {
          try { views[i].container.innerHTML = ''; } catch (e2) {}
        }
        views.length = 0;
        overlayAnchor = null;
        cancelHoverClose();
      }

      // ───────────── hover 开合（鼠标移入按钮弹出、移开消失） ─────────────
      // 浮层经 portal 挂到 body、与按钮之间有 ANCHOR_GAP 间隙，按钮 mouseleave
      // 不能立刻关闭，否则鼠标还没移到浮层就消失。用短延迟 + 浮层 mouseenter
      // 取消关闭来跨越间隙。
      function cancelHoverClose() {
        if (hoverCloseTimer) {
          try { root.clearTimeout(hoverCloseTimer); } catch (e) {}
          hoverCloseTimer = null;
        }
      }
      function scheduleHoverClose() {
        cancelHoverClose();
        hoverCloseTimer = root.setTimeout(function () {
          hoverCloseTimer = null;
          try { closeEmitter.emit(); } catch (e) {}
          closeNativeOverlay();
        }, HOVER_CLOSE_DELAY);
      }
      // 原生降级的「打开」（幂等，不 toggle 关闭）：hover 与 click 都复用。
      function ensureNativeOpen(ctx, btn) {
        if (btn) overlayAnchor = btn;
        if (!nativeOverlay) toggleOverlayNative(ctx);
      }

      // 点击浮层/触发按钮以外的空白位置，自动关闭浮层。
      // 用 document capture 阶段 + contains 显式判断，不依赖 React 的
      // stopPropagation（Fix 1），宿主换 React 版本或改 portal 挂载点也成立。
      function closeOverlaysFromOutside(ev) {
        if (!nativeOverlay && !views.length) return;
        if (ev && typeof ev.button === 'number' && ev.button !== 0) return;
        var target = ev && ev.target;
        // 点击浮层内部（含输入框、设置、清理按钮等所有子操作）：不关闭。
        for (var i = 0; i < views.length; i++) {
          var c = views[i].container;
          if (target && c && c.contains && c.contains(target)) return;
        }
        // 点击触发按钮本身：交给按钮 onClick 的 toggle，避免「先关后开」冲突。
        if (target && overlayAnchor && overlayAnchor.contains && overlayAnchor.contains(target)) return;
        // 其它空白区域：React 走 emitter 卸载 portal，原生降级直接移除。
        try { closeEmitter.emit(); } catch (e) {}
        closeNativeOverlay();
      }

      // ctx.slots 运行时不可用时，降级为纯 DOM 注入顶部按钮（尽力而为，不抛错）。
      function injectNativeTabButton(ctx) {
        try {
          var host = doc.querySelector('[data-session-header-actions], .session-header-actions, header')
            || doc.body;
          var btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'yanyan-tab-btn';
          btn.setAttribute('data-dsh-plugin', 'yanyan-subagent');
          btn.setAttribute('data-dsh-part', 'session-tab');
          btn.textContent = readTabLabel();
          // hover 模式：移入打开、移开延迟关闭。
          btn.addEventListener('mouseenter', function () {
            cancelHoverClose();
            ensureNativeOpen(ctx, btn);
          });
          btn.addEventListener('mouseleave', function () { scheduleHoverClose(); });
          // click 保留为键盘/无障碍兜底：已打开时不 toggle 关闭。
          btn.addEventListener('click', function () {
            cancelHoverClose();
            ensureNativeOpen(ctx, btn);
          });
          // 无子智能体时先隐藏，首屏 refresh 数据到位后由 visibilityEmitter 决定显隐。
          btn.style.display = 'none';
          host.appendChild(btn);
          var unsub = labelEmitter.subscribe(function (l) { btn.textContent = l || t('tab'); });
          var unsubVis = visibilityEmitter.subscribe(function (v) {
            btn.style.display = v ? '' : 'none';
            if (!v) { try { closeNativeOverlay(); } catch (e) {} cancelHoverClose(); }
          });
          return function () {
            try { unsub(); } catch (e) {}
            try { unsubVis(); } catch (e) {}
            cancelHoverClose();
            try { btn.remove(); } catch (e2) {}
          };
        } catch (e) { return function () {}; }
      }

      function injectOfficialButtons(ctx, panel) {
        // 用户要求：不再往官方「N 个子智能体」面板注入单条删除 X。
        // 保留空函数以兼容既有调用点；删除统一走「子智能体管理」浮层行内 X
        // 与底部「清理全部空闲」。clearOfficialButtons 仍会清掉历史注入残留。
        void ctx; void panel;
      }
      function clearOfficialButtons() {
        for (var i = 0; i < officialButtons.length; i++) {
          try { officialButtons[i].remove(); } catch (e) {}
        }
        officialButtons.length = 0;
      }

      // ───────────────── 样式 ─────────────────
      var STYLE_CSS = [
        // 「子智能体管理」按钮与官方「创造模式」一致：无边框、透明背景、次级灰字。
        // 复用宿主主题变量 --dsw-alias-label-secondary-foreground（与根包
        // lib/client.js:42 同一套 alias token），随明暗主题自适应。
        '.yanyan-tab-btn{display:inline-flex;align-items:center;gap:6px;',
        'background:transparent;border:0;',
        'color:var(--dsw-alias-label-secondary-foreground,var(--yanyan-muted,#6b7280));',
        'border-radius:6px;padding:4px 10px;',
        'font-size:12px;cursor:pointer;white-space:nowrap}',
        // hover 时对齐官方「N 个子智能体」按钮：字变黑（常规前景）、无边框、无背景。
        // 不能用 --dsw-alias-label-primary-foreground：它是「主按钮上的白字」token
        // （兜底 #fff），在浅色浮层背景上会变白字导致文字「消失」。
        // --yanyan-fg 在深色主题媒体查询里设为浅色、浅色主题兜底黑色，随主题自适应。
        '.yanyan-tab-btn:hover,.yanyan-tab-btn:focus-visible{background:transparent;border:0;',
        'color:var(--yanyan-fg,#1f2328)}',
        // 位置由 positionOverlay() 按锚点按钮实时计算（贴按钮下方）；left/top 为
        // 动态内联样式，CSS 只保留定位模式与尺寸，不再写死 top/right。
        '.yanyan-portal-host,.yanyan-native-overlay{position:fixed;',
        'width:380px;max-width:calc(100vw - 16px);max-height:min(72vh,600px);',
        'z-index:2147483000;background:var(--yanyan-bg,#fff);color:var(--yanyan-fg,#1f2328);',
        'border:1px solid var(--yanyan-border,#d0d7de);border-radius:12px;',
        'box-shadow:0 14px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;',
        'overflow:hidden;font-size:13px;font-family:inherit}',
        '.yanyan-header{display:flex;align-items:center;justify-content:space-between;',
        'padding:12px 14px;border-bottom:1px solid var(--yanyan-border,#d0d7de)}',
        '.yanyan-title{font-weight:600;font-size:14px}',
        '.yanyan-toolbar{display:flex;gap:8px;padding:8px 14px}',
        '.yanyan-btn,.yanyan-close{background:transparent;border:1px solid var(--yanyan-border,#d0d7de);',
        'color:var(--yanyan-fg,#1f2328);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}',
        '.yanyan-btn:hover,.yanyan-close:hover{border-color:var(--dsw-alias-button-primary-fill,#2f6feb)}',
        '.yanyan-btn-primary{background:var(--dsw-alias-button-primary-fill,#2f6feb);',
        'color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;',
        'padding:6px 12px;font-size:12px;cursor:pointer}',
        '.yanyan-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#2559c4)}',
        '.yanyan-btn-primary:disabled{opacity:.55;cursor:default}',
        '.yanyan-rename{display:flex;align-items:center;gap:8px;padding:8px 14px;',
        'border-bottom:1px solid var(--yanyan-border,#d0d7de)}',
        '.yanyan-label{font-size:12px;color:var(--yanyan-muted,#656d76);white-space:nowrap}',
        '.yanyan-input{flex:1;min-width:0;background:var(--yanyan-input-bg,#f6f8fa);',
        'border:1px solid var(--yanyan-border,#d0d7de);color:var(--yanyan-fg,#1f2328);',
        'border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}',
        '.yanyan-input.yanyan-small{width:76px;flex:none}',
        '.yanyan-settings{padding:10px 14px;border-bottom:1px solid var(--yanyan-border,#d0d7de)}',
        '.yanyan-grid{display:grid;grid-template-columns:auto 1fr auto;gap:6px 8px;align-items:center}',
        '.yanyan-check{display:flex;align-items:center;gap:6px;font-size:12px}',
        '.yanyan-hint{font-size:11px;color:var(--yanyan-muted,#656d76);margin:8px 0 0}',
        '.yanyan-settings .yanyan-btn-primary{margin-top:8px}',
        // 列表高度贴合内容：去掉固定 min-height，避免删到只剩一行时行下方留出大片空白。
        // 多行时仍由 flex:1 + overflow:auto 在浮层 max-height 内滚动。
        '.yanyan-list{flex:1;overflow:auto}',
        '.yanyan-row{display:flex;align-items:center;gap:8px;padding:8px 14px;',
        'border-bottom:1px solid var(--yanyan-border,#d0d7de)}',
        '.yanyan-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.yanyan-status{font-size:11px;padding:1px 6px;border-radius:10px;white-space:nowrap;align-self:flex-start}',
        '.yanyan-idle{background:var(--yanyan-idle-bg,#eaeef2);color:var(--yanyan-muted,#656d76)}',
        '.yanyan-running{background:var(--yanyan-run-bg,#dafbe1);color:#1a7f37}',
        '.yanyan-mode,.yanyan-idle-ms,.yanyan-root-tag{font-size:11px;',
        'color:var(--yanyan-muted,#656d76);white-space:nowrap}',
        '.yanyan-stop{color:#9a6700;white-space:normal}',
        '.yanyan-row-state{font-size:11px;color:#cf222e;white-space:nowrap}',
        '.yanyan-x{border:none;background:transparent;cursor:pointer;',
        'color:var(--yanyan-muted,#656d76);font-size:14px;line-height:1;padding:2px 6px;',
        'border-radius:4px;flex:none}',
        '.yanyan-x:hover{background:var(--yanyan-danger-bg,#ffebe9);color:#cf222e}',
        '.yanyan-x:disabled{opacity:.4;cursor:default}',
        '.yanyan-footer{display:flex;align-items:center;gap:10px;padding:10px 14px;',
        'border-top:1px solid var(--yanyan-border,#d0d7de);flex-wrap:wrap}',
        '.yanyan-threshold{font-size:11px;color:var(--yanyan-muted,#656d76)}',
        '.yanyan-result{font-size:11px;color:#1a7f37;flex-basis:100%}',
        '.yanyan-empty{padding:20px 14px;text-align:center;font-size:12px;',
        'color:var(--yanyan-muted,#656d76)}',
        // 图2（子智能体管理浮层）行布局：绿点 + 双行文字 + 状态徽标 + 删除 X
        '.yanyan-row-official{gap:10px;align-items:center;padding:9px 14px;',
        'border-radius:6px;transition:background .12s ease}',
        // 模仿官方「N 个子智能体」面板：鼠标悬停整行时显示浅灰圆角背景高亮。
        // 复用主题变量 idle-bg（浅色灰 / 深色灰），自动适配明暗主题。
        '.yanyan-row-official:hover{background:var(--yanyan-idle-bg,#eaeef2)}',
        '.yanyan-row-dot{flex:none;width:8px;height:8px;border-radius:50%;',
        'background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.15)}',
        '.yanyan-row-dot.is-running{background:#2f6feb;box-shadow:0 0 0 3px rgba(47,111,235,.15)}',
        '.yanyan-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.yanyan-row-main .yanyan-row-name{font-size:13px;line-height:1.25;',
        'color:var(--yanyan-fg,#1f2328)}',
        '.yanyan-row-note{font-size:11px;line-height:1.3;color:var(--yanyan-muted,#656d76)}',
        '@media (prefers-color-scheme:dark){',
        '.yanyan-portal-host,.yanyan-native-overlay{--yanyan-bg:#1c2128;--yanyan-fg:#e6edf3;',
        '--yanyan-border:#30363d;--yanyan-muted:#8b949e;--yanyan-input-bg:#0d1117;',
        '--yanyan-idle-bg:#21262d;--yanyan-run-bg:#12261e;--yanyan-danger-bg:#2d1315}',
        '.yanyan-tab-btn,.yanyan-btn,.yanyan-close{--yanyan-fg:#e6edf3;--yanyan-border:#30363d}}',
      ].join('');

      function injectStyles(ctx) {
        var styles = lookup('styles');
        if (styles && typeof styles.insert === 'function') {
          try { styles.insert(STYLE_CSS); return; } catch (e) {}
        }
        if (!doc || doc.getElementById('yanyan-subagent-style')) return;
        var style = doc.createElement('style');
        style.id = 'yanyan-subagent-style';
        style.setAttribute('data-dsh-plugin', 'yanyan-subagent');
        style.textContent = STYLE_CSS;
        (doc.head || doc.body).appendChild(style);
      }

      // ───────────────── apply ─────────────────
      var inject = ['locale', 'sessions', 'slots'];

      function apply(ctx) {
        rootCtx = ctx;

        // 字典注册（register 返回值直接作 effect 清理函数）。
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(function () {
              return ctx.locale.register(NS, { zh: UI_zh, en: UI_en });
            }, 'yanyan-subagent: dictionaries');
          }
        } catch (e) {}

        try { injectStyles(ctx); } catch (e) {}

        // 设置（异步读取 host /config 补齐缺省值 + 全库已退休隐藏清单）。
        // 隐藏清单到位后立即过滤官方浮层所读的内存投影，首屏就不会再显示幽灵行。
        loadSettings(ctx).then(function () { patchProjections(ctx); renderAll(); });

        // 顶部标签（决定性 Slot）。绝不复用官方 subagent-catalog id；官方 order=10，
        // 用 12 排在旁边。slots 不可用或 React 不可用时降级纯 DOM 按钮。
        var teardownTab = function () {};
        try {
          if (canReact && ctx.slots && typeof ctx.slots.inject === 'function' &&
              typeof ctx.slots.register === 'function' && doc) {
            // ActionButton 组件只创建一次（槽的 render 工厂每次返回新组件类型会
            // 反复卸载重挂丢 state）。它是一个不含 hooks 的薄组件：内部用
            // React.createElement 渲染真正带 hooks 的组件，因此无论宿主把注册项
            // 当组件类型 createElement、还是当 render 回调直接调用都不会触发
            // "Invalid hook call"（照抄 dsh-plugin-wechat-session 的双保险形态）。
            var ActionButtonInner = makeActionButton(ctx);
            var ActionButton = function ActionButton() {
              return React.createElement(ActionButtonInner, null);
            };
            ctx.slots.inject('conversation.session.header.actions', function () {
              return ctx.slots.register({
                name: 'conversation.session.header.actions',
                id: 'yanyan-subagent-mgr',
                order: 12,
                locale: NS,
                // label 也走 readTabLabel()，改名后若宿主用该字段做无障碍/溢出菜单文字，
                // 同样能同步；未改名时返回值即默认「智能体管理」（= t('tab')）。
                label: function () { return readTabLabel(); },
              }, ActionButton);
            });
          } else {
            teardownTab = injectNativeTabButton(ctx);
          }
        } catch (e) {
          teardownTab = injectNativeTabButton(ctx);
        }

        // 所有 observer / interval / 订阅 / 事件监听统一放进单个 ctx.effect 撤销。
        ctx.effect(function () {
          var disposed = false;
          var unsubs = [];

          // 订阅 sessions.list 数据变化，触发重渲染（只重读快照，不主动
          // refreshProjections，避免订阅回调自激循环）。
          // 同时持续把隐藏清单应用到内存投影：宿主对 live 父会话复用内存
          // fold state，推送帧 / projectList 随时可能把含残留行的 subagentCatalog
          // 重新 set 回来，必须在每次快照变化后立刻剔除（幂等收敛，无命中不写回）。
          try {
            var list = ctx.sessions && ctx.sessions.list;
            if (list && typeof list.subscribe === 'function') {
              var sub = list.subscribe(function () {
                if (disposed) return;
                patchProjections(ctx);
                refresh(ctx, false);
              });
              unsubs.push(function () {
                try {
                  if (typeof sub === 'function') sub();
                  else if (sub && typeof sub.unsubscribe === 'function') sub.unsubscribe();
                } catch (e) {}
              });
            }
          } catch (e) {}

          // 首屏刷新。
          refresh(ctx);

          // 自动清理巡检（默认开启；配置变更即时重排 interval）。
          reconfigureInterval(ctx);
          unsubs.push(function () {
            if (autoTimer) { try { root.clearInterval(autoTimer); } catch (e) {} autoTimer = null; }
          });

          // 图3 官方列表浮层出现时，给每行追加 U+2715（可选增强）。
          try {
            if (root.MutationObserver && doc && doc.body) {
              officialObserver = new root.MutationObserver(function () {
                if (disposed) return;
                try {
                  var panels = doc.querySelectorAll('[data-subagent-panel]');
                  for (var i = 0; i < panels.length; i++) injectOfficialButtons(ctx, panels[i]);
                } catch (e) {}
              });
              officialObserver.observe(doc.body, { childList: true, subtree: true });
              unsubs.push(function () { try { officialObserver.disconnect(); } catch (e) {} });
            }
          } catch (e) {}
          unsubs.push(function () { clearOfficialButtons(); });

          // 视口尺寸变化时重定位所有已打开浮层（仍贴锚点按钮，不会跑回右上角）。
          try {
            if (root.addEventListener) {
              root.addEventListener('resize', positionAllViews);
              unsubs.push(function () {
                try { root.removeEventListener('resize', positionAllViews); } catch (e) {}
              });
            }
          } catch (e) {}

          // 点击空白关闭：capture 阶段监听，保证在浮层 stopPropagation 之前拿到事件。
          try {
            if (doc.addEventListener) {
              doc.addEventListener('mousedown', closeOverlaysFromOutside, true);
              unsubs.push(function () {
                try { doc.removeEventListener('mousedown', closeOverlaysFromOutside, true); } catch (e) {}
              });
            }
          } catch (e) {}

          return function () {
            disposed = true;
            for (var i = 0; i < unsubs.length; i++) { try { unsubs[i](); } catch (e) {} }
            closeAllViews();
            try { teardownTab(); } catch (e2) {}
          };
        }, 'yanyan-subagent: lifecycle');
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
