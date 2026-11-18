# dsh-plugin-yanyan-session-hub

会话管理中心（Phase 1）。在 DSH 原生会话文件之外，用一份旁路账本 `$DSH_HOME/session-metadata.json`（原子写 + 进程内串行锁）存储 `sessionId -> { tags, folderId, customTitle }`，并提供「左侧导航树 + 中间会话列表 + 右侧操作区」的三栏设置页区块。

## 设计边界

- **绝对不修改原生会话文件**：文件夹与标签都是逻辑映射，只写旁路 JSON；DSH 的 `sessions/` 目录只读不写。
- **原子写 + 并发锁**：复用回收站的 nonce temp + rename 原子替换与 Promise 链串行锁，避免写一半崩溃或多客户端并发覆盖。
- **回收站作为系统文件夹**：左侧导航底部保留「回收站」入口（逻辑 id `@trash`），实体条目由回收站插件管理。

## 组成

- Host 半（`lib/index.js`）：组装聚合包 `lib/session-metadata-{service,routes}.js`，暴露 `api/dsh-yanyan-session-hub/*` 回环路由。
- Client 半（`lib/client.js`）：React 插件，注册 `settings.section`（id `dsh-yanyan-session-hub`，order 27），三栏布局 UI。

## Phase 1 范围

- 数据层读写 + 原子写 + 并发锁；
- 三栏 UI 骨架（左导航：文件夹/标签/回收站；中列表：搜索 + 多选 + 按更新时间排序；右操作区：详情/标签/文件夹）；
- 交互：新建/重命名/删除文件夹、会话移入文件夹、添加/移除标签、自定义标题——全部持久化到旁路 JSON。

**不含** Phase 2 全文搜索（zstd 倒排索引）与 Phase 3 Markdown/ZIP 批量导出。

## 安装与部署

- **安装后需重启 DSH 宿主**：新 Loader 条目由宿主启动时扫描。
- **不可独立发布/安装**：Host 半通过相对路径 `../../../lib/` 反向 import 聚合包模块，须随 `dsh-plugin-yanyan-toolkit` 一起发布。
