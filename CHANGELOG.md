# Changelog

All notable changes to this project are documented here.

## 1.4.1 — 2026-11-15

### 图标生成：修复生成图标偏小 + 版本号迭代

- **现象**（用户反馈）：插件页「已安装插件」列表里研研工具包的哈士奇图标明显比 dsh-ops / dsh-pet 等邻居插件小。
- **根因**：`packages/dsh-plugin-yanyan-icon/lib/index.js` 的 `buildIconSvg` 默认布局为 `outer=6 / frameSize=52 / padding=4 / radius=14`，位图仅占 `44/64≈69%`；浅紫背景 `#eef2ff` 描边 `#c7d2fe` 在白底上几乎不可见，视觉上只剩中间一小块。用 Edge 无头浏览器按 DSH 真实 30px / 36px 渲染做了五方案对比图确认。
- **修复**：改为用户选定的「方案 A · 适度放大」——`outer=3 / frameSize=58 / padding=3 / radius=13`，位图占 `52/64≈81%`，保留圆角框呼吸感且 30px 下明显更清楚。同步 `normalizeOptions` 默认值、根与子包两处 `cordis.patch.yml` 的 config、单测断言与双语文档。
- **图标重生成**：用更新后的 `buildIconSvg` 重新生成聚合根包 `icon.svg` 与桌面三张哈士奇 `icon.svg` / `icon-2.svg` / `icon-3.svg`，结构校验 3/3 PASS 并经真实 Edge `<img>` 渲染确认。
- **版本**：聚合根包 → `1.4.1`；图标生成组件 `dsh-plugin-yanyan-icon` → `1.0.1`（随生成器修复一并迭代）；其余组件版本不变。
- **测试**：`npm test` 全绿；新增「默认布局方案 A」单测锁定 `52/64` 占比，防止回退。
- **生效**：涉及 bundle 行与 `cordis.patch.yml`，需重新 `npm pack` 并在插件页更新安装（或重建 bundle 后刷新页面）。

## 1.4.0 — 2026-11-15

### 新增「图标生成」组件包

- **需求**：根据上传的图片生成适配插件列表图标位（`PackageArtwork`，列表行 30px / 详情卡片 36px）的 `icon.svg`。
- **规范探查**：`/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/typert.host.js` 的 `icon` schema 描述为 `Base64 image data URL from a package root's manifest icon or an exported <specifier>/icon; render as an image, not inline markup.`；`dsh-client-ui-plugin-manager` 的 `PackageArtwork` 用 `<img src={row.meta?.icon}>` 渲染，故生成物必须纯静态、自带背景与显式颜色、无脚本 / 外链 / `foreignObject`；市场索引 `MAX_INLINE_ICON_BYTES = 32 * 1024` 作为体积上限。
- **实现**：新增自写子包 `dsh-plugin-yanyan-icon`（纯 JS ESM、零第三方依赖）。client 半区照抄 `dsh-plugin-yanyan-update` 的 `__ModuleLoader__` + `MutationObserver` + `ctx.effect` 注入骨架，用原生 Canvas 居中裁切正方形并缩放成 48px PNG dataURL；host 半区照抄其 `/health` / `/generate` 路由骨架，纯函数 `buildIconSvg` 包装成 64×64 viewBox、圆角背景、内嵌 `data:image/png;base64,...` 的自包含静态 SVG（单一真源、可单测）。提供 30px / 36px 双尺寸预览与「下载 icon.svg」。
- **接线**：根 `cordis.patch.yml` 加第 5 条 insert 行、`dependencies` 加第 4 项、`lib/index.js` 的 `SUBPACKAGES` 加新包名，三份 README 与双语 `locale` 同步。
- **测试**：新包 12 个单测；聚合根包三份结构测试同步到第 5 条行 / 第 4 个组件 / 5 个组件版本。
- **版本**：聚合根包 → `1.4.0`；新组件 `dsh-plugin-yanyan-icon` → `1.0.0`；其余组件版本不变。
- **图标**：聚合根包 `icon.svg` 改用本组件由用户上传的哈士奇照片生成的图标（48px 居中裁切、64×64 圆角背景、内嵌 `data:image/png;base64,...`，7426 B），形成「用图标生成插件产出自身图标」的闭环；`package.json` 的 `icon` 与 `exports["./icon"]` 声明保持不变。
- **生效**：涉及 bundle 行与 `cordis.patch.yml`，需重新 `npm pack` 并在插件页更新安装（或重建 bundle 后刷新页面）才能看到新组件。

## 1.3.1 — 2026-11-15

### 子智能体管理：修复浮层「直接退出 / 清理无反应」

- **现象**（用户反馈）：点击「清理全部空闲」没反应；点击「设置」「重命名标签」输入框浮层直接退出、没有任何反应。
- **根因 1 — React Portal 事件冒泡**：`packages/dsh-plugin-yanyan-subagent/lib/client.js` 的 `makeActionButton`（原 :951-979）把 `ReactDOM.createPortal(...)` 当作 `<button>` 的 children（`kids.push(...)`）。React 合成事件沿 fiber 树（非 DOM 树）冒泡：浮层内任意点击（按钮 / 输入框都是原生 `addEventListener`）从 portal-host 沿 fiber return 链上溯到 `<button>`，触发 `onClick` → `setOpen(v=>!v)` → 浮层被 toggle 卸载。纯 DOM 降级路径不受影响，故只在 slots + createPortal 路径出现。
- **修复 1**：`makeActionButton` 用 `React.Fragment` 让 `<button>` 与 portal 成为兄弟节点（`return React.createElement(React.Fragment, null, tabBtn, portal)`），portal 的 fiber 父级是 Fragment、不再经过 button；`PortalHost` 的 div 增加 `onClick/onMouseDown/onPointerDown/onTouchStart` 的 `stopPropagation` 双保险（只 stopPropagation、不 preventDefault，输入框聚焦不受影响）。DOM 位置不变，仍 createPortal 到 `document.body`。
- **根因 2 — 清理 0 命中**：`cleanAllIdle`（原 :638-663）复用 `idleFilterLocal`，要求 `activity==='inactive'` 且空闲 ≥ `shared.idleMinutes`（默认 30 分钟）；但官方 catalog 行无 `idleSince/lastActiveAt` 字段，客户端 `firstSeen`（:348）又是打开浮层后才起步，几乎永远达不到阈值；且 `renderRow`（:897）用「非 running 即空闲」渲染、清理却要求 `==='inactive'`，无 activity 字段的行显示空闲却清不掉，对应截图「已清理 0 个空闲子智能体」。
- **修复 2**：新增纯函数 `manualCleanTargets(rows, options)`；手动「清理全部空闲」改为清掉所有 `activity !== 'running'`、非 `diagnostic`、非 root、有 id、不在隐藏清单（`isDeleted`）的条目，**不套 30 分钟阈值**，与 `renderRow`、host `/cleanup`（`isRunningSubagent` 用 `agents.get(v).status==='running'` 判定，即清理所有非 running，`lib/index.js:794-801`）完全对齐；0 命中给出 `cleanNoIdle` 提示。定时**自动清理** `autoCleanTick`（:667-690）仍保留 `idleFilterLocal` + 阈值语义（阈值只约束自动清理）。host 半区 `lib/index.js` 未改，避免破坏 `test/idle-filter.test.mjs` 与已发布语义。
- **字典**：`UI_zh` / `UI_en` 同步新增 `cleanNoIdle`（zh 为 key 源、en 键集完整契约）。
- **测试**：新增 `packages/dsh-plugin-yanyan-subagent/test/portal-interaction.test.mjs`，用「花括号配对提取函数 + `vm` 真实执行」验证 `manualCleanTargets` 筛选边界，用源码契约断言锁定 Fragment 兄弟结构、stopPropagation 双保险、`cleanAllIdle` 不再套阈值、zh/en 字典键集一致。
- **版本**：`dsh-plugin-yanyan-subagent` → `1.2.2`；聚合根包 → `1.3.1`（仅承载并发布子包修复）。`dsh-plugin-yanyan-update` `1.2.1` / `@linxin666/dsh-session-archive` `0.4.18` 不变；三份 README 的当前版本与组件版本列表、测试注释同步对齐。子包 host 半区 `lib/index.js` 的 `VERSION` 常量改为像根包一样从自身 `package.json` 动态读取，根治 bump 时硬编码常量与包声明失同步（仅元数据，路由逻辑零改动）。
- **生效**：bug 修复全部落在 client（浏览器）半区，host 路由逻辑未改，**修好交互无需重启宿主进程**；但插件 bundle 在启动 / 安装时加载，需重新 `npm pack` 并在插件页更新安装（或 `pnpm run dev:web` 重建 bundle 后刷新页面）才能在 Web GUI 看到新交互。若顺带更新了子包 host 的 `VERSION` 常量，重载插件 / 重启宿主后 `/health` 才会报 `1.2.2`，未重启时仍报旧值属正常、不影响功能。

## 1.3.0 — 2026-11-15

### 各组件显示自己的独立版本

- **需求**：插件详情页「包含的组件」列表里，每个组件都应有自己独立的版本并显示出来（此前只有整包一个版本号）。
- **根因 / 约束**：官方 `core/protocol.ts:15-24` 的 `InstalledPluginChild` 只有 `id/name/enabled/locked`，**没有 `version` 字段**；`host/state.ts:150-157` 用 loader 行构造 children 时也不带版本，因此 DSH 设置页自身不会、也无法渲染组件版本。组件显示名来自 `cordis.patch.yml` 的 loader 行，且每行 `name` 必须恰好等于包名（否则 `duplicate factory registration`），不能把版本号塞进 name。
- **数据来源（单一真相）**：各组件本就有独立的 `package.json`（聚合根包与两个自写子包、外加复用的 `@linxin666/dsh-session-archive`）。根 `lib/index.js` 新增纯函数 `collectVersions(rootDir)`，动态读取每个组件**自身的** `package.json` 版本；外部包优先用 `createRequire` 解析实际安装包，失败再定位 `node_modules` 路径，最终回退根 `dependencies` 的声明范围（去掉 `^`）。`VERSION` 常量也改为从根 `package.json` 动态读取，消除把版本号硬编码成静态常量、与包声明容易失同步的旧问题。
- **Host 半区**：新增同源回环路由 `/__dsh-plugin-yanyan-toolkit/components`，与 `/health` 共用准入 fence（`ctx.connection.requestRejection(req)===undefined`）、方法白名单与 `ctx.effect` 多路由注册骨架（复用 `packages/dsh-plugin-yanyan-update/lib/index.js:897-924`），返回 `{ok:true, components:{包名:版本}}`。
- **Client 半区**：根 `lib/client.js` 从空壳改为版本标签注入器，照抄现成轮子 `packages/dsh-plugin-yanyan-update/lib/client.js:354-392` 的「`MutationObserver(document.body)` + 16ms 节流 + 单个 `ctx.effect` 统一清理」骨架。按 `section[data-plugin-rows] li[data-plugin-row]` 与行内 `<code>` 的**真实包名**（CSS Modules 类名是 hash，不可依赖）匹配版本表，把带 `data-yanyan-component-version` 标记的 `v<版本>` 小标签追加到中文标题元素（支持 `button.rowOpen` configure 形态），用主题变量 `var(--dsw-alias-*)` 带回退色、自持 `<style>`，版本值变化才更新、靠 data 属性去重；只认本包 4 个组件包名，不误伤其它插件详情页；React 重渲染清掉标签后由 observer 自动重挂；`inject` 保持 `[]`，不依赖任何服务。
- **测试**：新增 `test/component-versions.test.mjs`，断言 `collectVersions()` 覆盖全部 4 个组件包名、值等于各 `package.json` 的 version（外部包回退声明）、`VERSION` 等于根包版本，以及 host / client 半区的关键契约（components 路由、fence、DOM 锚点、MARK、observer/effect 清理）。
- **版本**：聚合包 bump 到 `1.3.0`；三个功能子包由各自分支独立维护版本、不随聚合包强制对齐，正好体现各自独立版本：toolkit `1.3.0` / update `1.2.1` / subagent `1.2.1` / session-archive `0.4.18`。

## 1.2.1 — 2026-11-15

### 子智能体管理：彻底修复「一直删不掉」的根因（内存投影根治）

- **根因**：v1.2.0 的「日志原位退休」已把磁盘 `session.v4.jsonl.zstd` 里的 `subagent/catalog` 行改写为 `subagent-delete/retired`，projcache 也已清；但官方「N 个子智能体」浮层 `SubagentHeaderLineage` 只读 client 内存 store `ctx.sessions.list.getSnapshot().projectionsBySession[*].values.subagentCatalog`，宿主对已加载的 live 父会话复用内存 fold state，改磁盘 / 删 projcache 都不触发重算，残留行仍显示且点进去报 `subagent is unavailable (subagent/not-found)`。插件面板因 `localStorage` 隐藏清单过滤显示「0 个」，二者数据源相同、差别只在过滤。
- **修复（6 层删除的第 6 层）**：① `lib/log-rewrite.js` 新增 `collectRetiredIds(dshHome)`，扫全库 zstd 日志收集 `subagent-delete/retired` 的 `data.childId`；② `lib/index.js` 新增 `collectHiddenIds`（`legacyHiddenIds ∪ collectRetiredIds` 去重归一），`/config` 下发 `hiddenIds`；③ `lib/legacy-hidden-ids.json` 扩到 24 个 id 作为「旧 host 进程无需重启即生效」的兼容桥（旧 `legacyHiddenIds()` 每次请求读盘）；④ `lib/client.js` 新增 `patchProjections(ctx)`，订阅 `sessions.list`、用宿主自身 `list.set()` 把隐藏 childId 从所有 `projectionsBySession[*].values.subagentCatalog` 持续剔除（幂等收敛、不自激），并在 `loadSettings`、单删成功后、首屏各调用一次。
- **验证**：新增 `test/hidden-ids.test.mjs`（4 项）与 `test/projection-patch.test.mjs`（4 项，真实 vm 沙箱执行 `patchProjections`、回归图1 的 7 个残留 id），全树 `node --test` **68/68 通过**；底层 `createSnapshotStore` 确证 `list.set()` 为宿主合法写入口；端到端实测 `/config` 下发 24 个隐藏 id、client bundle 经 HMR 已含 `patchProjections`；运行中的 GUI 刷新页面即可看到官方浮层残留行消失，重启后 host 新代码 `hiddenIds` 动态全集接管。
- **组件信息同步**：子包与根包版本一并升到 `1.2.1`，对齐 `lib/index.js` 的 `VERSION`（根包此前误留 `1.0.0`）、更新中英 `locale/*.json` 描述与双语 README / CHANGELOG。

### 插件更新：修复「更新后插件默认关闭、不自动启动」

- **根因**：面板显示「更新完成，已即时生效。」说明走的是官方 `pluginManager.updateBundle` 首选分支。已查证官方实现（`packages/boot/plugin-manager/src/index.ts`）：`updateBundle` 在 HMR 下先 `removeBundle`（内部 `selectBundle(name, false)`）再 `installBundle(spec, { enabled })`，其 `enabled` 取自 `listBundles()` 的 bundle 选择态，而 `installBundle` 只把 bundle 选择态放回（`selectBundle`），并不保证「已安装插件」页开关所依据的 entry 级 enablement（`cordis.patch.yml` 的 loader 行 override，见 `host/state.ts:145`：`rowEnabled.get(id) ?? bundleDefaults.get(id) ?? true`）。remove→install 过程把 entry 级启用态丢失，故更新后开关变灰、插件不会自动启动。`UpdateBundleOptions` 只有 `registry`/`spec`/`requestId`（strict codec，无 `enabled`），本包无法靠传参修复。
- **修复**（借鉴官方现成轮子 `host/gateway.ts:1631-1639 restoreBundleSelection` 的「方法可选 + 吞异常 + 不影响结论」）：新增 `readEnablement(manager, id)` 在更新前容错捕获启用态（`listPlugins` 的 entry 级 `enabled` 优先，并带出 `entryId`；无则回退 `listBundles` 的 bundle 选择态），仅明确 `enabled === false`（用户主动关闭）时尊重、跳过恢复；新增 `restoreEnablement(manager, id, enablement)` 在更新成功后 best-effort 放回——优先 `setPluginEnabled(entryId, true)`（直接写 patch 行 override，对应开关本体），缺失或抛错回退 `setBundleEnabled(id, true)`，所有方法可选、异常吞掉、绝不改动 `ok/updated/message`。首选 `updateBundle` 与降级两阶段/覆盖安装的全部成功出口均恢复，失败出口不触碰启用态。
- 新增 8 个单测（共 22 个）覆盖：优先 `setPluginEnabled(entryId)`、回退 `setBundleEnabled`、`wasDisabled` 不恢复、恢复抛错不影响成功结论、旧 mock 无 `list*`/`set*` 方法仍通过、降级成功也恢复。根包 12 + 子包 22 全部测试通过。
- 版本 `dsh-plugin-yanyan-update` 与聚合包均 bump 到 1.2.1，使「检查更新」能识别并拉取本修复。

## 1.2.0 — 2026-11-14

首个公开发布版本，聚合「插件更新」「会话管理」「子智能体管理」三个可独立开关的插件。

### 子智能体管理：删除改为物理删除 + 日志根除

- **根因**：旧版删除只调用 `archiveSession` 归档，既删不掉 mnemon 虚拟委派（报 `session/not-found`），也移除不了父会话 `subagentCatalog` 的 append-only 引用，导致列表里仍显示该条目；点进去则报 `subagent is unavailable`。
- **五层删除**：① 真实会话优先复用现成 `/api/dsh-session-archive/delete` 物理删除管线；② host `/purge` 兜底清会话目录、projcache 与 catalog 引用、workspace 记账、归档台账与归档标记；③ mnemon 虚拟 id 直走第 2 层；④ v1.2.0 借鉴 `huajiao1998/dsh-plugin-subagent-clean@0.3.0`（MIT，原始实现 `heiheiha798/dsh-plugin-subagent-delete@0.2.3`）的「原位退休」，把父会话日志 `session.v4.jsonl.zstd` 里的 `subagent/catalog` 事件改写为 `subagent-delete/retired`（保留 seq/time、ignorable），用 `node:zlib` 的 zstd 与两次 stat + 原子 rename 保证安全，从 append-only 源头根除目录行；失败排队到 `yanyan-subagent-pending.json` 下次启动补做；⑤ `localStorage['yanyan-subagent.deletedIds']` 隐藏清单兜底。
- **结合两种清理方法**：用户建议的 `mnemon_forget` 删的是 Mnemon 记忆洞察（insight）而非子智能体会话，按字面调用不对症；其「让 Agent 也能触发清理」的意图改由注册三个可选模型工具承接：`yanyan_list_subagents` / `yanyan_delete_subagent` / `yanyan_cleanup_subagents`。client 新增「清理残留行」按钮（`/scrub`）、一键清理只改写一次日志（`/cleanup`）、`ctx.sessions.refresh()` 让侧边栏残留行同步消失。
- 子包新增 `lib/log-rewrite.js`、`lib/zstd-frames.js`（MIT 署名保留）与 8 个测试文件。

### 插件更新：修复「更新时卸载后没装回」

- **判定为真实代码 bug**：旧 registry 更新路径无条件先 `removeBundle(id)` 再 `installBundle(targetSpec)`，失败时只做一次 best-effort 回滚；第二次安装面对同一组失败条件（registry 超时 / 版本不存在 / engines 不兼容 / 构建脚本被拒），且 profile 状态已改动，回滚失败是结构性可能。
- **修复**：首选官方 `pluginManager.updateBundle(name, version)`（内建失败/取消自动装回原版本，非 HMR 根本不先卸载），本分支零 `removeBundle` 调用；无该 API 时降级为「先覆盖安装，仅 already-installed 才两阶段」，并硬保证回滚装回原版本（最多 2 次 + profile 依赖二次核验兜底）；找不到管理器时直接返回且不动安装状态。client 失败信息改为在面板如实展示。
- 新增 9 个 mock 单测覆盖「官方通道零卸载」「抛异常 restored」「覆盖安装失败从未卸载」「两阶段失败回滚装回原版本」等失败路径。

### 发布

- 补齐 MIT LICENSE（保留派生署名的 heiheiha798 版权）、根包与子包发布元数据、`engines.node` 统一为 `^22.19.0 || >=24.0.0`（`node:zlib` zstd 需要 Node 22.15+/24）。
- 新增两个自动化流程：`.github/workflows/publish.yml`（OIDC 可信发布到 npm）与 `.github/workflows/sync-gitee.yml`（main 与标签镜像到 Gitee）。
- 生成 `.tgz` 分发包并随 GitHub Release 发布。

## 1.0.0 — 2026-11-13

内部初始版本：聚合根包 + 两个自写子包 + 复用 `@linxin666/dsh-session-archive@0.4.18`；30/30 测试通过并安装到本机 profile。当时删除语义为归档（已知限制），后续在 1.1.0 / 1.2.0 修复。
