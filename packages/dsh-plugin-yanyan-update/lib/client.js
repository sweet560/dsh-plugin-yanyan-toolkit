// dsh-plugin-yanyan-update — 浏览器半区（__ModuleLoader__ 装载形态）。
//
// 严格照抄 dsh-plugin-wechat-session/lib/client.js:47-60 与 :1359-1364 的装载骨架。
// 只声明 inject = ['locale']，其余全部使用原生 document / fetch，不依赖 React，
// 避免 require('react') 失败。所有 observer 与事件监听集中在单个 ctx.effect 里
// 注册与撤销，容器自持、不做 DOM 改写、不干扰页面 React reconciliation。
//
// 所有 UI 文案中文，代码与注释禁用 emoji。

(function (root) {
  if (!root) return;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-plugin-yanyan-update',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var NS = 'yanyan-update';
      var BASE = '/__dsh-plugin-yanyan-update';

      // zh 为 key 源，en 键集完整对照。
      var zh = {
        check: '检查更新',
        checking: '检查中…',
        noUpdates: '没有需要更新的插件',
        updatesTitle: '可更新的插件',
        update: '更新',
        updating: '更新中…',
        updated: '已更新',
        failed: '失败',
        localNoGit: '本地源码，无法自动更新',
        fetchFailed: '检查失败，请重试',
        githubUnsupported: '该来源暂不支持一键更新',
        close: '关闭',
        refresh: '刷新',
        restartHint: '更新完成，重启 DSH 服务后生效',
        updateAll: '一键更新全部',
        updatingAll: '批量更新中…',
        summary: '批量更新完成：成功 {ok} 个，失败 {fail} 个',
      };
      var en = {
        check: 'Check updates',
        checking: 'Checking…',
        noUpdates: 'No plugins need updating',
        updatesTitle: 'Updatable plugins',
        update: 'Update',
        updating: 'Updating…',
        updated: 'Updated',
        failed: 'Failed',
        localNoGit: 'Local source, cannot auto-update',
        fetchFailed: 'Check failed, please retry',
        githubUnsupported: 'This source does not support one-click update',
        close: 'Close',
        refresh: 'Refresh',
        restartHint: 'Updated. Restart the DSH service to apply.',
        updateAll: 'Update all',
        updatingAll: 'Updating all…',
        summary: 'Update all done: {ok} succeeded, {fail} failed',
      };

      var CSS = [
        '.yyup-root{position:relative;display:inline-flex;align-items:center;margin-left:8px;font-family:inherit;vertical-align:middle;}',
        // 主按钮填充严格用主按钮三件套，带回退色。
        '.yyup-main{background:var(--dsw-alias-button-primary-fill,#4f46e5);color:var(--dsw-alias-label-primary-foreground,#fff);border:0;border-radius:6px;padding:4px 12px;font-size:12px;line-height:1.6;cursor:pointer;}',
        '.yyup-main:hover{background:var(--dsw-alias-button-primary-hover,#4338ca);}',
        '.yyup-main:disabled{opacity:.6;cursor:default;}',
        '.yyup-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:50;width:340px;max-width:80vw;box-sizing:border-box;background:var(--yyup-panel-bg,#ffffff);color:var(--yyup-panel-fg,#374151);border:1px solid var(--yyup-panel-border,#e5e7eb);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:10px;font-size:12px;}',
        '.yyup-head{font-weight:600;margin-bottom:8px;color:var(--yyup-head-fg,#111827);}',
        '.yyup-list{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto;}',
        '.yyup-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 2px;border-bottom:1px solid var(--yyup-panel-border,#f3f4f6);}',
        '.yyup-row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.yyup-row-btn{background:var(--dsw-alias-button-primary-fill,#4f46e5);color:var(--dsw-alias-label-primary-foreground,#fff);border:0;border-radius:5px;padding:2px 10px;font-size:12px;cursor:pointer;flex:none;}',
        '.yyup-row-btn:hover{background:var(--dsw-alias-button-primary-hover,#4338ca);}',
        '.yyup-row-btn:disabled{opacity:.6;cursor:default;}',
        '.yyup-empty{padding:10px 2px;color:#6b7280;}',
        '.yyup-hint{margin-top:8px;color:#b45309;}',
        '.yyup-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}',
        '.yyup-ghost{background:transparent;border:1px solid var(--yyup-panel-border,#d1d5db);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;color:inherit;}',
        '.yyup-ghost:hover{background:var(--yyup-panel-border,#f3f4f6);}',
        '.yyup-allbtn{background:var(--dsw-alias-button-primary-fill,#4f46e5);color:var(--dsw-alias-label-primary-foreground,#fff);border:0;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;margin-right:auto;}',
        '.yyup-allbtn:hover{background:var(--dsw-alias-button-primary-hover,#4338ca);}',
      ].join('\n');

      var inject = ['locale'];

      function apply(ctx) {
        var disposeLocale = function () {};
        var tr = function (k) { return zh[k] || k; };
        try {
          var r = ctx.locale.register(NS, { zh: zh, en: en });
          if (typeof r === 'function') disposeLocale = r;
          tr = ctx.locale.bind(NS);
        } catch (e) {
          // locale 服务异常时退化为中文默认字典，不影响工具条核心能力
        }

        // 容器与关键部件引用，供各处理函数共享。
        var container = null;
        var mainBtn = null;
        var panel = null;
        var list = null;
        var hint = null;
        var refreshBtn = null;
        var closeBtn = null;
        var allBtn = null;
        var currentUpdates = []; // 最近一次检查到的可更新插件 [{id,...}]
        var busy = false;
        var ensureTimer = null;
        var observer = null;

        function seat() {
          try {
            var group = document.querySelector('[data-plugin-panel] [data-plugin-group="bundles"]');
            if (!group) return null;
            return group.firstElementChild || null; // 标题行元素
          } catch (e) {
            return null;
          }
        }

        function buildContainer() {
          var c = document.createElement('div');
          c.setAttribute('data-dsh-plugin', 'yanyan-update');
          c.setAttribute('data-dsh-part', 'update-toolbar');
          c.setAttribute('data-yanyan-update-toolbar', '');
          c.className = 'yyup-root';
          c.setAttribute('role', 'group');

          var style = document.createElement('style');
          style.setAttribute('data-yyup-style', '');
          style.textContent = CSS;
          c.appendChild(style);

          mainBtn = document.createElement('button');
          mainBtn.type = 'button';
          mainBtn.className = 'yyup-main';
          mainBtn.setAttribute('data-update-check', '');
          mainBtn.setAttribute('aria-haspopup', 'true');
          mainBtn.setAttribute('aria-expanded', 'false');
          mainBtn.setAttribute('aria-controls', 'yyup-panel');
          mainBtn.textContent = tr('check');
          c.appendChild(mainBtn);

          panel = document.createElement('div');
          panel.className = 'yyup-panel';
          panel.id = 'yyup-panel';
          panel.setAttribute('role', 'region');
          panel.setAttribute('aria-label', tr('updatesTitle'));
          panel.style.display = 'none';

          var head = document.createElement('div');
          head.className = 'yyup-head';
          head.textContent = tr('updatesTitle');
          panel.appendChild(head);

          list = document.createElement('ul');
          list.className = 'yyup-list';
          panel.appendChild(list);

          hint = document.createElement('div');
          hint.className = 'yyup-hint';
          hint.style.display = 'none';
          panel.appendChild(hint);

          var foot = document.createElement('div');
          foot.className = 'yyup-foot';
          allBtn = document.createElement('button');
          allBtn.type = 'button';
          allBtn.className = 'yyup-allbtn';
          allBtn.setAttribute('data-update-all', '');
          allBtn.textContent = tr('updateAll');
          allBtn.style.display = 'none'; // 仅在可更新插件 >= 2 时显示
          foot.appendChild(allBtn);
          refreshBtn = document.createElement('button');
          refreshBtn.type = 'button';
          refreshBtn.className = 'yyup-ghost';
          refreshBtn.setAttribute('data-update-refresh', '');
          refreshBtn.textContent = tr('refresh');
          foot.appendChild(refreshBtn);
          closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.className = 'yyup-ghost';
          closeBtn.setAttribute('data-update-close', '');
          closeBtn.textContent = tr('close');
          foot.appendChild(closeBtn);
          panel.appendChild(foot);

          c.appendChild(panel);
          return c;
        }

        function openPanel() {
          if (!panel || !mainBtn) return;
          panel.style.display = 'block';
          mainBtn.setAttribute('aria-expanded', 'true');
        }

        function closePanel() {
          if (!panel || !mainBtn) return;
          panel.style.display = 'none';
          mainBtn.setAttribute('aria-expanded', 'false');
        }

        function clearHint() {
          if (!hint) return;
          hint.textContent = '';
          hint.style.display = 'none';
        }

        function showHint(text) {
          if (!hint) return;
          hint.textContent = text;
          hint.style.display = 'block';
        }

        function setButtonLabel(text) {
          if (mainBtn) mainBtn.textContent = text;
        }

        function renderMessage(text) {
          if (!list) return;
          list.textContent = '';
          var li = document.createElement('li');
          li.className = 'yyup-empty';
          li.textContent = text;
          list.appendChild(li);
        }

        // 「一键更新全部」仅在本次检查出 2 个及以上可更新插件时显示，
        // 0 或 1 个时隐藏（单个插件直接点行内「更新」即可）。
        function syncAllButton() {
          if (!allBtn) return;
          var usable = currentUpdates.filter(function (u) {
            return u && u.id && u.hasUpdate !== false;
          });
          allBtn.style.display = usable.length >= 2 ? '' : 'none';
          allBtn.textContent = tr('updateAll');
        }

        function renderUpdates(updates) {
          if (!list) return;
          list.textContent = '';
          currentUpdates = Array.isArray(updates) ? updates.slice() : [];
          syncAllButton();
          if (!updates || !updates.length) {
            renderMessage(tr('noUpdates'));
            return;
          }
          for (var i = 0; i < updates.length; i++) {
            var row = updates[i] || {};
            var id = String(row.id || '');
            var li = document.createElement('li');
            li.className = 'yyup-row';
            li.setAttribute('data-yanyan-update-row', id);
            var label = document.createElement('span');
            label.className = 'yyup-row-label';
            label.textContent = id + '  ' + String(row.current || '') + ' → ' + String(row.latest || '');
            li.appendChild(label);
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'yyup-row-btn';
            b.setAttribute('data-update-row', id);
            b.textContent = tr('update');
            li.appendChild(b);
            list.appendChild(li);
          }
        }

        function post(pathname, body) {
          return fetch(pathname, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          }).then(function (resp) {
            return resp.json();
          });
        }

        function runCheck() {
          if (busy) return;
          busy = true;
          if (mainBtn) {
            mainBtn.disabled = true;
            mainBtn.setAttribute('aria-busy', 'true');
            setButtonLabel(tr('checking'));
          }
          clearHint();
          openPanel();
          currentUpdates = [];
          syncAllButton();
          renderMessage(tr('checking'));
          post(BASE + '/check', {}).then(function (data) {
            if (!data || data.ok !== true) throw new Error('invalid-response');
            renderUpdates(data.updates);
          }).catch(function () {
            renderMessage(tr('fetchFailed'));
          }).then(function () {
            busy = false;
            if (mainBtn) {
              mainBtn.disabled = false;
              mainBtn.removeAttribute('aria-busy');
              setButtonLabel(tr('check'));
            }
          });
        }

        // 按插件 id 找到该行的 li 与按钮，供单条与批量更新共用回填逻辑。
        function findRowParts(id) {
          var li = list ? list.querySelector('[data-yanyan-update-row="' + id + '"]') : null;
          var btn = li ? li.querySelector('[data-update-row]') : null;
          return { li: li, btn: btn };
        }

        // 把一条更新结果回填到对应行；返回该条是否更新成功。
        function applyRowResult(id, result) {
          var parts = findRowParts(id);
          var li = parts.li;
          var btn = parts.btn;
          var ok = Boolean(result && result.ok === true && result.updated === true);
          if (ok) {
            if (li) li.setAttribute('data-yanyan-update-state', 'updated');
            if (btn) {
              btn.textContent = tr('updated');
              btn.disabled = true;
            }
            return true;
          }
          var msg = (result && result.message) || tr('failed');
          if (btn) {
            btn.textContent = tr('failed');
            btn.disabled = false;
          }
          // 失败结果（含「已装回原版本 / 需手动重装」）必须让用户看见，
          // 不能只塞进行 title。
          showHint(String(msg));
          if (li) li.setAttribute('title', String(msg));
          return false;
        }

        function runUpdate(id, li, btn) {
          if (!id || btn.disabled) return;
          btn.disabled = true;
          btn.textContent = tr('updating');
          // 每行独立 try/catch：单条失败不影响其它行。
          post(BASE + '/update', { id: id }).then(function (data) {
            var ok = applyRowResult(id, data);
            // host 会返回可读中文结果（含「已即时生效 / 重启后生效」），优先展示。
            if (ok) showHint((data && data.message) || tr('restartHint'));
          }).catch(function (error) {
            applyRowResult(id, { message: (error && error.message) || tr('failed') });
          });
        }

        // 一键更新全部：把当前列表里的可更新插件一次性提交给 host 批量路由。
        function runUpdateAll() {
          if (busy || !allBtn || allBtn.style.display === 'none') return;
          var ids = [];
          for (var i = 0; i < currentUpdates.length; i++) {
            var u = currentUpdates[i];
            if (u && u.id && u.hasUpdate !== false && ids.indexOf(u.id) < 0) ids.push(u.id);
          }
          if (!ids.length) return;
          busy = true;
          allBtn.textContent = tr('updatingAll');
          clearHint();
          openPanel();
          // 先把所有参与更新的按钮置为更新中，给出即时反馈。
          for (var j = 0; j < ids.length; j++) {
            var parts = findRowParts(ids[j]);
            if (parts.btn) {
              parts.btn.disabled = true;
              parts.btn.textContent = tr('updating');
            }
          }
          post(BASE + '/update-all', { ids: ids }).then(function (data) {
            var results = (data && Array.isArray(data.results)) ? data.results : [];
            var okCount = 0;
            var failCount = 0;
            for (var k = 0; k < results.length; k++) {
              var row = results[k] || {};
              if (applyRowResult(row.id, row)) okCount += 1;
              else failCount += 1;
            }
            // host 未逐条返回时，按请求条数兜底统计为失败。
            if (!results.length) failCount = ids.length;
            var summary = tr('summary').replace('{ok}', String(okCount)).replace('{fail}', String(failCount));
            showHint(summary);
          }).catch(function (error) {
            showHint((error && error.message) || tr('fetchFailed'));
          }).then(function () {
            busy = false;
            syncAllButton();
          });
        }

        function onClick(e) {
          var t = e.target;
          var btn = t && t.closest ? t.closest('button') : null;
          if (!btn) return;
          if (btn.hasAttribute('data-update-check') || btn.hasAttribute('data-update-refresh')) {
            runCheck();
            return;
          }
          if (btn.hasAttribute('data-update-all')) {
            runUpdateAll();
            return;
          }
          if (btn.hasAttribute('data-update-close')) {
            closePanel();
            return;
          }
          var rowId = btn.getAttribute('data-update-row');
          if (rowId) runUpdate(rowId, btn.parentNode, btn);
        }

        function onKey(e) {
          if (e.key === 'Escape' || e.keyCode === 27) closePanel();
        }

        function onOutside(e) {
          if (!container || !container.contains(e.target)) closePanel();
        }

        // 座位消失则摘除容器，重新出现则重新 append；重复 apply 通过标记去重。
        function ensureMounted() {
          var s = seat();
          if (!s) {
            if (container && container.parentNode) {
              try { container.parentNode.removeChild(container); } catch (e) {}
            }
            closePanel();
            return;
          }
          if (!container) {
            var stale = document.querySelector('[data-yanyan-update-toolbar]');
            if (stale && stale.parentNode) {
              try { stale.parentNode.removeChild(stale); } catch (e) {}
            }
            container = buildContainer();
            try { container.addEventListener('click', onClick); } catch (e) {}
          }
          if (container.parentNode !== s) {
            try { s.appendChild(container); } catch (e) {}
          }
        }

        function scheduleEnsure() {
          if (ensureTimer !== null) return;
          ensureTimer = setTimeout(function () {
            ensureTimer = null;
            ensureMounted();
          }, 16);
        }

        // 所有 observer / 事件监听统一在这个 effect 内注册，并在清理函数里统一撤销。
        ctx.effect(function () {
          ensureMounted();
          try {
            observer = new MutationObserver(function () { scheduleEnsure(); });
            observer.observe(document.body, { childList: true, subtree: true });
          } catch (e) {
            observer = null;
          }
          try { document.addEventListener('keydown', onKey); } catch (e) {}
          try { document.addEventListener('click', onOutside, true); } catch (e) {}

          return function () {
            try { if (observer) observer.disconnect(); } catch (e) {}
            observer = null;
            if (ensureTimer !== null) {
              try { clearTimeout(ensureTimer); } catch (e) {}
              ensureTimer = null;
            }
            try { document.removeEventListener('keydown', onKey); } catch (e) {}
            try { document.removeEventListener('click', onOutside, true); } catch (e) {}
            if (container) {
              try { container.removeEventListener('click', onClick); } catch (e) {}
              if (container.parentNode) {
                try { container.parentNode.removeChild(container); } catch (e) {}
              }
            }
            try { disposeLocale(); } catch (e) {}
            container = null;
          };
        }, 'yanyan-update: toolbar');
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
