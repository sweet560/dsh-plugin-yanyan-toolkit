/* dsh-plugin-yanyan-trash — Client (browser) half：会话回收站设置页区块。
 *
 * 手写预编译 IIFE（toolkit 无构建步骤），用 window.__ModuleLoader__ 装载，
 * 与现成包 @linxin666/dsh-session-archive 的结构一致：react 由 require 注入，
 * DSH 内部服务（slots/locale/connection/sessions）由 dsh.client.inject 声明。
 *
 * 本 client 只消费 Host 半的回收站路由（api/dsh-yanyan-trash/*），不重写任何
 * 归档/删除安全逻辑。4b 承接要点：
 *   - reason 映射区分粒度（单条目拒绝 / 整族保留 / 结构性整批拒绝）；
 *   - read-error 家族整族保留提示「父受保护 → N 个子代理一并保留」；
 *   - payload id 已是 canonical 字符串，直接消费不再归一；
 *   - 双入口过渡：旧 @linxin666 删除入口旁标注「此操作不进入回收站，不可恢复」；
 *   - 订阅宿主原生 api-session/removed/added 事件刷新（与第 1 阶段旧结论相反，
 *     第 4 阶段核实宿主确实 emit 这两个事件）。
 *
 * UI 重构（网页 chat 真机反馈）：上半区=活跃会话列表（搜索 + 多选 + 标题/时间），
 * 下半区=回收站列表（保留功能、优化样式）。视觉对齐 DSH 原生设置页：内联 CSS
 * 用 --dsw-alias-* token + fallback，注入 document.head 并按 tagId 防重（照抄
 * 现成包 archive.module.css 的生产做法）。标题回退见 displayTitle：活跃会话
 * summary 本身无 title，优先用 row 自带的 title/label，拿到即显示，拿不到回退
 * 短 id + 活跃时间——绝不显示裸的长 uuid。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-yanyan-trash",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useSyncExternalStore = React.useSyncExternalStore;

    var API_PREFIX = "api/dsh-yanyan-trash";
    var SECTION_ID = "dsh-yanyan-trash";
    var SECTION_ORDER = 26; // 与现成包的 25 不同，避免同 id/priority 冲突；仅作排序。
    var NS = "dsh-yanyan-trash";
    var DEFAULT_TIMEOUT_MS = 15000;
    var BATCH_TIMEOUT_MS = 120000;

    // ---------- 内联 CSS（对齐 DSH 原生设置页视觉 token） ----------
    // 照抄现成包 @linxin666/dsh-session-archive 的做法：内联 CSS 字符串 + style
    // 标签注入 document.head，用 data-plugin-css tagId 防重。全部颜色/间距走
    // --dsw-alias-* token 并带 fallback，跟随 DSH 明暗主题。
    var CSS = ".ytr-root{color:var(--dsw-alias-label-primary,#1f2328);flex-direction:column;gap:14px;font-size:13px;line-height:1.5;display:flex;max-width:100%}.ytr-root input[type=checkbox]{accent-color:var(--dsw-alias-button-primary-fill,#4a6cf7);cursor:pointer}.ytr-section{border:1px solid var(--dsw-alias-border-l1,#e1e5ea);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:10px;flex-direction:column;gap:10px;padding:14px;display:flex;min-width:0}.ytr-section-head{align-items:baseline;gap:10px;display:flex;flex-wrap:wrap}.ytr-section-title{font-size:14px;font-weight:600}.ytr-section-sub{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}.ytr-header{justify-content:space-between;align-items:center;gap:8px;display:flex;flex-wrap:wrap}.ytr-title{font-size:15px;font-weight:600}.ytr-count{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}.ytr-btn{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;border-radius:8px;padding:5px 12px;transition:background-color .14s,border-color .14s}.ytr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#0000000d)}.ytr-btn:disabled{opacity:.45;cursor:default}.ytr-btn-primary{background:var(--dsw-alias-button-primary-fill,#4a6cf7);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent}.ytr-btn-primary:hover:not(:disabled){filter:brightness(1.06)}.ytr-btn-danger{background:var(--dsw-alias-state-error-primary,#d64545);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent}.ytr-btn-danger:hover:not(:disabled){filter:brightness(1.08)}.ytr-link{color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-button-primary-fill,#4a6cf7));cursor:pointer;background:none;border:0;border-radius:6px;padding:3px 8px;font-size:12px}.ytr-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#0000000d)}.ytr-link-danger{color:var(--dsw-alias-state-error-primary,#d64545)}.ytr-toolbar{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.ytr-toolbar-end{margin-left:auto;display:inline-flex;gap:8px;flex-wrap:wrap}.ytr-search{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:5px 10px;font-size:13px;min-width:180px;flex:1}.ytr-search::placeholder{color:var(--dsw-alias-label-tertiary,#8c959f)}.ytr-search:focus-visible,.ytr-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 60%,transparent);outline-offset:1px}.ytr-list{border:1px solid var(--dsw-alias-border-l1,#e1e5ea);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-shadow-lv1,0 1px 3px #00000014);border-radius:8px;flex-direction:column;display:flex;overflow:hidden;max-height:320px;overflow-y:auto}.ytr-list-row{border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea);align-items:center;gap:10px;padding:8px 10px;transition:background-color .14s;display:flex}.ytr-list-row:last-child{border-bottom:0}.ytr-list-row:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000a)}.ytr-list-row-selected{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 10%,transparent);box-shadow:inset 3px 0 0 0 var(--dsw-alias-button-primary-fill,#4a6cf7)}.ytr-row-main{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}.ytr-row-title{overflow-wrap:anywhere;font-weight:600}.ytr-row-meta{color:var(--dsw-alias-label-secondary,#57606a);flex-wrap:wrap;gap:4px 12px;font-size:12px;display:flex}.ytr-id-sub{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 7%,transparent);overflow-wrap:anywhere;border-radius:4px;padding:0 5px;font-family:ui-monospace,monospace;font-size:11px;margin-left:6px}.ytr-check{display:inline-flex;align-items:center;gap:5px;cursor:pointer}.ytr-empty{text-align:center;color:var(--dsw-alias-label-tertiary,#8c959f);padding:22px 16px}.ytr-dual-warning{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 8%,transparent);color:var(--dsw-alias-state-warn-primary,#b45309);border-radius:8px;padding:8px 12px}.ytr-hint{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}.ytr-table{width:100%;border-collapse:collapse}.ytr-table th,.ytr-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea);vertical-align:top}.ytr-table th{color:var(--dsw-alias-label-secondary,#57606a);font-weight:600;font-size:12px}.ytr-path{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;overflow-wrap:anywhere;max-width:260px}.ytr-status{font-size:12px}.ytr-actions{white-space:nowrap}.ytr-results{border:1px solid var(--dsw-alias-border-l1,#e1e5ea);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}.ytr-result-head{font-weight:600}.ytr-ok{color:var(--dsw-alias-state-success-primary,#2f9e6e)}.ytr-fail{color:var(--dsw-alias-state-error-primary,#d64545)}.ytr-family-note{color:var(--dsw-alias-state-warn-primary,#b45309);font-size:12px}.ytr-results ul{margin:0;padding-left:18px}.ytr-result-row{padding:2px 0}.ytr-scope-family{color:var(--dsw-alias-state-warn-primary,#b45309)}.ytr-scope-batch{color:var(--dsw-alias-state-error-primary,#d64545)}.ytr-confirm{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 6%,transparent);border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ytr-confirm-text{flex:1;min-width:180px}.ytr-selected-count{font-weight:600}.ytr-no-match{color:var(--dsw-alias-label-tertiary,#8c959f);font-size:12px}@media(prefers-reduced-motion:reduce){.ytr-btn,.ytr-list-row{transition:none}}";
    var CSS_TAG_ID = "@dsh-plugin-yanyan-trash/client/trash-ui.css";
    function injectCss() {
      try {
        if (typeof document === "undefined") return;
        if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-plugin-yanyan-trash";
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) {}
    }

    // ---------- 本地化 ----------
    var dict = {
      zh: {
        "trash.nav": "会话回收站",
        "trash.title": "会话回收站",
        "trash.count": "共 {n} 项",
        "trash.refresh": "刷新",
        "trash.refreshing": "刷新中…",
        "trash.empty": "回收站为空。删除会话后可在恢复前从这里找回。通过其他入口删除的会话不会出现在此处。",
        "trash.col.session": "会话",
        "trash.col.path": "原位置",
        "trash.col.status": "状态",
        "trash.col.action": "操作",
        "trash.selectAll": "全选",
        "trash.restore": "恢复",
        "trash.purge": "彻底删除",
        "trash.cascade": "级联删除（含子代理）",
        "trash.batchRestore": "批量恢复",
        "trash.batchPurge": "批量彻底删除",
        "trash.trashTitle": "移入回收站",
        "trash.trashHint": "在当前会话中选择一个或多个会话移入回收站（可恢复）。",
        "trash.noLive": "没有可操作的当前会话。",
        "trash.trashDo": "移入回收站",
        "trash.warnDual": "提示：官方/归档插件的删除不进入回收站，不可恢复。请改用上方「移入回收站」。",
        "trash.busy": "处理中…",
        "trash.resultOk": "操作完成。",
        "trash.resultFail": "操作未完成，请看下方逐条结果。",
        "trash.reasonUnknown": "操作未完成，原因代码：{r}（新代码请在回收站插件中补充映射）。",
        "trash.none": "（无）",
        "trash.confirmCascade": "确认级联删除：将彻底删除父会话及其 {n} 个子代理（不可恢复）。",
        "trash.confirmCascadeNone": "确认级联删除：将彻底删除所选父会话（快照不可用，子代理数量未知）。",
        "trash.confirmYes": "确认删除",
        "trash.confirmNo": "取消",
        "trash.sectionActive": "当前会话",
        "trash.sectionTrash": "回收站",
        "trash.activeSub": "勾选会话后可批量移入回收站，操作可恢复。",
        "trash.search": "搜索会话标题或 ID…",
        "trash.noMatch": "没有匹配的会话。",
        "trash.selectedCount": "已选 {n} 项",
        "trash.lastActive": "活跃于 {t}",
        "trash.timeUnknown": "时间未知",
        "trash.noTitle": "（无标题）",
      },
      en: {
        "trash.nav": "Session Recycle Bin",
        "trash.title": "Session Recycle Bin",
        "trash.count": "{n} item(s)",
        "trash.refresh": "Refresh",
        "trash.refreshing": "Refreshing…",
        "trash.empty": "Trash is empty. Deleted sessions can be recovered here before purge. Sessions deleted through other entries do not appear here.",
        "trash.col.session": "Session",
        "trash.col.path": "Original path",
        "trash.col.status": "Status",
        "trash.col.action": "Action",
        "trash.selectAll": "Select all",
        "trash.restore": "Restore",
        "trash.purge": "Purge",
        "trash.cascade": "Cascade delete (incl. subagents)",
        "trash.batchRestore": "Restore selected",
        "trash.batchPurge": "Purge selected",
        "trash.trashTitle": "Move to trash",
        "trash.trashHint": "Pick one or more current sessions to move into the trash (recoverable).",
        "trash.noLive": "No current session available.",
        "trash.trashDo": "Move to trash",
        "trash.warnDual": "Note: the official/archive plugin's delete does NOT enter this trash and cannot be undone. Use “Move to trash” above instead.",
        "trash.busy": "Working…",
        "trash.resultOk": "Done.",
        "trash.resultFail": "Incomplete — see per-item results below.",
        "trash.reasonUnknown": "Operation incomplete, reason code: {r} (add a mapping in the trash plugin for new codes).",
        "trash.none": "(none)",
        "trash.confirmCascade": "Confirm cascade delete: this will permanently delete the parent session and its {n} subagent(s) (not recoverable).",
        "trash.confirmCascadeNone": "Confirm cascade delete: this will permanently delete the selected parent session (snapshot unavailable, subagent count unknown).",
        "trash.confirmYes": "Confirm delete",
        "trash.confirmNo": "Cancel",
        "trash.sectionActive": "Current sessions",
        "trash.sectionTrash": "Recycle bin",
        "trash.activeSub": "Select sessions to move them into the trash (recoverable).",
        "trash.search": "Search session title or ID…",
        "trash.noMatch": "No matching sessions.",
        "trash.selectedCount": "{n} selected",
        "trash.lastActive": "Active {t}",
        "trash.timeUnknown": "time unknown",
        "trash.noTitle": "(untitled)",
      },
    };
    var runtimeLocale = null;
    function t(key, vars) {
      var raw = (runtimeLocale ? runtimeLocale(key) : null) ?? dict.zh[key] ?? key;
      if (vars) {
        Object.keys(vars).forEach(function (k) {
          raw = String(raw).split("{" + k + "}").join(String(vars[k]));
        });
      }
      return raw;
    }

    // ---------- 标题/时间格式化（displayTitle 回退逻辑，供活跃会话列表与测试复用） ----------
    // 活跃会话 summary 本身不带 title（DSH summaryFor 只有 sessionId/updatedAt/running 等），
    // 真标题在日志的 session/title 事件里（client 无 fs 无法读，故 host 侧回收站用 readSessionTitle）。
    // 这里按优先级回退：row 自带 title / displayTitle / label / sessionTitle → 无则 null，
    // 由调用方显示短 id + 活跃时间。绝不显示裸的长 uuid，也不显示 undefined/NaN。
    function displayTitle(row) {
      if (!row || typeof row !== "object") return null;
      var keys = ["title", "displayTitle", "label", "sessionTitle"];
      for (var i = 0; i < keys.length; i++) {
        var v = row[keys[i]];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    }
    function shortId(id) {
      var s = String(id == null ? "" : id).replace(/^session-/, "");
      return s.length > 8 ? s.slice(0, 8) : s;
    }
    function formatActivityTime(row) {
      if (!row || typeof row !== "object") return null;
      var candidates = ["lastActivityAt", "updatedAt", "lastPromptAt", "createdAt"];
      for (var i = 0; i < candidates.length; i++) {
        var v = row[candidates[i]];
        if (typeof v === "number" && isFinite(v) && v > 0) {
          try { return new Date(v).toLocaleString(); } catch (e) { return String(v); }
        }
      }
      return null;
    }
    function filterLiveRows(rows, query) {
      var needle = String(query || "").trim().toLowerCase();
      if (!needle) return rows || [];
      return (rows || []).filter(function (row) {
        var id = String(row && (row.id || row.sessionId) || "").toLowerCase();
        if (id.indexOf(needle) >= 0) return true;
        var title = displayTitle(row);
        return !!title && title.toLowerCase().indexOf(needle) >= 0;
      });
    }

    // ---------- reason → 用户提示（区分影响范围粒度，4b 承接核心） ----------
    // 每条返回 { text, scope }：scope ∈ 'item' | 'family' | 'batch'，供 UI 决定呈现强度。
    var REASON_MAP = {
      "corrupt-target": {
        zh: "该会话数据已损坏，已单独跳过，不影响其它会话。",
        en: "This session's data is corrupt; it was skipped alone without affecting others.",
        scope: "item",
      },
      "read-error": {
        zh: "父会话处于受保护状态，连同其子代理一并保留，未删除任何会话。",
        en: "The parent is protected; it and its subagents were all kept. Nothing was deleted.",
        scope: "family",
      },
      "family-protected": {
        zh: "会话树中有受保护成员，整族保留，未删除任何会话。",
        en: "A protected member exists in the tree; the whole family was kept. Nothing was deleted.",
        scope: "family",
      },
      "child-ids-dangling": {
        zh: "会话树数据不完整（存在悬挂引用），请刷新后重试；本次未删除任何会话。",
        en: "The session tree is incomplete (dangling references). Refresh and retry; nothing was deleted.",
        scope: "batch",
      },
      "invalid-origin":
        { zh: "会话树含非法来源标记，已整批拒绝，未删除任何会话。", en: "Invalid origin in the tree; batch refused, nothing deleted.", scope: "batch" },
      "purge-in-progress":
        { zh: "会话正在彻底删除中，请稍候再试。", en: "A purge is in progress; please retry shortly.", scope: "item" },
      purging:
        { zh: "该会话已进入彻底删除流程，正在处理中。", en: "This session is in the purge pipeline.", scope: "item" },
      quarantined:
        { zh: "该会话已被隔离，无法操作。", en: "This session is quarantined and cannot be operated on.", scope: "item" },
      exdev:
        { zh: "回收站与会话目录不在同一磁盘，已拒绝删除。", en: "Trash and sessions are on different volumes; delete refused.", scope: "item" },
      "restore-project-first":
        { zh: "原项目目录不存在，请先恢复项目再恢复该会话。", en: "The original project directory is gone; restore the project first.", scope: "item" },
      "original-project-missing":
        { zh: "原项目目录不存在，无法恢复。", en: "The original project directory is missing; cannot restore.", scope: "item" },
      "no-manifest-entry":
        { zh: "回收站账本无此条目，请刷新。", en: "No manifest entry for this session; refresh.", scope: "item" },
      "not-found":
        { zh: "未找到该会话，请刷新。", en: "Session not found; refresh.", scope: "item" },
      "target-race":
        { zh: "目标位置已被占用，请刷新后重试。", en: "Target path is occupied; refresh and retry.", scope: "item" },
      "manifest-write-failed":
        { zh: "账本写入失败，操作将在恢复流程中收敛。", en: "Manifest write failed; it will settle via recovery.", scope: "item" },
      "archive-gate":
        { zh: "该会话不支持归档或正处于锁定状态，暂时无法移入回收站。", en: "This session cannot be archived or is locked; it could not be moved to the trash.", scope: "item" },
      "archive-active":
        { zh: "该会话仍处于活动状态，请先结束其任务再移入回收站。", en: "This session is still active; finish its task before moving it to the trash.", scope: "item" },
    };
    function reasonText(result) {
      var reason = result && result.reason;
      if (reason === undefined) return { text: t("trash.resultFail"), scope: "batch" };
      var hit = REASON_MAP[reason];
      // fail-safe：未来宿主新增保护态/原因码未映射时，回退通用文案而非空白/undefined，
      // 并保留原始 reason 代码便于诊断（与第 3 阶段 ?? Infinity 纪律一致）。
      if (!hit) return { text: t("trash.reasonUnknown", { r: String(reason) }), scope: "item" };
      return { text: typeof hit[NS === "zh" ? "zh" : "en"] === "string" ? hit[NS === "zh" ? "zh" : "en"] : hit.zh, scope: hit.scope };
    }

    // ---------- API ----------
    function ApiError(status, body) {
      this.status = status;
      this.body = body;
      this.message = "trash api failed (" + status + ")";
    }
    ApiError.prototype = Object.create(Error.prototype);
    function request(path, init, timeoutMs) {
      return fetch(path, {
        method: init && init.method,
        headers: Object.assign({ "content-type": "application/json" }, init && init.headers),
        body: init && init.body,
        signal: AbortSignal.timeout(timeoutMs),
      }).then(function (response) {
        return response.json().catch(function () { return undefined; }).then(function (body) {
          if (!response.ok) throw new ApiError(response.status, body);
          return body;
        });
      });
    }
    function post(path, payload, timeoutMs) {
      return request(path, { method: "POST", body: JSON.stringify(payload || {}) }, timeoutMs);
    }
    function createApi() {
      return {
        list: function () { return request(API_PREFIX + "/list", undefined, DEFAULT_TIMEOUT_MS); },
        snapshot: function () { return request(API_PREFIX + "/snapshot", undefined, DEFAULT_TIMEOUT_MS); },
        restore: function (id) { return post(API_PREFIX + "/restore", { id: id }, BATCH_TIMEOUT_MS); },
        trash: function (ids) { return post(API_PREFIX + "/trash", { ids: ids }, BATCH_TIMEOUT_MS); },
        purge: function (ids) { return post(API_PREFIX + "/purge", { ids: ids }, BATCH_TIMEOUT_MS); },
        cascade: function (ids, protectedReason) { return post(API_PREFIX + "/cascade", { ids: ids, protectedReason: protectedReason || {} }, BATCH_TIMEOUT_MS); },
        purgeExpired: function () { return post(API_PREFIX + "/purge-expired", {}, BATCH_TIMEOUT_MS); },
        recover: function () { return post(API_PREFIX + "/recover", {}, BATCH_TIMEOUT_MS); },
      };
    }

    // ---------- store（useSyncExternalStore 兼容） ----------
    function createStore(initial) {
      var state = initial;
      var listeners = new Set();
      return {
        subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
        getSnapshot: function () { return state; },
        set: function (next) { state = Object.assign({}, state, next); listeners.forEach(function (fn) { fn(); }); },
      };
    }

    // ---------- controller ----------
    function TrashController(options) {
      this.api = options.api;
      this.sessions = options.sessions;
      this.store = createStore({
        status: "idle",
        entries: [],
        snapshot: null,
        selection: [], // 回收站条目的勾选（批量恢复/彻底删除）
        liveRows: [],  // 活跃会话完整行（含可能的 title / 时间），不再只存 id 字符串
        last: null,
      });
    }
    TrashController.prototype.load = function () {
      var self = this;
      this.store.set({ status: "loading" });
      return Promise.all([
        this.api.list().catch(function () { return { entries: [] }; }),
        this.api.snapshot().catch(function () { return null; }),
      ]).then(function (res) {
        self.store.set({
          status: "ready",
          entries: Array.isArray(res[0] && res[0].entries) ? res[0].entries : [],
          snapshot: res[1],
        });
      });
    };
    // 保留完整 row（含 title/lastActivityAt），修复原先只取 id 导致选项显示裸 id 的根因。
    TrashController.prototype.liveRows = function () {
      var rows = [];
      try {
        var store = this.sessions && this.sessions.list;
        var snap = store && typeof store.getSnapshot === "function" ? store.getSnapshot() : null;
        var byId = snap && snap.byId;
        if (byId) {
          Object.keys(byId).forEach(function (key) {
            var row = byId[key];
            var id = row && (row.id || row.sessionId || key);
            if (typeof id === "string") rows.push(Object.assign({}, row, { id: id }));
          });
        }
      } catch (e) {}
      this.store.set({ liveRows: rows });
      return rows;
    };
    // 兼容旧名（若有外部契约读取 live）。
    TrashController.prototype.liveIds = function () {
      return this.liveRows().map(function (r) { return r.id; });
    };
    TrashController.prototype._run = function (promise) {
      var self = this;
      this.store.set({ status: "busy" });
      return promise
        .then(function (result) {
          self.store.set({ last: result });
          // 真机 bug m03612/m03616 修复：恢复/删除会改变宿主会话集合，必须让宿主自行重新发现
          // （照抄现成包 @linxin666 client.js:541-542 的 sessions.refresh()）。绝不在 host 伪造
          // api-session/added——宿主期望 summary 对象，字符串 id 会造出"未命名/NaN"幽灵行。
          self._refreshHostSessions();
          return self.load();
        })
        .catch(function (err) {
          self.store.set({ last: { ok: false, reason: "request-failed", message: String((err && err.message) || err) } });
          return self.load();
        });
    };
    /** 让宿主重新扫描磁盘发现被移入/移出回收站的会话（fire-and-forget，异常不影响本插件 UI）。 */
    TrashController.prototype._refreshHostSessions = function () {
      try {
        var sessions = this.sessions;
        if (sessions && typeof sessions.refresh === "function") {
          var p = sessions.refresh();
          if (p && typeof p.catch === "function") p.catch(function () {});
        }
      } catch (e) {}
    };
    TrashController.prototype.trash = function (ids) { return this._run(this.api.trash(ids)); };
    TrashController.prototype.trashMany = function (ids) { return this._run(this.api.trash(ids)); };
    TrashController.prototype.restore = function (id) { return this._run(this.api.restore(id)); };
    TrashController.prototype.purge = function (ids) { return this._run(this.api.purge(ids)); };
    TrashController.prototype.cascade = function (ids) { return this._run(this.api.cascade(ids, {})); };
    TrashController.prototype.toggle = function (id) {
      var cur = this.store.getSnapshot().selection.slice();
      var i = cur.indexOf(id);
      if (i >= 0) cur.splice(i, 1); else cur.push(id);
      this.store.set({ selection: cur });
    };
    TrashController.prototype.setSelection = function (ids) { this.store.set({ selection: ids.slice() }); };

    // ---------- 原生事件订阅（刷新） ----------
    function subscribeSessionEvents(ctx, onChange) {
      var events = ["api-session/removed", "api-session/added", "api-session/purged"];
      var offs = [];
      events.forEach(function (evt) {
        try {
          if (ctx.on && typeof ctx.on === "function") {
            var off = ctx.on(evt, onChange);
            if (typeof off === "function") offs.push(off);
          } else if (ctx.connection && typeof ctx.connection.on === "function") {
            var off2 = ctx.connection.on(evt, onChange);
            if (typeof off2 === "function") offs.push(off2);
          }
        } catch (e) {}
      });
      return function () { offs.forEach(function (fn) { try { fn(); } catch (e) {} }); };
    }

    // ---------- 级联预览 ----------
    // 与 cascade.descendantsOf 同构：从选中 id 出发只沿 origin=subagent 的 childIds 边
    // 遍历，fork 及其分支剪掉。这样预览的 N 与实际被删的子代理数一致，避免误导。
    // 收集 rootId 的全部后代 id（不含自身）。与 host 侧 cascade.descendantsOf 等价：
    // 只沿 childIds 边、只纳入 origin === "subagent" 的子节点（fork/未知剪掉），seen 去重、容忍环。
    // client 是浏览器 IIFE，不能 import host 模块，故为独立实现；等价性由 __testing 对照测试锁死。
    function collectCascadeDescendants(rows, rootId) {
      var byId = {};
      (rows || []).forEach(function (r) { if (r && r.id) byId[r.id] = r; });
      var seen = {};
      var out = [];
      var queue = [rootId];
      while (queue.length) {
        var cur = queue.shift();
        var row = byId[cur];
        if (!row) continue;
        (row.childIds || []).forEach(function (childId) {
          if (seen[childId]) return;
          var child = byId[childId];
          if (!child || child.origin !== "subagent") return; // fork/未知剪掉
          seen[childId] = true;
          out.push(childId);
          queue.push(childId);
        });
      }
      return out;
    }
    function countCascadeDescendants(rows, rootId) {
      return collectCascadeDescendants(rows, rootId).length;
    }

    // ---------- React 组件 ----------
    function ResultPanel(props) {
      var last = props.last;
      if (!last) return null;
      var results = Array.isArray(last.results) ? last.results : [];
      var ok = last.ok === true;
      var familyKept = results.some(function (r) { return r && r.reason === "read-error" || r.reason === "family-protected"; });
      var header = h("div", { className: "ytr-result-head " + (ok ? "ytr-ok" : "ytr-fail") },
        ok ? t("trash.resultOk") : t("trash.resultFail"));
      var rows = results.map(function (r, i) {
        var info = reasonText(r);
        return h("li", { key: i, className: "ytr-result-row ytr-scope-" + info.scope },
          h("code", null, String(r.id || "")),
          h("span", null, " — " + info.text));
      });
      var familyNote = familyKept
        ? h("div", { className: "ytr-family-note" }, reasonText({ reason: "read-error" }).text)
        : null;
      return h("div", { className: "ytr-results", "data-dsh-part": "results" },
        header, familyNote, rows.length ? h("ul", null, rows) : null);
    }

    /** 活跃会话多选列表（搜索 + 复选框 + 标题 + 最后活跃时间），替代原 <select>。 */
    function ActiveSessionList(props) {
      var controller = props.controller;
      var busy = props.busy;
      var ui = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
      var [query, setQuery] = useState("");
      var [checked, setChecked] = useState([]);
      useEffect(function () { controller.liveRows(); }, [controller]);
      var liveRows = ui.liveRows || [];
      var shown = filterLiveRows(liveRows, query);
      var checkedSet = new Set(checked);
      var toggleOne = function (id) {
        var cur = checked.slice();
        var i = cur.indexOf(id);
        if (i >= 0) cur.splice(i, 1); else cur.push(id);
        setChecked(cur);
      };
      var allShownSelected = shown.length > 0 && shown.every(function (r) { return checkedSet.has(r.id); });
      var toggleAllShown = function (on) {
        var cur = checked.slice();
        shown.forEach(function (r) {
          var i = cur.indexOf(r.id);
          if (on && i < 0) cur.push(r.id);
          if (!on && i >= 0) cur.splice(i, 1);
        });
        setChecked(cur);
      };
      var doTrash = function () {
        if (!checked.length) return;
        var ids = checked.slice();
        controller.trashMany(ids).then(function () { setChecked([]); });
      };
      if (!liveRows.length) return h("div", { className: "ytr-empty" }, t("trash.noLive"));
      return h("div", { className: "ytr-active-list", "data-dsh-part": "active-list" },
        h("div", { className: "ytr-toolbar" },
          h("input", {
            type: "search",
            className: "ytr-search",
            value: query,
            placeholder: t("trash.search"),
            onChange: function (e) { setQuery(e.target.value); },
          })),
        h("div", { className: "ytr-list", "data-dsh-part": "live-list" },
          shown.length === 0
            ? h("div", { className: "ytr-no-match" }, t("trash.noMatch"))
            : shown.map(function (row) {
              var id = row.id;
              var title = displayTitle(row);
              var at = formatActivityTime(row);
              var selected = checkedSet.has(id);
              return h("div", {
                key: id,
                className: "ytr-list-row" + (selected ? " ytr-list-row-selected" : ""),
                "data-dsh-part": "live-row",
              },
                h("input", {
                  type: "checkbox",
                  checked: selected,
                  "aria-label": title || id,
                  onChange: function () { toggleOne(id); },
                }),
                h("div", { className: "ytr-row-main" },
                  h("div", { className: "ytr-row-title" },
                    title || t("trash.noTitle"),
                    h("code", { className: "ytr-id-sub" }, String(id))),
                  h("div", { className: "ytr-row-meta" },
                    at ? t("trash.lastActive", { t: at }) : t("trash.timeUnknown"))));
            })),
        h("div", { className: "ytr-toolbar" },
          h("label", { className: "ytr-check" },
            h("input", {
              type: "checkbox",
              checked: allShownSelected,
              onChange: function (e) { toggleAllShown(e.target.checked); },
            }),
            t("trash.selectAll")),
          h("span", { className: "ytr-selected-count" }, t("trash.selectedCount", { n: checked.length })),
          h("span", { className: "ytr-toolbar-end" },
            h("button", {
              type: "button",
              className: "ytr-btn ytr-btn-primary",
              disabled: busy || !checked.length,
              onClick: doTrash,
            }, t("trash.trashDo")))));
    }

    function SessionTrashCard(props) {
      var controller = props.controller;
      var ui = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
      useEffect(function () { controller.load(); }, [controller]);
      var [pending, setPending] = useState(null); // {kind:'cascade'|'purge'|'batchPurge', ids:[...]}

      var entries = ui.entries || [];
      var selection = ui.selection || [];
      var selectionSet = new Set(selection);
      var busy = ui.status === "busy";
      var selected = function () { return entries.filter(function (e) { return selectionSet.has(e.id); }).map(function (e) { return e.id; }); };

      // 级联预览：从快照 rows 算出所选根会话的后代数量（fork 剪掉，与实际删除范围一致）。
      var snapshotRows = ui.snapshot && Array.isArray(ui.snapshot.rows) ? ui.snapshot.rows : null;
      var previewCount = function (ids) {
        if (!snapshotRows) return null; // 快照不可用 → 数量未知，走兜底文案
        // 后代集合按 id 去重后计数，与实际删除用的 cascade planDelete（targets 为 Set）一致。
        // 数据异常时两个父可能共享一个子代理，逐个求和会高估 N、误导用户。
        var union = {};
        ids.forEach(function (id) {
          collectCascadeDescendants(snapshotRows, id).forEach(function (child) { union[child] = true; });
        });
        return Object.keys(union).length;
      };
      var runPending = function () {
        if (!pending) return;
        var act = pending;
        setPending(null);
        if (act.kind === "cascade") controller.cascade(act.ids);
        else if (act.kind === "batchPurge") controller.purge(act.ids);
        else controller.purge(act.ids);
      };
      var confirmText = function () {
        if (!pending) return "";
        var n = previewCount(pending.ids);
        if (n === null) return t("trash.confirmCascadeNone");
        return t("trash.confirmCascade", { n: n });
      };

      var statusOf = function (e) { return e.status || "trashed"; };
      var row = function (e) {
        var id = e.id;
        // 真机 A2 标题子项修复（m03612）：manifest 无 title，Host list 已从会话日志补 e.title；
        // 有标题显示标题、小字附 id；无标题回退 id（绝不显示 undefined/NaN）。
        var title = typeof e.title === "string" && e.title ? e.title : "";
        return h("tr", { key: id, className: "ytr-row" },
          h("td", null,
            h("label", { className: "ytr-check" },
              h("input", {
                type: "checkbox",
                checked: selectionSet.has(id),
                onChange: function () { controller.toggle(id); },
              }),
              title
                ? h("span", null, title, h("code", { className: "ytr-id-sub" }, String(id)))
                : h("code", null, String(id)))),
          h("td", { className: "ytr-path" }, String(e.originalPath || e.original_path || t("trash.none"))),
          h("td", { className: "ytr-status" }, String(statusOf(e))),
          h("td", { className: "ytr-actions" },
            h("button", { type: "button", className: "ytr-link", disabled: busy, onClick: function () { controller.restore(id); } }, t("trash.restore")),
            h("button", { type: "button", className: "ytr-link", disabled: busy, onClick: function () { setPending({ kind: "cascade", ids: [id] }); } }, t("trash.cascade")),
            h("button", { type: "button", className: "ytr-link ytr-link-danger", disabled: busy, onClick: function () { controller.purge([id]); } }, t("trash.purge"))));
      };

      return h("div", { className: "ytr-root", "data-dsh-plugin": "dsh-plugin-yanyan-trash" },
        h("div", { className: "ytr-header", "data-dsh-part": "header" },
          h("span", { className: "ytr-title" }, t("trash.title")),
          h("span", { className: "ytr-count" }, t("trash.count", { n: entries.length })),
          h("button", { type: "button", className: "ytr-btn", disabled: ui.status === "loading" || busy, onClick: function () { controller.load(); } },
            ui.status === "loading" ? t("trash.refreshing") : t("trash.refresh"))),
        h("div", { className: "ytr-dual-warning", "data-dsh-part": "dual-warning" }, t("trash.warnDual")),

        // 上半区：当前会话（搜索 + 多选 + 移入回收站）
        h("div", { className: "ytr-section", "data-dsh-part": "active-section" },
          h("div", { className: "ytr-section-head" },
            h("span", { className: "ytr-section-title" }, t("trash.sectionActive")),
            h("span", { className: "ytr-section-sub" }, t("trash.activeSub"))),
          ActiveSessionList({ controller: controller, busy: busy })),

        // 下半区：回收站（批量操作区与列表分排，不再挤作一团）
        h("div", { className: "ytr-section", "data-dsh-part": "trash-section" },
          h("div", { className: "ytr-section-head" },
            h("span", { className: "ytr-section-title" }, t("trash.sectionTrash")),
            h("span", { className: "ytr-count" }, t("trash.count", { n: entries.length }))),
          h("div", { className: "ytr-toolbar", "data-dsh-part": "trash-batch" },
            h("button", { type: "button", className: "ytr-btn", disabled: busy || !selection.length, onClick: function () { controller._run(Promise.all(selected().map(controller.api.restore))); } }, t("trash.batchRestore")),
            h("button", { type: "button", className: "ytr-btn ytr-btn-danger", disabled: busy || !selection.length, onClick: function () { setPending({ kind: "batchPurge", ids: selected() }); } }, t("trash.batchPurge")),
            h("span", { className: "ytr-toolbar-end" },
              h("label", { className: "ytr-check" },
                h("input", {
                  type: "checkbox",
                  checked: entries.length > 0 && selection.length === entries.length,
                  onChange: function (e) { controller.setSelection(e.target.checked ? entries.map(function (x) { return x.id; }) : []); },
                }),
                t("trash.selectAll")))),
          entries.length === 0
            ? h("div", { className: "ytr-empty" }, t("trash.empty"))
            : h("table", { className: "ytr-table", "data-dsh-part": "list" },
              h("thead", null, h("tr", null,
                h("th", null, t("trash.col.session")),
                h("th", null, t("trash.col.path")),
                h("th", null, t("trash.col.status")),
                h("th", null, t("trash.col.action")))),
              h("tbody", null, entries.map(row)))),
        pending
          ? h("div", { className: "ytr-confirm", "data-dsh-part": "confirm", role: "alertdialog" },
            h("span", { className: "ytr-confirm-text" }, confirmText()),
            h("button", { type: "button", className: "ytr-btn ytr-btn-danger", onClick: runPending }, t("trash.confirmYes")),
            h("button", { type: "button", className: "ytr-btn", onClick: function () { setPending(null); } }, t("trash.confirmNo")))
          : null,
        ResultPanel({ last: ui.last }));
    }

    // ---------- apply ----------
    var inject = ["slots", "locale", "connection", "sessions"];
    function apply(ctx) {
      try {
        injectCss();
        ctx.effect(function () {
          try {
            return ctx.locale.register(NS, { zh: dict.zh, en: dict.en });
          }
          catch (e) { return function () {}; }
        }, "dsh-plugin-yanyan-trash: dictionaries");
        try { runtimeLocale = ctx.locale.bind(NS); } catch (e) { runtimeLocale = null; }

        var api = createApi();
        var controller = new TrashController({ api: api, sessions: (function () {
          try { return ctx.get("sessions"); } catch (e) { return undefined; }
        })() });

        var off = subscribeSessionEvents(ctx, function () { controller.load(); });
        ctx.effect(function () { return off; }, "dsh-plugin-yanyan-trash: session events");

        var face = function () { return { controller: controller }; };
        ctx.slots.inject("settings.section", function () {
          try {
            var unregister = ctx.slots.register({
              name: "settings.section",
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: function () { return t("trash.nav"); },
              locale: NS,
              inject: face,
            }, SessionTrashCard);
            return function () { unregister(); };
          } catch (e) { return function () {}; }
        });
      } catch (e) {}
    }

    exports.apply = apply;
    exports.inject = inject;
    // 测试钩子：暴露纯函数供 Node 侧执行等价测试，锁死
    // collectCascadeDescendants 与 host cascade.descendantsOf 的语义一致；
    // 以及 displayTitle/filterLiveRows 的标题回退契约。
    // 仅 Node 环境（typeof process !== 'undefined'）暴露，浏览器运行时不携带此内部钩子。
    if (typeof process !== 'undefined') {
      exports.__testing = {
        collectCascadeDescendants, countCascadeDescendants, reasonText, REASON_MAP,
        displayTitle, shortId, formatActivityTime, filterLiveRows,
      };
    }
    return module.exports;
  },
});
