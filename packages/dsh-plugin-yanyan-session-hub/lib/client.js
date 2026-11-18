/* dsh-plugin-yanyan-session-hub — Client (browser) half：会话管理中心（UI v3）。
 *
 * 手写预编译 IIFE（toolkit 无构建步骤），用 window.__ModuleLoader__ 装载，
 * 与回收站 client 同构：react 由 require 注入，服务由 dsh.client.inject 声明。
 *
 * 布局（v3，参考图2/图3 billion-context）：顶部固定 tab，一个按钮一个页面：
 *   - 总览：统计卡片 + 快捷入口。
 *   - 会话（主视图）：顶部吸顶工具栏（搜索/文件夹筛选/标签筛选/批量操作）
 *     + 表格（会话 | 标签 | 文件夹 | 活跃时间 | 操作），表头固定、表体独立滚动；
 *     点击行弹出右侧抽屉，编辑标题/标签/文件夹（不常驻占屏）。
 *   - 文件夹 / 标签：管理页，点击可带着过滤条件跳到会话表格。
 *   - 回收站：跳转到「会话回收站」插件区块。
 *
 * 纪律：本轮只改 React 组件与样式，数据层 / Service / 路由完全不碰。
 * 所有写操作经 Host 路由落盘旁路 JSON，绝不读写原生会话文件。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-yanyan-session-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useSyncExternalStore = React.useSyncExternalStore;

    var API_PREFIX = "api/dsh-yanyan-session-hub";
    var SECTION_ID = "dsh-yanyan-session-hub";
    var SECTION_ORDER = 27; // 回收站是 26，本区块紧随其后。
    var NS = "dsh-yanyan-session-hub";
    var DEFAULT_TIMEOUT_MS = 15000;
    var UNFILED = "@unfiled";
    var TRASH = "@trash";
    // DSH 状态标签：与后端 statusLabels() 的全部输出 + service 层补的「空会话」一致。
    // 用前缀编码成 select value，避免与同名手动标签（如手动建的「空闲」）冲突。
    var STATUS_TAG_PREFIX = "__status__";
    var STATUS_TAGS = ["已归档", "进行中", "空白", "子会话", "空闲", "空会话"];
    function encodeStatusTag(label) { return STATUS_TAG_PREFIX + label; }
    function decodeStatusTag(value) {
      if (typeof value === "string" && value.indexOf(STATUS_TAG_PREFIX) === 0) {
        return value.slice(STATUS_TAG_PREFIX.length);
      }
      return null;
    }
    // 按 items 的 it.status 统计每种状态的数量，供标签下拉/标签云显示。
    function buildStatusTags(items) {
      var counts = {};
      STATUS_TAGS.forEach(function (s) { counts[s] = 0; });
      (items || []).forEach(function (it) {
        (it.status || []).forEach(function (s) {
          if (counts[s] !== undefined) counts[s]++;
        });
      });
      return STATUS_TAGS.map(function (s) {
        return { tag: encodeStatusTag(s), label: s, count: counts[s], isStatus: true };
      });
    }

    // ---------- 内联 CSS（顶部 toolbar/表头吸顶 + 表格 + 抽屉） ----------
    var CSS = ".ysh-root{color:var(--dsw-alias-label-primary,#1f2328);display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;max-width:100%}.ysh-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;position:sticky;top:0;z-index:9;background:var(--dsw-alias-bg-layer-1,#fff);padding:4px 0}.ysh-title{font-size:15px;font-weight:600}.ysh-count{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}.ysh-btn{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;border-radius:8px;padding:5px 12px;transition:background-color .14s,border-color .14s}.ysh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#0000000d)}.ysh-btn:disabled{opacity:.45;cursor:default}.ysh-btn-primary{background:var(--dsw-alias-button-primary-fill,#4a6cf7);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent}.ysh-btn-ghost{background:transparent}.ysh-btn-sm{padding:3px 9px;font-size:12px}.ysh-input{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:5px 10px;font-size:13px}.ysh-input:focus-visible,.ysh-btn:focus-visible,.ysh-tab:focus-visible,.ysh-select:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 60%,transparent);outline-offset:1px}.ysh-search{flex:1;min-width:170px}.ysh-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea);position:sticky;top:38px;z-index:8;background:var(--dsw-alias-bg-layer-1,#fff);padding-top:2px}.ysh-tab{border:1px solid transparent;border-bottom:0;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;border-radius:8px 8px 0 0;padding:7px 14px;font-size:13px;font-weight:500;transition:background-color .14s,color .14s}.ysh-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000a)}.ysh-tab-active{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 10%,transparent);color:var(--dsw-alias-button-primary-fill,#4a6cf7);font-weight:600}.ysh-tab-icon{margin-right:5px;opacity:.85}.ysh-page{padding-top:2px}.ysh-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.ysh-card{border:1px solid var(--dsw-alias-border-l1,#e1e5ea);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-shadow-lv1,0 1px 3px #00000014);border-radius:10px;padding:14px}.ysh-stat{display:flex;flex-direction:column;gap:4px}.ysh-stat-num{font-size:26px;font-weight:700;line-height:1.1}.ysh-stat-label{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}.ysh-shortcuts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.ysh-section{border:1px solid var(--dsw-alias-border-l1,#e1e5ea);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-shadow-lv1,0 1px 3px #00000014);border-radius:10px;overflow:hidden}.ysh-section-head{padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea);font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);display:flex;align-items:center;justify-content:space-between;gap:6px}.ysh-scroll{max-height:540px;overflow-y:auto;overflow-x:hidden}.ysh-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;table-layout:fixed}.ysh-table th,.ysh-table td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea);vertical-align:middle;overflow-wrap:anywhere}.ysh-sticky-head{position:sticky;top:0;z-index:5}.ysh-toolbar-row>td{background:var(--dsw-alias-bg-layer-1,#fff);padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea)}.ysh-head-row>th{background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;font-weight:600;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de)}.ysh-row{cursor:pointer}.ysh-row:hover>td{background:var(--dsw-alias-interactive-bg-hover,#0000000a)}.ysh-row-sel>td{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 9%,transparent)}.ysh-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ysh-toolbar .ysh-select{width:auto;min-width:110px}.ysh-cell-title{font-weight:600;overflow-wrap:anywhere}.ysh-cell-meta{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;margin-top:2px}.ysh-chip{display:inline-flex;align-items:center;gap:3px;background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 12%,transparent);border-radius:10px;padding:1px 7px;font-size:11px;margin:1px 3px 1px 0}.ysh-status-chip{display:inline-flex;align-items:center;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 14%,transparent);color:var(--dsw-alias-state-success-primary,#1a7f37);border-radius:10px;padding:1px 7px;font-size:11px;margin:1px 3px 1px 0;font-weight:600}.ysh-sc-normal{background:color-mix(in srgb,#1a7f37 15%,transparent);color:#1a7f37}.ysh-sc-subagent{background:color-mix(in srgb,#0969da 14%,transparent);color:#0969da}.ysh-sc-running{background:color-mix(in srgb,#cf222e 14%,transparent);color:#cf222e}.ysh-sc-archived{background:color-mix(in srgb,#8250df 15%,transparent);color:#8250df}.ysh-sc-current{background:color-mix(in srgb,#bf8700 16%,transparent);color:#9a6700}.ysh-sc-idle{background:color-mix(in srgb,#57606a 12%,transparent);color:#57606a}.ysh-sc-empty{background:color-mix(in srgb,#8c959f 14%,transparent);color:#8c959f;border:1px dashed #8c959f}.ysh-trash-restore{color:#1a7f37;border-color:#1a7f37}.ysh-trash-cascade{color:#9a6700;border-color:#9a6700}.ysh-trash-purge{color:#d64545;border-color:#d64545}.ysh-id{font-family:ui-monospace,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary,#8c959f);overflow-wrap:anywhere}.ysh-empty{color:var(--dsw-alias-label-tertiary,#8c959f);text-align:center;padding:28px 14px;font-size:12px}.ysh-note{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:1.5}.ysh-filter-chip{display:inline-flex;align-items:center;gap:5px;background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 12%,transparent);border-radius:10px;padding:2px 8px;font-size:12px}.ysh-backdrop{position:fixed;inset:0;background:#00000066;z-index:40;display:flex;justify-content:center;align-items:center;padding:24px;animation:ysh-fade .14s ease-out}.ysh-drawer{width:460px;max-width:92vw;max-height:82vh;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 14px 44px #00000040;border:1px solid var(--dsw-alias-border-l1,#e1e5ea);border-radius:14px;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px;animation:ysh-slide .18s ease-out}.ysh-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.ysh-drawer-title{font-size:15px;font-weight:600}.ysh-close{border:0;background:transparent;cursor:pointer;font-size:20px;line-height:1;color:var(--dsw-alias-label-secondary,#57606a);padding:2px 8px;border-radius:6px}.ysh-close:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d)}.ysh-field{display:flex;flex-direction:column;gap:5px}.ysh-field-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#57606a)}.ysh-tagrow{display:flex;flex-wrap:wrap;gap:5px}.ysh-tag{display:inline-flex;align-items:center;gap:4px;background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 12%,transparent);border-radius:10px;padding:2px 8px;font-size:12px}.ysh-tag-x{border:0;background:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#57606a);font-size:13px;line-height:1}.ysh-tag-x:hover{color:var(--dsw-alias-state-error-primary,#d64545)}.ysh-addtag{display:flex;gap:6px}.ysh-addtag .ysh-input{min-width:0;flex:1;width:100%}.ysh-select{width:100%;border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:5px 8px;font-size:13px}.ysh-folder-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;padding:12px}.ysh-folder-card{border:1px solid var(--dsw-alias-border-l1,#e1e5ea);border-radius:9px;padding:12px;display:flex;flex-direction:column;gap:8px;cursor:pointer;transition:border-color .14s,background-color .14s}.ysh-folder-card:hover{border-color:var(--dsw-alias-button-primary-fill,#4a6cf7);background:var(--dsw-alias-interactive-bg-hover,#0000000a)}.ysh-folder-name{font-weight:600;overflow-wrap:anywhere}.ysh-folder-meta{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px}.ysh-folder-actions{display:flex;gap:6px;flex-wrap:wrap}.ysh-tagcloud{display:flex;flex-wrap:wrap;gap:10px;padding:16px}.ysh-tagbig{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l1,#e1e5ea);border-radius:20px;padding:7px 14px;cursor:pointer;font-size:13px;transition:border-color .14s,background-color .14s}.ysh-tagbig:hover{border-color:var(--dsw-alias-button-primary-fill,#4a6cf7);background:var(--dsw-alias-interactive-bg-hover,#0000000a)}.ysh-tagbig-num{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px}.ysh-form{display:flex;gap:6px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea)}.ysh-form .ysh-input{min-width:0;flex:1}.ysh-status{padding:8px 10px;border-radius:8px;font-size:12px}.ysh-status-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 8%,transparent);color:var(--dsw-alias-state-error-primary,#d64545)}.ysh-confirm{margin:10px 12px}.ysh-hint{padding:24px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}.ysh-search-panel{border:1px solid var(--dsw-alias-border-l1,#e1e5ea);background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-radius:10px;padding:0}.ysh-results-head{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-2,#f6f8fa);padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e1e5ea)}.ysh-results-scroll{max-height:520px;overflow-y:auto;overflow-x:hidden;padding:2px 12px 8px}.ysh-index-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}.ysh-index-track{flex:1;min-width:80px;height:5px;border-radius:3px;background:var(--dsw-alias-border-l1,#e1e5ea);overflow:hidden}.ysh-index-fill{height:100%;background:var(--dsw-alias-button-primary-fill,#4a6cf7);transition:width .2s}.ysh-hit{padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,#e1e5ea)}.ysh-hit:last-child{border-bottom:0}.ysh-hit-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.ysh-hit-title{font-weight:600;cursor:pointer;overflow-wrap:anywhere}.ysh-hit-title:hover{color:var(--dsw-alias-button-primary-fill,#4a6cf7)}.ysh-hit-snippet{margin-top:4px;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:1.55;overflow-wrap:anywhere}.ysh-hit-meta{font-size:10px;color:var(--dsw-alias-label-tertiary,#8c959f)}.ysh-mark{background:#fff2a8;color:inherit;border-radius:2px;padding:0 1px;font-weight:600}.ysh-search-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1,#e1e5ea);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-shadow-lv1,0 1px 3px #00000014);border-radius:10px;position:sticky;top:76px;z-index:7}.ysh-search-wrap{position:relative;flex:1;min-width:180px;display:flex;align-items:center}.ysh-search-wrap .ysh-search{width:100%;padding-right:32px;min-width:0}.ysh-search-clear-x{position:absolute;right:7px;top:50%;transform:translateY(-50%);border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#57606a);font-size:19px;line-height:1;padding:0 5px;border-radius:4px}.ysh-search-clear-x:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d);color:var(--dsw-alias-state-error-primary,#d64545)}.ysh-status-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 10%,transparent);color:var(--dsw-alias-state-success-primary,#1a7f37)}.ysh-filter-row{display:flex;gap:8px;flex-wrap:nowrap;align-items:center;flex:0 0 100%;min-width:0}.ysh-filter-row .ysh-select{width:auto;min-width:110px}.ysh-card-row>td{border-bottom:0;padding:5px 8px!important}.ysh-card-row .ysh-card{display:flex;align-items:flex-start;gap:10px;padding:11px 12px;border-radius:10px;cursor:default;transition:border-color .14s,background-color .14s}.ysh-card-row .ysh-card:hover{border-color:var(--dsw-alias-button-primary-fill,#4a6cf7)}.ysh-card-row .ysh-card-sel{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 8%,transparent);border-color:var(--dsw-alias-button-primary-fill,#4a6cf7)}.ysh-card-check{margin-top:2px;flex:0 0 auto;cursor:pointer}.ysh-card-main{flex:1;min-width:0;cursor:pointer;display:flex;flex-direction:column;gap:3px}.ysh-card-title-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.ysh-card-title{font-weight:600;font-size:13px;overflow-wrap:anywhere}.ysh-card-id{margin-top:1px}.ysh-card-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;margin-top:3px}.ysh-card-actions{display:flex;gap:4px;flex:0 0 auto;align-items:center;flex-wrap:wrap;justify-content:flex-end}.ysh-btn-link{border-color:transparent;background:transparent;color:var(--dsw-alias-button-primary-fill,#4a6cf7);padding:3px 7px}.ysh-btn-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#0000000d)}.ysh-btn-danger{color:var(--dsw-alias-state-error-primary,#d64545)}.ysh-preview-id{background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-radius:6px;padding:6px 8px;line-height:1.5}.ysh-preview-title{font-size:15px;font-weight:600;overflow-wrap:anywhere}.ysh-preview .ysh-field{flex-direction:row;gap:10px;align-items:baseline}.ysh-preview .ysh-field-label{flex:0 0 82px}.ysh-preview .ysh-field>span:last-child{overflow-wrap:anywhere}.ysh-preview-path{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}.ysh-preview-foot{display:flex;justify-content:flex-end;margin-top:4px}.ysh-status-tabs{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.ysh-status-tab{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;border-radius:7px;padding:4px 12px;font-size:12px}.ysh-status-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000a)}.ysh-status-tab-active{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 12%,transparent);color:var(--dsw-alias-button-primary-fill,#4a6cf7);border-color:var(--dsw-alias-button-primary-fill,#4a6cf7);font-weight:600}.ysh-check-label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;font-size:12px}.ysh-selection-bar{display:flex;flex-direction:column;gap:8px;align-items:stretch;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1,#e1e5ea);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);margin-bottom:2px}.ysh-selection-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ysh-selection-row .ysh-input{padding-left:7px;padding-right:7px}.ysh-selected-count{font-size:12px;font-weight:600;color:var(--dsw-alias-button-primary-fill,#4a6cf7)}.ysh-batch-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:auto}.ysh-path-cell{overflow:hidden}.ysh-path-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}.ysh-hit-snips{margin:5px 0 2px}.ysh-hit-snips .ysh-hit-snippet{border-bottom:0;padding:1px 0}.ysh-results-scroll .ysh-card-row>td{border-bottom:0}@keyframes ysh-fade{from{opacity:0}to{opacity:1}}@keyframes ysh-slide{from{transform:translateX(24px);opacity:.6}to{transform:translateX(0);opacity:1}}@media(max-width:820px){.ysh-table th,.ysh-table td{padding:6px 8px}}";
    var CSS_TAG_ID = "@dsh-plugin-yanyan-session-hub/client/ui.css";
    function injectCss() {
      try {
        if (typeof document === "undefined") return;
        if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-plugin-yanyan-session-hub";
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) {}
    }

    // ---------- 本地化 ----------
    var dict = {
      zh: {
        "hub.nav": "会话管理中心",
        "hub.title": "会话管理中心",
        "hub.refresh": "刷新",
        "hub.refreshing": "刷新中…",
        "tab.overview": "总览",
        "tab.sessions": "会话",
        "tab.folders": "文件夹",
        "tab.tags": "标签",
        "tab.trash": "回收站",
        "hub.overview": "全局总览",
        "hub.statSessions": "会话总数",
        "hub.statFolders": "文件夹数",
        "hub.statTags": "标签数",
        "hub.statUnfiled": "未分类",
        "hub.shortcuts": "快捷入口",
        "hub.goFolders": "管理文件夹",
        "hub.goTags": "查看标签",
        "hub.goSessions": "浏览会话",
        "hub.goTrash": "打开回收站",
        "hub.folders": "文件夹",
        "hub.tags": "标签",
        "hub.unfiled": "未分类",
        "hub.trash": "回收站",
        "hub.trashHint": "回收站已内置：移入的会话可恢复，也可彻底删除或级联删除整个会话树。",
        "hub.openTrashSection": "刷新回收站",
        "hub.newFolder": "新建文件夹",
        "hub.newFolderPlaceholder": "文件夹名称…",
        "hub.create": "创建",
        "hub.rename": "重命名",
        "hub.delete": "删除",
        "hub.cancel": "取消",
        "hub.confirmDeleteFolder": "确认删除文件夹「{n}」？其中的会话将退回「未分类」（原生会话文件不受影响）。",
        "hub.folderOpen": "查看会话",
        "hub.noFolders": "还没有文件夹，在上方输入框新建一个。",
        "hub.noTags": "还没有标签，到「会话」页给会话添加标签后，这里会聚合显示。",
        "hub.search": "搜索标题、ID 或聊天内容…",
        "hub.searchHint": "输入关键词后将同时搜索标题和历史聊天内容（全文索引）。",
        "hub.searching": "搜索中…",
        "hub.searchResults": "内容搜索：{n} 条命中",
        "hub.noContentHits": "聊天内容中没有匹配「{q}」的消息。",
        "hub.clearSearch": "清除内容搜索",
        "hub.indexBuilding": "正在建立搜索索引…",
        "hub.indexReady": "索引就绪",
        "hub.indexProgress": "已扫描 {scanned}/{total} 个会话",
        "hub.indexSkipped": "跳过 {n} 个超大文件",
        "hub.hitOpen": "打开会话",
        "hub.sort": "排序",
        "hub.sortUpdatedDesc": "最近更新优先",
        "hub.sortUpdatedAsc": "最早更新优先",
        "hub.sortTitle": "按标题",
        "hub.colSession": "会话",
        "hub.colTags": "标签",
        "hub.colFolder": "文件夹",
        "hub.colUpdated": "活跃时间",
        "hub.colActions": "操作",
        "hub.selectAll": "全选",
        "hub.selectedCount": "已选 {n} 项",
        "hub.batchExport": "导出选中（Markdown）",
        "hub.exportAll": "导出全部",
        "hub.exporting": "正在导出…",
        "hub.exportDone": "已导出 {n} 个会话（{failed} 个失败）",
        "hub.batchTag": "批量打标",
        "hub.batchUnTag": "批量删标签",
        "hub.removeTag": "移除标签",
        "hub.batchTagPlaceholder": "输入标签名…（留空则删除选中会话全部标签）",
        "hub.apply": "应用",
        "hub.exportHint": "将勾选的会话导出为干净的 Markdown 并打包成 ZIP 下载。",
        "hub.exportSelectedShort": "导出选中",
        "hub.detail": "会话详情",
        "hub.close": "关闭",
        "hub.customTitle": "自定义标题",
        "hub.customTitlePlaceholder": "输入自定义标题…",
        "hub.tagsField": "标签",
        "hub.addTag": "添加标签",
        "hub.tagPlaceholder": "新标签名…",
        "hub.folderField": "所属文件夹",
        "hub.filterFolder": "文件夹筛选",
        "hub.filterTag": "标签筛选",
        "hub.allFolders": "全部文件夹",
        "hub.allTags": "全部标签",
        "hub.statusTagLabel": "◉ 状态：{s} ({n})",
        "hub.statusTagChip": "◉ {s}",
        "hub.filtering": "当前过滤",
        "hub.clearFilter": "清除过滤",
        "hub.viewDetail": "详情",
        "hub.preview": "预览",
        "hub.delete": "删除",
        "hub.noWorkspace": "不属于任何工作区",
        "hub.lastActive": "最后活动",
        "hub.size": "大小",
        "hub.timeUnknown": "时间未知",
        "hub.noTitle": "（无标题）",
        "hub.noMatch": "没有匹配的会话。",
        "hub.items": "共 {n} 个会话",
        "hub.sessions": "会话列表",
        "hub.saved": "已保存",
        "hub.saveFailed": "保存失败：{m}",
        "hub.active": "活跃",
        "hub.inactive": "非活跃",
        "tab.archived": "已归档",
        "hub.archive": "归档",
        "hub.unarchive": "取消归档",
        "hub.archiving": "处理中…",
        "hub.archiveDone": "已归档 {n} 个会话（{failed} 个失败）",
        "hub.unarchiveDone": "已恢复 {n} 个会话（{failed} 个失败）",
        "hub.deleteArchived": "删除",
        "hub.deleteArchivedConfirm": "🚨 确认彻底删除这 {n} 个已归档会话？将直接永久删除，不进入回收站，不可恢复！",
        "hub.deleteToTrashConfirm": "确认删除 {n} 个未归档会话？删除后将移入回收站中。",
        "hub.deleteArchivedDone": "已删除 {n} 个会话（{failed} 个失败）",
        "hub.noArchived": "没有已归档的会话。",
        "hub.colArchivedAt": "归档时间",
        "hub.trashTitle": "回收站",
        "hub.trashEmpty": "回收站为空。",
        "hub.trashCount": "回收站共 {n} 项",
        "hub.trashRestore": "恢复",
        "hub.trashPurge": "彻底删除",
        "hub.trashCascade": "级联删除",
        "hub.trashMove": "移入回收站",
        "hub.trashBusy": "处理中…",
        "hub.trashDone": "操作完成（成功 {n}，失败 {failed}）",
        "hub.trashConfirmPurge": "⚠️ 确认彻底删除？此操作不可恢复。",
        "hub.trashConfirmCascade": "⚠️ 确认级联删除整个会话树？此操作不可恢复。",
        "hub.trashSearch": "搜索标题 / 内容 / ID…",
        "hub.trashFilter": "筛选：",
        "hub.trashAllTags": "全部标签",
        "hub.batch.trashRestore": "批量彻底恢复",
        "hub.batch.trashPurge": "批量彻底删除",
        "hub.trashBatchRestoreConfirm": "确认彻底恢复已选的 {n} 项？",
        "hub.trashBatchPurgeConfirm": "⚠️ 确认彻底删除已选的 {n} 项？此操作不可恢复。",
        "tab.workspaces": "工作区",
        "hub.goWorkspaces": "管理工作区",
        "hub.workspaceList": "工作区列表（自动识别）",
        "hub.workspaceHint": "工作区由系统自动识别，无需手动创建或归类。",
        "hub.noWorkspaces": "没有识别到工作区。",
        "hub.workspace": "工作区",
        "hub.filterWorkspace": "工作区筛选",
        "hub.allWorkspaces": "全部工作区",
        "hub.previewTitle": "会话预览",
        "hub.createdAt": "创建于",
        "hub.cwd": "工作目录",
        "hub.messageCount": "对话消息",
        "hub.messages": "共 {n} 条对话消息",
        "hub.noMessages": "该会话没有可展示的对话内容",
        "hub.filter.all": "全部",
        "hub.filter.active": "未归档",
        "hub.filter.archived": "已归档",
        "hub.filter.issuesOnly": "仅看异常会话",
        "hub.select.allCurrent": "全选当前结果",
        "hub.select.clear": "清空选择",
        "hub.select.selected": "已选 {n} 项",
        "hub.batch.archive": "批量归档",
        "hub.batch.unarchive": "批量取消归档",
        "hub.batch.delete": "批量删除",
        "hub.componentError": "组件加载失败",
      },
      en: {
        "hub.nav": "Session Hub",
        "hub.title": "Session Hub",
        "hub.refresh": "Refresh",
        "hub.refreshing": "Refreshing…",
        "tab.overview": "Overview",
        "tab.sessions": "Sessions",
        "tab.folders": "Folders",
        "tab.tags": "Tags",
        "tab.trash": "Recycle bin",
        "hub.overview": "Overview",
        "hub.statSessions": "Total sessions",
        "hub.statFolders": "Folders",
        "hub.statTags": "Tags",
        "hub.statUnfiled": "Unfiled",
        "hub.shortcuts": "Shortcuts",
        "hub.goFolders": "Manage folders",
        "hub.goTags": "View tags",
        "hub.goSessions": "Browse sessions",
        "hub.goTrash": "Open recycle bin",
        "hub.folders": "Folders",
        "hub.tags": "Tags",
        "hub.unfiled": "Unfiled",
        "hub.trash": "Recycle bin",
        "hub.trashHint": "Recycle bin is built in: trashed sessions can be restored, purged, or cascade-deleted with their whole tree.",
        "hub.openTrashSection": "Refresh recycle bin",
        "hub.newFolder": "New folder",
        "hub.newFolderPlaceholder": "Folder name…",
        "hub.create": "Create",
        "hub.rename": "Rename",
        "hub.delete": "Delete",
        "hub.cancel": "Cancel",
        "hub.confirmDeleteFolder": "Delete folder {n}? Its sessions return to Unfiled (native session files are untouched).",
        "hub.folderOpen": "View sessions",
        "hub.noFolders": "No folders yet — create one with the input above.",
        "hub.noTags": "No tags yet — add tags to sessions on the Sessions tab and they aggregate here.",
        "hub.search": "Search titles, IDs or chat content…",
        "hub.searchHint": "Typing also searches titles and full chat history (content index).",
        "hub.searching": "Searching…",
        "hub.searchResults": "Content search: {n} match(es)",
        "hub.noContentHits": "No chat messages match \"{q}\".",
        "hub.clearSearch": "Clear content search",
        "hub.indexBuilding": "Building search index…",
        "hub.indexReady": "Index ready",
        "hub.indexProgress": "Scanned {scanned}/{total} sessions",
        "hub.indexSkipped": "Skipped {n} oversized file(s)",
        "hub.hitOpen": "Open session",
        "hub.sort": "Sort",
        "hub.sortUpdatedDesc": "Recently updated first",
        "hub.sortUpdatedAsc": "Oldest updated first",
        "hub.sortTitle": "By title",
        "hub.colSession": "Session",
        "hub.colTags": "Tags",
        "hub.colFolder": "Folder",
        "hub.colUpdated": "Updated",
        "hub.colActions": "Actions",
        "hub.selectAll": "Select all",
        "hub.selectedCount": "{n} selected",
        "hub.batchExport": "Export selected (Markdown)",
        "hub.exportAll": "Export all",
        "hub.exporting": "Exporting…",
        "hub.exportDone": "Exported {n} sessions ({failed} failed)",
        "hub.batchTag": "Batch tag",
        "hub.batchUnTag": "Remove tag",
        "hub.removeTag": "Remove tag",
        "hub.batchTagPlaceholder": "Tag name… (leave blank to remove all from selected)",
        "hub.apply": "Apply",
        "hub.exportHint": "Export selected sessions as clean Markdown, packaged into a ZIP download.",
        "hub.exportSelectedShort": "Export selected",
        "hub.detail": "Session detail",
        "hub.close": "Close",
        "hub.customTitle": "Custom title",
        "hub.customTitlePlaceholder": "Enter a custom title…",
        "hub.tagsField": "Tags",
        "hub.addTag": "Add tag",
        "hub.tagPlaceholder": "New tag…",
        "hub.folderField": "Folder",
        "hub.filterFolder": "Folder filter",
        "hub.filterTag": "Tag filter",
        "hub.allFolders": "All folders",
        "hub.allTags": "All tags",
        "hub.statusTagLabel": "◉ Status: {s} ({n})",
        "hub.statusTagChip": "◉ {s}",
        "hub.filtering": "Filter",
        "hub.clearFilter": "Clear filter",
        "hub.viewDetail": "Detail",
        "hub.preview": "Preview",
        "hub.delete": "Delete",
        "hub.noWorkspace": "No workspace",
        "hub.lastActive": "Last active",
        "hub.size": "Size",
        "hub.timeUnknown": "time unknown",
        "hub.noTitle": "(untitled)",
        "hub.noMatch": "No matching sessions.",
        "hub.items": "{n} session(s)",
        "hub.sessions": "Sessions",
        "hub.saved": "Saved",
        "hub.saveFailed": "Save failed: {m}",
        "hub.active": "active",
        "hub.inactive": "inactive",
        "tab.archived": "Archived",
        "hub.archive": "Archive",
        "hub.unarchive": "Unarchive",
        "hub.archiving": "Working…",
        "hub.archiveDone": "Archived {n} session(s) ({failed} failed)",
        "hub.unarchiveDone": "Restored {n} session(s) ({failed} failed)",
        "hub.deleteArchived": "Delete",
        "hub.deleteArchivedConfirm": "🚨 Permanently delete these {n} archived sessions? They will be deleted directly, NOT moved to recycle bin, and cannot be recovered!",
        "hub.deleteToTrashConfirm": "Delete {n} unarchived session(s)? They will be moved to the recycle bin.",
        "hub.deleteArchivedDone": "Deleted {n} session(s) ({failed} failed)",
        "hub.noArchived": "No archived sessions.",
        "hub.colArchivedAt": "Archived at",
        "hub.trashTitle": "Recycle bin",
        "hub.trashEmpty": "Recycle bin is empty.",
        "hub.trashCount": "{n} item(s) in recycle bin",
        "hub.trashRestore": "Restore",
        "hub.trashPurge": "Purge",
        "hub.trashCascade": "Cascade delete",
        "hub.trashMove": "Move to recycle bin",
        "hub.trashBusy": "Working…",
        "hub.trashDone": "Done (succeeded {n}, failed {failed})",
        "hub.trashConfirmPurge": "⚠️ Purge permanently? This cannot be undone.",
        "hub.trashConfirmCascade": "⚠️ Cascade-delete the whole session tree? This cannot be undone.",
        "hub.trashSearch": "Search title / content / ID…",
        "hub.trashFilter": "Filter:",
        "hub.trashAllTags": "All tags",
        "hub.batch.trashRestore": "Batch restore",
        "hub.batch.trashPurge": "Batch purge",
        "hub.trashBatchRestoreConfirm": "Restore {n} selected item(s)?",
        "hub.trashBatchPurgeConfirm": "⚠️ Permanently delete {n} selected item(s)? This cannot be undone.",
        "tab.workspaces": "Workspaces",
        "hub.goWorkspaces": "Manage workspaces",
        "hub.workspaceList": "Workspaces (auto-detected)",
        "hub.workspaceHint": "Workspaces are auto-detected by the system; no manual setup needed.",
        "hub.noWorkspaces": "No workspaces detected.",
        "hub.workspace": "Workspace",
        "hub.filterWorkspace": "Workspace filter",
        "hub.allWorkspaces": "All workspaces",
        "hub.previewTitle": "Session preview",
        "hub.createdAt": "Created",
        "hub.cwd": "Working directory",
        "hub.messageCount": "Messages",
        "hub.messages": "{n} chat messages",
        "hub.noMessages": "This session has no displayable chat content",
        "hub.filter.all": "All",
        "hub.filter.active": "Active",
        "hub.filter.archived": "Archived",
        "hub.filter.issuesOnly": "Issues only",
        "hub.select.allCurrent": "Select all results",
        "hub.select.clear": "Clear selection",
        "hub.select.selected": "{n} selected",
        "hub.batch.archive": "Archive",
        "hub.batch.unarchive": "Unarchive",
        "hub.batch.delete": "Delete",
        "hub.componentError": "Component failed to load",
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

    // ---------- API ----------
    function request(path, init, timeoutMs) {
      return fetch(path, {
        method: init && init.method,
        headers: Object.assign({ "content-type": "application/json" }, init && init.headers),
        body: init && init.body,
        signal: AbortSignal.timeout(timeoutMs),
      }).then(function (response) {
        return response.json().catch(function () { return undefined; }).then(function (body) {
          if (!response.ok) throw new Error("http " + response.status);
          if (body && body.ok === false) throw new Error(body.message || body.error || "request failed");
          return body;
        });
      });
    }
    function post(path, payload) {
      return request(path, { method: "POST", body: JSON.stringify(payload || {}) }, DEFAULT_TIMEOUT_MS);
    }
    function createApi() {
      return {
        list: function () { return request(API_PREFIX + "/list", undefined, DEFAULT_TIMEOUT_MS); },
        createFolder: function (name) { return post(API_PREFIX + "/folder/create", { name: name }); },
        renameFolder: function (id, name) { return post(API_PREFIX + "/folder/rename", { id: id, name: name }); },
        deleteFolder: function (id) { return post(API_PREFIX + "/folder/delete", { id: id }); },
        setFolder: function (sessionId, folderId) { return post(API_PREFIX + "/session/folder", { sessionId: sessionId, folderId: folderId }); },
        addTag: function (sessionId, tag) { return post(API_PREFIX + "/session/tag/add", { sessionId: sessionId, tag: tag }); },
        removeTag: function (sessionId, tag) { return post(API_PREFIX + "/session/tag/remove", { sessionId: sessionId, tag: tag }); },
        setTitle: function (sessionId, title) { return post(API_PREFIX + "/session/title", { sessionId: sessionId, title: title }); },
        search: function (q, limit) {
          var url = API_PREFIX + "/search?q=" + encodeURIComponent(q || "") + (limit ? "&limit=" + limit : "");
          return request(url, undefined, DEFAULT_TIMEOUT_MS);
        },
        indexStatus: function () { return request(API_PREFIX + "/index-status", undefined, DEFAULT_TIMEOUT_MS); },
        exportSessions: function (ids) { return post(API_PREFIX + "/export", { ids: ids }); },
        exportAll: function () { return post(API_PREFIX + "/export-all", {}); },
        // 原生归档 / 取消归档（融合后的核心能力）
        archive: function (ids) { return post(API_PREFIX + "/archive", { ids: ids }); },
        unarchive: function (ids) { return post(API_PREFIX + "/unarchive", { ids: ids }); },
        deleteArchived: function (ids) { return post(API_PREFIX + "/delete-archived", { ids: ids }); },
        // 回收站融合（trash 子包能力并入本子包，统一 prefix）
        trashList: function () { return request(API_PREFIX + "/trash/list", undefined, DEFAULT_TIMEOUT_MS); },
        trashSnapshot: function () { return request(API_PREFIX + "/trash/snapshot", undefined, DEFAULT_TIMEOUT_MS); },
        trashRestore: function (id) { return post(API_PREFIX + "/trash/restore", { id: id }); },
        trashMove: function (ids) { return post(API_PREFIX + "/trash/move", { ids: ids }); },
        trashPurge: function (ids) { return post(API_PREFIX + "/trash/purge", { ids: ids }); },
        trashCascade: function (ids) { return post(API_PREFIX + "/trash/cascade", { ids: ids }); },
        trashPurgeExpired: function () { return post(API_PREFIX + "/trash/purge-expired", {}); },
        trashRecover: function () { return post(API_PREFIX + "/trash/recover", {}); },
      };
    }

    // ---------- store / controller ----------
    function createStore(initial) {
      var state = initial;
      var listeners = new Set();
      return {
        subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
        getSnapshot: function () { return state; },
        set: function (next) { state = Object.assign({}, state, next); listeners.forEach(function (fn) { fn(); }); },
      };
    }

    function HubController(options) {
      this.api = options.api;
      this.sessions = options.sessions;
      this._searchTimer = null;
      this._pollTimer = null;
      this._searchSeq = 0;
      this._lastIndexedSessions = -1;
      this.store = createStore({
        status: "idle",
        items: [],
        folders: [],
        tags: [],
        systemFolders: [],
        overview: { folderCounts: {}, tagCounts: {}, total: 0 },
        last: null,
        searching: false,
        searchQuery: "",
        searchHits: [],
        searchTotal: 0,
        searchError: null,
        indexStatus: { state: "idle", sessions: 0, tokens: 0, scanned: 0, total: 0, skipped: 0, failed: 0 },
        exporting: false,
        exportResult: null,
        archiving: false,
        archiveResult: null,
        trashItems: [],
        trashCount: 0,
        trashBusy: false,
        trashResult: null,
      });
    }
    HubController.prototype.load = function () {
      var self = this;
      this.store.set({ status: "loading" });
      return this.api.list().then(function (res) {
        self.store.set({
          status: "ready",
          items: Array.isArray(res.items) ? res.items : [],
          folders: Array.isArray(res.folders) ? res.folders : [],
          workspaces: Array.isArray(res.workspaces) ? res.workspaces : [],
          tags: Array.isArray(res.tags) ? res.tags : [],
          systemFolders: Array.isArray(res.systemFolders) ? res.systemFolders : [],
          overview: res.overview || { folderCounts: {}, tagCounts: {}, total: 0 },
        });
      }).catch(function (err) {
        self.store.set({ status: "error", last: { error: String((err && err.message) || err) } });
      });
    };
    HubController.prototype._mutate = function (promise) {
      var self = this;
      this.store.set({ status: "busy" });
      return promise.then(function (res) {
        self.store.set({ last: { ok: true } });
        return self.load();
      }).catch(function (err) {
        self.store.set({ last: { ok: false, error: String((err && err.message) || err) } });
        return self.load();
      });
    };
    HubController.prototype.createFolder = function (name) { return this._mutate(this.api.createFolder(name)); };
    HubController.prototype.renameFolder = function (id, name) { return this._mutate(this.api.renameFolder(id, name)); };
    HubController.prototype.deleteFolder = function (id) { return this._mutate(this.api.deleteFolder(id)); };
    HubController.prototype.setFolder = function (sid, fid) { return this._mutate(this.api.setFolder(sid, fid)); };
    HubController.prototype.addTag = function (sid, tag) { return this._mutate(this.api.addTag(sid, tag)); };
    HubController.prototype.removeTag = function (sid, tag) { return this._mutate(this.api.removeTag(sid, tag)); };
    HubController.prototype.setTitle = function (sid, title) { return this._mutate(this.api.setTitle(sid, title)); };

    /** 搜索：防抖 220ms + 序号防竞态（旧请求回包不覆盖新查询）。 */
    HubController.prototype.search = function (q) {
      var self = this;
      var query = String(q || "").trim();
      if (this._searchTimer) clearTimeout(this._searchTimer);
      if (!query) { this.clearSearch(); return Promise.resolve(); }
      this.store.set({ searchQuery: query, searching: true, searchError: null });
      var seq = ++this._searchSeq;
      this._searchTimer = setTimeout(function () {
        self.api.search(query, 50).then(function (res) {
          if (seq !== self._searchSeq) return; // 过期回包丢弃
          self.store.set({
            searching: false,
            searchHits: Array.isArray(res.hits) ? res.hits : [],
            searchTotal: typeof res.total === "number" ? res.total : 0,
            indexStatus: res.status || self.store.getSnapshot().indexStatus,
          });
        }).catch(function (err) {
          if (seq !== self._searchSeq) return;
          self.store.set({ searching: false, searchHits: [], searchTotal: 0, searchError: String((err && err.message) || err) });
        });
      }, 220);
    };
    HubController.prototype.clearSearch = function () {
      this._searchSeq += 1;
      if (this._searchTimer) clearTimeout(this._searchTimer);
      this.store.set({ searchQuery: "", searching: false, searchHits: [], searchTotal: 0, searchError: null });
    };
    /** 静默刷新：只更新列表数据，不动 status（避免轮询时界面闪烁/按钮被禁用）。 */
    HubController.prototype.refreshItems = function () {
      var self = this;
      if (this._refreshInFlight) return Promise.resolve();
      // 写操作进行中（busy）不刷新，避免覆盖用户刚提交的编辑回显。
      if (this.store.getSnapshot().status === "busy") return Promise.resolve();
      this._refreshInFlight = true;
      return this.api.list().then(function (res) {
        self.store.set({
          items: Array.isArray(res.items) ? res.items : [],
          folders: Array.isArray(res.folders) ? res.folders : [],
          workspaces: Array.isArray(res.workspaces) ? res.workspaces : [],
          tags: Array.isArray(res.tags) ? res.tags : [],
          systemFolders: Array.isArray(res.systemFolders) ? res.systemFolders : [],
          overview: res.overview || { folderCounts: {}, tagCounts: {}, total: 0 },
        });
      }).catch(function () {}).then(function () { self._refreshInFlight = false; });
    };
    /** 索引进度轮询：每 2s 拉一次 status。索引就绪后不停止，改为低频静默刷新，
     *  使会话标题（来自原生 projcache）与状态标签在会话进行中也能实时同步。 */
    HubController.prototype.startIndexPolling = function () {
      var self = this;
      if (this._pollTimer) return;
      this._idleTicks = 0;
      var tick = function () {
        self.api.indexStatus().then(function (res) {
          var st = res && res.status ? res.status : res;
          if (st && st.state) self.store.set({ indexStatus: st });
          var ready = st && (st.state === "ready" || st.state === "stopped");
          // 索引会话数变化时刷新列表：host 端列表靠索引兜底，索引是异步建好的，
          // 首次 load() 时可能还没扫完，需要在索引推进后重新拉一次。
          if (st && typeof st.sessions === "number" && st.sessions !== self._lastIndexedSessions) {
            self._lastIndexedSessions = st.sessions;
            if (!ready) self.load();
          }
          if (ready) {
            // 索引就绪后保持轮询，每 3 个 tick（约 6s）静默刷新一次列表。
            // 会话标题/状态由原生 projcache 实时更新，索引本身不会重扫已就绪的会话，
            // 因此必须周期性重新拉 list() 才能反映「空白对话→有标题」等变化。
            self._idleTicks = (self._idleTicks || 0) + 1;
            if (self._idleTicks % 3 === 0) self.refreshItems();
          }
        }).catch(function () {});
      };
      tick();
      this._pollTimer = setInterval(tick, 2000);
    };
    /** 把 base64 ZIP 触发浏览器下载（用 Blob + 临时 <a download>）。 */
    HubController.prototype._downloadZip = function (res) {
      if (!res || !res.base64) return;
      var bytes = Uint8Array.from(atob(res.base64), function (c) { return c.charCodeAt(0); });
      var blob = new Blob([bytes], { type: "application/zip" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = res.filename || "sessions.zip";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    };
    /** 批量导出：调后端 → 下载 ZIP → 写回结果供 UI 提示。 */
    HubController.prototype.exportSessions = function (ids) {
      var self = this;
      if (!ids || ids.length === 0) return Promise.resolve();
      this.store.set({ exporting: true, exportResult: null });
      return this.api.exportSessions(ids).then(function (res) {
        self._downloadZip(res);
        self.store.set({ exporting: false, exportResult: { ok: true, n: (res.files || []).length, failed: (res.failed || []).length } });
      }).catch(function (err) {
        self.store.set({ exporting: false, exportResult: { ok: false, error: String((err && err.message) || err) } });
      });
    };
    HubController.prototype.exportAll = function () {
      var self = this;
      this.store.set({ exporting: true, exportResult: null });
      return this.api.exportAll().then(function (res) {
        self._downloadZip(res);
        self.store.set({ exporting: false, exportResult: { ok: true, n: (res.files || []).length, failed: (res.failed || []).length } });
      }).catch(function (err) {
        self.store.set({ exporting: false, exportResult: { ok: false, error: String((err && err.message) || err) } });
      });
    };
    /** 原生归档 / 取消归档：调后端 → 写回结果 → 刷新列表（本地账本 archived 标记）。 */
    HubController.prototype._archiveMutate = function (promise, kind) {
      var self = this;
      this.store.set({ archiving: true, archiveResult: null });
      return promise.then(function (res) {
        var done = Array.isArray(res && res.done) ? res.done.length : 0;
        var failed = Array.isArray(res && res.failed) ? res.failed.length : 0;
        self.store.set({
          archiving: false,
          archiveResult: { ok: res && res.ok !== false, kind: kind, n: done, failed: failed, message: res && res.message },
        });
        return self.load();
      }).catch(function (err) {
        self.store.set({ archiving: false, archiveResult: { ok: false, kind: kind, error: String((err && err.message) || err) } });
        return self.load();
      });
    };
    HubController.prototype.archiveSessions = function (ids) {
      if (!ids || ids.length === 0) return Promise.resolve();
      return this._archiveMutate(this.api.archive(ids), "archive");
    };
    HubController.prototype.unarchiveSessions = function (ids) {
      if (!ids || ids.length === 0) return Promise.resolve();
      return this._archiveMutate(this.api.unarchive(ids), "unarchive");
    };
    /** 删除已归档会话：解档 → 移入回收站 → 物理清除（图9「删除」按钮）。 */
    HubController.prototype.deleteArchived = function (ids) {
      if (!ids || ids.length === 0) return Promise.resolve();
      return this._archiveMutate(this.api.deleteArchived(ids), "delete");
    };
    /** 回收站：加载条目 + 恢复/移入/彻底删除/级联删除。 */
    HubController.prototype.loadTrash = function () {
      var self = this;
      this.store.set({ trashBusy: true });
      return this.api.trashList().then(function (res) {
        self.store.set({
          trashBusy: false,
          trashItems: Array.isArray(res && res.entries) ? res.entries : [],
          trashCount: typeof (res && res.count) === "number" ? res.count : 0,
        });
      }).catch(function (err) {
        self.store.set({ trashBusy: false, trashItems: [], trashCount: 0, trashResult: { ok: false, error: String((err && err.message) || err) } });
      });
    };
    HubController.prototype._trashMutate = function (promise) {
      var self = this;
      this.store.set({ trashBusy: true, trashResult: null });
      return promise.then(function (res) {
        var n = (res && Array.isArray(res.done)) ? res.done.length
          : (res && Array.isArray(res.restored)) ? res.restored.length
          : (res && Array.isArray(res.purged)) ? res.purged.length : 1;
        var failed = res && Array.isArray(res.failed) ? res.failed.length : 0;
        self.store.set({ trashBusy: false, trashResult: { ok: res && res.ok !== false, n: n, failed: failed } });
        return self.loadTrash();
      }).catch(function (err) {
        self.store.set({ trashBusy: false, trashResult: { ok: false, error: String((err && err.message) || err) } });
        return self.loadTrash();
      });
    };
    HubController.prototype.trashRestore = function (id) { return this._trashMutate(this.api.trashRestore(id)); };
    /** 批量彻底恢复：后端 restore 仅接受单 id，这里逐条并发并聚合结果。 */
    HubController.prototype.trashRestoreMany = function (ids) {
      var self = this;
      var list = Array.isArray(ids) ? ids.slice() : [];
      if (list.length === 0) return Promise.resolve();
      var all = Promise.all(list.map(function (id) {
        return self.api.trashRestore(id).catch(function () { return { ok: false }; });
      })).then(function (results) {
        var okCount = results.filter(function (r) { return r && r.ok !== false; }).length;
        var failedCount = results.length - okCount;
        return { ok: failedCount === 0, restored: results, n: okCount, failed: failedCount };
      });
      return this._trashMutate(all);
    };
    HubController.prototype.trashMove = function (ids) { return this._trashMutate(this.api.trashMove(ids)); };
    HubController.prototype.trashPurge = function (ids) { return this._trashMutate(this.api.trashPurge(ids)); };
    HubController.prototype.trashCascade = function (ids) { return this._trashMutate(this.api.trashCascade(ids)); };
    HubController.prototype.dispose = function () {
      if (this._searchTimer) clearTimeout(this._searchTimer);
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._searchTimer = null; this._pollTimer = null;
    };

    // ---------- 纯函数（供 __testing 锁契约） ----------
    /** 按过滤条件 + 排序返回列表。folderId 为 null / "__all__" 表示「全部」。 */
    function filterAndSort(items, query, workspaceFilter, tagFilter, sortKey) {
      var q = String(query || "").trim().toLowerCase();
      var out = (items || []).filter(function (it) {
        // 工作区维度过滤：workspace 是后端从日志 header.cwd 识别的友好工作区名。
        if (workspaceFilter && workspaceFilter !== "__all__") {
          if (workspaceFilter === UNFILED) {
            if (it.workspace) return false;
          } else if (it.workspace !== workspaceFilter) return false;
        }
        if (tagFilter) {
          var statusLabel = decodeStatusTag(tagFilter);
          if (statusLabel) {
            // 状态标签筛选：匹配 it.status（含 service 层补的「空会话」）。
            if ((it.status || []).indexOf(statusLabel) < 0) return false;
          } else if ((it.tags || []).indexOf(tagFilter) < 0) return false;
        }
        if (q) {
          var hay = String(it.title || "") + " " + String(it.id || "") + " " + (it.tags || []).join(" ");
          if (hay.toLowerCase().indexOf(q) < 0) return false;
        }
        return true;
      });
      var key = sortKey || "updatedDesc";
      out.sort(function (a, b) {
        if (key === "title") return String(a.title || "").localeCompare(String(b.title || ""));
        var ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        var tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return key === "updatedAsc" ? ta - tb : tb - ta;
      });
      return out;
    }
    function formatTime(value) {
      if (!value) return null;
      var d = new Date(value);
      if (isNaN(d.getTime())) return null;
      try { return d.toLocaleString(); } catch (e) { return String(value); }
    }
    /** 把字节数格式化成 KB/MB/GB（纯渲染，无 hooks）。 */
    function formatSize(bytes) {
      if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) return null;
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }

    /** 状态标签按语义分配独立颜色（参考会话归档管理界面）：普通=绿、子会话=蓝、
     *  进行中/运行中=红、已归档=紫、当前=橙、空白/空闲=灰。纯函数，无 hooks。 */
    function statusClass(s) {
      var k = String(s || "");
      if (k === "进行中" || k === "运行中" || k === "running") return "ysh-sc-running";
      if (k === "已归档" || k === "archived") return "ysh-sc-archived";
      if (k === "子会话" || k === "subagent") return "ysh-sc-subagent";
      if (k === "当前" || k === "current") return "ysh-sc-current";
      if (k === "普通" || k === "normal") return "ysh-sc-normal";
      if (k === "空会话" || k === "empty") return "ysh-sc-empty";
      if (k === "空白" || k === "空闲" || k === "blank" || k === "idle") return "ysh-sc-idle";
      return "ysh-sc-idle";
    }

    /** 把片段的 ranges 高亮为 <mark> 节点（纯渲染，无 hooks）。 */
    function renderHighlighted(snippet) {
      var text = snippet && snippet.text ? snippet.text : "";
      var ranges = (snippet && snippet.ranges) || [];
      if (!ranges.length) return [text];
      var nodes = [];
      var cursor = 0;
      ranges.forEach(function (r) {
        var s = Math.max(cursor, Math.min(r.start, text.length));
        var e = Math.max(s, Math.min(r.end, text.length));
        if (s > cursor) nodes.push(text.slice(cursor, s));
        if (e > s) nodes.push(h("mark", { className: "ysh-mark", key: "m" + s + "-" + e }, text.slice(s, e)));
        cursor = e;
      });
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    /** 全文搜索结果面板（独立子组件，props 驱动，无自身 hooks）。 */
    function SearchResultsPanel(props) {
      var query = props.searchQuery;
      var searching = props.searching;
      var hits = props.searchHits || [];
      var total = props.searchTotal || 0;
      var err = props.searchError;
      var idx = props.indexStatus || {};
      var onOpen = props.onOpen;
      var onClear = props.onClear;
      var selectedIds = props.selectedIds || [];
      var setSelectedIds = props.setSelectedIds;
      var onExportSelected = props.onExportSelected;
      var exporting = props.exporting;
      var itemsById = props.itemsById || {};
      var controller = props.controller;
      var selectedSet = new Set(selectedIds);
      var toggleHit = function (id) {
        if (!setSelectedIds) return;
        var cur = selectedIds.slice();
        var i = cur.indexOf(id);
        if (i >= 0) cur.splice(i, 1); else cur.push(id);
        setSelectedIds(cur);
      };
      if (!query) return null;

      // 图2 风格：每条命中渲染成会话卡片（与会话列表一致），并保留高亮匹配片段。
      // 用 renderHitCard 扁平函数，避免深层嵌套 h() 的括号问题。
      var renderHitCard = function (hit) {
        var id = hit.sessionId;
        var item = itemsById[id] || {};
        var title = hit.title || item.title || id;
        var at = formatTime(item.updatedAt);
        var wsName = item.workspace || t("hub.noWorkspace");
        var sizeText = formatSize(item.size);
        var statuses = Array.isArray(item.status) ? item.status : [];
        var archived = item.archived === true;
        var isSel = selectedSet.has(id);
        var snips = (hit.snippets || []).map(function (sn, i) {
          return h("div", { className: "ysh-hit-snippet", key: "s" + i }, renderHighlighted(sn));
        });
        var main = h("div", { className: "ysh-card-main", onClick: function () { if (onOpen) onOpen(id); } },
          h("div", { className: "ysh-card-title-row" },
            h("span", { className: "ysh-card-title" }, title),
            statuses.map(function (s) { return h("span", { key: "st-" + s, className: "ysh-status-chip " + statusClass(s) }, s); }),
            (item.tags || []).map(function (tag) { return h("span", { key: tag, className: "ysh-chip" }, "#" + tag); })),
          h("div", { className: "ysh-card-id ysh-id" }, id),
          snips.length ? h("div", { className: "ysh-hit-snips" }, snips) : null,
          h("div", { className: "ysh-card-meta" },
            h("span", null, wsName),
            at ? h("span", null, t("hub.lastActive") + ": " + at) : null,
            sizeText ? h("span", null, t("hub.size") + ": " + sizeText) : null));
        var actions = h("div", { className: "ysh-card-actions" },
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-link",
            onClick: function (e) { e.stopPropagation(); if (onOpen) onOpen(id); },
          }, t("hub.preview")),
          controller ? h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-link",
            onClick: function (e) {
              e.stopPropagation();
              if (archived) controller.unarchiveSessions([id]); else controller.archiveSessions([id]);
            },
          }, archived ? t("hub.unarchive") : t("hub.archive")) : null,
          controller ? h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-link ysh-btn-danger",
            onClick: function (e) {
              e.stopPropagation();
              var canConfirm = typeof window !== "undefined" && typeof window.confirm === "function";
              if (canConfirm && !window.confirm(t(archived ? "hub.deleteArchivedConfirm" : "hub.deleteToTrashConfirm", { n: 1 }))) return;
              if (archived) controller.deleteArchived([id]); else controller.trashMove([id]);
            },
          }, t("hub.delete")) : null);
        return h("tr", { key: id, className: "ysh-card-row" },
          h("td", { colSpan: 1 },
            h("div", { className: "ysh-card" + (isSel ? " ysh-card-sel" : "") },
              h("input", {
                type: "checkbox", checked: isSel, "aria-label": title,
                className: "ysh-card-check",
                onClick: function (e) { e.stopPropagation(); },
                onChange: function () { toggleHit(id); },
              }),
              main,
              actions)));
      };

      var idxBar = null;
      if (idx.state === "scanning") {
        var pct = idx.total > 0 ? Math.round((idx.scanned / idx.total) * 100) : 0;
        idxBar = h("div", { className: "ysh-index-bar" },
          h("span", null, t("hub.indexBuilding")),
          h("div", { className: "ysh-index-track" }, h("div", { className: "ysh-index-fill", style: { width: pct + "%" } })),
          h("span", null, t("hub.indexProgress", { scanned: idx.scanned, total: idx.total })));
      } else if (idx.skipped > 0) {
        idxBar = h("div", { className: "ysh-index-bar" }, h("span", null, t("hub.indexSkipped", { n: idx.skipped })));
      }

      var body;
      if (searching) {
        body = h("div", { className: "ysh-empty" }, t("hub.searching"));
      } else if (err) {
        body = h("div", { className: "ysh-status ysh-status-err" }, err);
      } else if (hits.length === 0) {
        body = h("div", { className: "ysh-empty" }, t("hub.noContentHits", { q: query }));
      } else {
        body = h("div", { className: "ysh-scroll" },
          h("table", { className: "ysh-table" },
            h("tbody", null, hits.map(renderHitCard))));
      }

      return h("div", { className: "ysh-search-panel" },
        h("div", { className: "ysh-results-head" },
          idxBar,
          h("div", { className: "ysh-results-head-row", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" } },
            h("span", null, t("hub.searchResults", { n: total })),
            h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
              h("button", {
                type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-primary",
                disabled: exporting || selectedIds.length === 0,
                title: t("hub.exportHint"),
                onClick: function () { if (onExportSelected) onExportSelected(selectedIds); },
              }, exporting ? t("hub.exporting") : t("hub.exportSelectedShort")),
              h("button", { type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-ghost", onClick: onClear }, t("hub.clearSearch"))))),
        h("div", { className: "ysh-results-scroll" }, body));
    }

    // ---------- 顶部 tab ----------
    var TABS = [
      { id: "overview", label: "tab.overview", icon: "▦" },
      { id: "sessions", label: "tab.sessions", icon: "▤" },
      { id: "workspaces", label: "tab.workspaces", icon: "▸" },
      { id: "tags", label: "tab.tags", icon: "#" },
      { id: "trash", label: "tab.trash", icon: "废" },
    ];
    function TabBar(props) {
      var active = props.active;
      var setActive = props.setActive;
      return h("div", { className: "ysh-tabs", role: "tablist" },
        TABS.map(function (tab) {
          return h("button", {
            key: tab.id,
            type: "button",
            role: "tab",
            "aria-selected": active === tab.id,
            className: "ysh-tab" + (active === tab.id ? " ysh-tab-active" : ""),
            onClick: function () { setActive(tab.id); },
          },
            h("span", { className: "ysh-tab-icon" }, tab.icon),
            t(tab.label));
        }));
    }

    // ---------- 总览页 ----------
    function StatCard(props) {
      return h("div", { className: "ysh-card ysh-stat" },
        h("span", { className: "ysh-stat-num" }, props.value),
        h("span", { className: "ysh-stat-label" }, props.label));
    }
    function OverviewPage(props) {
      var ui = props.ui;
      var go = props.go;
      var counts = ui.overview && ui.overview.folderCounts ? ui.overview.folderCounts : {};
      var sessionCount = (ui.items || []).length;
      var folderCount = (ui.folders || []).length;
      var tagCount = (ui.tags || []).length;
      var unfiledCount = counts[UNFILED] || 0;
      var shortcuts = [
        { label: "hub.goSessions", tab: "sessions" },
        { label: "hub.goWorkspaces", tab: "workspaces" },
        { label: "hub.goTags", tab: "tags" },
        { label: "hub.goTrash", tab: "trash" },
      ];
      return h("div", { className: "ysh-page" },
        h("div", { className: "ysh-section" },
          h("div", { className: "ysh-section-head" }, h("span", null, t("hub.overview"))),
          h("div", { className: "ysh-stats", style: { padding: "12px" } },
            h(StatCard, { key: "s1", value: sessionCount, label: t("hub.statSessions") }),
            h(StatCard, { key: "s2", value: folderCount, label: t("hub.statFolders") }),
            h(StatCard, { key: "s3", value: tagCount, label: t("hub.statTags") }),
            h(StatCard, { key: "s4", value: unfiledCount, label: t("hub.statUnfiled") }))),
        h("div", { className: "ysh-shortcuts" },
          shortcuts.map(function (s) {
            return h("button", {
              key: s.tab,
              type: "button",
              className: "ysh-btn",
              onClick: function () { go(s.tab); },
            }, t(s.label));
          })));
    }

    // ---------- 右侧抽屉（会话详情编辑） ----------
    // ---------- 会话预览弹窗（图3） ----------
    function DetailDrawer(props) {
      var row = props.row || {};
      var onClose = props.onClose;
      return h("div", { className: "ysh-backdrop", onClick: onClose },
        h("div", { className: "ysh-drawer ysh-preview", onClick: function (e) { e.stopPropagation(); }, role: "dialog" },
          h("div", { className: "ysh-drawer-head" },
            h("span", { className: "ysh-drawer-title" }, t("hub.previewTitle")),
            h("button", { type: "button", className: "ysh-close", onClick: onClose, "aria-label": t("hub.close") }, "×")),
          h("div", { className: "ysh-preview-id ysh-id" }, row.id || ""),
          h("div", { className: "ysh-preview-title" }, row.customTitle || row.title || t("hub.noTitle")),
          h("div", { className: "ysh-field" },
            h("span", { className: "ysh-field-label" }, t("hub.createdAt")),
            h("span", null, formatTime(row.createdAt))),
          h("div", { className: "ysh-field" },
            h("span", { className: "ysh-field-label" }, t("hub.workspace")),
            h("span", null, row.workspace || t("hub.noWorkspace"))),
          h("div", { className: "ysh-field" },
            h("span", { className: "ysh-field-label" }, t("hub.cwd")),
            h("span", { className: "ysh-preview-path" }, row.cwd || "—")),
          h("div", { className: "ysh-field" },
            h("span", { className: "ysh-field-label" }, t("hub.size")),
            h("span", null, row.size != null ? formatSize(row.size) : "—")),
          h("div", { className: "ysh-field" },
            h("span", { className: "ysh-field-label" }, t("hub.messageCount")),
            h("span", null, t("hub.messages", { n: row.messageCount || 0 }))),
          h("p", { className: "ysh-note" }, (row.messageCount || 0) === 0 ? t("hub.noMessages") : ""),
          h("div", { className: "ysh-preview-foot" },
            h("button", { type: "button", className: "ysh-btn ysh-btn-sm", onClick: onClose }, t("hub.close")))));
    }

    // ---------- 会话页：吸顶工具栏 + 表格 + 批量操作 ----------
    function SessionsPage(props) {
      var shown = props.shown;
      var query = props.query;
      var setQuery = props.setQuery;
      var sortKey = props.sortKey;
      var setSortKey = props.setSortKey;
      var selectedIds = props.selectedIds;
      var setSelectedIds = props.setSelectedIds;
      var onOpen = props.onOpen;
      var folders = props.folders || [];
      var allTags = props.allTags || [];
      var activeFolder = props.activeFolder;
      var setActiveFolder = props.setActiveFolder;
      var activeTag = props.activeTag;
      var setActiveTag = props.setActiveTag;
      var filterLabel = props.filterLabel;
      var clearFilter = props.clearFilter;
      var controller = props.controller;
      var busy = props.busy;
      var onSearch = props.onSearch;
      var onClearSearch = props.onClearSearch;
      var searchQuery = props.searchQuery || "";
      var searching = props.searching;
      var searchHits = props.searchHits;
      var searchTotal = props.searchTotal;
      var searchError = props.searchError;
      var indexStatus = props.indexStatus;
      var exporting = props.exporting;
      var exportResult = props.exportResult;
      var mode = props.mode === "archived" ? "archived" : "sessions";
      var archiving = props.archiving;
      var archiveResult = props.archiveResult;

      var [batchTagText, setBatchTagText] = useState("");
      // 图2 布局：分段状态（全部/未归档/已归档）+ 仅看异常会话，均为本组件独立 hook，
      // 无条件放在顶部，hook 数恒定（严守 Phase1 白屏教训）。
      var [statusFilter, setStatusFilter] = useState("all");
      var [onlyIssues, setOnlyIssues] = useState(false);

      // 二次过滤：shown 已是后端/父组件的过滤结果，这里再按分段与异常条件收窄。
      var viewShown = (shown || []).filter(function (it) {
        if (statusFilter === "active" && it.archived) return false;
        if (statusFilter === "archived" && !it.archived) return false;
        if (onlyIssues) {
          var st = (it.status || []).join(" ");
          if (!(it.blank || it.running || st.indexOf("空白") >= 0 || st.indexOf("进行中") >= 0 || !it.workspace)) return false;
        }
        return true;
      });

      var selectedSet = new Set(selectedIds);
      var toggleOne = function (id) {
        var cur = selectedIds.slice();
        var i = cur.indexOf(id);
        if (i >= 0) cur.splice(i, 1); else cur.push(id);
        setSelectedIds(cur);
      };
      var allShownSelected = viewShown.length > 0 && viewShown.every(function (r) { return selectedSet.has(r.id); });
      var toggleAll = function (on) {
        setSelectedIds(on ? viewShown.map(function (r) { return r.id; }) : []);
      };
      // 标签名归一化：去掉显示用的 # 前缀与首尾空白，避免「#会话管理」匹配不上「会话管理」。
      var normalizeTag = function (s) { return String(s || "").trim().replace(/^#+/, "").trim(); };
      var doBatchTag = function () {
        var tag = normalizeTag(batchTagText);
        if (!tag || selectedIds.length === 0) return;
        Promise.all(selectedIds.map(function (sid) { return controller.addTag(sid, tag); }))
          .then(function () { setBatchTagText(""); setSelectedIds([]); });
      };
      var doBatchUnTag = function () {
        if (selectedIds.length === 0) return;
        var typed = normalizeTag(batchTagText);
        var jobs = [];
        if (typed) {
          // 输入了标签名：删除选中会话上的该标签。
          selectedIds.forEach(function (sid) { jobs.push(controller.removeTag(sid, typed)); });
        } else {
          // 未输入标签名：删除选中会话的全部手动标签（符合「批量删标签」字面意图）。
          selectedIds.forEach(function (sid) {
            var row = viewShown.filter(function (r) { return r.id === sid; })[0];
            var tags = (row && row.tags) || [];
            tags.forEach(function (tg) { jobs.push(controller.removeTag(sid, tg)); });
          });
        }
        if (jobs.length === 0) return;
        Promise.all(jobs).then(function () { setBatchTagText(""); setSelectedIds([]); });
      };

      var workspaceOptions = (props.workspaces || []).map(function (w) {
        var name = w.title || w.path;
        return h("option", { key: w.id || w.path, value: name }, name);
      });
      var statusTagOptions = (props.statusTags || []).map(function (x) {
        return h("option", { key: x.tag, value: x.tag }, t("hub.statusTagLabel", { s: x.label, n: x.count }));
      });
      var manualTagOptions = allTags.map(function (x) { return h("option", { key: x.tag, value: x.tag }, "#" + x.tag + " (" + x.count + ")"); });
      var tagOptions = statusTagOptions.concat(manualTagOptions);

      // 图2：分段切换（全部/未归档/已归档）
      var statusTabs = [
        { id: "all", label: "hub.filter.all" },
        { id: "active", label: "hub.filter.active" },
        { id: "archived", label: "hub.filter.archived" },
      ];
      var statusTabBar = h("div", { className: "ysh-status-tabs", role: "tablist" },
        statusTabs.map(function (tab) {
          return h("button", {
            key: tab.id, type: "button", role: "tab",
            className: "ysh-status-tab" + (statusFilter === tab.id ? " ysh-status-tab-active" : ""),
            "aria-selected": statusFilter === tab.id,
            onClick: function () { setStatusFilter(tab.id); },
          }, t(tab.label));
        }));

      var hasContentSearch = !!searchQuery.trim();
      var searchToolbar = h("div", { className: "ysh-search-toolbar" },
        statusTabBar,
        h("div", { className: "ysh-search-wrap" },
          h("input", {
            type: "text",
            className: "ysh-input ysh-search",
            value: query,
            placeholder: t("hub.search"),
            title: t("hub.searchHint"),
            onChange: function (e) { setQuery(e.target.value); if (onSearch) onSearch(e.target.value); },
          }),
          query
            ? h("button", {
              type: "button", className: "ysh-search-clear-x",
              onClick: function () { if (onClearSearch) onClearSearch(); },
              "aria-label": t("hub.clearSearch"),
            }, "×")
            : null
        ),
        h("div", { className: "ysh-filter-row" },
          h("select", {
            className: "ysh-select",
            value: activeFolder || "__all__",
            "aria-label": t("hub.filterWorkspace"),
            onChange: function (e) { setActiveFolder(e.target.value); },
          },
            h("option", { value: "__all__" }, t("hub.allWorkspaces")),
            h("option", { value: UNFILED }, t("hub.noWorkspace")),
            workspaceOptions),
          h("select", {
            className: "ysh-select",
            value: activeTag || "__all__",
            "aria-label": t("hub.filterTag"),
            onChange: function (e) { setActiveTag(e.target.value === "__all__" ? null : e.target.value); },
          },
            h("option", { value: "__all__" }, t("hub.allTags")),
            tagOptions),
          h("select", {
            className: "ysh-select",
            value: sortKey,
            "aria-label": t("hub.sort"),
            onChange: function (e) { setSortKey(e.target.value); },
          },
            h("option", { value: "updatedDesc" }, t("hub.sortUpdatedDesc")),
            h("option", { value: "updatedAsc" }, t("hub.sortUpdatedAsc")),
            h("option", { value: "title" }, t("hub.sortTitle"))),
          h("label", { className: "ysh-check-label" },
            h("input", {
              type: "checkbox", checked: onlyIssues,
              onChange: function (e) { setOnlyIssues(e.target.checked); },
            }),
            t("hub.filter.issuesOnly")))
      );
      var resultsPanel = h(SearchResultsPanel, {
        searchQuery: searchQuery, searching: searching,
        searchHits: searchHits, searchTotal: searchTotal, searchError: searchError,
        indexStatus: indexStatus, onOpen: onOpen, onClear: onClearSearch,
        selectedIds: selectedIds, setSelectedIds: setSelectedIds,
        exporting: exporting, controller: controller,
        itemsById: (shown || []).reduce(function (acc, it) { acc[it.id] = it; return acc; }, {}),
        onExportSelected: function (ids) { controller.exportSessions(ids); },
      });
      // 图2：独立的批量操作条（全选当前结果/清空/已选N + 批量归档/取消归档/删除）
      var selectionBar = h("div", { className: "ysh-selection-bar" },
        // 第一排：选择控制 + 批量归档/取消归档/删除
        h("div", { className: "ysh-selection-row" },
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm",
            disabled: viewShown.length === 0,
            onClick: function () { setSelectedIds(viewShown.map(function (r) { return r.id; })); },
          }, t("hub.select.allCurrent")),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm",
            disabled: selectedIds.length === 0,
            onClick: function () { setSelectedIds([]); },
          }, t("hub.select.clear")),
          h("span", { className: "ysh-selected-count" }, t("hub.select.selected", { n: selectedIds.length })),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm",
            disabled: busy || archiving || selectedIds.length === 0,
            onClick: function () { controller.archiveSessions(selectedIds); },
          }, t("hub.batch.archive")),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm",
            disabled: busy || archiving || selectedIds.length === 0,
            onClick: function () { controller.unarchiveSessions(selectedIds); },
          }, t("hub.batch.unarchive")),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-danger",
            disabled: busy || archiving || selectedIds.length === 0,
            onClick: function () {
              var canConfirm = typeof window !== "undefined" && typeof window.confirm === "function";
              var allArchived = selectedIds.length > 0 && selectedIds.every(function (sid) {
                var r = viewShown.filter(function (x) { return x.id === sid; })[0];
                return r && r.archived;
              });
              if (canConfirm && !window.confirm(t(allArchived ? "hub.deleteArchivedConfirm" : "hub.deleteToTrashConfirm", { n: selectedIds.length }))) return;
              selectedIds.forEach(function (sid) {
                var row = viewShown.filter(function (r) { return r.id === sid; })[0];
                if (row && row.archived) controller.deleteArchived([sid]);
                else controller.trashMove([sid]);
              });
            },
          }, t("hub.batch.delete"))),
        // 第二排：标签 + 导出（放不下时内部 flex-wrap 自动换第三排）
        h("div", { className: "ysh-selection-row" },
          h("input", {
            type: "text", className: "ysh-input", style: { width: "80px" },
            value: batchTagText, placeholder: t("hub.batchTagPlaceholder"),
            onChange: function (e) { setBatchTagText(e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter") doBatchTag(); },
          }),
          h("button", { type: "button", className: "ysh-btn ysh-btn-sm", disabled: busy || selectedIds.length === 0, onClick: doBatchTag }, t("hub.batchTag")),
          h("button", { type: "button", className: "ysh-btn ysh-btn-sm", disabled: busy || selectedIds.length === 0, onClick: doBatchUnTag }, t("hub.batchUnTag")),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm",
            disabled: busy || exporting || selectedIds.length === 0,
            title: t("hub.exportHint"),
            onClick: function () { controller.exportSessions(selectedIds); },
          }, exporting ? t("hub.exporting") : t("hub.batchExport")),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm",
            disabled: busy || exporting,
            onClick: function () { controller.exportAll(); },
          }, t("hub.exportAll")),
          filterLabel
            ? h("span", { className: "ysh-filter-chip" }, t("hub.filtering") + ": " + filterLabel,
              h("button", { type: "button", className: "ysh-tag-x", onClick: clearFilter, "aria-label": t("hub.clearFilter") }, "×"))
            : null)
      );
      var listSection = h("div", { className: "ysh-section" },
          h("div", { className: "ysh-section-head" },
            h("span", null, mode === "archived" ? t("tab.archived") : t("hub.sessions")),
            h("span", { className: "ysh-count" }, t("hub.items", { n: viewShown.length }))),
          h("div", { className: "ysh-scroll" },
            h("table", { className: "ysh-table" },
              h("colgroup", null,
                h("col", { style: { width: "38%" } }),
                h("col", { style: { width: "20%" } }),
                h("col", { style: { width: "16%" } }),
                h("col", { style: { width: "16%" } }),
                h("col", { style: { width: "10%" } })),
              h("tbody", null,
                viewShown.length === 0
                  ? h("tr", null, h("td", { colSpan: 5 }, h("div", { className: "ysh-empty" }, t("hub.noMatch"))))
                  : viewShown.map(function (it) {
                    var at = formatTime(mode === "archived" ? (it.archivedAt || it.updatedAt) : it.updatedAt);
                    var isSel = selectedSet.has(it.id);
                    var wsName = it.workspace || t("hub.noWorkspace");
                    var sizeText = formatSize(it.size);
                    return h("tr", { key: it.id, className: "ysh-card-row" },
                      h("td", { colSpan: 5 },
                        h("div", { className: "ysh-card" + (isSel ? " ysh-card-sel" : "") },
                          // 左：勾选框
                          h("input", {
                            type: "checkbox",
                            checked: isSel,
                            "aria-label": it.title || it.id,
                            className: "ysh-card-check",
                            onClick: function (e) { e.stopPropagation(); },
                            onChange: function () { toggleOne(it.id); },
                          }),
                          // 中：标题 + 状态chip + 灰色 id + 工作区/活动/大小
                          h("div", { className: "ysh-card-main", onClick: function () { onOpen(it.id); } },
                            h("div", { className: "ysh-card-title-row" },
                              h("span", { className: "ysh-card-title" }, it.title || t("hub.noTitle")),
                              (Array.isArray(it.status) && it.status.length > 0)
                                ? it.status.map(function (s) { return h("span", { key: "st-" + s, className: "ysh-status-chip " + statusClass(s) }, s); })
                                : null,
                              (it.tags || []).map(function (tag) { return h("span", { key: tag, className: "ysh-chip" },
                                "#" + tag,
                                h("button", {
                                  type: "button", className: "ysh-tag-x", title: t("hub.removeTag") || "移除标签",
                                  onClick: function (e) { e.stopPropagation(); controller.removeTag(it.id, tag); },
                                }, "×")); })),
                            h("div", { className: "ysh-card-id ysh-id" }, it.id),
                            h("div", { className: "ysh-card-meta" },
                              h("span", null, wsName),
                              h("span", null, t("hub.lastActive") + ": " + (at || t("hub.timeUnknown"))),
                              sizeText ? h("span", null, t("hub.size") + ": " + sizeText) : null)),
                          // 右：预览/归档(or取消归档)/删除
                          h("div", { className: "ysh-card-actions" },
                            h("button", {
                              type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-link",
                              onClick: function (e) { e.stopPropagation(); onOpen(it.id); },
                            }, t("hub.preview")),
                            h("button", {
                              type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-link",
                              onClick: function (e) {
                                e.stopPropagation();
                                if (it.archived) controller.unarchiveSessions([it.id]);
                                else controller.archiveSessions([it.id]);
                              },
                            }, it.archived ? t("hub.unarchive") : t("hub.archive")),
                            h("button", {
                              type: "button", className: "ysh-btn ysh-btn-sm ysh-btn-link ysh-btn-danger",
                              onClick: function (e) {
                                e.stopPropagation();
                                var canConfirm = typeof window !== "undefined" && typeof window.confirm === "function";
                                if (canConfirm && !window.confirm(t(it.archived ? "hub.deleteArchivedConfirm" : "hub.deleteToTrashConfirm", { n: 1 }))) return;
                                if (it.archived) controller.deleteArchived([it.id]);
                                else controller.trashMove([it.id]);
                              },
                            }, t("hub.delete"))))));
                  })))));
      var exportNotice = exportResult
        ? h("div", { className: exportResult.ok ? "ysh-status ysh-status-ok" : "ysh-status ysh-status-err" },
            exportResult.ok
              ? t("hub.exportDone", { n: exportResult.n, failed: exportResult.failed })
              : String(exportResult.error || t("hub.saveFailed", { m: "" })))
        : null;
      var archiveNotice = archiveResult
        ? h("div", { className: archiveResult.ok ? "ysh-status ysh-status-ok" : "ysh-status ysh-status-err" },
            archiveResult.ok
              ? t(archiveResult.kind === "unarchive" ? "hub.unarchiveDone" : archiveResult.kind === "delete" ? "hub.deleteArchivedDone" : "hub.archiveDone", { n: archiveResult.n, failed: archiveResult.failed })
              : String(archiveResult.error || t("hub.saveFailed", { m: "" })))
        : null;
      return h("div", { className: "ysh-page" },
        searchToolbar,
        exportNotice,
        archiveNotice,
        hasContentSearch ? resultsPanel : h("div", { className: "ysh-list-wrap" }, selectionBar, listSection));
    }

    // ---------- 文件夹页 ----------
    // ---------- 工作区页（只读：来自原生 workspace.json，自动识别） ----------
    function WorkspacesPage(props) {
      var ui = props.ui;
      var openWorkspace = props.openWorkspace;
      var items = ui.items || [];
      var workspaces = ui.workspaces || [];
      var counts = {};
      items.forEach(function (it) { if (it.workspace) counts[it.workspace] = (counts[it.workspace] || 0) + 1; });
      var noWs = items.filter(function (it) { return !it.workspace; }).length;

      function card(key, name, path, count, ws) {
        return h("div", { key: key, className: "ysh-folder-card" },
          h("div", { className: "ysh-folder-name" }, name),
          h("div", { className: "ysh-folder-meta" }, path),
          h("div", { className: "ysh-folder-meta" }, t("hub.items", { n: count })),
          h("button", {
            type: "button",
            className: "ysh-btn ysh-btn-sm ysh-btn-primary",
            onClick: function () { openWorkspace(ws); },
          }, t("hub.folderOpen")));
      }

      var cards = workspaces.map(function (w) {
        var name = w.title || w.path;
        return card(w.id || w.path, name, w.path || "", counts[name] || 0, name);
      });
      if (noWs > 0) cards.push(card("__none__", t("hub.noWorkspace"), "", noWs, UNFILED));

      var body = cards.length === 0
        ? h("div", { className: "ysh-empty" }, t("hub.noWorkspaces"))
        : h("div", { className: "ysh-folder-grid" }, cards);

      return h("div", { className: "ysh-page" },
        h("div", { className: "ysh-section" },
          h("div", { className: "ysh-section-head" }, h("span", null, t("hub.workspaceList"))),
          h("p", { className: "ysh-note" }, t("hub.workspaceHint")),
          body));
    }

    // ---------- 标签页 ----------
    function TagsPage(props) {
      var ui = props.ui;
      var openTag = props.openTag;
      var statusTags = props.statusTags || [];
      var manualTags = ui.tags || [];
      var total = statusTags.length + manualTags.length;
      return h("div", { className: "ysh-page" },
        h("div", { className: "ysh-section" },
          h("div", { className: "ysh-section-head" },
            h("span", null, t("hub.tags")),
            h("span", { className: "ysh-count" }, t("hub.items", { n: total }))),
          total === 0
            ? h("div", { className: "ysh-empty" }, t("hub.noTags"))
            : h("div", { className: "ysh-tagcloud" },
              statusTags.map(function (x) {
                return h("div", {
                  key: x.tag,
                  className: "ysh-tagbig",
                  onClick: function () { openTag(x.tag); },
                },
                  h("span", null, t("hub.statusTagChip", { s: x.label })),
                  h("span", { className: "ysh-tagbig-num" }, x.count));
              }).concat(manualTags.map(function (x) {
                return h("div", {
                  key: x.tag,
                  className: "ysh-tagbig",
                  onClick: function () { openTag(x.tag); },
                },
                  h("span", null, "#" + x.tag),
                  h("span", { className: "ysh-tagbig-num" }, x.count));
              })))));
    }

    // ---------- 回收站页（融合 trash 子包：真实列表 + 恢复/彻底删除/级联删除） ----------
    // 纯 props 驱动，无自身 hook（hook 全在 SessionHubCard 顶层，避免切 tab 时 hook 数突变）。
    function TrashPage(props) {
      var ui = props.ui;
      var controller = props.controller;
      var refresh = props.refresh;
      var items = ui.trashItems || [];
      var busy = ui.trashBusy;
      var result = ui.trashResult;

      // 筛选/选择状态：hook 数量恒定、无条件注册，避免 React Hooks 突变白屏。
      var qs = useState("");
      var query = qs[0], setQuery = qs[1];
      var ws = useState("__all__");
      var workspaceFilter = ws[0], setWorkspaceFilter = ws[1];
      var ts = useState("__all__");
      var tagFilter = ts[0], setTagFilter = ts[1];
      var ss = useState([]);
      var selectedIds = ss[0], setSelectedIds = ss[1];

      var workspaces = props.workspaces || [];
      var allTags = props.allTags || [];
      var workspaceOptions = workspaces.map(function (w) {
        var val = w.title || w.path;
        return h("option", { key: w.id || w.path, value: val }, val);
      });
      var tagOptions = allTags.map(function (x) {
        return h("option", { key: x.tag, value: x.tag }, "#" + x.tag + " (" + x.count + ")");
      });

      // 二次过滤：标题 / 内容 / ID + 工作区 + 标签（数据来自后端 trashList 补字段）。
      var q = String(query || "").trim().toLowerCase();
      var viewShown = items.filter(function (it) {
        if (workspaceFilter !== "__all__" && it.workspace !== workspaceFilter) return false;
        if (tagFilter !== "__all__" && (it.tags || []).indexOf(tagFilter) < 0) return false;
        if (q) {
          var hay = String(it.title || "") + " " + String(it.id || "") + " " + String(it.content || "");
          if (hay.toLowerCase().indexOf(q) < 0) return false;
        }
        return true;
      });

      var selectedSet = {};
      selectedIds.forEach(function (id) { selectedSet[id] = true; });
      var selectedShownCount = viewShown.filter(function (it) { return selectedSet[it.id]; }).length;
      function toggleOne(id) {
        if (selectedSet[id]) {
          setSelectedIds(selectedIds.filter(function (x) { return x !== id; }));
        } else {
          setSelectedIds(selectedIds.concat([id]));
        }
      }
      function toggleAll() {
        if (viewShown.length > 0 && selectedShownCount === viewShown.length) {
          var shown = {};
          viewShown.forEach(function (it) { shown[it.id] = true; });
          setSelectedIds(selectedIds.filter(function (x) { return !shown[x]; }));
        } else {
          var merged = selectedIds.slice();
          viewShown.forEach(function (it) { if (merged.indexOf(it.id) < 0) merged.push(it.id); });
          setSelectedIds(merged);
        }
      }
      function clearSelection() { setSelectedIds([]); }
      function batchPurge() {
        var ids = selectedIds.slice();
        if (ids.length === 0) return;
        if (typeof confirm === "function" && !confirm(t("hub.trashBatchPurgeConfirm", { n: ids.length }))) return;
        controller.trashPurge(ids).then(function () { clearSelection(); });
      }
      function batchRestore() {
        var ids = selectedIds.slice();
        if (ids.length === 0) return;
        if (typeof confirm === "function" && !confirm(t("hub.trashBatchRestoreConfirm", { n: ids.length }))) return;
        controller.trashRestoreMany(ids).then(function () { clearSelection(); });
      }

      var resultNotice = result
        ? h("div", { className: result.ok ? "ysh-status ysh-status-ok" : "ysh-status ysh-status-err" },
            result.ok
              ? t("hub.trashDone", { n: result.n, failed: result.failed })
              : String(result.error || t("hub.saveFailed", { m: "" })))
        : null;
      var filterToolbar = h("div", { className: "ysh-filter-row" },
        h("div", { className: "ysh-search-wrap" },
          h("input", {
            type: "text", className: "ysh-input ysh-search", placeholder: t("hub.trashSearch"),
            value: query, onChange: function (e) { setQuery(e.target.value); },
          })),
        h("span", { className: "ysh-cell-meta" }, t("hub.trashFilter")),
        h("select", {
          className: "ysh-select", value: workspaceFilter,
          onChange: function (e) { setWorkspaceFilter(e.target.value); },
        }, h("option", { value: "__all__" }, t("hub.allWorkspaces")), workspaceOptions),
        h("select", {
          className: "ysh-select", value: tagFilter,
          onChange: function (e) { setTagFilter(e.target.value); },
        }, h("option", { value: "__all__" }, t("hub.trashAllTags")), tagOptions));
      var selectionBar = h("div", { className: "ysh-selection-bar" },
        h("div", { className: "ysh-selection-row" },
          h("label", { className: "ysh-check-label" },
            h("input", {
              type: "checkbox", checked: viewShown.length > 0 && selectedShownCount === viewShown.length,
              onChange: toggleAll, disabled: viewShown.length === 0,
            }),
            t("hub.select.allCurrent")),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm", onClick: clearSelection,
            disabled: selectedIds.length === 0,
          }, t("hub.select.clear")),
          h("span", { className: "ysh-selected-count" }, t("hub.select.selected", { n: selectedIds.length })),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm ysh-trash-restore", onClick: batchRestore,
            disabled: selectedIds.length === 0 || busy,
          }, t("hub.batch.trashRestore")),
          h("button", {
            type: "button", className: "ysh-btn ysh-btn-sm ysh-trash-purge", onClick: batchPurge,
            disabled: selectedIds.length === 0 || busy,
          }, t("hub.batch.trashPurge"))));
      return h("div", { className: "ysh-page" },
        h("div", { className: "ysh-section" },
          h("div", { className: "ysh-section-head" },
            h("span", null, t("hub.trashTitle")),
            h("span", null,
              h("span", { className: "ysh-count" }, t("hub.trashCount", { n: ui.trashCount != null ? ui.trashCount : items.length })),
              h("button", {
                type: "button", className: "ysh-btn ysh-btn-sm", style: { marginLeft: "8px" },
                disabled: busy, onClick: refresh,
              }, busy ? t("hub.trashBusy") : t("hub.openTrashSection")))),
          resultNotice,
          filterToolbar,
          selectionBar,
          h("div", { className: "ysh-scroll" },
            h("table", { className: "ysh-table" },
              h("colgroup", null,
                h("col", { style: { width: "4%" } }),
                h("col", { style: { width: "38%" } }),
                h("col", { style: { width: "20%" } }),
                h("col", { style: { width: "16%" } }),
                h("col", { style: { width: "22%" } })),
              h("thead", { className: "ysh-sticky-head" },
                h("tr", { className: "ysh-head-row" },
                  h("th", null, h("input", {
                    type: "checkbox", checked: viewShown.length > 0 && selectedShownCount === viewShown.length,
                    onChange: toggleAll, disabled: viewShown.length === 0,
                  })),
                  h("th", null, t("hub.colSession")),
                  h("th", null, t("hub.colUpdated")),
                  h("th", null, t("hub.colFolder")),
                  h("th", null, t("hub.colActions")))),
              h("tbody", null,
                viewShown.length === 0
                  ? h("tr", null, h("td", { colSpan: 5 }, h("div", { className: "ysh-empty" }, t("hub.trashEmpty"))))
                  : viewShown.map(function (it) {
                    return h("tr", { key: it.id, className: "ysh-row" },
                      h("td", null, h("input", {
                        type: "checkbox", checked: !!selectedSet[it.id],
                        onChange: function () { toggleOne(it.id); },
                      })),
                      h("td", null,
                        h("div", { className: "ysh-cell-title" }, it.title || t("hub.noTitle")),
                        h("div", { className: "ysh-cell-meta ysh-id" }, it.id),
                        it.archiveSkipped ? h("div", { className: "ysh-cell-meta" }, t("hub.inactive")) : null),
                      h("td", null, formatTime(it.trashedAt) || t("hub.timeUnknown")),
                      h("td", { className: "ysh-path-cell" },
                        h("div", { className: "ysh-path-text", title: it.originalPath || "" }, it.originalPath || "—")),
                      h("td", null,
                        h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", flexDirection: "column", alignItems: "flex-start" } },
                          h("button", {
                            type: "button", className: "ysh-btn ysh-btn-sm ysh-trash-restore", disabled: busy,
                            onClick: function () { controller.trashRestore(it.id); },
                          }, t("hub.trashRestore")),
                          h("button", {
                            type: "button", className: "ysh-btn ysh-btn-sm ysh-trash-cascade", disabled: busy,
                            onClick: function () {
                              if (typeof confirm === "function" && !confirm(t("hub.trashConfirmCascade"))) return;
                              controller.trashCascade([it.id]);
                            },
                          }, t("hub.trashCascade")),
                          h("button", {
                            type: "button", className: "ysh-btn ysh-btn-sm ysh-trash-purge", disabled: busy,
                            onClick: function () {
                              if (typeof confirm === "function" && !confirm(t("hub.trashConfirmPurge"))) return;
                              controller.trashPurge([it.id]);
                            },
                          }, t("hub.trashPurge")))));
                  })))),
          h("p", { className: "ysh-note" }, t("hub.trashHint"))));
    }

    // ---------- 错误边界：局部渲染异常不外溢，避免整个设置页白屏 ----------
    // React.Component 子类借 React 本身创建（无构建步骤，用 ES5 原型继承）。
    var ErrorBoundary = (function (Component) {
      function EB(p) {
        Component.call(this, p);
        this.state = { failed: false };
      }
      EB.prototype = Object.create(Component.prototype);
      EB.prototype.constructor = EB;
      EB.getDerivedStateFromError = function () { return { failed: true }; };
      EB.prototype.componentDidCatch = function (err, info) {
        try { if (console && console.error) console.error("[session-hub] render error", err, info); } catch (e) {}
      };
      EB.prototype.render = function () {
        if (this.state && this.state.failed) {
          return h("div", { className: "ysh-status ysh-status-err", style: { margin: "12px" } }, t("hub.componentError"));
        }
        return this.props.children;
      };
      return EB;
    })(React.Component);

    // ---------- 主组件 ----------
    function SessionHubCard(props) {
      var controller = props.controller;
      var ui = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
      useEffect(function () {
        // 设置页关闭再打开时 controller 是复用的单例：清空上次遗留的搜索态，
        // 避免输入框（本地 query 已重置）与结果面板（store.searchQuery 残留）不一致——
        // 否则会出现「输入框空着、却还显示上次匹配结果」的错位。
        controller.clearSearch();
        controller.load();
        controller.startIndexPolling();
        return function () { controller.dispose(); };
      }, [controller]);
      var [activeTab, setActiveTab] = useState("overview");
      var [query, setQuery] = useState("");
      var [sortKey, setSortKey] = useState("updatedDesc");
      var [activeFolder, setActiveFolder] = useState("__all__");
      var [activeTag, setActiveTag] = useState(null);
      var [filterLabel, setFilterLabel] = useState(null);
      var [selectedIds, setSelectedIds] = useState([]);
      var [activeRowId, setActiveRowId] = useState(null);
      var busy = ui.status === "busy" || ui.status === "loading";

      // 状态标签（由全部会话的 it.status 聚合，与手动标签区分编码）供下拉/标签云复用。
      // 从全量 ui.items 计算，避免筛选后计数随结果收窄而跳变。
      var statusTags = buildStatusTags(ui.items);

      // 当前筛选的标签若已被删除（从标签下拉/标签页删掉，标签列表里不再有），自动回退到「全部标签」，
      // 否则下拉显示「全部标签」但 activeTag 仍指向已删标签，导致列表被过滤成 0 条。
      // 状态标签由 it.status 实时派生，不依赖 ui.tags，故跳过失效检查。
      useEffect(function () {
        if (activeTag && !decodeStatusTag(activeTag) && Array.isArray(ui.tags) &&
            !ui.tags.some(function (x) { return x.tag === activeTag; })) {
          setActiveTag(null);
          setFilterLabel(null);
        }
      }, [activeTag, ui.tags]);

      var shown = useMemo(function () {
        return filterAndSort(ui.items, query, activeFolder, activeTag, sortKey);
      }, [ui.items, query, activeFolder, activeTag, sortKey]);
      var activeRow = (ui.items || []).filter(function (it) { return it.id === activeRowId; })[0] || null;
      if (!activeRow && activeRowId && ui.searchHits) {
        var hitRow = (ui.searchHits || []).filter(function (hit) { return hit.sessionId === activeRowId; })[0];
        if (hitRow) activeRow = { id: hitRow.sessionId, title: hitRow.title, tags: [], folderId: null, customTitle: hitRow.title };
      }
      // 已归档清单：普通计算（非 hook），复用同一 filterAndSort 保持过滤/排序一致。
      var archivedShown = filterAndSort(
        (ui.items || []).filter(function (it) { return it.archived === true; }),
        query, activeFolder, activeTag, sortKey);

      var openWorkspace = function (name) {
        setActiveFolder(name === UNFILED ? UNFILED : name);
        setActiveTag(null);
        setFilterLabel(t("hub.workspace") + ": " + name);
        setActiveTab("sessions");
      };
      var openTag = function (tag) {
        setActiveFolder("__all__");
        setActiveTag(tag);
        var st = decodeStatusTag(tag);
        setFilterLabel(t("hub.tags") + ": " + (st ? st : "#" + tag));
        setActiveTab("sessions");
      };
      var clearFilter = function () {
        setActiveFolder("__all__");
        setActiveTag(null);
        setFilterLabel(null);
      };
      var closeDrawer = function () { setActiveRowId(null); };
      // 切换 tab：进入回收站时顺带加载回收站清单（纯函数，不增 hook）。
      var switchTab = function (tab) {
        setActiveTab(tab);
        if (tab === "trash") { try { controller.loadTrash(); } catch (e) {} }
      };

      return h("div", { className: "ysh-root", "data-dsh-plugin": "dsh-plugin-yanyan-session-hub" },
        h("div", { className: "ysh-head" },
          h("span", { className: "ysh-title" }, t("hub.title")),
          h("button", { type: "button", className: "ysh-btn ysh-btn-sm", disabled: busy, onClick: function () { controller.load(); } },
            ui.status === "loading" ? t("hub.refreshing") : t("hub.refresh"))),
        ui.last && ui.last.ok === false
          ? h("div", { className: "ysh-status ysh-status-err" }, t("hub.saveFailed", { m: ui.last.error }))
          : null,
        h(ErrorBoundary, null,
          h(TabBar, { active: activeTab, setActive: switchTab }),
          activeTab === "overview"
            ? h(OverviewPage, { ui: ui, go: switchTab })
            : (activeTab === "sessions" || activeTab === "archived")
              ? h(SessionsPage, {
                shown: activeTab === "archived" ? archivedShown : shown,
                mode: activeTab === "archived" ? "archived" : "sessions",
                query: query, setQuery: setQuery,
                sortKey: sortKey, setSortKey: setSortKey,
                selectedIds: selectedIds, setSelectedIds: setSelectedIds,
                onOpen: setActiveRowId,
                folders: ui.folders, workspaces: ui.workspaces, allTags: ui.tags, statusTags: statusTags,
                activeFolder: activeFolder, setActiveFolder: setActiveFolder,
                activeTag: activeTag, setActiveTag: setActiveTag,
                filterLabel: filterLabel, clearFilter: clearFilter,
                controller: controller, busy: busy,
                onSearch: function (v) { controller.search(v); },
                onClearSearch: function () { controller.clearSearch(); setQuery(""); },
                searchQuery: ui.searchQuery, searching: ui.searching,
                searchHits: ui.searchHits, searchTotal: ui.searchTotal,
                searchError: ui.searchError, indexStatus: ui.indexStatus,
                exporting: ui.exporting, exportResult: ui.exportResult,
                archiving: ui.archiving, archiveResult: ui.archiveResult,
              })
              : activeTab === "workspaces"
                ? h(WorkspacesPage, { ui: ui, openWorkspace: openWorkspace })
                : activeTab === "tags"
                  ? h(TagsPage, { ui: ui, openTag: openTag, statusTags: statusTags })
                  : h(TrashPage, {
                    ui: ui, controller: controller,
                    workspaces: ui.workspaces,
                    allTags: ui.tags,
                    refresh: function () { try { controller.loadTrash(); } catch (e) {} },
                  }),
          activeRow && activeTab === "sessions"
            ? h(DetailDrawer, { row: activeRow, controller: controller, folders: ui.folders, busy: busy, onClose: closeDrawer })
            : null));
    }

    // ---------- apply ----------
    var inject = ["slots", "locale", "connection", "sessions"];
    function apply(ctx) {
      try {
        injectCss();
        ctx.effect(function () {
          try { return ctx.locale.register(NS, { zh: dict.zh, en: dict.en }); }
          catch (e) { return function () {}; }
        }, "dsh-plugin-yanyan-session-hub: dictionaries");
        try { runtimeLocale = ctx.locale.bind(NS); } catch (e) { runtimeLocale = null; }

        var api = createApi();
        var controller = new HubController({ api: api });
        var face = function () { return { controller: controller }; };
        ctx.slots.inject("settings.section", function () {
          try {
            var unregister = ctx.slots.register({
              name: "settings.section",
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: function () { return t("hub.nav"); },
              locale: NS,
              inject: face,
            }, SessionHubCard);
            return function () { unregister(); };
          } catch (e) { return function () {}; }
        });
      } catch (e) {}
    }

    exports.apply = apply;
    exports.inject = inject;
    if (typeof process !== "undefined") {
      exports.__testing = { filterAndSort, formatTime, renderHighlighted, UNFILED, TRASH, STATUS_TAG_PREFIX, STATUS_TAGS, encodeStatusTag, decodeStatusTag, buildStatusTags };
    }
    return module.exports;
  },
});
