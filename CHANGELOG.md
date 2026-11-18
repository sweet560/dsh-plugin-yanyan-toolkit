# Changelog

All notable changes to this project are documented here.

## 1.4.12 — 2026-11-18（正式发布）

> 会话管理中心（Session Hub）Phase 1/2/3 首次随聚合包发布，并修复会话标题实时更新、增强回收站、标签体系纳入 DSH 状态标签。

### 版本总览

| 组件 | 版本 |
|---|---|
| `dsh-plugin-yanyan-toolkit`（聚合根包） | **1.4.12** |
| `dsh-plugin-yanyan-subagent`（子智能体管理） | 1.4.11 |
| `dsh-plugin-yanyan-session-hub`（会话管理中心） | 1.0.1（首次发布） |
| `dsh-plugin-yanyan-update` | 1.2.2 |
| `dsh-plugin-yanyan-icon` | 1.0.2 |
| `dsh-plugin-yanyan-trash`（能力并入 session-hub，保留占位） | 1.0.1 |
| `@linxin666/dsh-session-archive` | 0.4.18 |

### 一、会话管理中心 Session Hub（Phase 1/2/3，首次发布）

- **Phase 1 旁路元数据**：`lib/session-metadata.js` 以旁路 JSON 存储会话标签 / 文件夹 / 自定义标题（原子写 + Promise 串行锁，系统文件夹 `@trash`/`@unfiled` 受保护）；`lib/session-metadata-service.js` 合并活跃会话 × 元数据；`lib/session-metadata-routes.js` 提供 `/api/dsh-yanyan-session-hub` 统一路由（22 条）。
- **Phase 2 全文搜索**：`lib/search-index.js` 复用 `zstd-frames.decodeLog` 逐帧解压会话日志（跳过 reasoning / tool-call / tool-result，中文单字 + 2-gram / 英文整词），内存倒排索引 + `setImmediate` 分片 + 多重熔断，支持增量更新。
- **Phase 3 Markdown 导出**：`lib/export-markdown.js` 自带 store-mode ZIP 打包（CRC32 0xEDB88320，零第三方依赖），支持导出选中 / 全部会话。
- **回收站融合**：原 `dsh-plugin-yanyan-trash` 置为 disabled，能力并入 session-hub，`trash/*`、`archive/unarchive/deleteArchived` 统一到 `/api/dsh-yanyan-session-hub`。
- 新子包 `packages/dsh-plugin-yanyan-session-hub`（host/client 半区 + 中英 locale + 双语 README），随根包发布。

### 二、修复会话标题不实时更新

- 根因：标题权威源在 `$DSH_HOME/storages/session_projcache/sessions/<id>.json` 的 `rows.title.val`，但 `lib/native-session-source.js:readSessionIndexIds` 原本只读 `createdAt`/`cwd`、未读 title；日志派生的 `empty` 近似判断又会把有真实标题的会话强制覆盖成「空会话」。
- 修复：`readSessionIndexIds` 扩展读取 `rows.title.val` / `rows.titleInput.val.first.text` / `rows.sessionListMetadata.val.blank`（fail-closed）；`session-metadata-service.buildItem` 标题优先级改为「自定义标题 > 原生 projcache 标题 > 日志派生 > 截断 id」，`empty` 改用原生 blank 标志；client 新增 `refreshItems()` 静默刷新，索引 ready 后每约 6s 重拉 `list()` 保持标题 / 状态实时同步。

### 三、回收站增强

- 新增筛选工具条：搜索框（按标题 / 内容 / ID，大小写不敏感）、工作区下拉、标签下拉。
- 新增批量条：全选当前结果 / 清空选择 / 已选 N 项 / 批量彻底恢复 / 批量彻底删除（均带确认提示，只作用于筛选后的可见行）。
- 后端 `lib/session-snapshot.js` 新增 `readSessionTitleAndContent()`，一次解压同时抽出标题 / 对话文本（供内容搜索，`maxContentChars=4000`）/ cwd；`session-trash-service.list()` 补 `content`/`cwd`；`session-metadata-service.trashList` 补 `tags`/`workspace`（纯内存映射，不落账本）。
- 批量恢复因后端 `trashRestore` 仅收单 id，由前端 `trashRestoreMany` 逐条并发并聚合结果。

### 四、标签体系纳入 DSH 状态标签

- 「全部标签」下拉与「标签」页标签云现包含 6 种 DSH 状态标签：`已归档 / 进行中 / 空白 / 子会话 / 空闲 / 空会话`，计数从全量会话实时聚合。
- 状态标签用内部前缀 `__status__` 编码为 value，与同名手动标签隔离；筛选时状态走 `it.status`、手动标签走 `it.tags`，互不串味。
- 中英 i18n 各补 `hub.statusTagLabel` / `hub.statusTagChip`。

## 1.4.2 — 2026-11-17（正式发布）

> 路径 A（会话管理重做）完整落地版本。**下方各 `###` 段是本版本各特性的详细变更记录**（由原「Unreleased」段归档而来，均已真机验证通过）。

### 版本总览

| 组件 | 版本 |
|---|---|
| `dsh-plugin-yanyan-toolkit`（聚合根包） | **1.4.2** |
| `dsh-plugin-yanyan-subagent`（子智能体管理） | **1.4.0** |
| `dsh-plugin-yanyan-trash`（会话回收站） | 1.0.0（新增） |
| `dsh-plugin-yanyan-update` | 1.2.1 |
| `dsh-plugin-yanyan-icon` | 1.0.1 |
| `@linxin666/dsh-session-archive` | 0.4.18 |

### 一、子智能体增强

- 浮层交互与样式对齐官方：按钮 hover 开合（200ms 延迟关闭）、点击空白关闭、按触发按钮 `getBoundingClientRect()` 实时定位、resize 重定位；列表行模仿官方布局（状态点 + 双行文字 + 右箭头 + 删除 X），`formatTokenCount` / `formatDuration` 防御性探测字段。
- 彻底删除（日志根除 + 内存投影根治）、批量清理空闲与自动清理、清理残留行；三个可选模型工具（`yanyan_list_subagents` / `yanyan_delete_subagent` / `yanyan_cleanup_subagents`）。
- 子包版本 `dsh-plugin-yanyan-subagent` → `1.4.0`。

### 二、路径 A 四阶段（会话管理重做）

1. **可逆回收站（第 1、2 阶段）**：中心 manifest + 原子写 + 会话目录真实 `move` 到 `session-trash` 并支持恢复；第 2 阶段补物理删除（purge）管线，回收站条目可彻底删除。
2. **级联（第 3 阶段）**：子代理树级联删除 + 批量部分失败结果模型；确认框预览 N 与实际进回收站的子代理数一致，fork 剪枝、受保护整族保留。
3. **快照（第 4a 阶段）**：会话树快照构建（Host 半），`buildSnapshot` / `descendantsOf` / `planDelete` 支撑级联预览与 fail-closed 判定。
4. **UI 重构（第 4b 阶段 + m04934）**：独立子包 React client + Host 路由接回；活跃会话列表由原生 `<select>` 重构为「搜索 + 多选 + 标题回退」的现代列表，视觉对齐 DSH 原生设置页（CSS token + `:focus-visible` + `prefers-reduced-motion`）。

### 三、本轮真机测出的 5 个重大 Bug（全部修复并复验）

| Bug | 现象 / 根因 | 修复 | 详细段 |
|---|---|---|---|
| `~0020` 编码 project key | 删除会话报 `illegal project name`；DSH 的 Windows project key 是 URL 编码形式 `--F-DeepSeek~0020Harness~0020workspace--`，被命名正则误拒 | `SEGMENT_RE` 放宽为只拒绝 `/`、`\`、空字节，显式拒绝 `.`/`..`；纵深防御交给 `isTwoLevelUnder` + `lstat` + `realpath` 校验 | 下方「放宽 DSH 编码 project key 的命名校验」 |
| 假 running | 空闲会话被判为 running 而拒绝删除；`runningOf()` 把「在 `sessions.list` 存在（attached）」当成 running | 改用宿主 `agents.get(id).status === 'running'`（兼容 session- 前缀两种形态），能力缺失返回 false、读态异常仍 throw | 下方「runningOf 误判空闲会话为 running」 |
| 幽灵会话 | A3 恢复后侧栏出现「未命名 / NaN / id=undefined」幽灵行；宿主 `api-session/added` payload 是 `summaryFor` 对象，本插件却发字符串 id | `emitAdded` 恒为 null（停发伪造事件）+ client 成功后调宿主 `sessions.refresh()` 自行扫描磁盘；回收站标题从会话日志 `session/title` 末条读取 | 下方「A3 恢复幽灵会话 + 回收站标题」 |
| zstd 多帧 | A2 标题重启后仍裸 id；会话日志是拼接帧容器，旧「整文件一次性解压」在宿主 Electron 老 Node 只拿首帧，末帧标题丢失 | 移植 DSH 生产实现 `scanZstdFrames()` + 逐帧解压拼接（保留 8 MiB 上限） | 下方「拼接帧 zstd 解压」 |
| `archive-gate` | `mnemon-task-v1-*` 类会话移入回收站报 `archive-gate`；canonical 强加 `session-` 前缀导致 DSH 按原始 id 找不到会话 | 归档闸门降级：unknown 且 canonical≠rawId 时用原始 id 重试；仍 unknown 则跳过归档继续 move（标 `archiveSkipped:true`）；active 与其它异常 fail-closed；补两条中文 `REASON_MAP` | 下方「归档闸门降级」 |

### 四、质量与发布

- 自动化测试：根包 `npm test` **196/196 全绿**（零回归），host / client `node --check` 通过；真机 GUI + 真实数据 service 层双证据验证（详见 `VERIFICATION.md`）。
- 发布：走 GitHub Actions OIDC 可信发布（`.github/workflows/publish.yml`，`id-token: write` + `npm publish --provenance`），由 push main / tag `v*` 触发；Gitee 由 `.github/workflows/sync-gitee.yml` 同步。
- 包一致性：本版本功能代码与最后真机验证包逐文件一致；因本汇总段（CHANGELOG 在打包白名单内）与 subagent 版本号元数据更新，最终 tgz 哈希相应变化，最终哈希以发布时 `npm pack` 为准，详见 `VERIFICATION.md`。

### 归档闸门降级：mnemon- 非标准会话可移入回收站 + reason 中文提示（网页chat 真机反馈，m05087）

- **触发**：网页chat 真机审核反馈 `mnemon-task-v1-*` 类会话点「移入回收站」报 `archive-gate`，要求排查 `archiveSession` 为何失败，抛异常/不可用时降级（跳过归档强行 move）或给清晰中文提示，并补 REASON_MAP 映射后重新打包。
- **根因（读 DSH 源码铁证，非猜测）**：`archiveSession(sessionId)`（dsh-workspace/lib/index.js:527）→ `sessionKnown(id)`（:621）按**原始 id 精确匹配** live/persistence；不在其中即抛 `WorkspaceUnknownSessionError`（:530/:298 "live sessions and session persistence hold no such session"）。本模块 `moveOneToTrash:466` 传的是 `check.id`（canonical 形式），普通 `session-<uuid>` canonical 不变故正常；`mnemon-task-v1-<uuid>` 不以 `session-` 开头，被 canonical 强加前缀变成 `session-mnemon-task-v1-<uuid>` → header 里无此 id → 抛错 → reason `archive-gate`。这是 1.1 命门的又一延续。
- **修复（降级策略，只放未知会话、绝不放运行中保护）**：`lib/session-trash.js` 的 `moveOneToTrash` 归档闸门重写——
  - 先按 canonical 归档（`session-*` 行为完全不变）；
  - `WorkspaceActiveSessionError`（运行中）→ `reason:'archive-active'` **fail-closed**、不移动；
  - `WorkspaceUnknownSessionError` 且 canonical≠rawId → 用**原始 id 重试一次**（DSH 认识 header.id 原始形式）；重试成功=正常归档；重试仍 unknown=降级跳过归档继续 move；重试其它错=fail-closed；
  - unknown 且无 canonical/raw 差异 → 也降级跳过；
  - 其它未知错误 → `reason:'archive-gate'` fail-closed。
  - 降级条目在 manifest entry 标 `archiveSkipped:true`（便于审计与恢复感知）；恢复侧无需改——DSH `unarchiveSession:562` 对未归档 id 直接 no-op，mnemon- 会话恢复无害。
- **安全边界**：只对「会话不在 registry（DSH 不认识）」这一种确定miss降级；运行中保护（active）、能力缺失、其它异常一律 fail-closed，绝不静默放行。move 本身可逆（manifest 记录原路径 + emitRemoved 刷新）。
- **client REASON_MAP 补充**：新增 `archive-gate`「该会话不支持归档或正处于锁定状态，暂时无法移入回收站。」与 `archive-active`「该会话仍处于活动状态，请先结束其任务再移入回收站。」（各含 en 文案、scope=item），用户不再看到原始 reason 代码；既有 reasonUnknown 兜底保留。
- **测试**：`test/session-trash.test.mjs` +4（unknown 降级跳过并 move/无差异也降级/active fail-closed 不移动/canonical 失败 rawId 重试成功不标降级）；`test/session-trash-host.test.mjs` +1（两条 reason 有映射文案、不暴露原始代码）。根包 `npm test` **196/196 全绿**（191+5 零回归），client/host `node --check` 通过。
- **状态**：代码完成、待重新打包与覆盖安装；用户重启宿主后真机复验 mnemon- 会话可移入回收站。

### UI 重构：活跃会话列表（搜索/多选/标题回退）+ 视觉对齐（网页chat 真机反馈，m04934）

- **触发**：网页chat 真机审核指出两个必须修的体验问题——①「移入回收站」的下拉 `<select>` 选项直接渲染裸 session.id（`session-xxx`/`mnemon-run-xxx`），要求复用标题提取函数显示人类可读标题；②原生下拉无法展示丰富信息、不利多选、界面粗糙，要求重构为现代化会话选择列表并视觉对齐 DSH 原生设置页。
- **边界**：本轮**只改前端 React 组件**（`packages/dsh-plugin-yanyan-trash/lib/client.js`），不碰 host 物理 move/manifest/事件广播/路由；不改 `@linxin666/dsh-session-archive`。
- **裸 id 根因**：活跃会话 summary（`summaryFor`）本身不含 title（只有 sessionId/updatedAt/running/listFields），真标题在会话日志 `session/title` 事件（client 无 fs 读不到）；旧 `liveIds()` 只从 `sessions.list().getSnapshot().byId` 提取 id 字符串、丢掉 row 上的 title/时间字段 → 列表只能显示裸 id。
- **修复（纯前端 displayTitle 回退）**：新增 `displayTitle(row)` 按 `title → displayTitle → label → sessionTitle` 次序取非空标题；无标题回退 `shortId`（去 `session-` 前缀取前 8 位）+ `formatActivityTime`（`lastActivityAt → updatedAt → lastPromptAt → createdAt`）。绝不显示裸长 uuid / undefined / NaN。`liveIds()` 升级为 `liveRows()` 保留完整 row（兼容旧名）。
- **UI 重构**：
  - `<select>` → `ActiveSessionList`：搜索框（`type=search`）按标题/ID 实时过滤（`filterLiveRows`，大小写不敏感）、每行 `[复选框] + [标题/短ID] + [最后活跃时间]`、全选当前筛选集、批量「移入回收站」按钮（`trashMany`）。
  - 区块划分：上半区「当前会话」（带搜索、多选），下半区「回收站」（保留原功能、优化样式）；批量恢复/彻底删除/全选按钮与列表分排，不再挤作一团。
  - 视觉对齐 DSH 原生设置页：内联 CSS（`ytr-*` 类）全部走 `--dsw-alias-*` token + fallback（照抄现成包 `archive.module.css` 的生产做法），含 `:focus-visible` 与 `prefers-reduced-motion`；style 标签按 `data-plugin-css` tagId 防重注入 `document.head`。
  - 既有契约全部保留：REASON_MAP（粒度 + 未知 reason 兜底）、read-error 家族整族保留提示、确认框级联预览 N（fork 剪掉、共享去重）、双入口过渡标注、原生事件订阅、`_refreshHostSessions`、`__testing`（Node-only，新增导出 displayTitle/shortId/formatActivityTime/filterLiveRows）。
- **测试**：新增 4 个行为测试（displayTitle 多级回退、`shortId`/`formatActivityTime`、`filterLiveRows` 搜索过滤、CSS 注入 + 列表/搜索/多选结构 + 核心逻辑未破坏契约）；根包 `npm test` **191/191 全绿**（187+4，零回归）；client `node --check` OK。
- **状态**：待重装 + 重启后真机复验新 UI（搜索/多选/标题显示/视觉），物理删除链路未改故 A2/A3/A4 逻辑不受影响。

### 真机 bug 修复：拼接帧 zstd 解压（A2 标题子项重启后仍裸 id，m03899）

- **触发**：真机 A2 标题子项在上一轮"修复 3"（readSessionTitle）后仍显示裸 id。重启宿主、重装新包后复验依然失败，排除了 renderer 缓存/旧 client bundle 假设。node 层完整复现 `service.list()` → `readSessionTitle()` 却能正确返回标题，矛盾收窄到**宿主运行时解压返回 null**。
- **根因（铁证）**：会话日志 `session.v4.jsonl.zstd` 不是单个 zstd 帧，而是**拼接帧容器**（concatenated-frame，DSH `dsh-session-persistence-jsonl/src/zstd.ts:4-6` 明确）——每追加一批事件写独立帧。实测测试会话日志 33261 B 含 **9 个帧**，标题 `空白会话 用于真机实测` 在末尾帧（line23）。旧 `defaultDecompress` 用**整文件一次性** `zstdDecompressSync(buf)`：shell Node 26 能解全部 24 行，但宿主 Electron 内置 Node 版本较老，一次性多帧解压只拿到首帧或报错 → 末尾标题读不到 → null → 裸 id。header 在第 1 帧故 A6 快照读 header 正常，A2 删除/A3 恢复不读日志故通过，只有标题（需末帧）失败——与观察完全一致。
- **修复（拒绝重复造轮子，移植 DSH 生产实现）**：`lib/session-snapshot.js` 新增 `scanZstdFrames()`，逐字节移植 DSH 已生产验证的 `scanZstdFrames`（zstd.ts），扫帧边界不解压；`defaultDecompress()` 改为**逐帧解压后拼接**——对每帧 `zstdDecompressSync(buf.subarray(start,end))` 再 `Buffer.concat`，与 DSH `PublicZstdFrameDecoder`（public-decoder.ts:25）同构。单帧文件行为不变；截断残帧忽略（已完整帧数据可用）；逐帧累计字节仍受 8 MiB 上限保护。DSH 自己用 `zstdDecompressSync` 逐帧解码，证明宿主 Node 支持单帧解压，问题只在多帧一次性行为差异——本修复正好规避。
- **影响面**：不仅标题，`scanTrashDisk` 的 header 读取也走 `defaultDecompress`，逐帧修复后 4a 快照/A6 级联预览在真机也一并受益（此前多帧文件可能只读首帧 header，恰好 header 在首帧故未暴露）。
- **测试**：新增 3 例（scanZstdFrames 识别 3 帧边界、末帧标题可读的端到端回归、逐帧累计超上限拒绝），session-snapshot 单测 37/37、根包 `npm test` **187/187 全绿**（184+3，零回归）。
- **状态**：待重装 + 重启后真机复验 A2 标题子项（应显示标题非裸 id）；本 bug 修复不改 host 路由/client 契约。

### 真机 bug 修复：A3 恢复幽灵会话 + 回收站标题（m03612/m03616）

- **触发**：真机 A3 恢复会话后，侧栏出现「未命名 / NaN」会话行、无法点进、id 变成 `undefined`、报错 `session-undefined — not found by locate()`；新建会话删除恢复同样复现。用户已叫停后续操作。文件层对账确认**数据安全**：会话已完整回到 sessions 原位、trash 与 manifest 均清空，问题是纯 UI 呈现层。
- **根因（铁证，非推断）**：宿主原生 `api-session/added` 的 payload 是 `summaryFor(session)` 对象（`dsh-api-session-controller/lib/index.js:3923/3929`，结构 `{sessionId, title, running, updatedAt, ...}`，字段是 `sessionId` 而非 `id`，见 :2824-2839）。我的 `lib/session-trash-service.js` 此前 `emitAdded=(id)=>emit(ADDED_EVENT, id)` 发的是**字符串 id**；宿主侧栏监听器按对象取 `.title`/`.sessionId` 全得 undefined → 造出「未命名/NaN/id=undefined」幽灵行 → 点击报 `session-undefined not found by locate()`。删除侧 `removed` 发字符串 id 与宿主 `session/disposed`（:3927）schema 匹配，故只有恢复坏。**第 4 阶段核实④只核实了 removed payload、漏了 added，才埋下此雷**。
- **修复 1（停发伪造事件）**：`emitAdded` 恒为 `null`（`session-trash.js` 的 `emitAdded?.()` 成为 no-op），绝不再伪造宿主领域事件。现成包 `@linxin666` 恢复会话同样不 emit added。
- **修复 2（照抄现成包刷新姿势）**：Client `_run` 成功后调 `_refreshHostSessions()` → `sessions.refresh()`（现成包 client.js:541-542），让宿主自行扫描磁盘重新发现会话，异常 fire-and-forget 不影响本插件 UI。
- **修复 3（标题来源）**：回收站列表此前显示裸 id——manifest 无 title、projcache 是过期旧值，唯一可靠来源是会话日志里的 `session/title` 事件（末条最新，日志压缩态 zstd 可读）。新增 `lib/session-snapshot.js:readSessionTitle()`（复用 defaultDecompress 的 8 MiB 上限，异常回退 null）；`TrashService.list()` 逐条补 `entry.title`；Client `row()` 显示 `title||id`（有标题显示标题 + 小字 id，无标题回退 id，绝不显示 undefined/NaN）。
- **测试**：新增 5 例（emitAdded 恒 null、client 调 sessions.refresh、readSessionTitle 取末条/无标题回退/损坏回退、service.list 补 title），根包 `npm test` **184/184 全绿**（179+5，零回归）。
- **状态**：待用户用新包重装 + 重启宿主后重测 A2 标题子项 / A3 恢复 / A4，回填 VERIFICATION.md。

### 真机 bug 修复：runningOf 误判空闲会话为 running（m03443）

- **触发**：真机 A2 在 ~0020 路径 bug 修复后仍删除失败，报错 `session session-21ccdd5d-... is still running; refusing to move`。磁盘对账实锤 move **从未发生**（manifest 始终 `entries:{}`、mtime 固定、会话目录 mtime 未动）。截图显示目标会话是「Numeric Input / 26分钟前 / 空闲」，用户明确纠正「不是当前会话，是空闲会话」。
- **根因**：`lib/session-trash-service.js` 的 `runningOf(id)` 旧实现 `return isLive(id)`，把「在 `sessions.list()` 中存在」（attached）当成「running」。空闲会话仍 attached，于是被 `session-trash.js:447` 的 `isSessionActive` 预检判为 running 而拒绝 move。现成包 `@linxin666/dsh-session-archive` 权威语义（janitor.d.ts:121-122 注释 "running (feed flag) ... travel on their own"、lib/index.js:2108 `row.running`）明确 **running 独立于 attached**：`liveSessionIds()` 只标 attached，`running` 来自 feed flag / `agents.get(id).status === 'running'`。
- **修复**：`runningOf(id)` 改用宿主 `agents` 服务（cordis_inspect_list 实测 `get(id: SessionId): Agent | undefined`）——`agents.get(id)?.status === 'running'`（兼容 session- 前缀两种形态）；能力缺失返回 false（不误伤删除），读态异常仍 throw（fail-safe）。`isLive`/`protectedReasonOf` 的 attached 语义保持不变。
- **收窄判断**：另两处曾怀疑的 client 缺陷经读代码后**不改**——「残留红色旧报错」非独立 bug（`_run` 成功时 set last 覆盖，报错持续是因每次 move 都失败）；「回收站列表显示 session-xxx」实为报错文本里的 id（回收站 `共 0 项` 无列表行），LiveSessionPicker 显示 id 属体验小瑕疵，记为记录项不在本轮扩大真机验证面。
- **测试**：`test/session-trash-host.test.mjs` 读态异常断言目标改为 agents.get；新增 3 用例（空闲会话 attached 但 idle 不算 running、真 running 才算、agents 缺失返回 false 不抛）。host 27/27、根包 `npm test` **179/179 全绿**（176 + 3，零回归）。
- **打包**：`npm pack` 59 文件、test 0、临时产物 0，已核验 tgz 内含修复后的 `agents.get(id)`。当前 shasum `d8db549c...`（中间值，发布以最终 pack 为准）。
- **状态**：待用户用新包重装 + 重启宿主后重测 A2→A3→A4；4b 仍「代码交付完成、待真机验证收口」。

### 真机 bug 修复：放宽 DSH 编码 project key 的命名校验（m03171）

- **触发**：真机验证 A2（删除会话）报错——`assertSafeTarget` 抛 `illegal project name`。根因：`lib/session-trash.js` 的 `SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/` 只允许字母数字/下划线/连字符，而 DSH 的 Windows project key 是 URL 编码形式 `--F-DeepSeek~0020Harness~0020workspace-default-workspace--`（含 `~`、以 `-` 开头、含编码空格），被 `isValidSessionSegment(project)` 误拒。
- **修复**：`SEGMENT_RE` 放宽为 `/^[^/\\\0]{1,200}$/`——只拒绝路径分隔符 `/`、`\` 与空字节、保留 200 长度上限；`isValidSessionSegment` 额外显式拒绝 `.`/`..` 及含 `..` 子串。`~`、URL 编码、空格、前导 `-` 等一律放行。放宽**不影响纵深防御**：真正的防目录穿越由 `isTwoLevelUnder` + `lstat` 非符号链接 + `realpath` 后 `isInside` 容器校验保证，不依赖命名正则。`session-snapshot.js:161/:174` 复用同一校验函数，快照扫描同样能正确识别编码目录。
- **调用面**：`isValidSessionSegment` 的 7 处调用（trash 的 :88/:203/:206/:367/:368/:404/:405/:651 + snapshot 的 :161/:174）统一受益，无需逐处改。
- **测试**：`test/session-trash.test.mjs` 放行空格/`~0020`/前导 `-`/`%20` 断言；bad 列表空格项改 `bad..id`；`assertSafeTarget`/rebuild 隔离测试改用 `bad..seg`/`bad..proj` 触发校验；新增「真机 bug m03171：DSH Windows 编码 project key（含 ~0020）可 move→restore 往返」用例。根包 `npm test` **176/176 全绿**（175 + 1 新增，零回归）。
- **打包**：`npm pack` 59 文件（6 会话模块 + 子包 9 文件齐全），test 0、临时产物 0；已核验 tgz 内 `SEGMENT_RE` 为放宽后版本。当前 shasum `62907a40...`（中间值，发布以最终 pack 为准）。
- **状态**：真机验证待用户用新包重装后继续（A2 起）；4b 仍为「代码交付完成、待真机验证收口」。

### 路径 A 第 4b 阶段：UI 入口接回（独立子包 React client + Host 路由）

- **范围与形态**：第 4b 阶段把前四阶段的纯函数底座（trash/purge/cascade/snapshot）真正接回用户可操作的界面。按用户拍板「扩成完整 4b（React client + host 路由）」+「新建独立子包」，新建 `packages/dsh-plugin-yanyan-trash`——**不动**现有聚合包 client.js/lib/index.js 的 health/components 路由（那些被 `integration.test.mjs` / `component-versions.test.mjs` 硬断言锁定），也**不改** `@linxin666/dsh-session-archive`（并行策略）。
- **Host 服务层** `lib/session-trash-service.js`：`TrashService` 汇总 ctx 能力（archiveSession/unarchiveSession/emit/agents/sessions）为统一 deps，方法 list/restore/trash/purge/purgeExpired/recoverPurging/snapshot/cascadePurge。`capabilitiesFromContext` 能力缺失返回 null、读态异常 throw（fail-safe，延续第 4a 阶段 read-error 保护纪律）。cascadeDeps 透传链逐行核实：显式提供 `cascadeDeps.purgeDeps`（含 fs/trashRoot/emitPurged），否则级联物理删除会拿到空 deps。
- **Host 路由层** `lib/session-trash-routes.js`：8 条 exact 路由（list/snapshot 为 GET，restore/trash/purge/cascade/purge-expired/recover 为 POST），前缀 `/api/dsh-yanyan-trash`；复用 `ctx.connection.requestRejection` 做同源准入（403），method 校验（405）、body 解析（400 坏 JSON / 413 超限 1MB）、`cache-control: no-store`；service 结果（ok/primaryOk/descendantsOk/reason 码）原样序列化，供 UI 影响范围提示。
- **React client** `packages/dsh-plugin-yanyan-trash/lib/client.js`：手写预编译 IIFE（无构建工具），react 由 `require("react")` 运行时注入（与现成包同一 ModuleLoader 机制）。`ctx.slots.register('settings.section', ...)` 用独立 id `dsh-yanyan-trash` + order 26（避现成包 id `dsh-session-archive`/order 25 防重）。list 表格 + 恢复/移入回收站/彻底删除/批量按钮；REASON_MAP 每条含 `{zh,en,scope}`，scope ∈ item/family/batch——`corrupt-target` 单条目拒绝、`read-error`/`family-protected` 整族保留、`child-ids-dangling`/`invalid-origin` 结构性整批拒绝；ResultPanel 对 read-error 额外显示「父会话连同其子代理一并保留」；双入口过渡标注「此操作不进入回收站，不可恢复」；订阅原生事件 `api-session/removed/added/purged`，payload 已是 canonical id 字符串直接消费、不再自行归一。
- **配置集成**：根 `cordis.patch.yml` 加第 6 行 loader（id/name=`dsh-plugin-yanyan-trash`）；根 `package.json` dependencies 加子包、files 加 `lib/session-trash-service.js`/`lib/session-trash-routes.js`（否则子包运行时 import 找不到）；`lib/index.js` SUBPACKAGES 加子包。三个既有测试的「5→6」断言已同步。
- **测试**：新增 `test/session-trash-host.test.mjs`（19 个契约测试：常量/工厂、能力探测 fail-safe、TrashService.list/baseDeps/cascadePurge、createTrashService、路由 403/405/400/413/reason 透传/8 条方法、子包 host import、client 源码契约 reason scope/双入口标注/事件订阅/不自行归一、静态守护）。根包 `npm test` **169/169 全绿**（第 1~4a 阶段 150 + 4b 19，零回归）。
- **状态与承接**：并行期旧入口仍可绕过回收站（已用 UI 标注缓解，待后续单独评估替换）；临时产物 `.tmp-asar-*.cjs`/`.tmp-dsh-src/` 仍保留到验证结束；版本复用 1.4.2。

### 4b 收口评审核实（deepseek-chat 闭环，逐条实测）

- **P0-1 子包加载机制（成立，链路完整）**：走「主包 `cordis.patch.yml` 第 6 行直接注册 name」路径，非 ModuleLoader 扫描 packages/*。子包 `package.json` 声明完整（`dsh.client`{platform:web,inject}、`dsh.bundle.patch`、`exports['./client']`、`dsh.engines`），9 文件全在 tgz 内。【关键实测】解包 tgz 后，子包 host 从 `packages/<name>/lib/` 反向 `../../../lib/` import 聚合包 `session-trash-service.js`/`session-trash-routes.js` 解析正确，`TGZ_HOST_LOAD_OK`。inject 短名疑点不成立：对比 toolkit 已工作子包 update=`["locale"]`/subagent=`["locale","sessions","slots"]`/icon=`[]` 全用短名（工厂用 apply(ctx) 取服务、只 require("react")），本子包 `["slots","locale","connection"]` 与 subagent 同构，短名是自家约定。DSH `dsh-client-modules/README` 确认 client-modules 扫描全部 Loader entries、按 entry name 解析 `dsh.client`+`./client` 导出，新包需重启 Loader 条目或 Host 才被扫描（部署注意）。
- **P0-2 真机验证（agent 无法完成，诚实标注）**：当前 runtime 跑已安装旧 bundle（1.4.1），agent 无法操作浏览器 UI 做端到端「删→回收站列出→恢复→侧栏重显→再删→彻底删→无幽灵行 / 订阅刷新 / 双入口标注可见 / 级联预览」。**4b 状态为「代码交付完成、待真机验证收口」，非「功能已验证」**。`cordis_inspect_query` 的 client Slots 子树查询因工具 bridge 输入校验问题（带/不带 input 均失败）不可用。
- **P1-1 requestRejection 真实性（成立）**：`cordis_inspect_query(host, Service, listService)` 实测宿主 connection 服务方法清单含 `requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection`。API 真实存在。（bridge 无法传 input，故未做非同源 403 的 inspect 实测，留真机清单。）
- **P1-2 order/id 防重（确认）**：现成包 SECTION_ID=`dsh-session-archive`、order 25；本子包用独立 id `dsh-yanyan-trash`、order 26。防重靠 id 唯一；order 仅排序，与现成包相邻不影响功能（归档/回收站语义不同）。
- **P1-3 reason 码对齐（成立，无改）**：核实 `session-cascade.js` 实际返回 reason 集合 = `not-found`/`family-protected`（整族跳过）/`invalid-origin`/`child-ids-dangling` + 直接受保护成员的自身 reason（可为 `read-error`）；client REASON_MAP 全部覆盖，`familyKept` 判定 `reason==="read-error"||"family-protected"`，整族保留提示可正常显示。`family-protected` 是第 3 阶段 cascade 已有码，非 4b 新造。
- **P1-4 级联删除预览（本轮已修）**：原行删除/批量彻底删除直接执行、无确认，存在数据丢失体验风险。本轮新增 `countCascadeDescendants(rows,rootId)`——与 cascade.descendantsOf 同构，只沿 `origin==="subagent"` 的 childIds 边遍历、fork 剪掉，确保预览 N 与实际删除范围一致；快照来自已加载的 `ui.snapshot.rows`。级联删除与批量彻底删除改为 `setPending(...)` 弹确认对话框（`data-dsh-part="confirm"`），文案「将彻底删除父会话及其 {n} 个子代理（不可恢复）」；快照不可用时走兜底文案「子代理数量未知」。单条彻底删除因范围单一保持直接执行。
- **P1-5 client 测试深度（记录）**：`test/session-trash-host.test.mjs` 的 client 契约是文本 grep + 静态守护（检查独立 id/order、REASON_MAP scope、双入口标注、事件订阅、级联预览结构、不自行归一 id），非行为测试（无 mock ctx.slots 断言 register 调用/订阅回调重渲染）。**client 行为未做自动化测试，收口依赖真机用例清单**。
- **P2 三条**：①子包 version=1.0.0、主包 1.4.2，经根 `package.json` `file:./packages/dsh-plugin-yanyan-trash` **随主包发布、无独立 npm 版本线**。②空状态文案已加「通过其他入口删除的会话不会出现在此处」（zh/en 双语）。③**验证结束后清理临时产物 `.tmp-asar-*.cjs`/`.tmp-dsh-src/`** 列为收口动作。
- **本轮加固结果**：client 语法 `node --check` 通过；新增 2 个契约断言（级联预览结构 + fork 剪掉、空状态文案）；根包 `npm test` **171/171 全绿**（第 1~4a 阶段 150 + 4b 21，零回归）。

### 4b 收口前最终确认（deepseek-chat 闭环 m02773，三处确认/小修）

- **P1-a cordis.patch.yml 测试覆盖（盲区不存在，补显式断言）**：核实 `test/toolkit.test.mjs`（`patchRows()` 直接读根 `cordis.patch.yml`）与 `test/integration.test.mjs:61-63` **直接读 patch 文件**并硬断言 6 行 name、6 个 dependencies、自写子包 name 与各自 package.json 一致——评审担心的「测试读运行时 health 输出、覆盖不到 patch 文件」不成立。补显式断言：`patch 行数 === dependencies 数 + 1（自身行）`、`dsh-plugin-yanyan-trash` loader 行的 name === 子包 package.json.name。根 `cordis.patch.yml`（含第 6 行）实测在 59 文件 tgz 内。
- **P1-b 级联预览等价性锁死 + 修批量去重 bug**：client 是浏览器 IIFE，**不能 import host 的 `descendantsOf`**（模块方向隔离），故走「独立实现 + 等价测试」。把计数函数拆为 `collectCascadeDescendants(rows,rootId)`（返回后代 id 数组，只沿 `origin==="subagent"`、fork/未知剪掉、seen 去重、容忍环）+ `countCascadeDescendants`(取 .length)；通过 `__testing` 钩子（浏览器运行时不消费）在 Node vm 沙箱执行 client factory，新增等价测试：同组 rows 含 subagent/fork/嵌套/环/共享子代理/未知 origin，断言 `collectCascadeDescendants` 与 host `descendantsOf` 结果集合逐一相等。**另修真实 bug**：批量预览 N 原为各父逐个求和，数据异常时两父共享子代理会高估 N；改为后代 id 并集去重（与 cascade planDelete 的 `targets` Set 一致），新增去重测试。
- **P1-c REASON_MAP 兜底（增强）**：`reasonText` 原本已回退显示原始 reason 字符串（非空白/undefined），本轮增强为通用文案 `trash.reasonUnknown`（zh/en 双语，保留 `{r}` 原始代码便于诊断，scope='item'），与第 3 阶段 `?? Infinity` fail-safe 纪律一致。新增原因码未映射的回退测试。**维护约定：cascade 新增 reason 码时需同步更新 client REASON_MAP**（否则走兜底文案，不崩但不精确）。
- **P2 三条落实**：①反向 import 隐含约束（子包 host `../../../lib/` 依赖聚合包目录结构，**不可独立发布/安装**）与②**安装后需重启 DSH 宿主**（新 Loader 条目启动时扫描，仅刷新页面不生效）——均已写入子包 `README.md`/`README.zh.md`「安装与部署」段。③**哈希不写死**：本轮 integrity 为中间值，真机验证后若再改 CHANGELOG 哈希会变；发布时以最后一次 `npm pack` 的 integrity 为准，CHANGELOG 不固化哈希。
- **client 测试深度重申**：等价测试/兜底测试通过 vm 执行真实 factory 纯函数（非 grep），但 slots 注册/订阅回调重渲染/按钮点击等 DOM 行为仍属文本契约 + 静态守护，**未做行为自动化测试，收口依赖真机清单**。
- **本轮结果**：`test/session-trash-host.test.mjs` 24/24、`test/toolkit.test.mjs` 5/5；根包全量见下方交付摘要。`__testing` 导出仅为测试钩子，现已加 `typeof process !== 'undefined'` 守卫，浏览器运行时不携带。

### 4b 收口前最终确认（deepseek-chat 闭环 m02912）

四处确认 + 两条记录，逐条读代码/实测核实：

- **P1-1 vm 沙箱执行的是同一份 factory 导出（成立，非复制品）**：`__testing` 挂在 client factory 的 `module.exports` 上（`packages/dsh-plugin-yanyan-trash/lib/client.js:513`），测试 `loadClientTesting()` 在 Node vm 沙箱里执行**真实的 client factory**（`entry.factory(require)`，`test/session-trash-host.test.mjs:337-341`），从返回的 module 上取 `__testing.collectCascadeDescendants`——是评审列举的「第一种：同一份 factory 导出」，等价测试锁住的是真实实现，不是测试文件里的粘贴副本。另按评审建议加暴露范围守卫：`exports.__testing` 仅在 `typeof process !== 'undefined'` 时赋值，浏览器运行时不携带此内部钩子；测试沙箱注入 `process: {}` 以拿到同一份导出。
- **P1-2 等价测试集合相等足够（降为记录）**：级联预览的确认文案只展示 `{n}` 数量（`trash.confirmCascade` / `confirmCascadeNone` 仅含 `{n}`），不列出子代理标题，故 `collectCascadeDescendants` 与 host `descendantsOf` 集合相等即满足展示需求，无需顺序锁定或字典序排序。
- **P1-3 预览到执行的时序语义（补记）**：确认框的 N 是**点击删除时基于当时快照的估算值**；用户点确认后 cascade 重新构建快照执行，实际删除范围**以执行时快照为准**。窗口期内其他客户端的删除、子代理状态变 running/受保护、新建子代理都可能使实际结果与预览不一致；此时 cascade 的 `ok/message` 如实反映实际结果，UI 原样透传，不承诺「说删 N 个就删 N 个」。
- **P1-4 cordis.patch.yml 口径精确化（文档措辞，非代码问题）**：精确结构是 **6 个 loader 条目（1 行自身声明 + 5 行插件依赖边）、5 个 npm dependencies**（`update/subagent/icon/trash/@linxin666`）。`test/toolkit.test.mjs` 断言 `rows.length === Object.keys(deps).length + 1`（6 === 5 + 1）正确；此前交付总结里「6 个 dependencies」为口误，以本节口径为准。术语统一为「loader 条目数（6）」与「patch 依赖边数（5）」。
- **P2-2 真机清单补一条**：新增「重启宿主后，回收站条目仍在」——验证中心 manifest 在进程重启后持久化有效（第 1 阶段中心 manifest 原子写的最终验收，内存 fs 用例覆盖不到真机文件系统写路径）。真机清单其余项不变。
- **P2-1 integrity 哈希不写死（记录确认）**：本轮 sha512-RUupqyw... 为中间值，真机验证后若补记结果、CHANGELOG 再变则哈希随之变；发布时以最后一次 `npm pack` 的 integrity 与 cordis.patch.yml 内容为准，不在 CHANGELOG 固化哈希。

### 4b 真机验证验收清单（收口条件，deepseek-chat 闭环 m02964）

唯一阻断项是真机端到端验证，其可执行性与完备性即收口的实质条件。把原「动作列表」升级为「动作 + 判定标准」，并补三个 fail-closed 场景（成功路径测不到，却是路径 A 前四阶段专门守住的语义）。执行记录形式：**逐项打勾 + 失败项截图/控制台日志 + 通过的 integrity 哈希**，回填本节形成「代码交付 + 真机验证」双签收口记录。

**A. 成功路径（动作 + 通过标准）**

| 动作 | 通过标准 |
|---|---|
| 设置页区块可见 | 标题文字正确；位置 order 26 在现成包 25 之后；无重复 id 冲突（id=`dsh-yanyan-trash`） |
| 删 → 回收站列出 | 条目显示会话**标题**而非裸 id；删除时间正确 |
| 恢复 → 侧栏重显 | 恢复后侧栏出现的是原标题、不是 `session-xxx`；点开能读到历史消息 |
| 彻底删 → 无幽灵行 | 侧栏、搜索结果、最近列表**三处**都无残留 |
| 订阅刷新 | 两个浏览器标签页，A 删 → B 的回收站**无需刷新**即出现条目（原生 `api-session/removed/added` 订阅生效） |
| 级联预览 | 确认框 N 与实际进回收站的子代理数一致（在回收站计数验证）；fork 不计入 N |
| 重启宿主后条目仍在 | 重启 DSH → 回收站条目、标题、删除时间均保留（验证中心 manifest 进程重启持久化，第 1 阶段原子写的最终验收，内存 fs 覆盖不到） |

**B. fail-closed 场景（成功路径测不到，必须单独确认）**

1. **级联删除后子代理的呈现与恢复语义（缺口定性：情况 A，数据不丢）**：核实代码层 `service.restore(id)` 为**单条独立恢复**、批量恢复是 `Promise.all` 逐条调用，**没有「恢复父会话自动带子代理」的级联语义**（删除侧整族、恢复侧未做对称）。**缺口定性核实（m02987 P1-1，通读 `restoreFromTrash` 542–680 行）**：该函数只校验「源在 trash + 原 project 目录存在 + 目标路径四层安全」，**完全不检查 `parentSession` 父是否存在**——所以子代理可独立恢复（情况 A，体验问题），不是"父恢复后子无法单独恢复"（情况 B，数据问题）。`buildRows` 中父恢复后子代理成为树孤儿（`parentId` 指向快照外、不进任何 `childIds`），但 `origin='subagent'` 合法、不触发 invalid-origin，能正常恢复。**已知限制措辞定为**：「恢复侧无级联，父恢复后子代理仍留回收站，需手动逐条恢复子代理」；真机确认：(a) 父 + N 子删除后各占一行还是折叠；(b) 先恢复父、再逐条恢复子代理，侧栏层级是否正常。**不静默改动 4b 范围**。后续评估方向记入 C 节。
2. **受保护/运行中会话的 fail-closed 提示（判定标准已按代码能力降级）**：用旧入口启动一个正在跑的会话，用新入口删它 → cascade 返回 `read-error` / `family-protected` → UI 是否显示**「会话受保护被保留」+ 通用整族保留提示**，而非「删除成功」或空白。**不能要求显示精确「连同 N 个子代理」**：核实 `planDelete`（`session-cascade.js:145-161`）——父本身受保护时只 push 父一条 skipped（reason=read-error，`continue` 家族不动），子代理完全不进结果；后代受保护时整族进 skipped（可数 N）。client 的 `familyNote`（`client.js:348-349`）是通用文案、不含 N。故本场景通过标准降为「父被保留提示可见 + 无成功/空白」，精确 N 属后续增强（若不降级，判定标准将高于代码实际展示能力）。这是第 3 阶段 `ok=false` + message 纪律的 UI 验收。
3. **双入口并行冲突**：通过旧 `@linxin666` 入口删一个会话 → 新回收站**不应**出现该条目（它没进新 manifest）；此时新回收站空状态应渲染「通过其他入口删除的会话不会出现在此处」文案。用户可能误以为回收站坏了，这条文案是否真正渲染只有真机能确认。
4. **恢复侧树断裂可逆（往返场景，m03025 P2 新增）**：恢复父 → 确认侧栏显示父、子代理仍在回收站 → 再次删除父 → 确认父重新进回收站、子代理仍在 → 在回收站里对父执行彻底删除 → 确认子代理被正确级联（与首次删除一致）。通过说明「恢复侧无级联」造成的树断裂可逆（`buildRows` 重新扫描到父子同处 trash 时重建 childIds），不造成永久性树关系损坏；不通过则说明 `buildRows` 对「曾为孤儿」状态处理有偏差，需修复。

**C. 记录项**

- **P3 __testing 守卫 polyfill 风险（不阻塞收口）**：`typeof process !== 'undefined'` 在注入 process polyfill 的打包环境（Webpack/Vite 某些配置）下浏览器端也可能成立，导致 `__testing` 暴露到 window。当前 ModuleLoader 的 IIFE 环境大概率无 polyfill、风险低；更精确的守卫是 `typeof process !== 'undefined' && process.versions?.node`（只认真正 Node 运行时）。记 P3，本轮不改。
- **P2 恢复侧无级联的后续评估方向**：记为两个候选方向而非空泛「后续单独评估」——(a) 恢复父会话时自动恢复其 `origin: subagent` 后代（与删除侧家族整族对称，语义一致但改动大，需改 restore 契约+测试）；(b) UI 在恢复父会话时提示「有 N 个子代理仍在回收站，是否一并恢复」（改动小、用户二次操作，可复用 4b 已有 snapshot 计数）。当前两者均未实现，属后续评估。
- **验证执行方式（m02987 P1-3 定案）**：记录格式=逐项 `[通过]`/`[失败]` + 实测值 + 失败项截图/控制台日志，末尾附通过的 integrity 哈希；**回填位置=独立 `VERIFICATION.md`**（新建于仓库根），不写进 CHANGELOG——验证记录随每次发布更新，混在 CHANGELOG 会稀释发布历史可读性。验收清单本体仍保留在 CHANGELOG 本节作为"待办定义"，`VERIFICATION.md` 作为"执行结果记录"，两者分离。
- **失败项处置（预定义，防绕过）**：任一 A 成功路径项或 B fail-closed 项判 `[失败]` → 4b **退回修改、不收口**；除非该项被明确标注为「已知限制」并写进 C 节（当前仅「恢复侧无级联」为已知限制），否则不得以「再测一次」绕过。收口条件=A/B 全部 `[通过]` 或已标注的已知限制，`VERIFICATION.md` 回填完成。
- **状态诚实不变**：4b「代码交付完成、待真机验证收口」；`VERIFICATION.md` 全部通过并回填后，4b 正式收口、路径 A 全部落地。

### 路径 A 交付摘要（四阶段收束）

路径 A 自 m00039 方案起，分四阶段把会话管理从复用 `@linxin666/dsh-session-archive` 扩建为自建回收站体系，全程并行、不改现成包：

- **第 1 阶段**（可逆回收站）：`lib/session-trash.js`——归档闸门 + `fs.rename` 搬入 `$DSH_HOME/session-trash` + manifest 可逆记录，四层路径校验 / 原子写 + withManifestLock / 双向对账 / quarantined 隔离。
- **第 2 阶段**（物理删除）：`lib/session-purge.js`——purge/purgeExpired/recoverPurging，显式 + 保留期扫描双入口共用 preflight + 整批 fail-closed，purging 三阶段锁边界 + Windows EBUSY/EPERM 重试 + 崩溃两分支恢复。
- **第 3 阶段**（子代理级联）：`lib/session-cascade.js`——移植已验证 planDelete 纯算法，整族 fail-closed、保护态分级、fork 剪枝、部分失败结果模型。
- **第 4a 阶段**（树快照）：`lib/session-snapshot.js`——从回收站目录 zstd header 构建 rows，manifest↔磁盘双向对照作独立完整性真相，三层校验 + 单条目 corrupt 隔离。
- **第 4b 阶段**（UI 接回）：`lib/session-trash-service.js` + `lib/session-trash-routes.js` + 独立子包 `packages/dsh-plugin-yanyan-trash`（React client）——设置页回收站区块 + 原生事件订阅 + reason 影响范围映射 + 级联预览 + 双入口过渡。
- **测试与产物**：根包测试从路径 A 前的 22 → 175（第 1~4a 150 + 4b 25），全程每阶段零回归；四阶段核心为四个自包含纯函数模块 + service/routes + 独立子包；1.4.2 尚未发布。收口动作：真机验证（待用户执行）+ 临时产物清理。
- **唯一已知限制 / 最后开放项**：**恢复侧无级联**（删除侧家族整族 fail-closed，恢复侧按单条 id 独立恢复）。前四阶段的 fail-closed 三态门（restoring/purging/quarantined）、树快照完整性、路径 1.1 命门均已闭环，这是路径 A 唯一保留的开放项。定性为情况 A（子代理可独立恢复、数据不丢，体验问题而非数据问题），措辞与后续评估方向见下方真机清单 C 节。

### 情况 A 护栏锁定（deepseek-chat 闭环 m03025）

把「恢复侧无级联」从口头记录变成代码契约，防未来「安全加固」把情况 A 静默收紧成情况 B：

- **注释护栏**：`lib/session-trash.js` 目标校验处写明「故意不检查 parentSession 父存在」——子代理在父未恢复时可独立恢复（情况 A）；加「恢复前确认父存在」会静默变成情况 B 且不触发任何现有测试。并指向测试与 CHANGELOG 已知限制条。
- **测试护栏**：`test/session-trash.test.mjs` 新增「父已恢复、子代理仍可独立恢复」用例——构造父先恢复离开 trash、子代理仍在 trash（其 parentSession 指向已不在 trash 的父），断言子代理 `restore` 成功、目录搬回、回收站清空。若未来加「父必须存在」校验，此用例立即失败。
- **familyNote 文案确认（P1-2，无需改）**：client 的 `familyNote` 取 read-error reason 文案（`client.js:123` zh「父会话处于受保护状态，连同其子代理一并保留，未删除任何会话」/ `:128`「整族保留，未删除任何会话」），是**明确说明连同子代理均未删除**的措辞，用户知情目标可达。故 fail-closed 场景 2 的通过标准精确化为「显示『父会话连同子代理一并保留、未删除任何会话』提示 + 无成功/空白」。
- **往返场景（P2，加入 B 节）**：恢复父 → 子代理仍在回收站 → 再次删除父 → 父与子重新同处 trash、`buildRows` 重建 childIds、树关系恢复 → 对父彻底删除能正确级联子代理。验证「恢复侧无级联」的树断裂可逆、不造成永久损坏（加入 B4）。
- **VERIFICATION.md 引用确认（P2）**：文件在仓库根、`git status` 为 untracked 但**未被 .gitignore 忽略**（随 1.4.2 tag 提交可追溯）；CHANGELOG:73 已引用「真机验证记录见仓库 VERIFICATION.md」；VERIFICATION.md 按 files 白名单**不进发布 tgz**（开发过程文档，发布包只含可运行代码）。

### 路径 A 第 1 阶段：可逆会话回收站管线

- **范围**：按用户「路径 A」方案只落地第 1 阶段——归档闸门 + 回收站移动，全程不碰 `rm` / `unlink` / `rmdir`（由 `test/session-trash.test.mjs` 静态断言守护）。第 2~4 阶段（物理删除、子代理级联 + 批量部分失败、接回 toolkit 设置页替换现有 `@linxin666/dsh-session-archive`）本轮明确不做，现有会话归档组件保持零改动。
- **新增模块**：`lib/session-trash.js`（纯函数 + 依赖注入，所有 fs/ctx/locate 从参数进入，便于离线单测）。核心能力：
  - `preflight` 整批 fail-closed 预检：任一 id 定位失败 / 路径不安全 / 归档闸门不可用 / 回收站目标被占用，整批拒绝、零移动。
  - `assertSafeTarget` 四层路径校验（借鉴现成包已生产验证算法）：恰好 `<sessionsRoot>/<project>/<segment>` 两层 → `lstat` 非符号链接且为目录 → `realpath` 落在会话根内（父目录逃逸也拦）→ 段名合法且规范化后等于目标 id。
  - `moveOneToTrash` 顺序：`archiveSession` 归档闸门（能力探测）→ 二次运行态复检 → 并发占用复检 → `fs.rename` 把目录搬进 `$DSH_HOME/session-trash/<project>/<segment>` → **立即广播** `api-session/removed` → 写 `manifest.json`。广播早于 manifest（见下方「评审加固」P0-1）。
  - `restoreFromTrash` 不信任 manifest 里的任何路径字段，按 id 在回收站重新 locate 并对「源/目标」双向重跑四层校验后 rename 回原路径；`unarchiveSession` 缺失降级为 partial 成功并广播恢复事件——这是第 1 阶段「可逆」的核心保证。
- **借鉴而非重造**：路径校验/id 规范化/归档闸门探测方式复用现成包 `@linxin666/dsh-session-archive@0.4.18` 已被生产验证的算法；本包的增量仅在「用 rename + manifest 实现可逆回收站」，以补上现成包 `removeSessionDir` 直接 `rmSync` 的不可逆缺口。现成包与 DSH checkout 中均无 `encodeSegment` / `api-session/added` API，故目标段安全采用「拒绝危险字符」显式校验、恢复事件用本模块自有约定，不臆造不存在的轮子。
- **评审加固（deepseek-chat 闭环评审 m00354 后逐条落实）**：
  - **P0-1 广播顺序**：由「写 manifest 后再广播」改为「rename 后立即广播、manifest 随后写」；manifest 写失败仅入补偿队列并标记 `manifestWriteFailed`，已广播的 UI 状态不说谎。新增 `drainCompensationQueue()` 与 `rebuildManifestFromTrash()`——回收站采用与会话树同构的两段 `<trashRoot>/<project>/<segment>` 布局，进程崩溃后可由目录名 100% 反推原路径重建 manifest。
  - **P0-2 restore 路径安全**：`restoreFromTrash` 完全忽略 manifest 的 `originalPath`，只信任 id + 回收站目录结构，源/目标都重新走校验；被篡改的 manifest 无法把目录 rename 到任意位置；原路径被占用则安全失败。
  - **P0-3 回收站目标 id 规范化**：新增 `safeTargetSegment(rawId)` 构造路径前拒绝空/非字符串/含 `/ \ ..` 空字节/非法段名，返回 canonical 段，与「不重造路径编码」一致（现成包无 encodeSegment 可借）。
  - **P0-4 静态守护精确化**：由子串 `includes('rm')`（会被 `rename` 误报）改为精确成员调用模式 `/\.(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/`，并正向确认 `rename` 存在。manifest 生命周期明确为「整文件覆盖写、不删文件」，故守护不误伤。
  - **P1-5 同卷探测**：`assertSameVolume` 取 sessions/trash 各自最近存在祖先的 `stat.dev` 比较，跨卷直接 EXDEV 拒绝，不 fallback 到 copy+delete（那会引入删除）。
  - **P1-6 unarchive 缺失降级**：缺 `unarchiveSession` 时目录照常恢复、返回 `partial:true` + 「需手动解档 archivedSessionIds」提示并广播恢复事件，避免「目录回来了但侧栏不显示」的假成功。
  - **P1-7 版本/打包一致性核实**：`package.json` 确为 `1.4.2`；tgz 45 文件含 `lib/session-trash.js`、不含任何 `test/`，命名与声明一致。
  - **P1-8 双入口冲突**：第 1 阶段未接回入口，旧 `@linxin666/dsh-session-archive` 删除按钮仍可绕过回收站直接 `rmSync`——回收站仅对新入口生效，第 4 阶段接回后关闭旧删除路径。
  - **P2**：`moveOneToTrash` 加 rename 前目标占用原子复检（并发）、`isSessionActive` 二次复检（新回合）、真机 fs 集成用例（临时目录 rename 往返 + realpath isInside）。子代理两处未提交改动与本模块无关、未打进本包。
- **测试**：新增 `test/session-trash.test.mjs`（26 个契约测试：原语边界、四层校验、同卷探测、能力探测、manifest、scanner、补偿重建、预检整批拒绝、管线顺序、广播/manifest、并发/复检、撤销与篡改防护、unarchive 降级、真机 fs、无删除原语静态守护）。根包 `npm test` **48/48 全绿**（原 22 + 新 26）。
- **第二轮评审加固（deepseek-chat 闭环评审 m00453 后逐条核实/修补）**：
  - **1.1 命门——回收站路径来源**：`trashTargetFor` 改为从 `locate()` 返回的**实际段名** `basename(dirPath)` 构造回收站目标，不再用 `safeTargetSegment(id)` 重算。`safeTargetSegment` 降级为纯防御性校验（只拒绝逃逸 id），不承担路径构造。理由：现成包 `canonicalSessionId` 注释明示 DSH 存在「带 `session-` 前缀 / 不带前缀」两种布局，用 canonical 重算会在无前缀布局下改写目录名、破坏反推可逆性。新增回归测试锁定两种布局。
  - **1.2 rebuild 隔离**：`rebuildManifestFromTrash` 对扫描到的 `project` 与 `segment` 双向校验（单层合法名 + `realpath` 仍在 trashRoot 内 + 反推目标恰好两层），不通过的进 `quarantined` 隔离清单，既不重建 manifest 也不允许 restore/purge。
  - **1.3 manifest 位置核实**：本实现 manifest 为 **trashRoot 级单一中心文件** `<trashRoot>/manifest.json`，restore 后留在 trashRoot、不进会话目录，删条目用整文件覆盖写无需 unlink——同时避开评审列举的「目录内异物」与「目录外需 unlink」两难。真机核实 DSH 会话目录仅含 `session.v4.jsonl.zstd`，即便未来放目录内也会被忽略。
  - **1.4 恢复事件与 partial**：核实 DSH/现成包公开代码**无** `api-session/added` 或任何 session 事件（grep 0 命中），事件名是本模块自有约定，第 4 阶段接回入口时对齐宿主。unarchive 缺失的 `partial` 补上结构化 `manualAction`（`kind/target/instruction`），避免「返回 partial 但 UI 不处理」的中间态。
  - **测试**：`test/session-trash.test.mjs` 增至 30 个契约测试，根包 `npm test` **52/52 全绿**。
- **第三轮评审加固（deepseek-chat 闭环评审 m00517 后逐条落实；评审宣布第 1 阶段收口通过）**：
  - **中心 manifest 原子写 + 并发串行锁**：`writeManifest` 由直接 `writeFile` 截断改为 **write temp（`<manifest>.tmp`）→ `fs.rename` 原子替换**，避免「写一半崩溃导致整个中心 manifest 丢失」。新增导出 `withManifestLock(task)`——进程内 Promise 串行队列，所有「读 manifest → 改 → 写」经此排队（pipeline 整段、restore 内部各一把），避免并发客户端后写覆盖先写；**第 2 阶段 purge 必须复用同一锁与原子写策略，不得另起写路径**。
  - **manifest 是缓存、目录是真相 + restore fallback**：`restoreFromTrash` 在 manifest 缺条目时自动调用 `rebuildManifestFromTrash` 从回收站目录两段结构重建后再恢复，不依赖启动时的一次性 rebuild。
  - **广播当前无监听者（明确记录，非改代码）**：实测 DSH 与现成包**不暴露/监听任何 session 事件**，`api-session/removed` 与恢复事件当前**无任何监听者、实际效果为零**。保留「广播早于 manifest」顺序纪律是为第 4 阶段接回入口时对齐宿主；第 4 阶段之前**不可**把广播当作「UI 已即时收行/刷新」的依据。remove 与 restore 两侧同样适用，已在模块头注释标注。
  - **restore 目标父目录缺失（保守拒绝）**：会话移入回收站后 `<sessionsRoot>/<project>` 可能被删（项目删除/工作区移除）导致 rename ENOENT。因「空 project 目录是否等同项目存在」由 workspace registry 决定、本模块不可见，采用 **fail-closed 保守拒绝**：返回结构化 `reason:'original-project-missing'` + `manualAction{kind:'restore-project-first'}` + 中文引导，不臆造 DSH 语义。
  - **restore 同卷探测**：`restoreFromTrash` 复用 `assertSameVolume`（trashRoot→sessionsRoot 也是跨卷 rename，卷挂载点可能在两次操作间变化），失败返回 `reason:'exdev'` 明确错误而非裸 EXDEV。
  - **测试**：`test/session-trash.test.mjs` 增至 **35** 个契约测试（新增原子写无 .tmp 残留、锁串行、restore fallback、跨卷 exdev、父目录缺失结构化错误）；根包 `npm test` **57/57 全绿**。
  - **第 2 阶段承接（未做，仅记录）**：purge 须独立文件 `lib/session-purge.js` 自声明允许 rm、复用本模块原子写/锁/`assertSafeTarget` 目标侧/整批 fail-closed/`restoring` 二次复检；`purging` 状态重试语义写进 manifest schema（重启扫描：purging 且目录存在→重试 purge；purging 且目录不存在→仅覆盖写移除条目），两种分支都要测试；真机 purge 用例 + 空 project 目录策略待第 2 阶段定。
- **版本叙述澄清（已联网核实，修正旧表述）**：首版与修订版 `package.json` 均为 `1.4.2`。**核实结论：1.4.2 从未发布到 npm**——registry `latest` 为 `1.4.1`（fileCount 44、gitHead `3d21b02`），本地与远端 tag 最新均 `v1.4.1`，无 `v1.4.2` tag / 提交（旧表述「为发布 subagent UI 增强已 bump 到 1.4.2」会误导为「1.4.2 已发布」，据此更正）。1.4.1 是上一已发布版本；1.4.2 是**尚未发布**的载体版本，承载 subagent UI 增强 + 路径 A 第 1 + 第 2 阶段，Unreleased 段记录尚未独立发布的路径 A 模块。复用 1.4.2 无同版本号内容变更风险。
- **状态**：本模块为独立自包含实现，尚未接入任何 host 路由或设置页 UI，不影响现有会话归档流程；接回入口属第 4 阶段，待后续授权。**本轮未做物理删除**：第 2 阶段应只对「已在回收站且有有效 manifest 或可 rebuild」的条目开放 `rm`，复用同一套 `assertSafeTarget` 与预检语义；purge 须独立文件（如 `lib/session-purge.js`，自声明允许 rm）、覆盖写 `purging` 状态后删、逐项正确码、真机 purge 用例与空 project 目录策略待第 2 阶段定。
- **收口附带记录项（用户 m00599 确认收口时提出，不阻塞，第 2 阶段承接）**：
  1. **锁的适用范围**：`withManifestLock` 是进程内 Promise 串行队列，只保证单进程串行；若 DSH 有多进程挂载 host（web 与 CLI 并行、插件被多宿主实例加载），跨进程「读-改-写」仍会互相覆盖。当前跨进程一致性依赖 `rebuildManifestFromTrash` 的目录真相兜底。第 2 阶段若确认单进程 host 可升级为「已验证无需跨进程锁」；否则 purge 前需引入文件锁（proper-lockfile 类）或明确接受「跨进程期间 manifest 可能 stale、以 rebuild 为准」。已写入模块头注释。
  2. **temp 名唯一化**：当前原子写用固定 `<manifest>.tmp`，正常路径有锁串行无碍，但崩溃残留 `.tmp` 或潜在多进程写会互相踩。第 2 阶段 purge 复用同一写路径时建议改为 `<manifest>.<pid>.<random>.tmp` 并在启动/首次写前清理残留；本轮按用户意向只记录、不改逻辑。
  3. **restore 已知限制（父目录在但项目已删）**：本模块只检查 `<sessionsRoot>/<project>` 父目录是否存在，无法感知「目录还在、但项目已从 workspace registry 移除」的中间态——此时 rename 会成功、会话恢复到「孤儿项目目录」，DSH 侧栏可能不显示。这是本模块不可见性所致，第 4 阶段接回入口时应通过 `workspaceRegistry` 二次校验或给出提示。
  4. **rebuild 全扫成本**：restore 缺条目时自动 rebuild 会全扫 `trashRoot`，条目多时为 O(n)。当前规模无碍；第 2 阶段 purge 也触发 rebuild 时可考虑「按 project/segment 直接定位子目录」的快速路径（P3，记录即可）。

### 路径 A 第 2 阶段：回收站物理删除（purge）管线

- **范围 / 风险边界**：新增独立模块 `lib/session-purge.js`（自声明允许 `rm`），复用第 1 阶段全部安全底座（`withManifestLock` / 原子写 `writeManifest` / `assertSafeTarget` / `readManifest` / `locateUnder` / `safeTargetSegment` 全部 import，绝不复制写路径）。不接回 UI（第 4 阶段），不改动 `@linxin666/dsh-session-archive`。风险边界（模块头第一段）：purge 只接受**已在回收站、manifest 状态有效**（非 `quarantined`、非 `restoring`、非未清 `purging` 崩溃残留）的条目；拒绝任意 sessionId 直接删会话目录（即「绕过回收站直删」），「直接彻底删除」是另一个功能、不在本轮范围。
- **三个决策点落实（用户 m00625 授权）**：
  1. **空 project 目录保留**：purge 只 `rm` `<trashRoot>/<project>/<segment>` 这一层，`<project>` 目录即使变空也保留——清理空目录是第二次 `rm`、会扩大攻击面，且空目录无害。已写入模块头注释防止「顺手优化」。真机测试断言删后 project 目录仍在。
  2. **两条触发路径共用一套校验**：`purge({sessionIds})` 显式 + `purgeExpired({now, retentionMs})` 保留期扫描，都先走同一 `preflightPurge` + `assertSafeTarget` 目标侧四层校验 + 整批 fail-closed，不因「自动」而跳过。保留期默认 **30 天**（`DEFAULT_RETENTION_MS = 30*24*60*60*1000`，保守，给恢复留足窗口），`purgeExpired` 从 `deps.retentionMs` 覆盖。无时间基准的条目 fail-safe 跳过，不误删。
  3. **purging 标记与 rm 的锁边界**：严格三段——阶段 1 在 `withManifestLock` 内二次校验状态非 `restoring` + locate 二次复检 + `assertSafeTarget` + 写 `{status:'purging',purgingAt}` + 原子写，**立即释放锁**；阶段 2 在锁外 `rmWithRetry(recheck.realPath)`（参数必须来自二次校验返回值，静态守护锁定）；阶段 3 再进锁从 manifest 移除条目。崩溃恢复 `recoverPurging` 两分支：`purging` 且目录存在→重试删；`purging` 且目录不存在→仅移除条目、不调用 `rm`。rm 失败 / manifest 移除失败都让条目保持 `purging`，下次启动 `recoverPurging` 收敛。
- **四项清单落点**：
  1. **复用而非复制**：`session-purge.js` 顶部 `import { writeManifest, withManifestLock, assertSafeTarget, readManifest, locateUnder, safeTargetSegment, canonicalSessionId, MANIFEST_NAME } from './session-trash.js'`，唯一自建的是 `rmWithRetry`——现成包 `purgePhysical`（`packages/dsh-plugin-yanyan-subagent/lib/index.js`）的 `rmSync` 无 `EBUSY/EPERM` 重试、catch 后只记 skipped，不满足 Windows 占用场景。
  2. **purging 两分支真机覆盖**：`recoverPurging` 分支 A（目录存在→重试删）/ 分支 B（目录不存在→仅移条目）均有独立用例；另含「rm 成功后 manifest 移除失败→保持 purging→由恢复收敛」。
  3. **Windows 占用重试**：`rmWithRetry` 对 `RETRYABLE_RM_CODES = {EBUSY, EPERM, EACCES, ENOTEMPTY, EWOULDBLOCK}` 退避重试（默认 5 次、`rmBaseDelayMs*(attempt+1)`）；不可重试码（如 ENOENT）立即抛、不静默吞。用例覆盖 EBUSY 重试 2 次成功、ENOENT 立即失败、重试耗尽返回逐项错误码 `code:'EBUSY'` 且条目保持 `purging`；延时应从 deps 注入，真机可注入。
  4. **收口四条记录项**：temp 名唯一化**本轮落实**——`writeManifest` 的临时名由固定 `<manifest>.tmp` 改为 `<manifest>.<pid>.<random>.tmp`，`rebuildManifestFromTrash` 跳过残留 `.tmp`（第 1 阶段 57 测试无回归）。其余三项维持记录：锁单进程范围（模块头）、restore 中间态（第 1 阶段 CHANGELOG）、rebuild O(n) 快速路径 P3。
- **验收结果**：
  - 新增 `test/session-purge.test.mjs`（21 个契约测试）：覆盖常量 / makePurgeFs / 非 manifest 条目拒绝 / `quarantined` 拒绝 / `restoring` 拒绝 / 目录不存在非 purging 拒绝 / 符号链接目标拒绝 / 整批 fail-closed / 正常删除 + 空 project 保留 + 广播 / rm 参数可追溯 / EBUSY 重试成功 / ENOENT 立即失败 / 重试耗尽逐项错误码 / 原子写无 .tmp / `recoverPurging` 两分支 / manifest 移除失败保持 purging / `purgeExpired` 过期与未过期 / 无时间基准跳过 / 真机 fs rm / 静态守护。
  - **静态守护**：`session-trash.js` 仍无任何 `rm` 成员调用；`session-purge.js` 的 `fs.rm(realPath, {recursive:true, force:false})` 只出现在 `rmWithRetry` 内，参数来自 `assertSafeTarget` 返回的 `recheck.realPath`；purgeOne 内不出现裸 `fs.rm`；标记锁回调块内不含 `rmWithRetry` / `fs.rm`（rm 在锁外），均由测试静态断言锁定。
  - 根包 `npm test` **78/78 全绿**（第 1 阶段 57 + 第 2 阶段 21，零回归）。
  - `npm pack`：46 文件，**含 `lib/session-purge.js` 与 `lib/session-trash.js`**，`test/` 文件数 **0**；版本仍 `1.4.2`（复用载体版本，未单独 bump）；shasum `1c5cf319...`（dry-run）。
- **状态**：第 2 阶段为独立自包含模块，未接入任何 host 路由或 UI，不影响现有会话归档流程。接回入口（第 4 阶段）、子代理树级联（第 3 阶段）本轮不做。事件 `api-session/purged` 为本模块约定，同第 1 阶段——DSH 当前无监听者、效果为零，仅保留顺序纪律待第 4 阶段对齐宿主，不可当作「UI 已即时刷新」。
- **第 2 阶段评审加固（deepseek-chat 闭环评审后逐条落实）**：
  - **P0 restore/purge 对称性（已修复，非仅记录）**：核实 `restoreFromTrashLocked` 原先只检查 `!entry`、无 `purging` 状态门，竞态窗口真实存在（purge 阶段 1 写 `purging` 释放锁 → 锁外 rm 期间 restore 并发搬回目录 → purge 的 rm 命中旧路径 ENOENT → 条目保持 purging → recover 见「purging + 目录不存在」误判已 purge → 数据已恢复但状态说谎）。修复：restore 状态门与 purge 对称——遇 `entry.status==='purging'` 一律拒绝，返回 `reason:'purge-in-progress'` + 中文提示「等待 purge 完成或重试」；rebuild fallback 反推的条目无 status 字段、不受影响。新增竞态测试：模拟「purge 写完 purging 但 rm 未执行」时 restore，断言被拒、目录未搬离回收站、无 rename、manifest 条目仍为 purging。
  - **P1 ENOENT 收敛路径（已补显式测试）**：注入阶段 2 rm 抛 ENOENT 的 mock，断言「逐项错误码 `code:'ENOENT'` + 条目保持 purging → 下一次 `recoverPurging` 见目录不存在仅移条目（`recovery:'purging-no-dir'`）、不再调 rm」，锁住抛错与 recover 的衔接，防止「抛 ENOENT 却被改成成功」或「recover 对 ENOENT 遗留态处理不同」。
  - **P1 版本发布状态（已联网核实，见上「版本叙述澄清」）**：npm latest=1.4.1、无 v1.4.2 tag/提交，1.4.2 未发布，复用无风险；已更正旧表述。
  - **P2 三条记录（不阻塞）**：
    1. **`purgeExpired` 无 `deletedAt` 条目永久滞留**：fail-safe 跳过意味着这类条目不会被自动清理，只能显式 `purge`。运维须知；后续可评估首次扫描补写 `deletedAt=now`（需核实旧 manifest 格式安全性）或显式告警。
    2. **TOCTOU 理论风险**：`recheck.realPath` 在阶段 1 解析、阶段 2 rm 使用，两次间若真实目录被替换，rm 会删替换后的目录（符号链接替换则安全——`fs.rm({recursive:true})` 不跟随链接删目标）。单用户本地环境概率极低，接受该风险；多用户/共享卷场景需在 rm 前重做 `lstat` 非链接校验。
    3. **`.tmp` 残留只跳过不清理**：`<pid>.<random>.tmp` 唯一化 + rebuild 跳过后，残留文件会累积，尚无启动清理任务（清理 `.tmp` 属 unlink，需放允许删的 `session-purge.js` 并评估是否值得），记 P3。
  - **测试结果**：新增 2 个用例（restore 拒绝 purging 竞态 + ENOENT 收敛），根包 `npm test` **80/80 全绿**（第 1 阶段 58 + 第 2 阶段 22，零回归）；tgz 重新打包，46 文件含 session-purge.js、test 为 0。
  - **第 3 阶段承接提示**：级联删除子代理时复用本轮 `preflightPurge` + 整批 fail-closed 语义；**父会话 purge 不得因子代理 purge 失败而继续宣称「主要意图已完成」**（整批语义：任一子项失败则整体失败或部分失败结果模型须如实反映），守住的正是「回收站状态不说谎」这条主线。
- **第 2 阶段第三轮评审加固（deepseek-chat 闭环评审后逐条核实；至此第 2 阶段收口）**：
  - **P1 双向互斥的另一半——purge 拒绝 purging 条目（已修复）**：核实 `purgeOne` 阶段 1 原只查 `restoring`、未查 `purging`，运行时并发 purge 竞态（客户端 A 写 purging 释放锁 → 锁外 rm 期间客户端 B 也 purge → 重复写标记 / 并发 rm / 阶段 3 重复移除条目）真实存在。修复：`preflightPurge(ids, deps, {allowPurging})` 与 `purgeOne(check, deps, {allowPurging})` 加门——正常 `purge` / `purgeExpired` 遇 `purging` 条目整批拒绝（`reason` 含 `purging; refusing to purge`），**只有 `recoverPurging`（启动恢复）传 `allowPurging:true` 放行**，作为唯一合法的「purging + 目录存在」重试入口（与 restore 的 `purge-in-progress` 门对称）。新增并发测试：第二个 purge 被拒（rejected）、rm 只执行一次；同条目的 recoverPurging 仍可正常收敛。「未清 purging」措辞由此明确为「recover 路径处理的 purging+目录存在」，运行时并发一律拒绝。
  - **P1 阶段 3 失败收敛（已补测）**：`rm 成功后 manifest 移除失败` 用例接上 recover 断言——阶段 3 写失败后条目仍 `purging`、目录已不存在 → 恢复 fs 写入后跑 `recoverPurging` 走分支 B（`purging-no-dir`）、不调 rm、条目被移除，锁住「阶段 3 失败→保持 purging→recover 收敛」的完整链条。
  - **P1 restore 拒绝 quarantined（已修复）**：核实 `restoreFromTrashLocked` 原只判 `purging`、未判隔离清单。修复：在 restore 入口按 `preflightPurge` 同样的 `canonicalSessionId` 归一化检查 `manifest.quarantined`，矛盾态残留（条目同时在 entries 与 quarantined）一律返回 `reason:'quarantined'` + 中文隔离提示；rebuild 反推的条目不进 entries 不受影响。新增回归测试，断言隔离条目被拒、无 rename。第 1 阶段「隔离项既不重建、也不 restore/purge」的承诺在恢复路径闭合。
  - **P2 两条核实（不阻塞）**：
    1. **测试数归属（已按文件级实测修正）**：82 = 第 1 阶段 **59**（原有 22 + `test/session-trash.test.mjs` **37**，其中第三轮新增的 restore 拒绝 quarantined 测试归此文件——测的是 restore 行为）+ 第 2 阶段 **23**（`test/session-purge.test.mjs`，第三轮新增并发 purge 拒绝 1 个；阶段 3 收敛是扩展原有用例而非新增）。此前写作「58 + 24」有误：restore 的 quarantined 测试实际归第 1 阶段文件（session-trash 由 36→37），第 2 阶段由 22→23。文件级实测 `component-versions 10 + integration 4 + session-archive-contract 3 + toolkit 5 + session-trash 37 + session-purge 23 = 82`，已核实，测试一个未漏。
    2. **1.4.2 内容核实**：已 tar 解包核对——tgz 含 `package/packages/dsh-plugin-yanyan-subagent/lib/client.js`，13 处新功能标记（`positionOverlay` / `HOVER_CLOSE_DELAY` / `closeOverlaysFromOutside` / `formatTokenCount`）与本地一致，subagent 版本 `1.3.0`。确认 1.4.2 的 tgz 确实包含声称的 subagent UI 增强内容。
  - **测试结果**：新增 2 个用例（并发 purge 拒绝 + restore 拒绝 quarantined；另阶段 3 收敛从原有用例扩展），根包 `npm test` **82/82 全绿**（零回归）；tgz 重新打包 46 文件含 session-purge.js+session-trash.js、test 为 0。
  - **收口核实（deepseek-chat 第四轮确认，两点均已实际核实，代码/测试正确、仅文档有误已更正）**：
    1. **restore 拒绝 quarantined 测试存在且完整**：`test/session-trash.test.mjs:429` 构造 quarantined 条目调 restore，断言 `reason:'quarantined'` + 中文隔离提示 + `renameCalls` 不变（目录未搬离）。此前「数字矛盾」源于 CHANGELOG 归属写错（58+24），文件级实测已更正为 59+23=82，测试一个未漏。
    2. **allowPurging 未放宽 quarantined**：`preflightPurge` 的 quarantined 检查（`lib/session-purge.js:130`）**无条件执行、先于** allowPurging 判断（`:134`）；allowPurging 只放宽 `purging` 一个状态，`recoverPurging`（传 allowPurging:true）遇 quarantined 条目仍会被拒，第 1 阶段「隔离项既不重建、也不 restore/purge」的双向承诺未被破坏。
  - **第 3 阶段额外承接提示（deepseek-chat 第四轮）**：级联删除子代理复用 `preflightPurge` 时，**不得传 `allowPurging:true`**——级联删除是正常的显式操作，不是启动恢复，遇 purging 条目应整批拒绝而非放行；allowPurging 是 `recoverPurging` 专用参数。
  - **第 3 阶段带入建议（deepseek-chat 第五轮，不阻塞收口）**：
    1. **收紧 allowPurging 的暴露方式（API 层约束优于文档约束）**：布尔参数靠文档约束比 API 结构约束弱，级联路径复用共享 `preflightPurge` 时重构易顺手透传。第 3 阶段实施 cascade 预检时考虑——`preflightPurge` 不再暴露 `allowPurging`，改为 `recoverPurging` 内部调用私有 `_preflightPurgeForRecovery`，正常路径签名里根本没有该开关，使「级联误传」从「需记住文档」变为「不可能传」。级联预检是本轮之后调整该签名成本最低的窗口。
    2. **integrity 采集时机**：CHANGELOG 在包内，纯文档更正也会改变 tgz 哈希（多次更正已使 integrity 连续变化；故此处不写死任何哈希值，写死必然 stale）。1.4.2 未发布前无碍；**发布时须以最后一次 `npm pack` 之后的最终 integrity 为准**，不要把中间轮次哈希混入记录——发布流程里把 integrity 采集放到最终打包之后。
  - **状态**：第 2 阶段至此**收口通过、无待办**；第 3 阶段（子代理树级联 + 批量部分失败）、第 4 阶段（接回入口）待单独授权后另开分支。

### 路径 A 第 3 阶段：子代理树级联删除 + 批量部分失败结果模型

- **范围 / 风险边界**：新增独立模块 `lib/session-cascade.js`（纯编排，自身**不含任何物理 I/O**——无 `rm` / `rename` / `writeFile` / `unlink`，静态守护断言锁定）。不接回 UI（第 4 阶段），不改动 `@linxin666/dsh-session-archive`。风险边界（模块头第一段）：只处理「已在回收站、由调用方显式传入 rows 快照」的会话；绝不根据任意 sessionId 直接删活跃 sessions 目录（「绕过回收站直删」仍禁止）；「直接彻底删除」是另一功能、不在本轮范围。
- **用户三项决策（ask_user_question 拍板）**：①树来源=调用方显式传入 rows 快照（含 id/parentId/origin/childIds/sizeBytes/running/hostProtectedReason），本模块为纯函数、不碰已收口的第 1 阶段 manifest（会话进回收站后从 feed 消失，树快照构建留给第 4 阶段接回入口解决）；②级联对象=仅回收站内会话，父 purge 时其已在回收站的子代理一并删；③算法形态=移植现成包生产验证算法（非重造）。
- **借鉴而非重造（已检索现成轮子）**：`descendantsOf` / `planDelete` / `clientProtectedReason` / `selectionFullyProtected` 逐行移植自 `@linxin666/dsh-session-archive@0.4.18` 的 `src/core/cascade.ts`（host 权威计划与浏览器预览共用、生产验证），完整保留：整族 fail-closed（家族含任一受保护成员则整族跳过、绝不半删）、保护态优先级 `PROTECTION_RANK`（running:1 < attached:2 < current:3 < in-flight:4）、每 id 在 skipped 中最多一次、直接选中的受保护成员保留自身 reason。批量部分失败结果模型借鉴同包 `src/host/janitor.ts` 的 `deleteSessions` / `executeDelete`。这些函数在现成包里是内联私有、无 JS 产物导出，故以「移植已验证算法」复用而非臆造。
- **编排 `cascadePurge(rows, directIds, protectedReason, deps)`**：`planDelete` 产出权威目标集 → 注入的 `purgeFn`（默认 `session-purge.js` 的 `purge`）物理删除 → 合并成统一结果模型。关键诚实性字段：`ok` 仅当**所有 targets 成功、无 skipped、无失败**才为 true——父成功但子代理失败时 `ok=false`、`descendantsOk=false`、`message` 明确点名失败子代理（承接第 2 阶段「父会话 purge 不得因子代理失败而宣称主要意图已完成」的承接提示）。另返回 `primaryOk`/`descendantsOk`/`succeeded`/`failed`/`skipped`/`totalBytes`/`results`/`message` 逐条可追溯。
- **allowPurging 纪律（承接第 2 阶段评审）**：`cascadePurge` 只调 `purge(ids, deps)`、绝不调 `recoverPurging`、绝不经任何路径传 `allowPurging`（级联是显式操作、非启动恢复；遇 purging 条目由 `purge` 的整批 fail-closed 拒绝）。静态守护断言模块内无 `recoverPurging(` 调用、无 `allowPurging:` 传参、`purgeFn(plan.targets, purgeDeps)` 固定两实参。注：第 2 阶段承接建议「把 allowPurging 从 preflightPurge 公开 API 收紧为私有」未在本轮改动已收口的 `session-purge.js`，改以本模块调用约束杜绝误用——是否收紧留后续独立评估。
- **测试**：新增 `test/session-cascade.test.mjs`（32 个契约测试）：PROTECTION_RANK 一致性、descendantsOf（全后代/环与重复边/不存在 id/**fork 排除/入口边 fork 过滤**）、planDelete（安全家族/not-found/自身受保护/整族受保护不半删/直接受保护保留自身 reason/skipped 去重/重复 directId/**fork 隔离不进 targets/直接选中的 fork 仍可删**）、clientProtectedReason（合并与优先级）、selectionFullyProtected、detectIncompleteSnapshot（**缺失未知 origin 后代保守拒绝**）、cascadePurge（安全家族聚合/父失败/子代理失败 ok=false/保护跳过不调 purgeFn/只传两参数/无 targets/空输入/**fork 隔离到 targets/**整批拒绝原因码传播/**快照不完整整批拒绝**、**fork 缺失不误判**）、两条静态守护。根包 `npm test` **114/114 全绿**（第 1+2 阶段 82 + 第 3 阶段 32，零回归）。
- **打包**：`package.json` files 加 `lib/session-cascade.js`；npm pack 含三个会话模块，test 文件数 0；版本仍 `1.4.2`（复用未发布载体版本，未单独 bump）。
- **状态**：第 3 阶段为独立自包含模块，未接入 host 路由或 UI，不影响现有会话归档流程。接回入口（第 4 阶段）、树快照构建（第 4 阶段接回入口时从 workspace registry / feed 解决）本轮不做。

### 第 3 阶段闭环评审加固（deepseek-chat，P0 + P1 全部核实修复）

- **P0 — descendantsOf 误删 fork（数据丢失点，已修）**：核实现成包 `inventory.ts:323-329` 构建 `childIds` 时**只看 `parentId`、不检查 `origin`**，故照搬的 `descendantsOf` 会把有 `parentId`、origin:`'fork'` 的独立对话当子代理级联删除——违反第 1 阶段「只跟随 subagent、不删 fork」的既定边界。修复：`descendantsOf` 的入口边与递归边均只跟随 `byId.get(child)?.origin === 'subagent'`，fork 及其整条分支全部剪掉；**直接选中的 id 不受过滤**（显式删除），过滤只作用于向下派生的后代。新增专项测试：源会话级联不删 fork（planDelete 层 + cascadePurge 层）、直接选中的 fork 仍可删、fork 分支后代不可达。
- **P1 — hostProtectedReason 取值域核实（无需改代码）**：核实 `hostProtectedReason` 取值域为 `'attached'|'in-flight'`（现成包 `janitor.ts:330-333`），均已在 `PROTECTION_RANK` 枚举内（attached:2 / in-flight:4），`clientProtectedReason` 按其 rank 合并，合法取值下不会被低优先级覆盖。已在模块头注释写明取值域与结论，测试覆盖 in-flight 胜 running / current 不覆盖 in-flight。
- **P1 — rows 快照完整性自检（已修，防留孤儿还说 ok=true）**：新增 `detectIncompleteSnapshot(rows, targets)`，对 `plan.targets` 各 id 的 `childIds` 做 Set 差集——出现 `origin==='subagent'`（或缺失无法判定，保守视为潜在 subagent）却不在 rows 里的 id，即判快照不完整；`cascadePurge` 据此整批拒绝、`reason:'incomplete-snapshot'`、不调 purgeFn。fork 缺失不算（不参与级联）。新增测试：漏子代理后代整批拒绝、fork 缺失不误判、未知 origin 保守拒绝。
- **P1 — purgeFn 整批拒绝传播（已补测）**：注入返回整批 `{status:'rejected', reason:'purge-in-progress'}` 的 mock，断言 cascade `ok=false`、`primaryOk=false`、`descendantsOk=false`、`failed` 含全部被拒 id、`results` 逐条带原因码、`message` 点名被拒 id。
- **P1 — rows 仅回收站契约（文档落定，P1-4）**：cascade 是纯函数、不查 manifest，无法自行判断「是否在回收站」。模块头写清 rows 只应含回收站条目；若混入活跃会话，purgeFn（session-purge）的 preflight 会因「不在 manifest」整批拒绝（fail-closed），表现为删除失败而非「跳过活跃」。第 4 阶段快照构建方须保证只传回收站条目。
- **P2 记录**：① `descendantsOf` 用 seen 去重、天然容忍环（已有测试）；② `sizeBytes` 仅用于汇总 `totalBytes` 供 UI 估算、不参与删除决策（模块头写明）；③ 1.4.2 未发布、tar integrity 每轮内容变更而变，发布时以最后一次 `npm pack` 的 integrity 为准，CHANGELOG 不写死哈希。
- **第 4 阶段带入约束（评审要求）**：树快照构建必须遵守「完整性（含全部 subagent 后代）/ 仅回收站条目 / origin=subagent 才级联」三约束；否则触发本轮的 child-ids-dangling / invalid-origin 拒绝或被 purge preflight 拒绝。

### 第 3 阶段第五轮评审加固（能力边界收窄 + origin 语义，P1 + P2）

- **P1 — 自检对照源循环依赖（核实成立，命名与契约已收窄）**：核实 `descendantsOf` 从 rows 自带 `childIds` 建 Map 遍历，`detectIncompleteSnapshot` 的差集基准同样是 `childIds` vs `rows.id`——**两者同源**。因此原自检只能发现「childIds 引用了 rows 外的 id」（悬挂引用），发现不了「childIds 本身漏了子代理」（快照整体不完整）——后者遍历与自检都看不见，`ok=true` 仍会留孤儿。这是自我参照，纯函数内无法自证。
  - 重命名：`detectIncompleteSnapshot` → **`detectDanglingChildIds`**；reason `'incomplete-snapshot'` → **`'child-ids-dangling'`**；message 改「悬挂 childIds 引用」。
  - 模块头诚实写明能力边界：**快照完整性的真正保证责任在第 4 阶段快照构建方**，必须用独立于 rows 的对照源（manifest 条目 / 磁盘扫描 / feed 快照）构建完整 childIds；cascade 自检仅作第二道引用一致性防线，不得被误认为已兜底。
  - 新增回归测试明确记录该边界：childIds 自身漏 sub2 时 `detectDanglingChildIds` 返回空（查不出）。
- **P1 — origin 缺失语义（已修，消除静默孤儿）**：P0 后 `origin !== 'subagent'` 一律剪枝，`origin` 缺失（旧数据/漏填）会让子代理被静默剪掉、`ok=true` 留孤儿。新增 **`detectInvalidOrigins`**：rows 中任一 parentId 非空、origin 不在 `['subagent','fork']` 的行判异常，cascadePurge 整批拒绝 `reason:'invalid-origin'`；第 4 阶段构建方须保证有 parentId 的行都带合法 origin。新增 2 测试（检出缺失/未知 origin + cascade 整批拒绝）。
- **P2 — 三项**：
  - hostProtectedReason 前向兼容：`clientProtectedReason` 的 rank 兜底从 `?? 0` 改为 `?? Infinity`——未知保护态（如未来 'pinned'/'shared'）按最高保护处理，绝不回退 0 而静默失去保护（与 purgeExpired 无 deletedAt fail-safe 跳过一致）。新增测试。
  - 显式删除 fork 的级联语义写明模块头：删 fork = 删 fork 本体 + 其 subagent 子树，不穿透嵌套 fork（fork 的 fork 在入口边剪掉）。
  - 第 4 阶段 UI 承接：results 的 reason 码须映射用户可读提示（child-ids-dangling → 「会话树数据不完整，请刷新后重试」；invalid-origin → 「会话树数据异常，请刷新后重试」），记入模块头承接段。
- **结果**：根包 `npm test` **118/118 全绿**（第 1+2 阶段 82 + 第 3 阶段 36，零回归）；打包含三个会话模块、test 0；版本仍 `1.4.2`。

### 路径 A 第 4a 阶段：会话树快照构建（Host 半）

- **范围与决策**：第 4 阶段拆 4a（树快照构建 Host 半）/ 4b（UI 入口接回 Client 半），4a 先于 4b；本轮只做 4a。用户拍板：①入口先并行后替换（本轮不动 `@linxin666`，不接 UI）；②旧账本不迁移（新 manifest 从零，旧 archiveTime 不参与保留期）；③复用版本 1.4.2；④广播订阅宿主原生事件；⑤对照源用磁盘扫描。开分支前已核实六项 DSH 事实（见下「前置结论修订」）。
- **核心洞察**：会话进回收站后从 feed/list 消失，但 `fs.rename` 保留了目录内 `session.v4.jsonl.zstd` 的 header（含 `origin` / `parentSession`，Node 26 `zstdDecompressSync` 可读）。故 `rows` 数据源 = 回收站目录内 session header；独立对照源 = manifest 条目 ↔ 磁盘目录扫描互照（不依赖 rows 自身，落实第 3 阶段移交的「快照完整性真正责任」）。
- **新增模块 `lib/session-snapshot.js`**（纯数据构建 + 三层完整性校验 + 编排 cascade，零物理删除）：`scanTrashDisk` 扫 `<trashRoot>/<project>/<segment>/session.v4.jsonl.zstd` 解压读首行 header（跳过 manifest 与 .tmp 残留）；`buildRows` 的 id 取 `header.id`（权威，不依赖目录段名，规避第 1 阶段 1.1 命门）、parentId←`header.parentSession`、origin 合法化、childIds 由 rows 内 parentSession **反向聚合**（不用文件自带字段，避免第 3 阶段自检循环依赖）；`reconcile` 做 manifest ↔ 磁盘双向对账（manifest 有磁盘无→悬挂拒绝，除非 status:purging 交 recoverPurging；磁盘有 manifest 无→orphans 记录不进 rows）；`buildSnapshot` 三层完整性校验（①集合一致 ②childIds 引用无悬挂，复用 `detectDanglingChildIds` ③origin 合法，复用 `detectInvalidOrigins`）；`cascadePurgeFromTrash` 在快照失败时整批拒绝且不调用 cascadeFn，成功则透传参数调 `cascadePurge`。零新 npm 依赖（复用 `readManifest`/`cascadePurge`/`detectDanglingChildIds`/`detectInvalidOrigins` + Node 内置 zstd）。
- **前置结论修订（核实推翻第 1 阶段旧结论，非篡改历史，特此声明）**：
  - 核实④ 广播：第 1 阶段记为「DSH 不暴露 session 事件、`api-session/removed` 无监听者、效果为零」。第 4 阶段重核宿主源码证实 `@deepseek-ai/dsh-api-session-controller/lib/index.js:3923-3941` **确实 emit** `api-session/added/removed/status/error/activity`；本模块 emit 的 `api-session/removed` 与宿主原生名恰好一致，4b 可直接订阅刷新、无需轮询兜底。`lib/session-trash.js` 模块头注释已更新为当前事实；上方第 1/2 阶段历史条目保留原记录以存真。
  - 核实⑥ unarchive：第 1 阶段记为「公开类型无 unarchiveSession、能力缺失走 partial 降级」。第 4 阶段重核证实 `@deepseek-ai/dsh-workspace/lib/index.js:559` **已提供** `unarchiveSession(sessionId)`，restore 可直接调用完成解档；partial 分支保留为能力缺失时的防御性降级，当前宿主正常路径不会触发。`lib/session-trash.js` 的 `restoreFromTrash` 文档注释已更新；历史条目保留原记录。
  - 其余四项核实（均成立、不改结论）：① origin/parentId 存于 session header（可读，`@deepseek-ai/dsh-subagent/lib/index.js:546-550`）与持久化 `subagent/descriptor` 事件；② `sessionPersistence.list()` 字段含 header + sizeBytes；③ running 取 `ctx.agents.get(id)?.status==='running'`、活跃保护走 workspace `session-activity` waterfall；⑤ 设置页用 `ctx.slots.register({name:'settings.section',...})`（4b 用，注意 id 防重）。
- **测试**：新增 `test/session-snapshot.test.mjs`（22 用例）：header 解析拒绝损坏、scanTrashDisk、buildRows 字段映射与 fork 语义、reconcile 双向对账各分支、buildSnapshot 三层校验各拒绝场景、cascadePurgeFromTrash 编排（快照失败 cascadeFn 未调用）、**真机 zstd 用例**（父 + 两子代理 + 一 fork 写真实 zstd 会话文件构建完整快照，断言 fork 不被误认子代理）、静态守护无物理删除。根包 `npm test` **140/140 全绿**（第 1~3 阶段 118 + 4a 22，零回归）。
- **状态**：4a 为纯 Host 半数据模块，未接任何 host 路由或 UI（4b 做），不改 `@linxin666`（并行期）。第 4b 阶段承接：设置页 `settings.section` 槽位接回回收站区块、订阅原生 `api-session/removed/added` 刷新、reason 码映射用户提示、双入口过渡提示。
- **闭环评审加固（P0 三项实测 + P1 四项 + P2 三条，2026-11-16）**：
  - **P0-1 Node 22 zstd 兼容性（实测排除，不推翻可行性）**：`zstdDecompressSync` 在 Node 22.15.0 引入（Stability 2 Stable）。下载 Node 22.19.0 实测：无 `--experimental-zstd` 标志即可压缩/解压往返，并真实解压本机 `session.v4.jsonl.zstd`（读到 header.id/origin/parentSession/version）。Node 24/26 线 API 一致（均 Stable）。`engines` 下界 `^22.19.0` 安全，无需收紧或 fallback。官方依据：nodejs.org v22.15.0 发布说明 + v22.x zlib 文档。
  - **P0-2 三者 id 一致性（1.1 命门延续，代码核实 + 补测钉死）**：权威 id = `canonicalSessionId(header.id)`（真实 header.id 已是 `session-<uuid>` 形式）。manifest 键（moveOneToTrash 写 `check.id`=canonical）、buildRows id、reconcile 对账键三者都经 canonicalSessionId 归一，恒等；目录段名由 `trashTargetFor` 取 locate 实际 basename 并断言 `canonical(段名)==canonical(rawId)`。三条路径对齐，无前缀布局下也不改写段名。新增测试用裸 uuid header.id + 裸 uuid manifest 键 + `session-` 前缀段名验证三者归一后一致、无 mismatch/orphan。
  - **P0-3 解压范围与内存保护**：现状为 `readFile` + `zstdDecompressSync` 全解（zstd 单帧无法只解首行）。真实会话文件极小（实测压缩约 443 B / 解压约 227 B），性能边界可接受；新增 `MAX_DECOMPRESSED_BYTES = 8 MiB` 上限，超限条目按单条目损坏隔离（不阻塞整批）。若 DSH 升级导致日志变大，4b 前评估流式 `createZstdDecompress` header-only 读取。
  - **P1-1 单条目损坏粒度（已修）**：原 `scanTrashDisk` 把 header 解压失败/字段缺失混入 `unsafe` 触发整批拒绝。改为独立 `corrupt` 清单——结构性失败（集合不一致/childIds 悬挂/非法段名/缺 session 文件）仍整批拒绝，单条目损坏只隔离该条目、其余正常构建、cascade 照常调用（与第 1 阶段 quarantined 粒度一致）；但显式要求删除损坏条目时返回 `corrupt-target` fail-closed（树关系不明不得删）。`reconcile` 用 `knownDiskIds` 避免把 corrupt 目录误判为「磁盘缺失」。
  - **P1-2 reconcile 职责边界（核实符合纪律，无需改）**：reconcile **纯对账只读**，返回 `{usable,orphans,purgingPending,mismatches}`，无 fs 写、无 `withManifestLock`；三套账本逻辑无写冲突——rebuild（启动反推重建）/ recoverPurging（purging 两分支）/ 4a reconcile（只读对账）职责清晰，写操作仍走已有路径。
  - **P1-3 回收站内活跃态读取（已修 fail-safe）**：`runningOf`/`protectedReasonOf` 注入读取，读不到（抛错）时置 `hostProtectedReason='read-error'` 视为受保护，绝不把未知状态当非运行而误删（与第 3 阶段 `?? Infinity` 纪律一致）。
  - **P1-4 广播 payload schema（实测对齐，无需改）**：宿主原生 `api-session/removed` payload = `session.id` 字符串（`@deepseek-ai/dsh-api-session-controller/lib/index.js:3926`），`api-session/added` payload = listState summary（:3923/:3929）；本模块 `emitRemoved(check.id)`/`emitAdded(canonical)` 传的也是 canonical id 字符串，与原生 removed schema 对齐。4b 订阅消费该 schema。
  - **P2-1 header 版本兼容（已修）**：新增 `SUPPORTED_HEADER_VERSION = 4`，`parseSessionHeader` 校验 `header.version` 存在且 ≠4 时拒绝该条目（单条目隔离）；无 version 字段的旧 header 放行（向后兼容）。模块头记录「依赖 v4 schema，升级需回归」。
  - **P2-2 buildSnapshot 缓存（记录，4b 处理）**：`cascadePurgeFromTrash` 每次全量 buildSnapshot，批量级联 O(n²)；当前回收站规模小可接受，4b 接 UI 时评估「一次批量内复用快照」或 `buildSnapshotFor(ids)` 只构建相关子树。
  - **P2-3 临时产物（已修 .gitignore）**：`.tmp-asar-*.cjs` / `.tmp-dsh-src/` 已加入 `.gitignore`；实测它们在 git 中为 untracked 但**未进入 tgz**（npm pack 按 package.json `files` 白名单，48 文件无临时产物）。用户选择保留到 4b 结束再清理。
  - **测试**：新增 6 用例（版本不匹配拒绝、解压字节上限、三者 id 归一一致、单条目隔离不阻塞、损坏目标 fail-closed、活跃态 fail-safe），根包 `npm test` **146/146 全绿**（第 1~3 阶段 118 + 4a 28，零回归）。
- **第六轮确认（收口前三项确认 + 四项记录，2026-11-16）**：
  - **canonicalSessionId 来源（自证质疑核实）**：本模块 `canonicalSessionId` 是自实现（`lib/session-trash.js:68-70`），但与现成包 `@linxin666/dsh-session-archive/src/host/session-files.ts:20-22` **逐字节一致**（`startsWith('session-') ? segment : 'session-'+segment`）。P0-2 的「归一恒等」断言不是凭空自证：外部锚点 = P0-1 实测的真实 DSH 目录（段名 = header.id = `session-<uuid>`，逐字节一致）。补一条测试用真实 DSH 段名格式断言 `canonical(真实段名) == canonical(真实 header.id)` 且还原段名与磁盘逐字节一致。
  - **cascade 消费 corrupt 清单（确认已接上）**：corrupt 条目不进 `found` → 不进 `rows` → cascade 天然跳过；显式删 corrupt 条目在 `buildSnapshot:311-315` 触发 `corrupt-target` fail-closed。补组合测试：1 corrupt + 2 正常，删 2 正常成功且 cascade 只处理正常条目、删 corrupt 被拒。
  - **reconcile 产出谁消费（确认数据流衔接）**：`buildSnapshot:306-309` 消费 reconcile 输出（传 `knownDiskIds` 隔离 corrupt 目录），结构性失败判定建立在 reconcile 的 mismatch 分类上；reconcile 是 buildSnapshot 的内部步骤而非独立诊断接口，模块头写明统一数据流，避免 4b 误以为必须先单独调 reconcile。
  - **read-error rank 行为（确认 fail-safe）**：`clientProtectedReason` 的 `rankOf() = PROTECTION_RANK[reason] ?? Infinity`（`lib/session-cascade.js:191`），`'read-error'` 不在枚举内 → rank=Infinity 最高保护 → cascade 整族跳过该会话及其后代。行为符合 fail-safe；补整族跳过测试，4b reason 映射加「该会话状态暂时无法读取，请稍后重试」。
  - **P2-1 宿主 payload id 形式（确认值对齐）**：宿主 `session.id` 本身即 `session-<uuid>` canonical 形式（P0-1 真机 header.id 实锤），本模块 `emitRemoved(check.id)` 同为 canonical id，schema **与值都对齐**。
  - **P2-2 旧 header 字段缺失（记录已知限制）**：`originOf`（`lib/session-snapshot.js:192-196`）对 v3 及更早 header（无 origin/parentSession）返回 undefined → detectInvalidOrigins 只在有 parentId 时拦截；纯无字段的旧 header 视为普通会话参与快照，树关系不完整风险由 4a 磁盘对照 + 4b UI 提示兜底。依赖 v4 schema，升级需回归。
  - **P2-3 8 MiB 基准（记录）**：`MAX_DECOMPRESSED_BYTES` 是**解压后**上限；超高压缩比会话（压缩态小但解压超 8 MiB）会被隔离为 corrupt，模块头已写明。
  - **测试**：新增 3 用例（canonical 真实目录锚点、corrupt 组合级联、read-error 整族跳过），根包 `npm test` **149/149 全绿**（零回归）。
- **第七轮确认（1.1 命门最后一道闸 + v3 疑点澄清，2026-11-16）**：
  - **canonical 只比较、不构造路径（核心确认，逐条读代码核实）**：`canonicalSessionId` 全程只用于等价类比较 / 查找 / 校验，绝不参与路径构造——`moveOneToTrash` 写 manifest 的 `originalPath`/`trashedPath` 用 `check.dirPath`/`check.target`（locate 实际段名，`lib/session-trash.js:485-486`），只有 `entry.id` 是 canonical（:484，仅作键）；restore 拼回路径用 `sourceSafe.segment = basename(locate 结果)`（:620/:661，原始未归一段名），canonical 只在 :611 查找 / :645 校验；`trashTargetFor` 用实际 basename（:403/:409）。故无前缀布局下 `'abc'` 全程保持 `'abc'`，不会被改写成 `'session-abc'`，1.1 命门安全。**新增无前缀段名 move→restore 往返测试**：断言回收站段名 / manifest 路径字段 / restore 目标都是原始 `'abc'`、绝不出现 `'session-abc'`（trash 单测 38/38）。
  - **v3 header 疑点澄清（核实推翻担忧）**：DSH 硬性要求 session header `version===4`（`@deepseek-ai/dsh-session__lib__index.js:1089`），v3 及更早 session header 根本不会被接受/读取。评审担心的「v3」实为 **subagent descriptor 版本**（`SUBAGENT_DESCRIPTOR_VERSION=3`，与 session header 无关，descriptor 本身不含父子字段——父子关系只在 header 的 `parentSession`/`origin`）。故不存在「v3 有 parentSession 但字段名不同导致漏判子代理」的风险；模块对 header 缺 origin/parentSession 的宽容处理仅针对异常/手工 header，模块头已据此修正。
  - **家族保留信息（确认，P2 记录）**：`cascadePurge` 的 message 已含 skipped（`N 个会话受保护被跳过`），但直接受保护父的子代理「既不在 skipped 也不在 targets（不被删）」这一族保留细节未逐条点名——这是 `planDelete` 的既定语义（直接受保护→家族不动）。4b UI 需按 reason 映射展示「影响范围」（单条目 vs 整族），`read-error`/`corrupt-target`/`child-ids-dangling` 提示需体现整族保留，已列入 4b 承接清单。
  - **8 MiB 全量扫描内存（确认）**：`scanTrashDisk` 逐条目解压、读完 header 即释放（`found` 只存解析后的 header 对象与 sizeBytes，不存解压 buffer），8 MiB 是**单条目**上限，总内存随条目数线性但不叠加解压 buffer，可控。

### 子智能体管理：浮层交互与样式对齐官方

- **来源**：用户反馈子智能体浮层「离按钮太远、样式与官方「N 个子智能体」浮层不一致」。改动全部落在 `packages/dsh-plugin-yanyan-subagent/lib/client.js`（浏览器半区），host 路由逻辑零改动。
- **浮层定位**：新增 `positionOverlay(view)` 按触发按钮 `getBoundingClientRect()` 实时计算内联 `left/top`，浮层贴按钮左下方展开，右侧/下方空间不足时收拢或翻到上方；删去原写死 `top:64px;right:24px`。`overlayAnchor` 在 React（`btnRef.current`）与原生降级（`btn`）两条路径打开前捕获；`resize` 时 `positionAllViews()` 重定位。锚点不可得时回退视口右上但按实时宽度收拢。
- **hover 开合**：按钮 `mouseenter` 打开（幂等，不 toggle）、`mouseleave` 经 `HOVER_CLOSE_DELAY=200ms` 延迟关闭；浮层 `PortalHost` / 原生 overlay 的 `mouseenter` 取消关闭、`mouseleave` 重新计时，跨越按钮↔浮层间隙不误关。`click` 保留为键盘/无障碍兜底。
- **点击空白关闭**：新增 `closeOverlaysFromOutside`，`document` capture 阶段监听 `mousedown`；浮层内部（含输入框/设置/清理）与触发按钮点击不关闭，其它空白区域关闭；右键（`button!==0`）忽略。effect 清理时移除监听。
- **样式对齐**：「子智能体管理」按钮改为无边框 + 透明背景 + 宿主次级灰字 token `--dsw-alias-label-secondary-foreground`，hover/focus 时字变黑（用随主题前景 `--yanyan-fg`，**不用** `--dsw-alias-label-primary-foreground`，那是白字 token 会让浅色背景文字消失）。列表行模仿官方布局：绿点（运行=蓝点）+ 双行文字（名称 / id + token · 耗时）+ 右箭头 + 删除 X；新增 `formatTokenCount` / `formatDuration` 防御性探测多种字段命名，取不到用空闲估算兜底、不臆造数据；保留 `data-dsh-part` 标记与删除回调。
- **测试**：新增 17 个契约测试到 `test/portal-interaction.test.mjs`（浮层定位/resize、按钮样式、点击空白三种目标、hover 延迟真实执行、图2 列表结构与 token/耗时格式化真实执行）全绿；根包 22/22、subagent 子包 81/81。
- **版本**：`dsh-plugin-yanyan-subagent` → `1.4.0`；聚合根包 → `1.4.2`（仅承载并发布子包 UI 增强）；`update` `1.2.1` / `icon` `1.0.1` / `@linxin666/dsh-session-archive` `0.4.18` 不变。两个 host `VERSION` 常量均动态读各自 `package.json`，自动跟随。
- **生效**：改动全部在 client（浏览器）半区，修好交互无需重启宿主进程；但 bundle 在启动/安装时加载，需重新 `npm pack` 并在插件页更新安装（或 `pnpm run dev:web` 重建 bundle 后刷新页面）才能在 Web GUI 看到新交互。

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
