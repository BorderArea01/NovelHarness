# dsh-purge 安装兼容性核查

核查日期：2026-10-29。下文为原版宿主兼容性核查记录。后续已实现并安装 **novel-1 小说适配版**；原版宿主补丁及演练台没有安装。使用和可逆性边界见 [小说适配版](DSH-PURGE-NOVEL.md)。

补充：用户随后授权了官方宿主的隔离验证。原版包、宿主补丁及客户端已在独立实验目录加载和核验，**没有替换线上 novel-1，也未切换正式服务或数据源**。实测结果和未通过的迁移门槛见 [官方宿主隔离验证](OFFICIAL-HOST-VALIDATION.md)。

## 来源

- 原仓库：<https://github.com/YuJunZhiXue/dsh-purge>
- 核查提交：`0c933dc7d3252698f3f0f9756932dcc88355f532`
- 该提交 `package.json`：`dsh-purge@1.1.82`，`dshTarget: 0.2.1-rc.2`。
- 本地源码副本：`data/plugin-audit/dsh-purge`；不是已激活的插件目录。
- 许可证以原仓库 `LICENSE`、`NOTICE` 及附带条款为准；此次未修改、分发插件或抽取提示词。

## 为什么不能直接执行上游安装命令

当前服务虽然由本机承载，内部仍是 dsh-edge 的 Workerd/Miniflare 运行时，并不是官方 `dsh web` Node 宿主。版本号接近不等于宿主兼容。

| 边界 | 插件原版需要                                           | 当前工作台                                                          |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| 加载 | 官方 profile 的 bundles、Cordis patch 和用户插件加载器 | 构建期固定的 Edge composition；原生文档明确说明本机可选插件尚不可用 |
| 补丁 | 定位并修改本机 `@deepseek-ai` 包与 DSH profile         | 固定、校验过的 `worker/native/index.js` 和不可变发布目录            |
| 服务 | 官方 Web server、宿主 HTTP 路由、Node 子进程与重启路径 | Node 外层托管 Workerd；公网通过现有 relay 访问同一本机服务          |
| 数据 | 插件演练台另建本机存储                                 | 当前书稿、会话由既有原生 SQLite/VFS 持久化，不能暗切或另建替代库    |

本地证据：

- `cloud/tools/node_modules/dsh-edge/README.zh.md`：浏览器责任边界和 Host boot and plugins 条目。
- `cloud/host/runtime.mjs`：实际模块装载、Miniflare 及持久化路径。
- `cloud/scripts/stage-runtime.mjs`：原生 Worker 和浏览器资源的发布组装。
- 插件 `package.json`、`cordis.patch.yml`、`scripts/ensure-profile-bundle.mjs`：安装目标及 postinstall 行为。
- 插件 `lib/index.js`、`lib/core.js`、`lib/web.js`：宿主注入、文件补丁及重启依赖。

以上原版安装边界检查不是完整安全审计。小说适配版单独进行了原生运行时及浏览器测试；没有调用原版入口、postinstall、Apply、更新器或重启器。

## 当前保持不变

- 未更改正在运行的发布、PIN、模型配置、数据库、书稿或对话。
- 未停止小说服务、Cloudflare Tunnel 或 EasyTier，未更改网络配置。
- 核查后本机 `/api/health` 返回 `status: ready`、`ok: true`、原生版本 `0.30.0`。

## 后续边界

要让这个原版插件在现有工作台中实际可用，需要另行设计、实现并验证 Edge 适配，不能把源码下载或安装进一个无关的官方 DSH profile 宣称为安装成功。适配也不能默认获准移除工作台认证、数据隔离、事务/版本保护，或替换现有小说提示词和正式数据源。

若改用官方 DSH 宿主，涉及产品运行时与数据兼容的迁移，应作为独立决策；本次没有执行。
