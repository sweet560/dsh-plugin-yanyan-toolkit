# Changelog

All notable changes to this project are documented here.

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
