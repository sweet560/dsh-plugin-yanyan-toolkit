# dsh-plugin-yanyan-trash

会话回收站插件（路径 A 第 1~4b 阶段成果）。提供**可恢复**的会话删除：移入回收站、恢复、彻底删除、会话树级联删除与批量操作。

## 与官方归档插件的关系

本插件与 `@linxin666/dsh-session-archive` **并行**，不接管其会话列表/搜索/归档：

- 官方插件的删除**不进入回收站、不可恢复**；设置页届时会有提示标注。
- 本插件新增独立的「会话回收站」设置区块（id `dsh-yanyan-trash`），只管理回收站条目。

## 组成

- Host 半（`lib/index.js`）：组装聚合包 `lib/session-{trash,purge,cascade,snapshot}.js` 四个纯函数模块，暴露 `api/dsh-yanyan-trash/*` 回环路由。
- Client 半（`lib/client.js`）：React 插件，注册 `settings.section` 区块，订阅宿主原生 `api-session/removed/added` 事件刷新。

## 安全底座（路径 A 全程）

- 归档闸门 + 四层路径校验（lstat 非符号链接 / realpath 在 root 内 / 恰好两层 / 段名匹配）。
- 中心 manifest 原子写（temp→rename）+ 进程内串行锁。
- 回收站可用性由 manifest ↔ 磁盘双向对账保证，会话树以磁盘 header（`origin`/`parentSession`）为真相。
- 级联删除整族 fail-closed，`read-error` / `family-protected` 整族保留，`corrupt-target` 单条目隔离。

## 安装与部署

- **安装后需重启 DSH 宿主**：新 Loader 条目由宿主在启动时扫描，仅刷新页面不会注册本插件；重启后设置页才会出现「会话回收站」区块。
- **不可独立发布/安装**：本子包 Host 半通过相对路径 `../../../lib/` 反向 import 聚合包的 `session-trash-service.js` / `session-trash-routes.js`，只在「子包与聚合包同处一个 tgz、按当前目录结构解包」时成立。单独安装或以 asar 等不同方式解包会导致路径断裂。必须随聚合包 `dsh-plugin-yanyan-toolkit` 一起发布。

## 版本

随聚合包 `dsh-plugin-yanyan-toolkit` 一起发布；本子包当前版本 1.0.0，无独立 npm 版本线。
