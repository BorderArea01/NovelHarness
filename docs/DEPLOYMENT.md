# 部署、数据与公网入口

## 数据归属

程序运行在 Node 主机。两种模式都使用本机 SQLite，而不是浏览器数据库，也不依赖 Cloudflare 数据库：

| 模式       | `dataDirectory` 内保存什么                                                        | 浏览器保存什么                                              |
| ---------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `isolated` | 每个访客自己的子目录，含 `main.sqlite`、`home/`；根目录另有访客签名密钥与模式登记 | 识别这个访客空间的 Cookie、界面偏好及可能尚未提交的本地草稿 |
| `shared`   | 一份 `main.sqlite`、`home/`、`owner-key.txt`、模式登记与会话锁                    | 登录 Cookie、界面偏好及可能尚未提交的本地草稿               |

`main.sqlite` 保存书稿虚拟文件系统，`home/sessions/` 保存原生对话，`home/` 也保存模型凭据、配置、附件、插件个人配置和 PIN 库。备份不能只复制章节 JSON 或主 SQLite 文件；单本导出也不包含全部原生对话和全局设置。

SQLite 没有独立的服务器地址、账号或密码设置；用 `dataDirectory` 指定本机目录或**已挂载**的持久磁盘路径。支持的是 SQLite，不是任意数据库 URL。配置不会挂载磁盘、迁移数据库或复制云端旧数据。

## 私人主机

复制 `novelharness.config.shared.example.json` 为 Git 排除的 `novelharness.config.json`：

```json
{
  "mode": "shared",
  "host": "0.0.0.0",
  "port": 3210,
  "ingress": "lan",
  "dataDirectory": "./data/private-writing-space"
}
```

相对目录按启动时的项目工作目录解析，推荐服务器使用固定的绝对目录。容器部署者必须将持久卷挂载到该目录；只保存镜像或程序构建目录不等于备份数据。兼容旧版本的默认数据目录仍可能位于 `data/anonymous-runtime/` 内，删除该程序目录前必须检查实际数据位置。

运行 `npm run deployment:check` 核对目录，再 `npm start`。第一次在终端设置 PIN，无人值守时通过环境变量 `NOVEL_INITIAL_PIN` 首次初始化；不要把 PIN 或 API Key 写入配置 JSON。已有 PIN 不会被首次初始化变量重置。

程序用模式登记与进程锁阻止误用数据和双写。已有私人库需按 README 的停机核验 / 登记流程接管原目录，不能随意把 `dataDirectory` 指到另一个新目录后宣称完成迁移。更换目录会打开另一份数据，不会把原书稿带过去。

## 公网入口

`publicOrigin` 声明浏览器访问的外部来源，**不会建立反向代理、隧道或 Cloudflare 绑定**。`ingress` 显式记录连接方式，网络设施仍由部署者配置：

| `ingress`        | 适用情况                                 | 必需设施                                                                       |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `lan`            | 只从本机或局域网访问                     | 适当的监听地址与端口，不填 `publicOrigin`                                      |
| `reverse-proxy`  | 自建服务器或已有 HTTPS 代理              | 已运行的 HTTPS 代理、域名 / 路由、`publicOrigin`                               |
| `cloudflare-vpc` | 私人模式通过现有 Pages / Worker 进入本机 | 出站 Cloudflare Tunnel、VPC Service、Worker 绑定、认证转发密钥、`publicOrigin` |

普通反向代理必须保留外部 Host，并透传 WebSocket 升级、SSE / 流式响应和 Cookie；用户 API 不应被缓存或缓冲。设置足够的长请求超时，不能把长时间写作请求当成短网页请求处理。

Cloudflare 私人模式可参考 `novelharness.config.public.example.json`。这套链路是：

```text
浏览器 → Pages / Worker → 认证 relay → VPC Service → 出站 Tunnel → 本机 Node
局域网浏览器 ────────────────────────────────────────────────────→ 同一本机 Node
                                                                    ↓
                                                          同一个 dataDirectory
```

现有 `cloud/host/relay-worker.mjs` 需要 `LOCAL_SERVICE` VPC binding、`NOVEL_PUBLIC_ORIGIN` 和 secret `DSH_EDGE_ACCESS_KEY`。该 secret 必须与所选私人数据目录的 `owner-key.txt` 一致，只保存在部署主机与服务端 secret 配置中，不能发到浏览器或提交 Git。relay 会覆盖客户端伪造的转发头，本机核验密钥和来源后才接收。单填 `ingress` 和网址不会部署 relay。

VPC Service 的目标必须是实际 Node 主机的地址与端口。外部域名不决定 VPC 目标；创建 Service、绑定权限、Tunnel 连接条件按 [Cloudflare VPC Services 文档](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) 和 [Tunnel 文档](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) 操作。本仓库的旧私人迁移脚本依赖部署者记录，不是通用首次部署工具，不应直接对新账号运行。

程序与检查工具不会修改路由器、DNS、防火墙、Wi-Fi 或 EasyTier，也不会启动、重启或断开现有隧道。对于已经运行的私人站，先保留原转发设施和数据路径，再单独更新程序；不能拿空库验证公网后覆盖原库。

## 验证与恢复

`npm run deployment:check` 不做网络探测，不启动服务，不建立数据库。`configurationValid` 仅表示没有检查到配置错误；输出中的 warning 与 `publicConnectionVerified: false` 不能当成公网验收成功。

私人页面「数据与访问 → 服务与存储」显示当前运行的 SQLite、原生对话和配置路径。这里只读，不允许浏览器热切换数据库。访客和未登录者不能读取主机部署路径。

实际部署后，应从局域网和外网分别确认登录、读取同一本书、一次保存后另一端刷新一致、原生 WebSocket 与流式生成，以及主机重启后的内容与会话保持。还应演练从完整数据目录备份恢复到独立验证目录；不能在正在写入的两个实例之间复制 SQLite 来实现同步。

主机关机或断网时，公网入口应明确报告离线，不能自动改用旧云端空库或历史库。恢复程序时仍使用最新数据目录；代码回退不等于把小说退回旧备份。
