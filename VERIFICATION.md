# 路径 A · 4b 真机验证记录

> 本文件是**执行结果记录**，不是待办定义。待办判定标准见 `CHANGELOG.md` 的「4b 真机验证验收清单」段。
> 状态：4b「代码交付完成、**待真机验证收口**」。本表全部通过并回填后，4b 正式收口、路径 A 全部落地。
> 执行人：__________　执行日期：__________　DSH 版本：__________　验证包 integrity：__________

## 验证前基线快照（只读采集）

**最新复采：2026-11-16T22:20:52Z**（重装新 1.4.2 包 + 重启宿主后）

| 项 | 基线值 | 说明 |
|---|---|---|
| DSH_HOME（宿主实际使用） | `F:\DeepSeek Harness workspace` | 环境变量；**不是** `C:\Users\Administrator\.dsh`（后者另存 2 个项目，属干扰项） |
| session-trash 目录 | 不存在 | 首次 trash 操作才创建；recoverPurging/rebuild 启动时无 manifest 可碰 |
| manifest.json | 不存在 | 回收站起点为空 |
| sessions 会话目录总数 | **501**（8 个 project）→ A2 后复采 506 | 会话持续新建使绝对数递增，A2/A3 以「trash 侧条数 + manifest 条目数 + 原目录是否移走」对账，不依赖总数 |
| 已装版本 | 1.4.2 | 已安装目录 package.json 确认 |
| 已装 cordis.patch.yml | 6 条 loader 行（含 trash） | 已安装目录核对，非 tgz |

> 历史：首次采集（21:54:21Z）为 494，重装+重启后复采为 501（期间正常使用新建会话所致，非缺陷）。**A2/A3 一律以最新 501 对账**。

> **对账公式**（基于 501）：A2 删 1 → sessions 总数应 500、session-trash 出现 1 条；A3 恢复 → sessions 回到 501、session-trash 清空。UI 显示"已删除"但 501 不变 = move 未真正执行（UI 假成功），这是文件系统层能抓到、UI 看不出的缺陷。
> **排查分叉**：若出现"UI 删了但回收站空"或"回收站有数据但侧栏没少"，**先核对 dshHome 解析路径**——两个 .dsh 并存是首要排查点。4a/4b 的 deps 从 ctx 拿，理论不会错，但需先排除。
> 采集脚本：`.tmp-baseline.cjs`，验证后重跑即可对比 mtime / entries 数 / 会话目录数。

## 本轮修复包重装记录（2026-11-17T10:48 +08:00）

- 起因：A2 标题子项 FAIL（显示裸 id）+ A3 恢复触发「未命名 / NaN / id=undefined」幽灵会话（详见失败项明细）。
- 根因（A3）：宿主原生 `api-session/added` 的 payload 是 `summaryFor(session)` 对象（字段 `sessionId`/`title`），本插件 `emitAdded` 却发字符串 id → 宿主侧栏监听方按对象取值得到 undefined → 造出幽灵行。`removed` 发字符串 id 与宿主一致故正常。删除侧家族整族、恢复侧无级联的已知限制与此无关。
- 三处修复（均已进包、重启前预检核实）：① `lib/session-trash-service.js` `emitAdded = null` 停发伪造 added；② `client.js` `_run` 成功后调宿主 `sessions.refresh()` 让其自行扫描磁盘重新发现；③ `readSessionTitle` 从回收站会话日志 `session/title` 末条读真实标题，`list()` 逐条补 `entry.title`，`row()` 显示 `title||id`。
- 重装：remove_bundle → install_bundle(1.4.2.tgz) → applied / exit 0。重启前预检 7 项全过：版本 1.4.2、emitAdded=null、client refresh、readSessionTitle、六模块、子包 host import、patch 第 6 行。
- 验证包 sha256 `95a696af83499a4a2738890a24c5a6a8ae1f3e20c353b8e8a5b848cdc6f72810`；最终 integrity 以收口时最后一次 `npm pack` 为准。
- **待用户重启宿主后重验 A2 标题子项 + A3 恢复 + A4**。幽灵行在宿主重启后应自动消失（不再有伪造 added 事件）。

## 4b 全项补验汇总（2026-11-17 12:23–12:37 +08:00）

> 用户 m04681「将所有需要验证的都全部执行，完成后给一份总结验证报告（发给网页 chat 审核）」。本轮补验 A5/A6/B1/B2/B3/B4。**未改任何代码、未重装、未重启。** 两种证据来源严格区分：①「GUI 真机」=supercu 操作 DSH 界面 + 文件层对账；②「service 层真实数据」=把真实会话（父 `session-98d7d8a6`+子 `cb3698ac`，含真实 zstd 日志）拷贝到隔离临时目录，用已装的真实模块跑 `buildSnapshot`/`planDelete`/`descendantsOf`/`TrashService` 全流程——零风险、可复现，不做不可逆真实删除。

- **A6 级联预览 [通过]**：真实父子树快照 rows=2、`descendantsOf(父)=[子]`（N=1）、`planDelete` targets=父+子整族、注入 fork 后 N 仍=1（fork 剪枝）。18/18 子检查全过。
- **B1 级联呈现与恢复 [通过]**：`trash([父,子])`→`restore(父)`（子留 trash）→`restore(子)`（独立恢复成功、partial:false）→回收站清空。证明情况 A（恢复侧无级联但数据不丢、可逐条恢复）。
- **B2 受保护会话 [通过]**：受保护父 skipped(read-error)、子整族保留（不进 targets/skipped）、rank=Infinity；client 整族保留文案在位；真机 running 会话此前已被 fail-closed 拒绝。
- **B4 恢复侧树断裂往返 [通过]**：完整五步（移入→恢复父→恢复子→再移入树重建→级联删除）在隔离副本全过，21/21 子检查。末步不可逆删除只在副本做，真实数据零风险。
- **A5 订阅刷新 [部分通过]**：契约层全过（emitAdded=null、removed 为字符串 id、两条 removed 事件、client 订阅三事件→load）；GUI 双标签端到端因环境限制（新标签焦点异常/PIL 缺失/select 不稳）未实测，诚实标注。
- **B3 双入口冲突 [部分通过]**：双入口提示文案+空状态文案 GUI 可见；旧入口实操未做（会触碰真实会话，逻辑上两入口数据独立）。
- **真实回收站卫生**：manifest `{"version":1,"entries":{}}`、trash 会话目录 0、无测试会话残留——所有级联/删除验证只在隔离副本进行。
- 累计证据：GUI 真机 A1/A2(含标题)/A3/A4/A7 + B3(文案)；service 层真实数据 A5 契约/A6/B1/B2/B4（39 子检查全过）；自动化测试 187/187 全绿。

## 拼接帧 zstd 修复后复验汇总（2026-11-17 12:17–12:19 +08:00）

> 用户 m04597「已经重启过了继续验证」。新包（含逐帧 zstd 解压修复，sha256 `e42ea39c…cdf3a9`）重装 + 宿主重启后，用 supercu 复验。**未改任何代码。**

- **A2 标题子项 [通过]**：回收站里跨重启保留的测试会话 `session-3e56fd3d` 行显示「空白会话 用于真机实测」+ 小字 id（UIA #335/#336），不再是裸 id。逐帧 zstd 解压（scanZstdFrames + 逐帧 decompression）在宿主 Electron 老 Node 真机生效——根因（会话日志是拼接帧容器、旧整文件一次性解压在宿主只拿首帧、末帧标题读不到）确认并修复。
- **A7 重启持久化 [通过]**：起点=上一轮留下的回收站 1 条；宿主重启后 manifest 条目完整（id/originalPath/trashedPath 含 `~0020`/时间戳）、trash 会话目录仍在、UI 标题正常——中心 manifest 进程重启持久化（第 1 阶段原子写）最终验收通过。
- **A3 恢复回归 [通过]**：点行内「恢复」→ 文件层 manifest entries 清空 `{}`、trash 目录=0、会话回到 `sessions/--F-DeepSeek~0020...--/session-3e56fd3d.../`；侧栏 #345 显示正常标题「空白会话 用于真机实测」，无未命名/NaN/裸 id/幽灵行。测试会话已清理归位。
- **A5/A6/B1–B4 [未验证]**：本轮未构造所需数据/环境（A5 需双标签页并发、A6/B1/B4 需带子代理树的会话、B2 需运行中/受保护会话、B3 需旧入口删会话），保持待验，不伪造通过。
- 结论：4b 核心生命周期 + 标题子项 + 重启持久化全部真机通过；A5/A6/B1–B4 仍待验证，4b 维持「待真机验证收口」。

## supercu 自主真机验证汇总（2026-11-17 11:39–11:52 +08:00）

> 用户 m03899 要求用 dsh-super-cu 插件自行走一遍 A2/A3/A4。全程 UIA 文本树 + #id 操作（截图工具在此环境报 PIL 缺失不可用）。对象=用户 m04196 授权的一次性测试会话 `session-21ccdd5d`（Numeric Input）。**未改任何代码、未重装、未重启。**

- **A2 删除 [主项通过]**：React 受控 `<select>` 必须用 focus+type 前缀触发原生 type-ahead（UIA select/setvalue/click option 均不可靠）。移入后文件层：manifest 落盘 1 条、trash 目录 1 个、原目录已移走=真实 move；`~0020` 编码路径正确。
- **A2 标题子项 [已于 12:19 复验通过]**：当时 UI 仍显示裸 id；后定位根因为**拼接帧 zstd 一次性解压在宿主 Electron 老 Node 失效**（标题在末帧、旧整文件解压只拿首帧），移植 DSH 生产逐帧方案修复（sha256 `e42ea39c…cdf3a9`），重装+重启后 12:19 复验显示正确标题。详见顶部「拼接帧 zstd 修复后复验汇总」。
- **A3 恢复 [通过]**：manifest 清空、trash 目录 0、原目录回到 sessions；侧栏 filter「未命名/NaN/undefined/session-」0 命中=**无幽灵行**，本轮伪造 added 修复真机生效。
- **A4 彻底删除 [通过]**：manifest 空、trash 目录 0、全盘无该会话目录、侧栏/最近列表无残留。projcache 残留属设计边界（并行策略下由 @linxin666 管），不影响 UI 三处判定。
- **未验证项**：A5 订阅刷新、A6 级联预览、A7 重启持久化、B1–B4 fail-closed——仍待验证；A1 双入口提示/空状态文案本次再次确认可见。
- 结论：核心生命周期（删→恢复→彻底删）在真机全部走通，数据安全、无幽灵行；标题子项与 A5/A6/A7/B1-B4 待用户重启后补验。

## 记录格式说明

每项填 `[通过]` 或 `[失败]` + 实测值；失败项必须附截图或控制台日志路径。任一 A/B 项失败 → 4b 退回修改、不收口（除已在 CHANGELOG C 节标注的已知限制「恢复侧无级联」）。

## A. 成功路径

| # | 动作 | 通过标准 | 结果 | 实测值 / 证据 |
|---|---|---|---|---|
| A1 | 设置页区块可见 | 标题文字正确；order 26 在现成包 25 之后；无重复 id（id=`dsh-yanyan-trash`） | [通过] | 截图 a80f5271：左侧菜单「会话回收站」高亮，位于「已归档会话」之后、仅一处；标题「会话回收站共 0 项」正确；双入口提示与空状态文案均可见。GUI port 56050 |
| A2 | 删 → 回收站列出 | 条目显示会话**标题**而非裸 id；删除时间正确 | [通过] | 删除本身 PASS：manifest 落盘 1 条 `session-21ccdd5d-...`，`trashedPath` 含 `~0020`、原目录已从 `sessions/` 移走（真实 move）。**标题子项 [通过，2026-11-17 12:19 复验]**：拼接帧 zstd 修复后重装+重启，回收站行显示「空白会话 用于真机实测」+ 小字 id（UIA #335/#336），非裸 id。根因=会话日志是拼接帧容器、旧整文件一次性解压在宿主 Electron 老 Node 只拿首帧（末帧标题丢失）；修复=移植 DSH 生产 scanZstdFrames + 逐帧解压拼接（187/187 全绿，sha256 `e42ea39c…cdf3a9`）。截图 m03540（删除）+ 本轮 UIA #335/#336（标题）。 |
| A3 | 恢复 → 侧栏重显 | 恢复后侧栏出现**原标题**（如「Numeric Input」）、不是 `session-xxx` 也不是「未命名/NaN」；id 非空、点开能读到历史消息；**无幽灵行生成**（本轮已修伪造 added 的根因，旧幽灵行重启后应消失） | [通过] | supercu 自验（2026-11-17 11:47）：点回收站行「恢复」→ 文件层对账 manifest entries 清空 `{}`、trash 会话目录=0、原目录回到 `sessions/--F-DeepSeek~0020...--/session-21ccdd5d.../`（`RESTORED_TO_SESSIONS_OK`）。侧栏 UIA filter「未命名/NaN/undefined/session-」**0 命中**=无幽灵行（emitAdded 停发伪造事件 + sessions.refresh 修复生效，A3 核心判定通过）。注：新出现的「BUG 修复. 待重跑循环…13小时」是 deepseek-chat 正常会话（有标题），非幽灵行。 |
| A4 | 彻底删 → 无幽灵行 | 侧栏、搜索结果、最近列表**三处**都无残留 | [通过] | supercu 自验（2026-11-17 11:49，对象=用户确认的一次性测试会话 session-21ccdd5d，用户 m04196 授权）：先移入回收站（manifest 1 条 + trash 目录 1 个 + 原位已无），再点行内「彻底删除」→ 文件层对账：① manifest entries 空 {}；② trash 会话目录=0；③ 全盘 find sessions+trash 无该目录（GONE_EVERYWHERE）；④ 侧栏会话列表无 Numeric Input 行、UIA filter 0 命中（未命名/NaN/session-21ccdd5d）=侧栏/最近列表无残留。说明：磁盘 storages/session_projcache/sessions/session-21ccdd5d....json 仍在——属设计边界非缺口：本模块 purge 按「先并行后替换」决策只删回收站会话目录一层（session-purge.js:93 fs.rm(realPath)，realPath 来自 trashRoot），projcache/workspace 记账由并行的 @linxin666 管理，不在 4b 删除范围；A4 判定标准是 UI 三处无残留，已满足。 |
| A5 | 订阅刷新 | 两标签页，A 删 → B 回收站**无需刷新**即出现条目（原生 `api-session/removed/added`） | [部分通过] | **契约层 [通过]（service 层真实数据脚本）**：`emitAdded === null`（不伪造幽灵会话）、`emitRemoved`/`emitPurged` 为函数；真实 `svc.trash([父,子])` 产生 2 条 `api-session/removed` 事件、payload 均为字符串 id，无 `api-session/added`。client 侧 `subscribeSessionEvents`（client.js:302-317）订阅 `["api-session/removed","api-session/added","api-session/purged"]` → `controller.load()`（:511），经 `ctx.effect` 挂载/清理；A3 真机恢复后侧栏无手动刷新即重显、无幽灵行，为订阅生效的实证。**GUI 双标签端到端未做**：新标签页点击后焦点异常、截图工具 PIL 缺失、select 控件 UIA 定位不稳，无法可靠完成纯 GUI 双标签动作。按诚实原则不伪造 GUI 通过，标部分通过（契约+单标签实证充分，双标签未实测）。 |
| A6 | 级联预览 | 确认框 N 与实际进回收站的子代理数一致；fork 不计入 N | [通过] | **service 层真实数据脚本（父 `session-98d7d8a6`+子 `cb3698ac`，拷贝到隔离临时目录，零风险）**：`buildSnapshot` ok、rows=2、父 childIds 含子、子 origin=subagent、parentId 指父；`descendantsOf(父)=[子]` → 预览 **N=1**；`planDelete(父)` targets=父+子（整族）；注入 fork 行后 `descendantsOf` 仍=1（fork 剪枝）。client 侧 `collectCascadeDescendants` 与 host `descendantsOf` 等价性由 `__testing` 对照测试锁死。18/18 子检查全过。 |
| A7 | 重启宿主后条目仍在 | 条目、标题、删除时间均保留（中心 manifest 进程重启持久化） | [通过] | 2026-11-17 12:17 宿主重启后：回收站仍有 1 条 `session-3e56fd3d`（上轮修复复验用），manifest 条目完整（id/originalPath/trashedPath 含 `~0020`/archivedAt/trashedAt 时间戳），trash 会话目录仍在，UI 显示标题「空白会话 用于真机实测」。中心 manifest 跨进程重启持久化验收通过。注：起点非严格空回收站（沿用了待清理的测试会话），但「条目+标题+时间跨重启保留」的核心判定已满足。 |

## B. fail-closed 场景

| # | 动作 | 通过标准 | 结果 | 实测值 / 证据 |
|---|---|---|---|---|
| B1 | 级联删除后子代理呈现与恢复（已知限制：恢复侧无级联） | (a) 确认父+N 子删除后的呈现（各占一行/折叠）；(b) 先恢复父、再逐条恢复子代理，侧栏层级正常；子代理可独立恢复（情况 A，数据不丢） | [通过] | **service 层真实数据往返脚本（隔离临时目录）**：`trash([父,子])` → 父子均在 trash、父不在 sessions；`restore(父)` → 父回 sessions、子仍留 trash（情况 A）；`restore(子)` → 子回 sessions（父已恢复仍可独立恢复，`partial:false`），回收站清空。证明「恢复侧无级联=数据不丢、可逐条恢复」成立。呈现层面：回收站列表按 manifest 条目逐行渲染（每行含恢复/级联删除/彻底删按钮），父子作为独立条目各占一行（client.js row()）。注：GUI 侧栏层级（树缩进）由宿主根据 header.parentSession 渲染，属宿主行为，本插件不改。 |
| B2 | 受保护/运行中会话删除 | UI 显示「会话受保护被保留」+ 通用整族保留提示，无「删除成功」或空白（判定标准已按代码能力降级，不要求精确 N） | [通过] | **service 层真实数据脚本**：对父设 `protectedReason=read-error` 后 `planDelete` → 父进 skipped（reason=read-error）、子既不进 targets 也不进 skipped（整族保留、无半删）；`PROTECTION_RANK` 无 read-error → rank=Infinity（最高保护 fail-safe）；`clientProtectedReason` 返回 Map。client 文案：client.js:123 `trash.familyNote`「父会话处于受保护状态，连同其子代理一并保留，未删除任何会话」+ 整族保留提示可见。真机侧：archify 后台任务会话（agent running）此前 A2 尝试被 `is still running; refusing to move` 正确 fail-closed（见失败项明细/历史）——保护闸门真机生效。 |
| B3 | 双入口并行冲突 | 旧入口删的会话**不进**新回收站；新回收站空状态渲染「通过其他入口删除的会话不会出现在此处」 | [部分通过] | **文案 [通过]**：GUI UIA #448 双入口提示「提示：官方/归档插件的删除不进入回收站，不可恢复。请改用上方「移入回收站」。」可见；空状态 #393「…通过其他入口删除的会话不会出现在此处。」可见（A1 亦确认）。**旧入口实操未做**：未在 GUI 用旧 @linxin666 删除按钮删会话再查新回收站是否为空——此项需构造旧入口操作，且会触碰真实会话，本轮未执行（设计上两入口数据完全独立：新回收站只读自身 manifest，旧入口删的会话不写本 manifest，逻辑上不进新回收站）。 |
| B4 | 恢复侧树断裂可逆（往返场景） | 恢复父 → 子代理仍在回收站 → 再次删除父 → 父与子重新同处 trash、树关系重建 → 对父彻底删除能正确级联子代理，与首次删除一致 | [通过] | **service 层真实数据完整往返脚本（隔离临时目录，零风险）**：① `trash([父,子])` ok、父子在 trash；② `restore(父)` ok、父回 sessions/子在 trash；③ `restore(子)` ok（情况 A 铁证）、回收站清空；④ 再次 `trash([父,子])` ok、`snapshot()` ok、树关系重建（rows=2、父 childIds 含子）；⑤ `cascadePurge([父])` ok、父子在 sessions 与 trash 均不存在（家族整族物理删除）。子检查 21/21 全过。此脚本覆盖 B4 全部五步（末步不可逆删除在隔离副本上做，真实数据零风险）。 |

## 已知限制（不阻塞收口）

- **恢复侧无级联**：父恢复后子代理仍留回收站，需手动逐条恢复（删除侧家族整族、恢复侧无对称）。后续评估方向：(a) 恢复父自动恢复 subagent 后代；(b) UI 提示「有 N 个子代理仍在回收站，是否一并恢复」。均未实现。

## 失败项明细

> 每个失败项附：项编号、现象、复现步骤、截图/日志路径、处置（退回修改 / 已知限制）。

（无）

## 收口签收

- A/B 全部通过或已标注已知限制：[x]（A1/A2/A3/A4/A6/A7/B1/B2/B4 通过；A5/B3 部分通过——契约与文案通过、GUI 双标签与旧入口实操受环境限制未做，已如实标注；B1 已知限制「恢复侧无级联」已标注）
- VERIFICATION.md 回填完成：[x]（全部 A/B 项已回填，部分通过项写明通过范围与未做原因）
- 真机验证包 integrity（拼接帧 zstd 修复包）：sha256 `e42ea39c9d645ca8cc4a237fc1443b5b194b148819e702401336286ac6cdf3a9`；重装包 sha256 `95a696af83499a4a2738890a24c5a6a8ae1f3e20c353b8e8a5b848cdc6f72810`；最后真机验证包（archive-gate 修复）sha256 `be7c7f731f68eb9b626b4f215933061a69906a800efaac54fb17c992ae8ff097`
- 最终发布包 integrity（1.4.2 正式发布，以最后一次 `npm pack` 为准）：sha256 `d896f687c3d00213c3a4192c2778c0704ac5dd3db3b85fe72b16559c3bb97407`，npm integrity `sha512-bjpSc/DpgGFDc0Of2ukAP6jsq1V0g7ARTYkUfsFNlL3etB2tKZmRzGIp96irBzMnVnMX4CELNUOqrIZ5iiUF+A==`（size 205154 B，unpacked 619300 B）
- 哈希一致性核对：最终发布包 vs 最后真机验证包逐文件 sha256 对比——**全部功能代码（`lib/**`、`scripts/**`、各子包 `lib/**`）零差异**；仅 5 个文档/元数据文件不同：`CHANGELOG.md`（新增 1.4.2 正式发布汇总段）、`README.md`/`README.en.md`/`README.zh.md`（subagent 版本表述 1.3.0→1.4.0）、`packages/dsh-plugin-yanyan-subagent/package.json`（version 1.3.0→1.4.0，`dsh` engines rc.2→rc.3）。功能等价性成立，发布包与真机验证包行为一致。
- 结论：[x] 4b 代码与逻辑验证完成 / [ ] 正式收口 —— **核心生命周期与全部 fail-closed 逻辑已通过（GUI 真机 + 真实数据 service 层双证据）；A5 双标签、B3 旧入口实操两项 GUI 端到端受环境限制未做，交由网页 chat 审核决定是否可据此收口或需补测**。详见交付给网页 chat 的总结验证报告。
