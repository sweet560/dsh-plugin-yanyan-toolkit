# 研研工具包 - 插件更新

聚合插件包「研研工具包」的第一个插件。在 DSH 设置页「已安装插件」分组标题右侧放置一个「检查更新」按钮，检查线上 npm 插件与本地 `link:` / `file:` 目录插件版本，并逐行提供更新操作。

## 功能

- 检查线上插件（npm 安装）：读取已装版本并与 npm registry 的 latest 版本比对。
- 检查本地插件（`link:` / `file:` 目录）：若是 git 仓库，fetch 后比对本地 HEAD 与 `origin/<branch>`；无 `.git` 时如实显示「本地源码，无法自动更新」。
- GitHub 源尽力而为比对，取不到时显示「GitHub 源请在插件详情页更新」，不阻断其它插件检查。
- 可更新行点击「更新」优先复用官方 `pluginManager` 服务的 `updateBundle`（内建失败/取消自动装回原版本，绝不先卸载）；无该 API 时降级为覆盖安装、仅在 `already-installed` 时两阶段并硬保证回滚装回原版本，本地 git 源执行 `git fetch` + `git merge --ff-only`。
- 禁止更新本包与聚合包自身，跳过 `@deepseek-ai/*` 官方包。

## 约束

- 纯 JavaScript（ESM host 半区 + `__ModuleLoader__` client 半区），不依赖 React、不使用 TypeScript / JSX / 构建工具、不引第三方依赖。
- 所有 UI 文案中文，代码与文档不使用 emoji。
- 所有同源 loopback 路由经 `ctx.connection.requestRejection` 准入裁决。
- 更新动作需要刷新页面或重启 DSH 后生效。

## 测试

```
node --test test/*.test.mjs
```
