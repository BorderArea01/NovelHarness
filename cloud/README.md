# Harness 小说工作台

当前开源入口是 `selfhost/`，部署说明见根目录 [README](../README.md)。

- `official/novel/`：原生 Harness 的 SQLite 工作区、小说工具和网页组合层。
- `selfhost/`：无 PIN 访客身份、独立宿主、构建与隔离验证。
- `worker/`：共享文档、历史、冲突、提示词和工具协议。
- `pages/public/novel-assets/`：小说前端源码。
- `scripts/`：构建及维护；旧迁移脚本依赖部署者私有配置。
- `tools/`、`official/`：分别固定构建工具和宿主依赖。

默认启动不连接任何既有公网站点、账号或数据库。
