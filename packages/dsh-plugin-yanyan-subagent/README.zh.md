# 子智能体管理（dsh-plugin-yanyan-subagent）

「研研工具包」聚合插件包中的第三个插件，用于查看与管理当前会话的所有子智能体。

## 功能

- 在会话顶部操作区新增一个标签（默认「智能体管理」，可在浮层的「重命名标签」处改名，名称保存在浏览器本地存储）。
- 点击标签打开浮层（浮层通过 `ReactDOM.createPortal` 挂到 `document.body`，避免被顶部操作区的溢出裁剪裁掉；`react-dom` 不可用时降级为把浮层直接追加到 `document.body` 并用原生 DOM 渲染）。
- 列出当前会话的所有子智能体，显示名称、状态（运行中 / 空闲）、模式以及估算的空闲时长。
- 行尾的删除按钮（U+2715 乘号，普通 Unicode 数学符号，非 emoji）可逐个删除，删除前二次确认；正在运行的子智能体删除时会先停止。根会话（lead）本身永不删除。
- 底部「清理全部空闲」立即清理当前列表里所有显示为空闲（非运行中）的子智能体，并显示清理数量；这是手动操作，**不受「空闲阈值」限制**（阈值只用于定时自动清理）。判定与列表「空闲」标签、host `/cleanup` 语义一致：排除运行中、诊断行、根会话与已在隐藏清单中的条目，不再出现「已清理 0 个」却清不掉条目的情况。
- 「设置」区可开启「自动清理空闲子智能体」（默认开启，空闲阈值默认 30 分钟、巡检间隔默认 10 分钟），设置「空闲超过（分钟）」与「巡检间隔（分钟）」。开启后按间隔巡检，只清理达到阈值且处于空闲的子智能体；读取列表数据失败时保守不删（fail-closed）。

## 删除语义（物理删除，不可逆）

删除会**真正移除会话数据并从源头根除目录行**，不再是「归档」。做法分层：

1. 真实会话优先复用现成包 `@linxin666/dsh-session-archive` 的 `POST /api/dsh-session-archive/delete` 物理删除管线（会清理 sqlite rdb、会话目录、投影缓存与归档台账）。
2. host 侧 `/purge` 路由再兜底清理一遍：会话目录（含 `session-` 前缀两种拼写、realpath 校验不越界）、projcache 文件与父会话 `subagentCatalog` 缓存引用、`workspace.json` 的 `global.archivedSessionIds` 与 `tables.workspaces[*].sessionIds` 记账、`archive-ledger.json` 台账；并用 `workspaceRegistry.unarchiveSession` 摘掉归档标记。
3. 对 mnemon 虚拟委派（id 形如 `mnemon-run-v1-<uuid>`，不是真实 `session-<uuid>` 会话）直接走第 2 层——这类 id 调用 `archiveSession` 会报 `session/not-found`。
4. **catalog 根治（v1.2.0）**：`subagentCatalog` 是父会话日志 `session.v4.jsonl.zstd` 里 `subagent/catalog` 事件的 **append-only 投影**（官方 `@deepseek-ai/dsh-chunked-list` 只追加、无删除 API）。因此清缓存、归档、删目录都移除不了底层日志引用，宿主下次 `refreshProjections` 会把条目重建回来。借鉴 `huajiao1998/dsh-plugin-subagent-clean@0.3.0` 的「原位退休」思路（MIT，原始实现 `heiheiha798/dsh-plugin-subagent-delete@0.2.3`），`/purge` 把命中的 `subagent/catalog` 事件**原位改写**为 `{"type":"subagent-delete/retired","seq":<原值>,"time":<原值>,"ignorable":true,"data":{"childId","retiredAt"}}`：`seq`/`time` 原样保留（日志 seq 连续性与压缩事件引用不受影响），而目录投影只在 `type === "subagent/catalog"` 时生成行，于是投影再也不会重建该行。日志解码/编码用 `node:zlib` 的 zstd（Node >= 22.15 / 24），原子 rename 前后各做一次 stat 并发校验；改写失败会排队到 `yanyan-subagent-pending.json`，宿主下次启动补做。
5. **隐藏清单兜底**：client 侧仍保留持久化隐藏清单 `localStorage['yanyan-subagent.deletedIds']`（存去 `session-` 前缀后的核心 id），在渲染、批量清理、自动清理与官方列表行尾按钮里持续过滤。即便日志改写遇到并发写入/解码失败，已删条目也不会重新出现。
6. **内存投影根治（v1.2.1）**：官方「N 个子智能体」浮层（`SubagentHeaderLineage`）只读 client 内存 store `ctx.sessions.list.getSnapshot().projectionsBySession[*].values.subagentCatalog`；宿主对已加载的 live 父会话复用内存 fold state，单纯改磁盘 zstd 日志 / 删 projcache 都不会让它重算，于是磁盘已退休的残留行仍会显示、点进去报 `subagent is unavailable (subagent/not-found)`。为此 host 新增 `collectRetiredIds` 扫全库 `subagent-delete/retired` 日志行，经 `/config` 下发 `hiddenIds`（兼容桥：扩充 `legacy-hidden-ids.json` 让旧 host 进程即时下发）；client 的 `patchProjections` 订阅 `sessions.list`，用宿主自身的 `list.set()` 把隐藏清单里的 childId 从所有 `projectionsBySession[*].values.subagentCatalog` 中持续剔除（幂等收敛、不自激），官方浮层 `directCount` 归零后自动隐藏。这是「一直删不掉」的真正根因层。

**该操作不可逆**，删除前会二次确认；正在运行的子智能体删除时先停止。根会话（lead）本身永不删除。

### 残留行、一键清理与侧边栏同步

- 浮层底部新增 **「清理残留行」** 按钮，调用 host `/scrub` 路由，把「子会话目录已不在、catalog 行还在」的引用从父会话日志原位退休（专治旧版归档 / 重建遗留的幽灵行，对应图2 / 图3）。每次单删、批量清理、自动清理与残留清理之后，client 除 `refreshProjections(rootId)` 外还会调用 `ctx.sessions.refresh()`，让**侧边栏残留行同步消失**。
- host `/cleanup` 路由（与模型工具）批量删除时对齐上游做法：所有命中 id **只全库改写一次日志**（`retireCatalogRowsEverywhere`），不是逐条改写。
- host `/catalog` 直接从日志真相源列出仍会生成目录行的 `subagent/catalog` 事件（比会被重建的 projcache 缓存可靠）。

### 模型工具（可选 `tools` 注入）

profile 提供 `tools` 服务时注册三个纯对象工具，让 Agent 一句话就能完成清理（用户建议里的 `mnemon_forget` 删的是 Mnemon 记忆洞察 insight、不是子智能体会话 / catalog 行，按字面调用不对症；其「让 Agent 也能触发清理」的真实意图由此承接）：

- `yanyan_list_subagents` —— 列出仍存活的目录行（可按标签过滤）。
- `yanyan_delete_subagent` —— 彻底删除单个子智能体（必填 `subagent_id`）。
- `yanyan_cleanup_subagents` —— 批量删除（标签过滤 / 仅空闲 / dry-run / 数量上限），对应「列出当前会话里所有空闲的 Mnemonic idle checkpoint review 子代理并全部删掉」。

## 数据来源与降级

- 主数据源为浏览器侧会话投影：`ctx.sessions.list.getSnapshot().projectionsBySession[rootId].values.subagentCatalog`。
- 根会话 id 由 `retainedBy.mainView > 0` 推导，找不到时回退到遍历 `projectionsBySession` 中带 `subagentCatalog` 的会话。
- 本地投影读不到时，回退到 host 侧 `/__dsh-plugin-yanyan-subagent/list`（依赖宿主的 `subagents.listDescendants`，服务缺失时返回 `service-unavailable`）。
- 官方投影没有空闲起点字段（`lastActiveAt` / `idleSince` 均无命中），空闲时长由本插件在内存中按「首次观察到 inactive 的时刻」估算，刷新页面后会重置。

## 官方子智能体列表浮层行尾删除按钮的限制（图3，可选增强）

本插件尽力用 `MutationObserver` 在官方子智能体列表浮层 `[data-subagent-panel]` 出现时，给每个 `[role="treeitem"]` 行尾追加一个小删除按钮。但存在已确认的硬限制：

- 官方列表行**没有行级 Slot，也没有 `data-id` 等稳定标识**；行的 `aria-label` 只是 `[primaryLabel, secondary, metrics].join(' ')` 的文本拼接，无法可靠反推出 `sessionId`。
- 因此点击该按钮时只能拿行文本到本地 `subagentCatalog` 做模糊匹配（名称包含匹配 + 顺序对应）。**只有唯一命中时才会执行删除**；无法唯一定位时会提示「无法定位该子智能体，请在智能体管理标签中删除」。
- 该 DOM 注入是「脆弱增强」：官方 DOM 结构一旦变化即可能失效，且匹配可能误判。它不保证成功，请优先使用本插件自己的「智能体管理」标签里的行尾删除按钮（那里有确定的 `sessionId`）。

## 配置

`cordis.patch.yml` 提供默认值（profile 覆盖层对同名 id 是整份替换 config、不做深合并，host 的 `normalizeConfig()` 对每个缺省 key 都做了兜底）：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `tabLabel` | 智能体管理 | 顶部标签文字，可在浮层内改名 |
| `autoCleanEnabled` | true | 自动清理开关，默认开启 |
| `idleMinutes` | 30 | 空闲阈值分钟数（1..10080） |
| `checkIntervalMin` | 10 | 自动清理巡检间隔分钟数（1..1440） |

## 测试

```
node --test test/*.test.mjs
```

纯单元测试覆盖 `normalizeConfig`、`parseCatalog`、`idleFilter`、删除 id 安全校验、日志原位退休、`collectRetiredIds` / `collectHiddenIds` 与 `patchProjections` 内存投影剔除，不连接任何 DSH 服务（全树 68/68 通过）。

## 版本说明

### 1.4.10 — 2026-11-18（功能性 BUG 修复）

修复「自动清理空闲子智能体开启后不触发删除」的功能性 BUG。

- **现象**：设置里开启自动清理后，到点巡检却几乎从不删除任何子智能体；手动点「清理全部空闲」则正常。
- **根因**：官方 `subagentCatalog` 投影行根本没有 `activity` 字段，但定时自动清理的两处逻辑都硬依赖它——`idleFilterLocal()` 强制要求 `activity === 'inactive'` 才把行选为目标，`updateIdleTracking()` 也只在 `activity === 'inactive'` 时记录空闲起点。结果所有官方行在自动路径里全被跳过，目标集恒为空；即使有 `activity`，空闲起点回退到 `Date.now()`，30 分钟阈值也永不满足。
- **修复**：
  - `idleFilterLocal()` 改为**只排除运行中**（`row.running === true || row.activity === 'running'`），与列表「空闲」标签、手动清理 `manualCleanTargets()` 判定口径统一；官方行无 `activity` 也能被正确选中。
  - `updateIdleTracking()` 改用统一的 `isRowRunning()` 判定空闲起点的记录/清除，官方行首次观察即记入 `firstSeen`，空闲阈值开始正常计时。
  - 保留 fail-closed（列表读取失败保守不删）与「运行中绝不碰」的安全约束。
- **验证**：先以临时测试版（巡检间隔 5 秒 + 空闲阈值归零）真机实测，确认开启自动删除后空闲子智能体被真实删除；验证通过后已恢复正式配置（巡检间隔、空闲阈值均走用户设置）。新增 2 个回归测试覆盖「无 activity 的官方空闲行可被自动清理选中」与「统一运行中判定记录空闲起点」。
- **版本**：仅升子包 `dsh-plugin-yanyan-subagent` → 1.4.10；聚合根包版本号不变。

> 本次改动前序还有一批界面微调（去除无效右箭头、行悬停高亮、状态徽标移到行首右侧、删除第二行元信息、列表高度贴合内容、刷新按钮可见反馈、官方面板不再注入单条删除 X、管理浮层保留行内删除 X），均已在真机逐项确认生效。
