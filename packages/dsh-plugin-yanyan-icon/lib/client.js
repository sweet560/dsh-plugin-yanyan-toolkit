// dsh-plugin-yanyan-icon — 浏览器半区（__ModuleLoader__ 装载形态）。
//
// 严格照抄 dsh-plugin-yanyan-update/lib/client.js 的装载 / 座位 / MutationObserver /
// 单 ctx.effect 清理骨架，零第三方依赖、不依赖 React。所有 UI 文案中文，禁用 emoji。
//
// 流程：选图 -> 原生 Canvas 居中裁切正方形并缩到 48x48 PNG -> POST 到 host
// /generate 拿到自包含 SVG -> 按插件列表 30px 行 / 36px 卡片尺寸预览 -> 下载 icon.svg。

(function (root) {
  if (!root) return;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-plugin-yanyan-icon',
    factory: () => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var BASE = '/__dsh-plugin-yanyan-icon';
      var CANVAS_SIZE = 48;
      var MARK = 'data-yanyan-icon-toolbar';

      // 文案全部中文，不接入 locale 服务，零依赖零异常风险。
      var T = {
        open: '图标生成',
        close: '关闭',
        chooseHint: '选择 PNG / JPEG / WebP 图片，自动居中裁切为正方形。',
        empty: '尚未生成图标',
        working: '正在生成…',
        ok: '已生成，可预览并下载 icon.svg',
        badFile: '请选择 PNG / JPEG / WebP 图片',
        badImage: '图片读取失败，请换一张',
        fail: '生成失败，请重试',
        download: '下载 icon.svg',
        reset: '重新选择',
        rowLabel: '列表行 30px',
        cardLabel: '详情卡片 36px',
        usage: '把下载的 icon.svg 放到插件包根目录，并在 package.json 里声明 "icon": "icon.svg" 与 exports["./icon"]，重启 DSH 后即可在插件列表显示。',
      };

      var CSS = [
        '.yyic-root{position:relative;display:inline-flex;align-items:center;margin-left:8px;font-family:inherit;vertical-align:middle;}',
        '.yyic-main{background:var(--dsw-alias-button-primary-fill,#4f46e5);color:var(--dsw-alias-label-primary-foreground,#fff);border:0;border-radius:6px;padding:4px 12px;font-size:12px;line-height:1.6;cursor:pointer;}',
        '.yyic-main:hover{background:var(--dsw-alias-button-primary-hover,#4338ca);}',
        '.yyic-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:50;width:320px;max-width:82vw;box-sizing:border-box;background:var(--yyic-panel-bg,#ffffff);color:var(--yyic-panel-fg,#374151);border:1px solid var(--yyic-panel-border,#e5e7eb);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px;font-size:12px;}',
        '.yyic-head{font-weight:600;margin-bottom:8px;color:var(--yyic-head-fg,#111827);}',
        '.yyic-hint{color:#6b7280;line-height:1.6;margin-bottom:8px;}',
        '.yyic-file{display:block;width:100%;box-sizing:border-box;font-size:12px;margin-bottom:10px;}',
        '.yyic-previews{display:flex;align-items:flex-end;gap:20px;justify-content:center;padding:12px 4px;border:1px dashed var(--yyic-panel-border,#d1d5db);border-radius:8px;margin-bottom:10px;background:var(--yyic-preview-bg,#f9fafb);}',
        '.yyic-pv{text-align:center;}',
        '.yyic-pv img{display:block;margin:0 auto 6px;border-radius:6px;background:#eef2ff;border:1px solid #c7d2fe;}',
        '.yyic-pv span{color:#6b7280;}',
        '.yyic-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:6px;}',
        '.yyic-btn{background:var(--dsw-alias-button-primary-fill,#4f46e5);color:var(--dsw-alias-label-primary-foreground,#fff);border:0;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;}',
        '.yyic-btn:disabled{opacity:.5;cursor:default;}',
        '.yyic-ghost{background:transparent;border:1px solid var(--yyic-panel-border,#d1d5db);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;color:inherit;}',
        '.yyic-status{margin-top:8px;color:#b45309;min-height:16px;}',
        '.yyic-usage{margin-top:10px;color:#6b7280;line-height:1.6;border-top:1px solid var(--yyic-panel-border,#f3f4f6);padding-top:8px;}',
      ].join('\n');

      var inject = [];

      function apply(ctx) {
        var container = null;
        var mainBtn = null;
        var panel = null;
        var fileInput = null;
        var previewRow = null;
        var previewCard = null;
        var statusEl = null;
        var downloadBtn = null;
        var generatedSvg = null;
        var objectUrl = null;
        var busy = false;
        var ensureTimer = null;
        var observer = null;

        function seat() {
          try {
            var group = document.querySelector('[data-plugin-panel] [data-plugin-group="bundles"]');
            if (!group) return null;
            return group.firstElementChild || null;
          } catch (e) {
            return null;
          }
        }

        function makePreview(label, px) {
          var wrap = document.createElement('div');
          wrap.className = 'yyic-pv';
          var img = document.createElement('img');
          img.width = px;
          img.height = px;
          img.alt = '';
          img.style.width = px + 'px';
          img.style.height = px + 'px';
          wrap.appendChild(img);
          var cap = document.createElement('span');
          cap.textContent = label;
          wrap.appendChild(cap);
          return { wrap: wrap, img: img };
        }

        function buildContainer() {
          var c = document.createElement('div');
          c.setAttribute('data-dsh-plugin', 'yanyan-icon');
          c.setAttribute('data-dsh-part', 'icon-toolbar');
          c.setAttribute(MARK, '');
          c.className = 'yyic-root';
          c.setAttribute('role', 'group');

          var style = document.createElement('style');
          style.setAttribute('data-yyic-style', '');
          style.textContent = CSS;
          c.appendChild(style);

          mainBtn = document.createElement('button');
          mainBtn.type = 'button';
          mainBtn.className = 'yyic-main';
          mainBtn.setAttribute('data-yyic-toggle', '');
          mainBtn.setAttribute('aria-haspopup', 'true');
          mainBtn.setAttribute('aria-expanded', 'false');
          mainBtn.textContent = T.open;
          c.appendChild(mainBtn);

          panel = document.createElement('div');
          panel.className = 'yyic-panel';
          panel.setAttribute('role', 'region');
          panel.setAttribute('aria-label', T.open);
          panel.style.display = 'none';

          var head = document.createElement('div');
          head.className = 'yyic-head';
          head.textContent = T.open;
          panel.appendChild(head);

          var hint = document.createElement('div');
          hint.className = 'yyic-hint';
          hint.textContent = T.chooseHint;
          panel.appendChild(hint);

          fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.accept = 'image/png,image/jpeg,image/webp';
          fileInput.className = 'yyic-file';
          fileInput.setAttribute('aria-label', T.open);
          try { fileInput.addEventListener('change', onFileChange); } catch (e) {}
          panel.appendChild(fileInput);

          var previews = document.createElement('div');
          previews.className = 'yyic-previews';
          previewRow = makePreview(T.rowLabel, 30);
          previewCard = makePreview(T.cardLabel, 36);
          previews.appendChild(previewRow.wrap);
          previews.appendChild(previewCard.wrap);
          panel.appendChild(previews);

          statusEl = document.createElement('div');
          statusEl.className = 'yyic-status';
          statusEl.textContent = T.empty;
          panel.appendChild(statusEl);

          var foot = document.createElement('div');
          foot.className = 'yyic-foot';
          downloadBtn = document.createElement('button');
          downloadBtn.type = 'button';
          downloadBtn.className = 'yyic-btn';
          downloadBtn.setAttribute('data-yyic-download', '');
          downloadBtn.textContent = T.download;
          downloadBtn.disabled = true;
          foot.appendChild(downloadBtn);
          var resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.className = 'yyic-ghost';
          resetBtn.setAttribute('data-yyic-reset', '');
          resetBtn.textContent = T.reset;
          foot.appendChild(resetBtn);
          var closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.className = 'yyic-ghost';
          closeBtn.setAttribute('data-yyic-close', '');
          closeBtn.textContent = T.close;
          foot.appendChild(closeBtn);
          panel.appendChild(foot);

          var usage = document.createElement('div');
          usage.className = 'yyic-usage';
          usage.textContent = T.usage;
          panel.appendChild(usage);

          try { c.addEventListener('click', onClick); } catch (e) {}
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
        function setStatus(text) {
          if (statusEl) statusEl.textContent = text;
        }
        function setBusy(v) {
          busy = v;
          if (downloadBtn) downloadBtn.disabled = v || !generatedSvg;
        }

        // 居中裁切：把原图按 cover 规则裁成正方形，再缩到 CANVAS_SIZE。
        function drawCover(img) {
          var canvas = document.createElement('canvas');
          canvas.width = CANVAS_SIZE;
          canvas.height = CANVAS_SIZE;
          var g = canvas.getContext('2d');
          var sw = img.naturalWidth || img.width;
          var sh = img.naturalHeight || img.height;
          var side = Math.min(sw, sh);
          var sx = (sw - side) / 2;
          var sy = (sh - side) / 2;
          g.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
          g.drawImage(img, sx, sy, side, side, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
          return canvas.toDataURL('image/png');
        }

        function post(pathname, body) {
          return fetch(pathname, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          }).then(function (resp) { return resp.json(); });
        }

        function onFileChange(e) {
          var file = e.target && e.target.files && e.target.files[0];
          if (!file) return;
          if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
            setStatus(T.badFile);
            return;
          }
          setBusy(true);
          setStatus(T.working);
          var reader = new FileReader();
          reader.onload = function () {
            var image = new Image();
            image.onload = function () {
              var dataUrl;
              try { dataUrl = drawCover(image); }
              catch (err) { setBusy(false); setStatus(T.badImage); return; }
              post(BASE + '/generate', { dataUrl: dataUrl }).then(function (data) {
                if (!data || data.ok !== true || typeof data.svg !== 'string') {
                  throw new Error((data && data.message) || 'invalid-response');
                }
                generatedSvg = data.svg;
                var src = 'data:image/svg+xml;base64,' + btoa(generatedSvg);
                if (previewRow) previewRow.img.src = src;
                if (previewCard) previewCard.img.src = src;
                setStatus(T.ok);
              }).catch(function (err) {
                setStatus((err && err.message) || T.fail);
              }).then(function () { setBusy(false); });
            };
            image.onerror = function () { setBusy(false); setStatus(T.badImage); };
            image.src = String(reader.result);
          };
          reader.onerror = function () { setBusy(false); setStatus(T.badImage); };
          reader.readAsDataURL(file);
        }

        function doDownload() {
          if (!generatedSvg) return;
          try {
            var blob = new Blob([generatedSvg], { type: 'image/svg+xml;charset=utf-8' });
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = objectUrl;
            a.download = 'icon.svg';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } catch (e) {
            setStatus(T.fail);
          }
        }

        function onClick(e) {
          var t = e.target;
          var btn = t && t.closest ? t.closest('button') : null;
          if (!btn) return;
          if (btn.hasAttribute('data-yyic-toggle')) {
            if (panel && panel.style.display === 'none') openPanel(); else closePanel();
            return;
          }
          if (btn.hasAttribute('data-yyic-close')) { closePanel(); return; }
          if (btn.hasAttribute('data-yyic-download')) { doDownload(); return; }
          if (btn.hasAttribute('data-yyic-reset')) {
            generatedSvg = null;
            if (fileInput) fileInput.value = '';
            if (previewRow) previewRow.img.removeAttribute('src');
            if (previewCard) previewCard.img.removeAttribute('src');
            if (downloadBtn) downloadBtn.disabled = true;
            setStatus(T.empty);
          }
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
            var stale = document.querySelector('[' + MARK + ']');
            if (stale && stale.parentNode) {
              try { stale.parentNode.removeChild(stale); } catch (e) {}
            }
            container = buildContainer();
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
            if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (e) {} objectUrl = null; }
            if (container) {
              try { container.removeEventListener('click', onClick); } catch (e) {}
              if (fileInput) { try { fileInput.removeEventListener('change', onFileChange); } catch (e) {} }
              if (container.parentNode) {
                try { container.parentNode.removeChild(container); } catch (e) {}
              }
            }
            container = null;
          };
        }, 'yanyan-icon: toolbar');
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
