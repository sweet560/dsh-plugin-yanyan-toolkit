# 研研工具包 - 图标生成

根据上传的图片，居中裁切为正方形后生成适配 DSH 插件列表图标位（截图红框处）的 `icon.svg`。

## 功能

- 在插件页「已安装插件」标题行右侧提供「图标生成」按钮，点开下拉面板。
- 选择 PNG / JPEG / WebP 图片后，浏览器用原生 Canvas 居中裁切（cover）并缩到 48×48 PNG。
- POST 到本包 host 半区 `/__dsh-plugin-yanyan-icon/generate`，由纯函数 `buildIconSvg` 包装成 64×64 viewBox、圆角矩形背景、居中内嵌位图的自包含静态 SVG（默认位图占 52/64≈81%，在 30px 列表行下清晰可辨）。
- 按插件列表真实的 30px 行尺寸与 36px 卡片尺寸双预览，支持一键下载 `icon.svg`。
- 生成物无脚本、无外链、无 foreignObject、无 currentColor（`<img>` 上下文不继承页面色），解码后不超过 32 KiB，与 DSH 市场索引的内联图标上限对齐。

## 为什么这么做

DSH 插件列表的图标由 `<img src="data:...;base64,...">` 渲染（见 `dsh-client-ui-plugin-manager` 的 `PackageArtwork`），行 30px / 卡片 36px，且明确「render as an image, not inline markup」。package.json 的 `icon` 字段或 `exports["./icon"]` 会被读成 base64 data URL。因此产物必须是纯静态、自带背景与显式颜色的图片，不能依赖页面 CSS 变量或脚本。

## 约束

- 纯 JavaScript ESM host 半区 + `__ModuleLoader__` client 半区，不依赖 React / TS / JSX / 构建工具 / 第三方依赖。
- UI 文案中文，不使用装饰性 emoji。
- 所有同源回环路由经 `ctx.connection.requestRejection` 准入；请求体上限 2 MiB。
- 只接受位图 base64 data URL，拒绝 SVG / javascript: / 外链，颜色只接受 `#rgb` / `#rrggbb`，避免注入。
- `buildIconSvg` / `normalizeOptions` / `validateDataUrl` / `parseGenerateRequest` 为无副作用纯函数，模块顶层不访问 document / window / ctx。

## 用法

把下载的 `icon.svg` 放到插件包根目录，并在 package.json 声明 `"icon": "icon.svg"` 与 `exports["./icon"]`，重启 DSH 后即可在插件列表显示。

## 测试

```
node --test test/*.test.mjs
```
