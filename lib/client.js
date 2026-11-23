// dsh-plugin-yanyan-toolkit — Client (browser) half.
//
// 根包是整包元数据的天然宿主：在插件详情页「包含的组件」列表里，给
// 每个组件自己的中文标题右侧补一个版本标签（v1.2.3 这种）。
//
// 官方「包含的组件」列表（app.asar 内 PluginManagerPage 的 RowsSection）
// 渲染的是 InstalledPluginChild，其协议只有 id/name/enabled/locked，
// 没有 version 字段，所以版本显示必须由 client 半区自行注入：
//   - section 有 [data-plugin-rows]，每行 li[data-plugin-row]；
//   - rowMain 里两个 <code> 分别写着 loader id 与「真实包名」；
//     按真实包名去 host /components 返回的版本表里查，只处理本包 6 个组件，
//     不会误伤其它插件的详情页。
//   - CSS 类名是 CSS Modules 编译过的 hash，不能依赖类名字符串，
//     一律靠 data 属性 + <code> 文本定位。
//
// 装载骨架与「observer + 16ms 节流 + ctx.effect 统一清理」严格照抄现成轮子
// packages/dsh-plugin-yanyan-update/lib/client.js:354-392，容器/标签自持、
// 不改 React 管理的 DOM、不干扰 reconciliation；React 重渲染清掉我们的
// span 后由 MutationObserver 自动重挂。inject 保持 []（fetch / document 原生，
// 不依赖任何服务），标签文案只有 v + 版本号，无需 locale。

(function (root) {
  if (!root) return;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-plugin-yanyan-toolkit',
    factory: () => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var BASE = '/__dsh-plugin-yanyan-toolkit/components';
      var MARK = 'data-yanyan-component-version';
      var STYLE_MARK = 'data-yanyan-component-version-style';

      // 简洁纯文字：无外框、无背景，只留次要前景色。
      var CSS = [
        '[' + MARK + ']{margin-left:5px;' +
          'font-size:11px;font-weight:400;vertical-align:middle;white-space:nowrap;' +
          'color:var(--dsw-alias-label-secondary-foreground,#9ca3af);}',
      ];

      var versions = null;
      var fetching = false;
      var observer = null;
      var ensureTimer = null;
      var disposed = false;

      function ensureStyle() {
        try {
          if (document.querySelector('style[' + STYLE_MARK + ']')) return;
          var st = document.createElement('style');
          st.setAttribute(STYLE_MARK, '');
          st.textContent = CSS.join('\n');
          (document.head || document.documentElement).appendChild(st);
        } catch (e) {}
      }

      function loadVersions() {
        if (disposed || versions || fetching) return;
        fetching = true;
        try {
          fetch(BASE, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d && d.ok === true && d.components && typeof d.components === 'object') {
                versions = d.components;
                scheduleEnsure();
              }
            })
            .catch(function () {})
            .then(function () { fetching = false; });
        } catch (e) {
          fetching = false;
        }
      }

      // 两个 <code> 的直接父容器就是 rowMain；其第一个元素子是标题。
      // configure 形态下第一个元素子是 button.rowOpen，标题 span 在按钮内部。
      function titleElement(codes) {
        var main = null;
        for (var i = 0; i < codes.length; i++) {
          if (codes[i].parentElement) { main = codes[i].parentElement; break; }
        }
        if (!main) return null;
        var first = main.firstElementChild;
        if (!first) return null;
        if (first.tagName === 'BUTTON') {
          for (var j = 0; j < first.children.length; j++) {
            if (first.children[j].tagName === 'SPAN') return first.children[j];
          }
        }
        return first;
      }

      function ensureTags() {
        if (disposed) return;
        if (!versions) { loadVersions(); return; }
        ensureStyle();
        var lists;
        try {
          lists = document.querySelectorAll('section[data-plugin-rows] li[data-plugin-row]');
        } catch (e) {
          return;
        }
        function hasVersion(key) {
          return Object.prototype.hasOwnProperty.call(versions, key);
        }

        // 纯 host 工具插件行（如 dsh-find-right-plugin）没有 <code> 两行、
        // 标题直接就是包名，这时按「元素文本恰好等于包名」兜底找标题宿主。
        function hostByPkgText(li) {
          var all;
          try { all = li.querySelectorAll('*'); } catch (e) { return null; }
          for (var a = 0; a < all.length; a++) {
            var t = (all[a].textContent || '').trim();
            if (t && hasVersion(t)) return all[a];
          }
          return null;
        }

        for (var i = 0; i < lists.length; i++) {
          var li = lists[i];
          var codes;
          try { codes = li.querySelectorAll('code'); } catch (e) { codes = []; }
          if (!codes) codes = [];

          // 只认本聚合包里的组件包名，其它插件详情页一概不动。
          var ver = null;
          for (var k = 0; k < codes.length; k++) {
            var pkg = (codes[k].textContent || '').trim();
            if (hasVersion(pkg)) {
              ver = versions[pkg];
              break;
            }
          }
          var host = ver ? titleElement(codes) : null;

          // 兜底：code 未命中（含无 code 的纯 host 插件行）时，
          // 用行内文本恰好等于包名的元素定位标题并取版本。
          if (!ver || !host) {
            var byText = hostByPkgText(li);
            if (byText) {
              if (!ver) ver = versions[(byText.textContent || '').trim()];
              if (!host) host = byText;
            }
          }
          if (!ver || !host) continue;
          var label = 'v' + ver;
          var existing = null;
          try { existing = host.querySelector('span[' + MARK + ']'); } catch (e) {}
          if (existing) {
            if (existing.getAttribute('data-version') === ver) continue;
            existing.textContent = label;
            existing.setAttribute('data-version', ver);
            continue;
          }
          var tag = document.createElement('span');
          tag.setAttribute(MARK, '');
          tag.setAttribute('data-version', ver);
          tag.textContent = label;
          try { host.appendChild(tag); } catch (e) {}
        }
      }

      function scheduleEnsure() {
        if (ensureTimer !== null) return;
        ensureTimer = setTimeout(function () {
          ensureTimer = null;
          ensureTags();
        }, 16);
      }

      var inject = [];
      var apply = function (ctx) {
        // ctx.effect 缺失时退化为「尽力跑一次」，不影响所在页面。
        if (!ctx || typeof ctx.effect !== 'function') {
          loadVersions();
          ensureTags();
          return;
        }
        // 所有 observer / timer 集中在这个 effect 内注册与撤销。
        ctx.effect(function () {
          disposed = false;
          loadVersions();
          ensureTags();
          try {
            observer = new MutationObserver(function () { scheduleEnsure(); });
            observer.observe(document.body, { childList: true, subtree: true });
          } catch (e) {
            observer = null;
          }

          return function () {
            disposed = true;
            try { if (observer) observer.disconnect(); } catch (e) {}
            observer = null;
            if (ensureTimer !== null) {
              try { clearTimeout(ensureTimer); } catch (e) {}
              ensureTimer = null;
            }
            try {
              var tags = document.querySelectorAll('span[' + MARK + ']');
              for (var i = 0; i < tags.length; i++) {
                if (tags[i].parentNode) tags[i].parentNode.removeChild(tags[i]);
              }
            } catch (e) {}
            try {
              var st = document.querySelector('style[' + STYLE_MARK + ']');
              if (st && st.parentNode) st.parentNode.removeChild(st);
            } catch (e) {}
            versions = null;
          };
        }, 'yanyan-toolkit: component versions');
      };

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
