# NovelHarness

基于 DeepSeek Harness 的小说工作台：用对话推动故事，同时维护正式书稿、章节大纲和小说资料。

- 小说书库、章节编辑、大纲、设定和可编辑提示词。
- 原生长对话、流式输出、工具调用和 dsh-purge 插件。
- AI 可直接更新书稿，保留旧版本和并发冲突保护。
- 桌面与手机共用工作台，正文、聊天和导航按屏幕调整。

## 无 PIN、访客之间独立

默认启动匿名访客隔离版，无需 PIN 或恢复口令。首次访问自动生成高熵、带签名的 HttpOnly Cookie。每个访客使用独立的 SQLite 小说库、原生对话目录、模型凭据和设置；每套部署还使用独立的签名密钥。

同站访客 A 不会读取访客 B 的小说、对话或 API 配置。各访客在“模型设置”中填写自己的 DeepSeek API Key，不继承部署者电脑的配置。无 Key 时仍可手动写作。

**Cookie 是访问凭证**。换设备、换浏览器或清除网站数据后会进入新空间，没有 PIN 找回功能；请定期在小说库导出作品。部署者仍能管理服务器数据，这不是端到端加密。不要分享自己的 Cookie。

## 运行

需要 Node.js **24 LTS** 和 npm；支持 Windows、Linux。安装和构建串行执行：

```sh
git clone https://github.com/BorderArea01/NovelHarness.git
cd NovelHarness
npm ci
npm --prefix cloud/tools ci --ignore-scripts --no-audit --no-fund
npm run build
npm start
```

打开 `http://127.0.0.1:3210`。新空间首次启动原生宿主会较慢；闲置空间释放进程后，再次访问从磁盘恢复。

公网使用 HTTPS 反向代理，保留 WebSocket、SSE、Cookie 和原始 Host，不缓存用户请求。

| 变量                  | 默认值       | 含义                                                |
| --------------------- | ------------ | --------------------------------------------------- |
| `HOST`                | `127.0.0.1`  | 监听地址；容器内可设 `0.0.0.0`                      |
| `PORT`                | `3210`       | 服务端口                                            |
| `PUBLIC_ORIGIN`       | 本机访问地址 | 实际来源，如 `https://novels.example.com`，不带路径 |
| `MAX_ACTIVE_VISITORS` | `2`          | 驻留访客宿主数，1–8；按内存调整                     |

运行中的 AI 不因访客切换被强制停止；驻留空间都忙时，新空间提示稍后重试。每个宿主 V8 堆上限 384 MiB，另有原生内存。本版适合小规模部署，尚未完成高并发和长期内存稳定性验证。

Cloudflare Pages 或 GitHub Pages **不能单独运行此 Node 服务**。可作为代理入口，实际数据仍保存在 Node 主机，不依赖 Cloudflare 数据库。仓库内旧实验入口用于源码维护，默认运行命令不会启动它们。

## 保存与升级

运行数据在 Git 排除的 `data/anonymous-runtime/` 内。需持久化其中的 `data/` 和 `visitor-secret.json`：前者包含各访客的小说、会话、图片及设置，后者决定原 Cookie 能否继续使用。停稳服务后一起备份；单本小说导出不含原生对话和全局设置。

升级前等 AI 完成、停止匿名服务并备份，再拉取源码、按锁文件安装依赖、运行 `npm run build` 和 `npm start`。构建不读取其他正式/隔离站数据库，也不清空已有访客目录。不要删除签名密钥，否则旧访客 Cookie 失效。

## 验证

```sh
npm run test:public
npm run test:public:integration
```

集成测试用独立身份和合成小说验证隔离与重启，不调用付费模型。共享小说协议测试需要先运行 `npm --prefix cloud/official ci --ignore-scripts`，再执行 `node cloud/tests/run.mjs`。私有环境迁移脚本需要部署者自己的记录，不是首次启动步骤。

## 许可证

GPL-3.0-only；上游依赖保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不内置 API Key、小说或对话。
