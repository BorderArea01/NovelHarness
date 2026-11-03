# NovelHarness

基于 DeepSeek Harness 的小说工作台：用对话推动故事，同时维护正式书稿、章节大纲和小说资料。

- 小说书库、章节编辑、大纲、设定和可编辑提示词。
- 原生长对话、流式输出、工具调用和 dsh-purge 插件。
- AI 可直接更新书稿，保留旧版本和并发冲突保护。
- 桌面与手机共用工作台，正文、聊天和导航按屏幕调整。

## 同一套程序，两种部署模式

两种模式使用同一个构建、运行内核和工作台界面。部署者通过 `novelharness.config.json` 或 `NOVEL_MODE` 选择模式，访客不能在网页中切换整站的数据边界。

| 配置值             | 登录方式              | 数据范围                         | 换设备            |
| ------------------ | --------------------- | -------------------------------- | ----------------- |
| `isolated`（默认） | 浏览器 Cookie，无 PIN | 各访客的作品、对话、模型配置独立 | 默认进入新空间    |
| `shared`           | 部署者设置的 PIN      | 已登录设备共用一个私人空间       | 输入 PIN 继续创作 |

侧栏统一提供「数据与访问」，显示当前空间和备份说明。私人模式可在这里修改 PIN，访客模式不会显示无效的 PIN 控件。

### 访客隔离模式

默认启动匿名访客隔离版，无需 PIN 或恢复口令。首次访问自动生成高熵、带签名的 HttpOnly Cookie。每个访客使用独立的 SQLite 小说库、原生对话目录、模型凭据和设置；每套部署还使用独立的签名密钥。

同站访客 A 不会读取访客 B 的小说、对话或 API 配置。各访客在“模型设置”中填写自己的 DeepSeek API Key，不继承部署者电脑的配置。无 Key 时仍可手动写作。

**Cookie 是访问凭证**。换设备、换浏览器或清除网站数据后会进入新空间，没有 PIN 找回功能；请定期在小说库导出作品。部署者仍能管理服务器数据，这不是端到端加密。不要分享自己的 Cookie。

### 私人共享模式

将配置中的 `mode` 设为 `shared`。首次交互式启动会在终端提示设置 PIN，输入会隐藏；服务容器或无人值守环境通过 `NOVEL_INITIAL_PIN` 完成首次设置。已有 PIN 时不会用该变量重设 PIN，以后在页面「数据与访问」修改即可。

所有已登录设备共用书库、对话、资料、模型配置，保存仍使用版本检查，不提供实时协作。恢复口令由服务生成并保存在该空间数据目录的 `owner-key.txt`，只在忘记 PIN 时使用，不需要填写到模型设置。

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

可将 [novelharness.config.example.json](novelharness.config.example.json) 复制为 `novelharness.config.json`，例如私人局域网服务：

```json
{
  "mode": "shared",
  "host": "0.0.0.0",
  "port": 3210,
  "dataDirectory": "./data/my-writing-space"
}
```

两种模式都运行同一个 `npm run build` 和 `npm start`。修改模式、监听地址或数据目录后需停稳服务再重启。数据目录有模式登记和进程锁：不会因为改错配置就合并两种空间，也不允许两个服务同时写入同一目录。切换模式不自动迁移已有数据；没有登记的旧私人书库会拒绝直接打开，需先核验迁移。

公网使用 HTTPS 反向代理，保留 WebSocket、SSE、Cookie 和原始 Host，不缓存用户请求。

| 变量                  | 默认值                         | 含义                                                |
| --------------------- | ------------------------------ | --------------------------------------------------- |
| `HOST`                | `127.0.0.1`                    | 监听地址；容器内可设 `0.0.0.0`                      |
| `PORT`                | `3210`                         | 服务端口                                            |
| `PUBLIC_ORIGIN`       | 本机访问地址                   | 实际来源，如 `https://novels.example.com`，不带路径 |
| `MAX_ACTIVE_VISITORS` | `2`                            | 驻留访客宿主数，1–8；按内存调整                     |
| `NOVEL_MODE`          | `isolated`                     | `isolated` 或 `shared`，覆盖 JSON 中的模式          |
| `NOVEL_DATA_DIR`      | 按模式选择安装目录内的空间目录 | 覆盖 `dataDirectory`，书稿、对话和配置所在目录      |
| `NOVEL_CONFIG`        | `novelharness.config.json`     | 部署配置文件路径                                    |
| `NOVEL_INITIAL_PIN`   | 无                             | 仅用于私人模式首次初始化，不重设已有 PIN            |

运行中的 AI 不因访客切换被强制停止；驻留空间都忙时，新空间提示稍后重试。访客宿主 V8 堆上限 384 MiB，私人宿主为 512 MiB，另有原生内存。本版适合小规模部署，尚未完成高并发和长期内存稳定性验证。

Cloudflare Pages 或 GitHub Pages **不能单独运行此 Node 服务**。可作为代理入口，实际数据仍保存在 Node 主机，不依赖 Cloudflare 数据库。仓库内旧实验入口用于源码维护，默认运行命令不会启动它们。

## 保存与升级

构建复用 Git 排除的 `data/anonymous-runtime/` 安装目录（兼容原部署目录名，实际支持两种模式）。未自定义 `dataDirectory` 时，访客数据和私人数据分别放在其内部的 `visitors/` 与 `shared/` 目录，不会互相覆盖。

访客模式需完整备份数据目录，包括其中的 `visitor-secret.json`，该密钥决定原 Cookie 能否继续使用。旧部署安装目录中的签名密钥会在首次升级时原样保留到默认访客数据目录，原文件也会保留。私人模式需完整备份选定的数据目录，包括 `main.sqlite`、`home/`、`owner-key.txt` 与模式登记文件。停稳服务后备份；单本小说导出不含原生对话和全局设置。

升级前等 AI 完成、停稳服务并备份，再拉取源码、按锁文件安装依赖、运行 `npm run build` 和 `npm start`。保留相同的部署配置和数据目录。构建不读取其他正式/隔离站数据库，不清空已有空间。不要删除签名密钥或恢复口令。

同一个构建可以供多个实例使用，但每个实例必须指定独立的数据目录和端口。所有使用该构建的实例停稳后才能原地重建。升级到另一份已准备好的构建时，程序只重新绑定有归属记录的托管依赖，不改写用户的资料或个人插件配置。

旧私人安装包可先用 `cloud/selfhost/adopt-store.mjs` 检查，再在服务停稳后登记原数据目录：

```sh
node cloud/selfhost/adopt-store.mjs --legacy-runtime=/path/to/old-runtime --runtime-directory=/path/to/prepared-runtime --data-directory=/path/to/old-runtime/data/official-validation/integration/formal-promotion
```

核验和备份完成后加 `--apply` 执行登记。原 SQLite、对话、图片、PIN 和恢复口令留在原路径；该工具拒绝在旧进程仍运行时登记，也保留恢复托管依赖的记录。随后将配置中的 `mode` 设为 `shared`，`dataDirectory` 指向这个原目录。不要在两个进程之间手工复制正在使用的数据库。

Windows 的 `npm run start:background` 和 `npm run autostart:install` 也读取同一份配置；首次 PIN 初始化先在交互式 `npm start` 完成。后台启动不会偷偷构建，也不会停止占用端口的其他服务。

## 验证

```sh
npm run test:public
npm run test:public:integration
```

集成测试用独立身份和合成小说验证隔离与重启，不调用付费模型。共享小说协议测试需要先运行 `npm --prefix cloud/official ci --ignore-scripts`，再执行 `node cloud/tests/run.mjs`。私有环境迁移脚本需要部署者自己的记录，不是首次启动步骤。

## 许可证

GPL-3.0-only；上游依赖保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不内置 API Key、小说或对话。
