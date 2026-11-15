// dsh-plugin-yanyan-toolkit — Client (browser) half.
//
// 根包本身不贡献任何 UI：三个功能插件各有独立 loader 行并各自注册 UI。
// 这里仅完成 __ModuleLoader__ 登记，满足 dsh-client-modules 的装载校验
// （每个进入 web boot graph 的包必须注册同 id 的 factory）。

(function (root) {
  if (!root) return;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-plugin-yanyan-toolkit',
    factory: () => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var inject = [];
      var apply = function () {};

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
