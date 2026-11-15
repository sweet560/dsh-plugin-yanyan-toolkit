# 研研工具包

一个聚合插件包，安装后同时获得三个可独立开关的插件。遵循「有现成的就直接借鉴、不重复造轮子」：会话管理直接复用社区现成包，另外两个自写插件也尽量照抄官方与社区已验证的注入点。

## 包含插件

| 插件 | 行 id | 作用 |
| --- | --- | --- |
| 插件更新 | `dsh-plugin-yanyan-update` | 在插件页「已安装插件」标题行右侧提供「检查更新」按钮；点击后展开下拉小面板，逐行列出可更新插件（当前版本 → 最新版本）并带独立「更新」按钮。覆盖 npm registry 源与本地 `link:`/`file:`（git 仓库）源。 |
| 会话管理 | `session-archive` | 自动归档会话、自动删除已归档会话（默认均关闭，可设 7/15/30/自定义天数）、单条与批量删除。**直接复用** `@linxin666/dsh-session-archive@0.4.18`，其设置页与后端已完整覆盖需求。 |
| 子智能体管理 | `dsh-plugin-yanyan-subagent` | 会话顶部新增可改名的「智能体管理」标签，浮层列出当前会话所有子智能体、支持行尾逐个删除与底部「清理全部空闲」；提供按空闲时间自动清理（默认关闭、可设分钟数）。 |

三个插件各有独立 loader 行，可在插件页分别启停。

## 设计取舍

- **会话管理零改动复用**：`@linxin666/dsh-session-archive` 已实现按 `updatedAt` 自动归档、按归档台账 `archivedAt` 自动删除、单条/批量物理删除、1~3650 任意天数、Host 端定时调度与设置页 UI。其天数输入框接受任意 1~3650 的整数，已包含 7/15/30/自定义，无需改造。
- **插件更新复用注入骨架，补齐现成轮子缺失的部分**：官方 `@linxin666/dsh-client-ui-plugin-manager` 的 DOM 座位 `[data-plugin-panel] [data-plugin-group="bundles"]`、「检查更新」按钮、下拉面板与双通道 RPC 契约可直接借鉴；但它的检查逻辑只覆盖 npm registry 源（`source.kind === 'npm'`），对本地 `link:`/`file:` 目录与 GitHub 源一律跳过。本插件在自写 Host 半区里补上 git 本地源的版本比对与 `git merge --ff-only` 更新，并给下拉列表每一行加独立更新按钮。
- **子智能体「删除」= 物理删除 + 日志根除（不可逆）**：旧版只调用 `archiveSession` 归档，既删不掉 mnemon 虚拟委派（会报 `session/not-found`），也移除不了父会话 `subagentCatalog` 的 append-only 引用，导致列表里仍显示该条目。现改为 host `/purge` 物理删除：真实会话优先复用现成 `/api/dsh-session-archive/delete` 管线，再兜底清会话目录、projcache 与 catalog 引用、workspace 记账、归档台账与归档标记；虚拟 id 直接走兜底。v1.2.0 起进一步借鉴 `dsh-plugin-subagent-clean`（MIT）的「原位退休」把父会话日志 `session.v4.jsonl.zstd` 里的 `subagent/catalog` 事件改写为 `subagent-delete/retired`（保留 seq/time、ignorable），从 append-only 源头根除目录行，宿主不再重建；配合「清理残留行」按钮（`/scrub`）、一键清理只改写一次日志（`/cleanup`）、`ctx.sessions.refresh()` 让侧边栏残留行同步消失，以及 `localStorage['yanyan-subagent.deletedIds']` 隐藏清单兜底。另注册三个可选模型工具（`yanyan_list_subagents` / `yanyan_delete_subagent` / `yanyan_cleanup_subagents`），让 Agent 一句话即可清理空闲 Mnemon review 子代理。
- **图 3 官方子智能体列表行尾加 X**：官方浮层行没有行级 Slot，也没有 `data-session-id` 之类的 DOM 锚点，无法通过稳定注入实现行尾删除。本插件把「逐个删除」做在自建的「智能体管理」标签浮层里（数据来自 `listDescendants`，id 明确），并在 `conversation.session.header.actions.subagent.footer` 提供「清理全部空闲」按钮。图 3 行内 X 仅作为可选的高风险 DOM 注入增强，默认不启用。

## 安装

本包是一个 npm 包，通过 `dsh.bundle.patch` 的 `cordis.patch.yml` 一次插入四条 loader 行。三种方式任选其一：

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
- 设置页新增的「会话管理」分区（由复用的包提供）；
- 会话顶部新增的「智能体管理」标签。

## 目录结构

```
dsh-plugin-yanyan-toolkit/          聚合根包（自身行为空壳，只承载 patch 与依赖）
  cordis.patch.yml                 4 行 insert：自身 + 3 个插件
  lib/index.js, lib/client.js      极简 host / client 半区
  locale/{zh,en}.json              插件页展示元数据
  packages/
    dsh-plugin-yanyan-update/      插件更新（自写）
    dsh-plugin-yanyan-subagent/    子智能体管理（自写）
  （会话管理无子目录，直接依赖 npm 包 @linxin666/dsh-session-archive）
```

三个真实插件列在根包 `dependencies` 里，pnpm 的 hoisted 布局会把它们与 npm 包一起提升到 profile 根 `node_modules`，四条 loader 行的 `name` 均可解析。
