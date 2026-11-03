# 测试产物与磁盘保护

2026-10-27 已清理 330 个过期 Cloud 测试目录，释放约 32.1 GiB。清理记录见 `test-results/artifact-cleanup-last.json`；作品、PIN、Key、正式发布目录及局域网数据库不在清理范围。

资源入口 `scripts/run-guarded-task.ps1` 现包含：

- 启动前自动整理旧测试目录，磁盘可用空间必须至少 10 GiB。
- 运行中每 500ms 检查可用空间，低于 5 GiB 停止本任务及其所属进程树，不自动重启。
- 每 5 秒统计测试产物；超过 4 GiB 停止任务。受保护证据本身过大时拒绝清理并报错，不强删证据。
- 正常完成、失败或守卫中止后再次整理；保留每类最新 3 次、当前发布审计引用的验收目录及最近失败现场。错误日志、截图、原始报告保留。
- 任务结果明确记录本次创建了哪些测试目录，失败现场不通过错误文案或时间差猜测归属。

只允许清理 `test-results` 的直接子目录，且名称须严格匹配 `cloud-native-13位时间戳`、`cloud-engine-13位时间戳` 或 `cloud-tool-scope-13位时间戳`。路径越界、目录链接、审计版本不一致、测试仍在运行或无法确认安全时拒绝删除。不清理 `data`、依赖、正式版本、真实备份或其他项目。

预览（默认不删除）：

```powershell
.\scripts\manage-test-artifacts.ps1
```

执行已授权的保留策略：

```powershell
.\scripts\manage-test-artifacts.ps1 -Apply
```

轻量策略自检（不构建、不启动浏览器、不调用模型）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-guarded-task.ps1 -Task artifact-policy-test
```

清理与任务共享同一把互斥锁，另一个进程不能趁任务运行时清理其现场。原游戏进程与内存守卫保持不变。直接绕过受控入口执行测试脚本不会获得此入口的实时资源监测。
