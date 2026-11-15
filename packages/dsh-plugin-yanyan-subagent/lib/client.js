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
        tabRenameHint: '输入新的标签名称',
        unknown: '未知',
        unsupported: '浏览器数据不可用',
        // 扩展键（en 必须逐键对照）。
        confirmDeleteRunning: '该子智能体正在运行，将停止并彻底删除（不可逆）。确定继续？',
        officialNoMatch: '无法定位该子智能体，请在智能体管理标签中删除',
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
        tabRenameHint: 'Enter a new tab name',
        unknown: 'Unknown',
        unsupported: 'Browser data unavailable',
        confirmDeleteRunning: 'This subagent is running and will be stopped and deleted permanently (irreversible). Continue?',
        officialNoMatch: 'Cannot locate this subagent; delete it in the Agent Manager tab',
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
          if (row.activity !== 'inactive') continue;
          if (rootId != null && row.id === rootId) continue;
          var started = since(row.id);
          var base = typeof started === 'number' && Number.isFinite(started) ? started : now;
          if (threshold > 0 && (now - base) < threshold) continue;
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

      // ───────────────── 已删除 id 的持久化隐藏清单 ─────────────────
      // catalog 的 childId 可能带或不带 `session-` 前缀（同一会话在父 catalog
      // 里是裸 uuid，在归档清单里是 session-uuid）。用「去前缀后的核心 id」
      // 做主键，保证两种写法都命中。
      function coreId(id) {
        return String(id || '').replace(/^session-/, '');
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
        autoCleanEnabled: false,
        idleMinutes: 30,
        checkIntervalMin: 1,
        renameDraft: null,
        autoDraft: { autoCleanEnabled: false, idleMinutes: 30, checkIntervalMin: 1 },
        rows: [],
        rootId: '',
        unsupported: false,
        firstSeen: new Map(), // id -> 首次观察到 inactive 的时刻
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

      function loadRows(ctx) {
        var rootId = deriveRootId(ctx);
        var local = readLocalCatalog(ctx, rootId);
        if (local !== null) {
          // append-only catalog 会被宿主重建，这里持续过滤已删除 id。
          return Promise.resolve({ rootId: rootId, rows: filterDeleted(local), unsupported: false });
        }
        // 本地投影读不到：回退 host 侧兜底数据源。
        return postJson(ROUTE_BASE + '/list', { rootSessionId: rootId })
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

      // 空闲起点：官方没有 idleSince / lastActiveAt 字段，用内存 Map 记首次观察到
      // inactive 的时刻；变回 running 就删除该记录。
      function updateIdleTracking(rows) {
        var alive = {};
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || !r.id || r.kind === 'diagnostic') continue;
          alive[r.id] = true;
          if (r.activity === 'running') shared.firstSeen.delete(r.id);
          else if (r.activity === 'inactive' && !shared.firstSeen.has(r.id)) {
            shared.firstSeen.set(r.id, Date.now());
          }
        }
        // 清理已消失的 id，避免 Map 无限增长。
        shared.firstSeen.forEach(function (_v, id) {
          if (!alive[id]) shared.firstSeen.delete(id);
        });
      }
      function idleSince(id) {
        return shared.firstSeen.has(id) ? shared.firstSeen.get(id) : Date.now();
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
        shared.autoCleanEnabled = auto === null ? false : (auto === 'true');
        var idle = readLS(LS_IDLE);
        shared.idleMinutes = idle === null ? 30 : clampInt(idle, 1, 10080, 30);
        var interval = readLS(LS_INTERVAL);
        shared.checkIntervalMin = interval === null ? 1 : clampInt(interval, 1, 1440, 1);
        shared.autoDraft = {
          autoCleanEnabled: shared.autoCleanEnabled,
          idleMinutes: shared.idleMinutes,
          checkIntervalMin: shared.checkIntervalMin,
        };
        // 读取 host /config 补齐本地从未存过的缺省值（标签文字等配置可读）。
        return postJson(ROUTE_BASE + '/config', {})
          .then(function (data) {
            // 一次性迁移清单（旧版归档残留）：并入持久化隐藏清单，
            // 防止 append-only catalog 重建后这些幽灵条目重新出现。
            // 放在 cfg 检查之前，保证即便 /config 只回清单也能生效。
            if (data && Array.isArray(data.legacyHiddenIds)) {
              for (var k = 0; k < data.legacyHiddenIds.length; k++) {
                var lid = data.legacyHiddenIds[k];
                if (typeof lid === 'string' && lid) markDeleted(lid);
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
              shared.checkIntervalMin = clampInt(cfg.checkIntervalMin, 1, 1440, 1);
              shared.autoDraft.checkIntervalMin = shared.checkIntervalMin;
            }
            // host 下发的一次性迁移清单（旧版归档残留）：并入持久化隐藏清单，
            // 防止 append-only catalog 重建后这些幽灵条目重新出现。
            if (Array.isArray(data.legacyHiddenIds)) {
              for (var k = 0; k < data.legacyHiddenIds.length; k++) {
                var lid = data.legacyHiddenIds[k];
                if (typeof lid === 'string' && lid) markDeleted(lid);
              }
            }
          })
          .catch(function () {});
      }

      // ───────────────── 删除 ─────────────────
      // 单个删除改为「物理删除」：调 host /purge（复用现成 dsh-session-archive
      // 的 /delete 物理删除管线 + host 侧清理 catalog 投影引用 / workspace 记账 /
      // 归档台账 / mnemon 虚拟目录）。成功后把 id 写入本地隐藏清单并从列表移除，
      // 因为 append-only catalog 会在下次刷新时被宿主从日志重建。
      // 每行独立 try/catch 隔离；root 会话绝不删；running 传 stopActivity:true。
      function deleteOne(ctx, row, stopActivity) {
        var id = row && row.id;
        if (!id || id === shared.rootId || !row || row.kind === 'diagnostic') return Promise.resolve();
        shared.rowStatus[id] = { state: 'deleting' };
        renderAll();
        var body = {
          sessionId: id,
          rootSessionId: shared.rootId || '',
          stopActivity: !!stopActivity,
        };
        return postJson(ROUTE_BASE + '/purge', body)
          .then(function (data) {
            if (!data || !data.ok) {
              throw new Error((data && (data.message || data.error)) || 'purge-failed');
            }
            // 删除已落地：写入持久化隐藏清单，并从当前列表立即移除该行。
            markDeleted(id);
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
            refreshSidebar(ctx, shared.rootId);
          });
      }

      function onRowDelete(ctx, row) {
        if (!row || !row.id || row.id === shared.rootId || row.kind === 'diagnostic') return;
        var running = row.activity === 'running';
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
        var targets = idleFilterLocal(filterDeleted(shared.rows), {
          rootId: shared.rootId,
          idleMinutes: shared.idleMinutes,
          now: Date.now(),
          idleSince: idleSince,
        });
        shared.cleanStatus = targets.length ? t('cleaning') : '';
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
      // running 绝不碰（idleFilterLocal 只选 inactive）。
      function autoCleanTick(ctx) {
        if (!shared.autoCleanEnabled) return;
        return loadRows(ctx).then(function (res) {
          if (res.unsupported || !res.rows.length) return; // fail-closed
          shared.rootId = res.rootId;
          shared.rows = filterDeleted(res.rows);
          updateIdleTracking(shared.rows);
          var targets = idleFilterLocal(shared.rows, {
            rootId: res.rootId,
            idleMinutes: shared.idleMinutes,
            now: Date.now(),
            idleSince: idleSince,
          });
          renderAll();
          var chain = Promise.resolve();
          targets.forEach(function (r) {
            chain = chain.then(function () { return deleteOne(ctx, r, false); });
          });
          return chain.then(function () {
            // 自动清理后同步刷新侧边栏（与手动删除 / 批量清理一致）。
            refreshSidebar(ctx, res.rootId);
          });
        }).catch(function () {});
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
        if (!row || row.kind === 'diagnostic' || row.activity === 'running') return '';
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
          shared.cleanStatus = ''; shared.settingsStatus = ''; refresh(ctx);
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
        refs.threshold.textContent = t('idleThreshold') + ' ' + shared.idleMinutes + ' ' + t('minutes');
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
        var line = el('yanyan-row');
        line.setAttribute('data-dsh-part', 'row');
        var name = (row.label || row.name || row.id || t('unknown'));
        line.appendChild(lineText(name, 'yanyan-row-name', 'row-name'));

        var running = row.activity === 'running';
        var isDiag = row.kind === 'diagnostic';
        var statusCls = 'yanyan-status ' + (running ? 'yanyan-running' : 'yanyan-idle');
        var statusLabel = isDiag ? t('diagnostic') : (running ? t('running') : t('idle'));
        var statusEl = lineText(statusLabel, statusCls, 'row-status');
        line.appendChild(statusEl);
        if (row.mode) line.appendChild(lineText(String(row.mode), 'yanyan-mode', 'row-mode'));
        if (!isDiag && !running) {
          line.appendChild(lineText(formatIdle(row), 'yanyan-idle-ms', 'row-idle'));
        }
        if (running) line.appendChild(lineText(t('stopHint'), 'yanyan-hint yanyan-stop', 'row-stop-hint'));

        var st = shared.rowStatus[row.id];
        if (st) {
          var sEl = lineText(statusText(st), 'yanyan-row-state', 'row-state');
          line.appendChild(sEl);
        }

        // 根会话 / 诊断行不显示删除按钮；其余（含 running）允许删除。
        var isRoot = row.id === shared.rootId;
        if (!isDiag && !isRoot && row.id) {
          var del = button(X_MARK, 'yanyan-x', 'row-delete', function () { onRowDelete(ctx, row); });
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
      var canReact = !!(React && React.createElement && React.useState && React.useEffect && React.useRef);
      var canPortal = !!(ReactDOM && ReactDOM.createPortal);

      function PortalHost(props) {
        var ref = React.useRef(null);
        React.useEffect(function () {
          if (!ref.current) return;
          var view = createView(ref.current, props.ctx, true);
          views.push(view);
          view.update();
          refresh(props.ctx);
          return function () {
            var i = views.indexOf(view); if (i >= 0) views.splice(i, 1);
            try { if (ref.current) ref.current.innerHTML = ''; } catch (e) {}
          };
        }, []);
        return React.createElement('div', { ref: ref, className: 'yanyan-portal-host' });
      }

      // ActionButton 组件只创建一次：槽的 render 工厂每次返回新组件类型会反复
      // 卸载重挂丢 state。label 用 readTabLabel() 支持改名即时生效。
      function makeActionButton(ctx) {
        return function ActionButton() {
          var openState = React.useState(false);
          var open = openState[0], setOpen = openState[1];
          var labelState = React.useState(readTabLabel());
          var lbl = labelState[0], setLbl = labelState[1];
          React.useEffect(function () {
            var u1 = labelEmitter.subscribe(function (v) { setLbl(v); });
            var u2 = closeEmitter.subscribe(function () { setOpen(false); });
            return function () { u1(); u2(); };
          }, []);
          var onClick = function () {
            if (canPortal) setOpen(function (v) { return !v; });
            else toggleOverlayNative(ctx);
          };
          var kids = [React.createElement('span', { key: 't' }, lbl || t('tab'))];
          if (open && canPortal) {
            kids.push(ReactDOM.createPortal(
              React.createElement(PortalHost, { ctx: ctx }), doc.body));
          }
          return React.createElement('button', {
            'data-dsh-plugin': 'yanyan-subagent',
            'data-dsh-part': 'session-tab',
            className: 'yanyan-tab-btn',
            title: t('title'),
            onClick: onClick,
          }, kids);
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
          refresh(ctx);
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
          btn.addEventListener('click', function () { toggleOverlayNative(ctx); });
          host.appendChild(btn);
          var unsub = labelEmitter.subscribe(function (l) { btn.textContent = l || t('tab'); });
          return function () {
            try { unsub(); } catch (e) {}
            try { btn.remove(); } catch (e2) {}
          };
        } catch (e) { return function () {}; }
      }

      // ───────────────── 图3 官方列表行尾加 U+2715（可选增强，尽力而为） ─────────────────
      // 官方行没有 data-id，无法可靠拿 sessionId；点击时按行文本去本地 catalog
      // 做模糊匹配（label/name 包含匹配 + 顺序对应），匹配到唯一 id 才删除，
      // 否则提示到「智能体管理」标签中删除。做不到可靠删除就诚实说明限制。
      function onOfficialXClick(ctx, item, items) {
        var text = (item.textContent || '').trim();
        var rows = filterDeleted(shared.rows).filter(function (r) {
          return r && r.kind !== 'diagnostic' && r.id;
        });
        var matches = [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var l = String(r.label || '').trim();
          var n = String(r.name || '').trim();
          if ((l && text.indexOf(l) !== -1) || (n && text.indexOf(n) !== -1)) matches.push(r);
        }
        if (matches.length !== 1) {
          // 顺序对应：用行序号与非诊断 catalog 序号对齐收敛，仍要求文本命中。
          matches = [];
          try {
            var idx = Array.prototype.indexOf.call(items, item);
            var byOrder = rows[idx];
            if (byOrder) {
              var l2 = String(byOrder.label || '').trim();
              var n2 = String(byOrder.name || '').trim();
              if ((l2 && text.indexOf(l2) !== -1) || (n2 && text.indexOf(n2) !== -1)) matches = [byOrder];
            }
          } catch (e) { matches = []; }
        }
        if (matches.length === 1 && matches[0].id) {
          var row = matches[0];
          var ok = true;
          try { ok = root.confirm(row.activity === 'running' ? t('confirmDeleteRunning') : t('confirmDelete')); }
          catch (e3) { ok = true; }
          if (ok) deleteOne(ctx, row, row.activity === 'running');
        } else {
          try { root.alert(t('officialNoMatch')); } catch (e4) {}
        }
      }

      function injectOfficialButtons(ctx, panel) {
        var items = panel.querySelectorAll('[role="treeitem"]');
        for (var i = 0; i < items.length; i++) {
          (function (item) {
            if (item.querySelector('[data-dsh-part="official-row-delete"]')) return;
            var b = doc.createElement('button');
            b.type = 'button';
            b.className = 'yanyan-official-x';
            b.setAttribute('data-dsh-plugin', 'yanyan-subagent');
            b.setAttribute('data-dsh-part', 'official-row-delete');
            b.setAttribute('aria-label', t('delete'));
            b.title = t('delete');
            b.textContent = X_MARK;
            b.addEventListener('click', function (ev) {
              if (ev && ev.stopPropagation) ev.stopPropagation();
              if (ev && ev.preventDefault) ev.preventDefault();
              onOfficialXClick(ctx, item, items);
            });
            item.appendChild(b);
            officialButtons.push(b);
          })(items[i]);
        }
      }
      function clearOfficialButtons() {
        for (var i = 0; i < officialButtons.length; i++) {
          try { officialButtons[i].remove(); } catch (e) {}
        }
        officialButtons.length = 0;
      }

      // ───────────────── 样式 ─────────────────
      var STYLE_CSS = [
        '.yanyan-tab-btn{display:inline-flex;align-items:center;gap:6px;',
        'background:transparent;border:1px solid var(--yanyan-border,#d0d7de);',
        'color:var(--yanyan-fg,#1f2328);border-radius:6px;padding:4px 10px;',
        'font-size:12px;cursor:pointer;white-space:nowrap}',
        '.yanyan-tab-btn:hover{border-color:var(--dsw-alias-button-primary-fill,#2f6feb)}',
        '.yanyan-portal-host,.yanyan-native-overlay{position:fixed;top:64px;right:24px;',
        'width:380px;max-width:calc(100vw - 48px);max-height:min(72vh,600px);',
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
        '.yanyan-list{flex:1;overflow:auto;min-height:60px}',
        '.yanyan-row{display:flex;align-items:center;gap:8px;padding:8px 14px;',
        'border-bottom:1px solid var(--yanyan-border,#d0d7de)}',
        '.yanyan-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.yanyan-status{font-size:11px;padding:1px 6px;border-radius:10px;white-space:nowrap}',
        '.yanyan-idle{background:var(--yanyan-idle-bg,#eaeef2);color:var(--yanyan-muted,#656d76)}',
        '.yanyan-running{background:var(--yanyan-run-bg,#dafbe1);color:#1a7f37}',
        '.yanyan-mode,.yanyan-idle-ms,.yanyan-root-tag{font-size:11px;',
        'color:var(--yanyan-muted,#656d76);white-space:nowrap}',
        '.yanyan-stop{color:#9a6700;white-space:normal}',
        '.yanyan-row-state{font-size:11px;color:#cf222e;white-space:nowrap}',
        '.yanyan-x,.yanyan-official-x{border:none;background:transparent;cursor:pointer;',
        'color:var(--yanyan-muted,#656d76);font-size:14px;line-height:1;padding:2px 6px;',
        'border-radius:4px;flex:none}',
        '.yanyan-x:hover,.yanyan-official-x:hover{background:var(--yanyan-danger-bg,#ffebe9);color:#cf222e}',
        '.yanyan-x:disabled{opacity:.4;cursor:default}',
        '.yanyan-official-x{margin-left:auto;font-size:12px}',
        '.yanyan-footer{display:flex;align-items:center;gap:10px;padding:10px 14px;',
        'border-top:1px solid var(--yanyan-border,#d0d7de);flex-wrap:wrap}',
        '.yanyan-threshold{font-size:11px;color:var(--yanyan-muted,#656d76)}',
        '.yanyan-result{font-size:11px;color:#1a7f37;flex-basis:100%}',
        '.yanyan-empty{padding:20px 14px;text-align:center;font-size:12px;',
        'color:var(--yanyan-muted,#656d76)}',
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

        // 设置（异步读取 host /config 补齐缺省值）。
        loadSettings(ctx).then(function () { renderAll(); });

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
          try {
            var list = ctx.sessions && ctx.sessions.list;
            if (list && typeof list.subscribe === 'function') {
              var sub = list.subscribe(function () { if (!disposed) refresh(ctx, false); });
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

          // 自动清理巡检（默认关闭；配置变更即时重排 interval）。
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
