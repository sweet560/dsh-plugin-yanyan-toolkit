# 研研工具包

[![npm version](https://img.shields.io/npm/v/dsh-plugin-yanyan-toolkit.svg)](https://www.npmjs.com/package/dsh-plugin-yanyan-toolkit) [![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-yanyan-toolkit.svg)](https://www.npmjs.com/package/dsh-plugin-yanyan-toolkit) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/) [![publish](https://github.com/sweet560/dsh-plugin-yanyan-toolkit/actions/workflows/publish.yml/badge.svg)](https://github.com/sweet560/dsh-plugin-yanyan-toolkit/actions/workflows/publish.yml) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.en.md) | 中文

> **当前版本：v1.5.0** ｜适配 DSH **0.2.2-rc.5**

> 仓库：[GitHub](https://github.com/sweet560/dsh-plugin-yanyan-toolkit)

研研工具包是一个「一次安装、五件套」的聚合插件包：装一次同时获得五个可独立开关的插件，覆盖插件更新、会话整理、子智能体清理、图标生成、插件挑选五个高频场景，装一个包就等于配齐一套 DSH 日常工具。

- **插件更新**：在插件页一键检查并逐行更新，npm 源与本地 git/file 源都覆盖；
- **会话管理中心**：三栏管理会话、工作区与标签，自带回收站和批量操作，误删可恢复；
- **子智能体管理**：会话标签里逐个或一键清理子智能体，彻底根除残留；
- **图标生成**：上传图片自动裁切、预览、下载插件图标，不用再开设计工具；
- **找对插件**：给 agent 注册工具，从整个 DSH 插件生态里挑出「最该装的那一个」。

五个插件均为作者自研，可各自启停，稳定可靠。

## 包含插件

| 插件 | 行 id | 作用 |
| --- | --- | --- |
| 插件更新 | `dsh-plugin-yanyan-update` | 在插件页「已安装插件」标题行右侧提供「检查更新」按钮；点击后展开下拉小面板，逐行列出可更新插件（当前版本 → 最新版本）并带独立「更新」按钮。覆盖 npm registry 源与本地 `link:`/`file:`（git 仓库）源。 |
| 会话管理中心 | `dsh-plugin-yanyan-session-hub` | 独立设置页分区，三栏布局（左导航 / 中列表 / 右详情）；工作区（文件夹）与标签管理、自定义标题、状态标签；会话搜索筛选、批量归档 / 取消归档 / 批量删除；内置「回收站」tab 支持移入 / 恢复 / 彻底删除（含级联），变更后主动触发宿主 `sessions.refresh()` 即时同步侧栏。所有元数据只写旁路账本，绝不改动 DSH 原生会话文件。原独立回收站子包能力已并入此插件。 |
| 子智能体管理 | `dsh-plugin-yanyan-subagent` | 会话顶部新增可改名的「智能体管理」标签，浮层列出当前会话所有子智能体、支持行尾逐个**彻底删除**（日志根除 + 内存投影根治）与底部「清理全部空闲」；提供按空闲时间自动清理（默认关闭、可设分钟数）。 |
| 图标生成 | `dsh-plugin-yanyan-icon` | 根据上传的图片居中裁切、套上圆角背景，生成适配插件列表图标位（列表行 30px / 详情卡片 36px）的 `icon.svg`；提供双尺寸预览与一键下载。 |
| 找对插件 | `dsh-find-right-plugin` | 纯 host 工具插件，给 agent 注册 `find_dsh_plugins` 工具：聚合整个 DSH 插件生态（社区精选目录 + GitHub 实时 + npm 实时），按「相关度 × 可信度 × 新鲜度 × 热度」排序，主推最优 1 个 + 少量备选，只读、不代为安装。自写。 |

五个插件各有独立 loader 行，可在插件页分别启停。

## 组件独立版本与显示

聚合包里的每个组件都保留自己独立的 `package.json` 版本（聚合根包与各功能插件可各自发版，互不强求一致）：当前为 `dsh-plugin-yanyan-toolkit` 1.5.0、`dsh-plugin-yanyan-update` 1.2.3、`dsh-plugin-yanyan-subagent` 1.4.12、`dsh-plugin-yanyan-session-hub` 1.0.19（会话管理中心，含回收站）、`dsh-plugin-yanyan-icon` 1.0.3、`dsh-find-right-plugin` 1.0.0（找对插件）。原独立回收站子包 `dsh-plugin-yanyan-trash` 的能力已并入 session-hub，子包已删除；第三方 `@linxin666/dsh-session-archive` 已彻底剔除。

在插件详情页「包含的组件」列表里，每个组件中文标题右侧会显示一个 `v<版本>` 小标签。官方的 `InstalledPluginChild` 协议只有 `id/name/enabled/locked`，不含 `version`，DSH 自身不会渲染组件版本；本包由 host 半区新增 `/__dsh-plugin-yanyan-toolkit/components` 路由**动态读取各组件自己的 `package.json`**（绝不写死，避免失同步），client 半区照抄 `插件更新` 包已有的 `MutationObserver` + `ctx.effect` 注入骨架，按 `[data-plugin-rows] li[data-plugin-row]` 与行内 `<code>` 里的真实包名匹配后注入版本标签，不改 React 管理的 DOM、不误伤其它插件详情页，页面重渲染后自动重挂。

## 设计取舍

- **会话管理中心复用聚合包底座，回收站能力融合**：`dsh-plugin-yanyan-session-hub` 的 Host 半直接复用聚合包根 `lib/session-metadata-{service,routes}.js` 与 `lib/session-{trash,purge,cascade,snapshot}.js`，不重复造轮子；原独立回收站子包 `dsh-plugin-yanyan-trash`（此前已置为 disabled 的占位包）的回收站能力已完整融进它的「回收站」tab，子包已删除。所有元数据只写旁路账本 `session-metadata.json`，绝不改动 DSH 原生会话文件；回收站恢复 / 归档 / 批量删除后会主动触发宿主 `sessions.refresh()`，侧栏即时同步，不再等宿主轮询；批量删除混合选中时按归档态分组并给出分态确认文案，删除后清空选中，已在回收站的会话只在回收站 tab 显示。
- **插件更新复用注入骨架，补齐现成轮子缺失的部分**：官方 `@linxin666/dsh-client-ui-plugin-manager` 的 DOM 座位 `[data-plugin-panel] [data-plugin-group="bundles"]`、「检查更新」按钮、下拉面板与双通道 RPC 契约可直接借鉴；但它的检查逻辑只覆盖 npm registry 源（`source.kind === 'npm'`），对本地 `link:`/`file:` 目录与 GitHub 源一律跳过。本插件在自写 Host 半区里补上 git 本地源的版本比对与 `git merge --ff-only` 更新，并给下拉列表每一行加独立更新按钮。
- **子智能体「删除」= 物理删除 + 日志根除（不可逆）**：旧版只调用 `archiveSession` 归档，既删不掉 mnemon 虚拟委派（会报 `session/not-found`），也移除不了父会话 `subagentCatalog` 的 append-only 引用，导致列表里仍显示该条目。现改为 host `/purge` 物理删除：真实会话直接清会话目录、projcache 与 catalog 引用、workspace 记账、归档台账与归档标记；虚拟 id 同样走本地清理。原「优先复用第三方 `/api/dsh-session-archive/delete` 管线」的依赖已随第三方包剔除一并移除，清理能力完全自持。v1.2.0 起进一步借鉴 `dsh-plugin-subagent-clean`（MIT）的「原位退休」把父会话日志 `session.v4.jsonl.zstd` 里的 `subagent/catalog` 事件改写为 `subagent-delete/retired`（保留 seq/time、ignorable），从 append-only 源头根除目录行，宿主不再重建；配合「清理残留行」按钮（`/scrub`）、一键清理只改写一次日志（`/cleanup`）、`ctx.sessions.refresh()` 让侧边栏残留行同步消失，以及 `localStorage['yanyan-subagent.deletedIds']` 隐藏清单兜底。另注册三个可选模型工具（`yanyan_list_subagents` / `yanyan_delete_subagent` / `yanyan_cleanup_subagents`），让 Agent 一句话即可清理空闲 Mnemon review 子代理。v1.2.1 起补上真正的根治层：官方「N 个子智能体」浮层只读 client 内存投影 `projectionsBySession[*].values.subagentCatalog`，宿主对已加载的 live 父会话复用内存 fold state，改磁盘日志 / 删 projcache 都不会让它重算，导致磁盘已退休的残留行仍显示、点进去报 `subagent/not-found`。现由 host 扫全库退休日志行经 `/config` 下发 `hiddenIds`，client `patchProjections` 订阅 `sessions.list` 用 `list.set()` 持续从内存投影剔除隐藏 childId（幂等收敛），官方浮层计数归零后自动隐藏。
- **图 3 官方子智能体列表行尾加 X**：官方浮层行没有行级 Slot，也没有 `data-session-id` 之类的 DOM 锚点，无法通过稳定注入实现行尾删除。本插件把「逐个删除」做在自建的「智能体管理」标签浮层里（数据来自 `listDescendants`，id 明确），并在 `conversation.session.header.actions.subagent.footer` 提供「清理全部空闲」按钮。图 3 行内 X 仅作为可选的高风险 DOM 注入增强，默认不启用。

## 安装

本包是一个 npm 包，通过 `dsh.bundle.patch` 的 `cordis.patch.yml` 一次插入六条 loader 行（自身行 + 五个功能插件行）。三种方式任选其一：

从 npm 安装（推荐，需 Node `^22.19.0 || >=24.0.0`）：

```
dsh plugin add dsh-plugin-yanyan-toolkit
```

本地目录安装（开发调试）：

```
dsh plugin add file:<本包目录>
```

或在插件页「添加插件」里选择本地目录 / 输入 npm 包名安装。

## 分发与自动化

- npm：`.github/workflows/publish.yml` 在 push `main`、`v*` 标签、Release 发布或手动触发时用 OIDC 可信发布执行 `npm publish --provenance --access public`；发布前先跑 `npm test`，并轮询跳过已发布版本。首次使用需在 npmjs.com 为本仓库与该工作流配置 trusted publisher。
- Gitee：`.github/workflows/sync-gitee.yml` 在 push `main` 或手动触发时把 main 与全部标签镜像到 Gitee；需要在仓库 Secret 配置 `GITEE_SSH_PRIVATE_KEY`（一把已注册在 Gitee 账号下的无口令私钥）。
- GitHub Release：每个版本附带 `dsh-plugin-yanyan-toolkit-<version>.tgz` 离线分发包，可直接 `npm install <tgz>` 后按本地包方式安装。

## 生效说明

改动涉及 bundle 行与 `cordis.patch.yml`，**需要用户重启 DSH 服务后生效**（本会话未自行重启正在运行的 DSH 服务）。重启后刷新页面即可看到：
- 插件页「已安装插件」标题行右侧的「检查更新」按钮；
- 插件详情页「包含的组件」列表里每个组件标题右侧的 `v<版本>` 标签；
- 设置页新增的「会话管理」分区（由复用的包提供）；
- 设置页新增的「会话管理中心」分区：会话 / 工作区 / 标签 / 回收站 tab，三栏布局与批量操作；
- 会话顶部新增的「智能体管理」标签；
- 插件页「已安装插件」标题行右侧的「图标生成」按钮，上传图片后双尺寸预览并下载 `icon.svg`；
- 给 agent 注册 `find_dsh_plugins` 工具（纯 host，无界面按钮），用于在整个 DSH 插件生态里查找「最该装的那一个」插件。

## 目录结构

```
dsh-plugin-yanyan-toolkit/          聚合根包（自身行为空壳，只承载 patch 与依赖）
  cordis.patch.yml                 7 行 insert：自身 + 6 个插件
  lib/index.js, lib/client.js      极简 host / client 半区
  locale/{zh,en}.json              插件页展示元数据
  packages/
    dsh-plugin-yanyan-update/      插件更新（自写）
    dsh-plugin-yanyan-session-hub/ 会话管理中心（自写，含回收站）
    dsh-plugin-yanyan-subagent/    子智能体管理（自写）
    dsh-plugin-yanyan-icon/        图标生成（自写）
    dsh-find-right-plugin/         找对插件（自写；纯 host 工具）
```

五个自写子包都列在根包 `dependencies` 里，pnpm 的 hoisted 布局会把它们提升到 profile 根 `node_modules`，六条 loader 行（自身行 + 五个功能插件行）的 `name` 均可解析。
