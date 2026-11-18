# 会话管理中心 Phase 1 交付汇总（交接给思考/审查 Agent）

## 一、背景与目标

1.4.2 已正式发布（OIDC + provenance，GitHub/Gitee 同步完成）。在此安全底座上开发「会话管理中心」，共 4 项能力、分 3 个 Phase：

- Phase 1（本次已完成）：数据层 + UI 骨架 + 文件夹/标签交互
- Phase 2（待你设计）：全局内容全文搜索
- Phase 3（待你设计）：Markdown 批量导出 + ZIP

架构硬约束：**绝不修改 DSH 原生会话文件**，所有元数据旁路存储于 `$DSH_HOME/session-metadata.json`。

## 二、Phase 1 已交付内容

### 1. 数据层（旁路 JSON，原子写 + 进程内锁）
- `lib/session-metadata.js`：模型 `{version, folders:{}, sessions:{}}`，`sessions[sessionId]={tags:[],folderId,customTitle}`。
  - `writeMetadata`：nonce 临时文件 + `rename` 原子替换（复用 `session-trash.js:323 writeManifest` 纪律）。
  - `withMetadataLock`：Promise 链串行（复用 `withManifestLock`）。
  - `createMetadataStore` 提供 `createFolder/renameFolder/deleteFolder/setSessionFolder/addTag/removeTag/setCustomTitle/allTags/overview` 等，所有写操作在锁内重新 read 再 write，fail-closed 校验。
  - 系统文件夹 `@trash` / `@unfiled` 受保护不可删；删文件夹时归入它的会话退回 `folderId=null`。
- `lib/session-metadata-service.js`：`createSessionHubService(ctx)` 合并「活跃会话 × 元数据」，`list()` 返回 `{items,folders,tags,overview,systemFolders}`。
- `lib/session-metadata-routes.js`：`makeSessionHubRoutes` 8 条 HTTP 路由，prefix `/api/dsh-yanyan-session-hub`，复用 `makeTrashHandler(fence,method,fn)`（fence 用 `ctx.connection.requestRejection`）。

### 2. UI（子包 `dsh-plugin-yanyan-session-hub`）
- 独立子包结构：`packages/dsh-plugin-yanyan-session-hub/`（host 半 `lib/index.js` + browser 半 `lib/client.js` + package.json/cordis.patch.yml/icon/locale/README）。
- 手写预编译 IIFE（`window.__ModuleLoader__.load`），复用 trash client 模式；注册在 `settings.section`，`order=27`（回收站 26 之后）。
- 最终 UI 形态（v3，经用户两轮反馈定型）：**顶部固定 TabBar**（总览/会话/文件夹/标签/回收站，一个按钮一个页面）+ 会话页为**宽幅表格**（吸顶工具栏 + 表头 sticky + 表体独立滚动）+ **点击行弹右侧抽屉**编辑标题/标签/文件夹。
- 数据层/Service/路由在 UI 改版中一行未碰。

### 3. 根包接线
- `package.json` files 白名单加 3 个 `lib/session-metadata*.js`；dependencies 加 `"dsh-plugin-yanyan-session-hub": "file:./packages/..."`。
- `cordis.patch.yml` 加第 7 条 loader 行（现共七条/六个真实插件）。
- `lib/index.js` SUBPACKAGES 数组加新包名（版本聚合）。

## 三、验证状态（全部绿）

- `npm test` **211/211** 全绿。
- 重命名/新建/移动文件夹、增删标签、持久化均有单测覆盖。
- `node --check` 全通过；无装饰性 emoji。
- `npm pack` → `dsh-plugin-yanyan-toolkit-1.4.2.tgz`（71 文件，225.9 kB）；当前包 sha256 `ef573e1cd4bed8d98acd693cf7559046bfca94618e1d1b6a6d801388e0eb0890`。
- 已通过 `plugin_manager` 覆盖安装，用户重启宿主验收 **UI 恢复正常**。

## 四、两个关键坑（供审查 agent 警惕，Phase 2 尤其注意）

1. **React Hooks 突变导致白屏（已修）**：主组件曾用直接函数调用 `SessionsPage({...})` 渲染子组件，使子组件 hooks 挂到父组件队列，切 tab 时 hook 数突变 → React 抛错 → 整棵树卸载白屏。修复：一律改为元素形式 `h(Component, props)`，并加 ES5 原型继承的 `ErrorBoundary` 兜底。**Phase 2 若新增带 hooks 的子组件，务必沿用元素形式。**
2. **手写嵌套 h() 的括号平衡**：`node --check` 会报 `missing ) after argument list`，肉眼数括号不可靠，用忽略字符串/注释的括号状态机脚本逐行定位（曾定位到 `return h(` 少一个 `)`）。

补充：带 hooks 的组件必须保证每次渲染 hook 数量恒定，不能放在 `if(activeTab===...)` 条件分支里调用。

## 五、Phase 2 需求（待你给出方案）

利用现有 4a zstd 解析能力，做**跨会话内容全文搜索**：
- 插件加载时后台异步扫描当前 Project 下所有 `session.v4.jsonl.zstd`。
- 提取每帧 `role`/`content`，构建内存倒排索引（或 SQLite FTS5，视实现难度）。
- 搜索范围不仅是标题，还要能搜到聊天记录里说过的某句话。

### 现有可复用 zstd 轮子（务必直接复用，勿重写）
- `packages/dsh-plugin-yanyan-subagent/lib/zstd-frames.js`（81 行，MIT）：
  - `scanZstdFrames(buf)`：按 zstd 帧格式逐一枚举可独立解码帧（含 skippable frame 处理）。
  - `decodeLog(buf)`：逐帧 `zstdDecompressSync` 后拼接成明文字符串——**Phase 2 读日志直接用它**。
  - `encodeLog(headerLine, eventLines, perFrame=400)`：重编码（header 独占首帧）。
  - 关键点：DSH 日志是「header 一帧 + 每批事件一帧」的多帧结构，`zstdDecompressSync` 只解首帧，必须先 `scanZstdFrames` 切帧。这正是 1.4.2 修复的「zstd 多帧」Bug 的成因。
- 活跃会话来源：host 侧 `serviceFace(ctx,'sessions')` / client 侧 `sessions.list.getSnapshot().byId`。

## 六、请你输出

基于以上现状，给出 **Phase 2 的完整技术方案**：数据/索引结构设计、异步扫描与增量更新策略、内存占用控制、UI 接入点（在现有 tab 加"搜索"页还是复用会话页搜索框）、与现有 8 条路由的扩展方式、测试与验证计划，以及分阶段实施步骤。
