# 项目监测

使用 Node.js 24，在 ADO 主机或已批准的网络中运行。每个项目使用独立的监测账号，只授予该项目的 Viewer 权限。命令通过正常登录和项目权限校验读取数据，每次采样后撤销本次会话。

把以下变量写入对应项目的环境文件，文件权限设为 0600。

| 变量 | 取值 |
| --- | --- |
| ADO_MONITOR_API_URL | HTTPS API 地址，也可使用本机回环地址，例如预发布主机上的 `http://127.0.0.1:43101`。 |
| ADO_MONITOR_PROJECT_ID | 获批项目的 UUID。 |
| ADO_MONITOR_EMAIL、ADO_MONITOR_PASSWORD | 专用监测账号的凭证。 |
| ADO_MONITOR_REPOSITORY、ADO_MONITOR_WORKFLOW | 查阅 CI 时同时设置，分别填对应项目已绑定的仓库和工作流文件名。监测分支沿用仓库绑定里的默认分支。 |
| GITHUB_TOKEN | 公开仓库可匿名读取。提供令牌时限制为该仓库的 Actions 只读权限。 |

在仓库目录执行一次采样。

```bash
node --env-file=/path/to/project-monitor.env scripts/monitor-project.mjs
```

每次输出一条 JSON 记录，包含最近 72 小时的规划与 QA 失败、当前待处理状态、可选的默认分支 CI 证据和改进建议。报告只保留任务计数和受控分类。ADO 读取失败时命令非零退出。CI 的读取失败、暂无记录、运行中和运行结果分别记录。例行采样重叠时，按时间窗口、阶段、岗位、分类及最近一次发生时间复核重复事件。

负责人确认项目、周期和报告位置后，可使用现有调度器定期运行。以下为每 6 小时采样一次的 crontab 示例。请先创建对应项目的输出目录与环境文件，并按项目权限保管报告。

```cron
0 */6 * * * /usr/bin/flock -n /path/to/project-monitor.lock /usr/bin/node --env-file=/path/to/project-monitor.env /path/to/aiplatform/scripts/monitor-project.mjs >> /path/to/project-monitor.jsonl
```

报告供负责人复核。执行请求继续通过现有授权流程提交。
