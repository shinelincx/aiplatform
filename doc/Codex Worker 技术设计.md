# AI Development Organization
## Codex Worker Technical Design V1.0

**Document ID:** ADO-WORKER-001  
**Version:** 1.0  
**Runtime:** Node.js + TypeScript  
**Coding Engine:** OpenAI Codex SDK  
**Execution:** Local / Remote Distributed Worker

---

## 1. 设计目标

Codex Worker 是云端研发管理平台与本地代码执行环境之间的执行代理。

负责：
- 接收云端任务。
- 验证任务权限。
- 准备代码工作区。
- 管理 Git 分支和 Worktree。
- 调用 Codex SDK。
- 监听执行事件。
- 执行测试。
- 收集代码变更。
- 创建 PR。
- 汇报执行结果。

Worker 不负责：
- 业务需求决策。
- 项目最终审批。
- 生产环境发布批准。
- 全局任务状态管理。

## 2. 运行环境

第一期支持：

### Windows Worker
推荐运行方式：
- Windows 11。
- WSL2。
- Docker Desktop。
- Node.js 20 LTS 或兼容版本。
- Git。
- Codex CLI 和 SDK。

实际 Codex SDK 的 Node.js 版本要求及操作系统兼容性应以所锁定的 SDK 版本文档为准。

### Linux Worker
- Ubuntu LTS。
- Node.js。
- Docker Engine。
- Git。
- Codex SDK。
- 测试与构建依赖。

## 3. 核心组件

### Worker Agent
负责注册、心跳、接收任务和生命周期管理。

### Workspace Manager
负责：
- Clone 仓库。
- 创建 Git Worktree。
- 管理任务分支。
- 清理工作目录。
- 维护 Workspace 状态。

### Codex Runtime
负责：
- 启动 Codex SDK。
- 创建 Thread。
- 恢复 Thread。
- 运行任务。
- 取消执行。
- 获取流式事件。

### Event Collector
负责：
- 接收 Codex 事件。
- 分配事件序号。
- 持久化本地待发送事件。
- 上报云端。
- 重连后补发。

### Test Executor
负责：
- 运行单元测试。
- 运行集成测试。
- 运行静态检查。
- 生成测试报告。

### GitHub Adapter
负责：
- 获取仓库。
- 推送分支。
- 创建 PR。
- 获取 PR 状态。

### Security Manager
负责：
- 校验任务授权。
- 控制文件和命令权限。
- 管理凭证。
- 限制网络访问。

## 4. Worker 通信协议

Worker 主动与云端建立 WSS 连接。

消息类型：

### Worker → Cloud

WORKER_REGISTER
WORKER_HEARTBEAT
WORKER_CAPABILITIES
TASK_ACCEPTED
TASK_STARTED
TASK_PROGRESS
TASK_EVENT
TASK_COMPLETED
TASK_FAILED
TASK_CANCELLED
WORKER_OFFLINE

### Cloud → Worker

REGISTER_ACK
TASK_OFFER
TASK_CANCEL
TASK_PAUSE
TASK_RESUME
CONFIG_UPDATE
CREDENTIAL_REFRESH

所有消息包含：

- message_id
- worker_id
- timestamp
- message_type
- correlation_id
- payload
- protocol_version

敏感信息不能通过普通日志明文记录。

## 5. Worker 注册

注册信息：

- worker_id
- worker_name
- OS
- architecture
- CPU
- memory
- disk
- Docker version
- Git version
- Node version
- Codex SDK version
- installed_tools
- supported_languages
- max_concurrency

云端认证成功后才允许接收任务。

## 6. Worker 调度

调度条件：

1. Worker 在线。
2. Worker 有剩余并发容量。
3. Worker 满足任务运行环境要求。
4. Worker 获得项目授权。
5. Worker 满足任务资源要求。
6. Worker 没有违反系统安全策略。

初始调度采用能力匹配 + 当前负载 + 项目权限。

不建议第一期使用复杂的 AI 自主调度算法。

## 7. Workspace 管理

推荐目录：

/workspaces/{project_id}/{task_id}/

每个任务创建独立 Worktree。

分支命名：

feature/{task_code}
bugfix/{task_code}
test/{task_code}

Workspace 元数据：

- workspace_id
- project_id
- task_id
- repository_id
- worker_id
- path
- branch
- base_commit
- current_commit
- status

禁止多个并发任务共享同一可写 Worktree。

## 8. Codex SDK 调用

执行生命周期：

1. 校验任务。
2. 加载项目规范。
3. 准备 Workspace。
4. 加载任务输入。
5. 创建或恢复 Codex Thread。
6. 运行 Codex。
7. 接收流式事件。
8. 保存 Thread ID。
9. 处理异常或取消。
10. 汇总执行结果。

调用接口建议：

CodexExecutionService:
- startRun()
- resumeRun()
- cancelRun()
- pauseRun()
- getRunStatus()
- streamEvents()
- getThread()
- getResult()

Codex Thread ID 必须与 agent_run_id 关联。

Thread ID 不能作为任务唯一标识。

## 9. 任务输入协议

{
  "task_id": "UUID",
  "project_id": "UUID",
  "repository_id": "UUID",
  "agent_role": "BACKEND_DEVELOPER",
  "workspace": {
    "branch": "feature/TASK-001"
  },
  "objective": "Implement the approved API requirement",
  "constraints": [],
  "acceptance_criteria": [],
  "allowed_tools": [],
  "execution_policy": {
    "sandbox": "workspace_write",
    "approval_required": false
  }
}

正式实现应使用版本化 JSON Schema 验证。

## 10. 事件处理

执行过程中收集：

- Thread started
- Turn started
- Agent message
- Tool call
- Tool result
- File change
- Command execution
- Approval request
- Turn completed
- Error

必须区分：
- 模型消息。
- 工具调用。
- 工具执行结果。
- 任务完成事件。

不能仅凭 Agent 输出“完成”两个字判定任务成功。

## 11. 事件可靠性

采用：

- 本地 SQLite 或持久化事件队列。
- 事件唯一 ID。
- 单次运行内递增序号。
- 云端幂等消费。
- ACK 确认。
- 失败重传。
- 重连补发。

执行完成事件必须在云端确认持久化后，才能安全清理本地待发送数据。

## 12. 安全设计

### 运行隔离
- 每个任务独立容器或受限工作区。
- 非 root 运行。
- 文件系统范围受限。
- 默认限制网络。
- CPU、内存、运行时间有限额。

### 密钥管理
- GitHub 使用短期 Installation Token。
- 模型密钥从凭证服务临时获取。
- 不在代码仓库保存密钥。
- 不把密钥注入模型上下文。
- 日志必须脱敏。

### 权限
- 普通开发 Agent 不允许合并主分支。
- 不允许访问生产密钥。
- 不允许任意修改 Worker 自身安全配置。
- 高风险操作需要人工审批。

## 13. GitHub 交付流程

1. 获取授权仓库。
2. 创建分支。
3. Codex 修改代码。
4. 执行检查和测试。
5. 生成变更摘要。
6. 推送分支。
7. 创建 PR。
8. 返回 PR URL。
9. 等待审批。

## 14. Worker 异常恢复

| 异常 | 处理 |
|---|---|
| 云端断线 | 本地暂存事件，尝试重连 |
| Worker 重启 | 恢复任务检查点 |
| Codex 异常退出 | 标记运行失败，分析恢复条件 |
| 磁盘不足 | 暂停新任务并告警 |
| Token 失效 | 请求刷新凭证 |
| Git 冲突 | 停止自动覆盖，报告冲突 |
| 测试失败 | 生成缺陷报告 |
| 任务取消 | 终止执行并清理资源 |

不得在状态未知时自动重新执行可能造成重复外部副作用的任务。

## 15. Worker 生命周期

UNREGISTERED
→ REGISTERING
→ ONLINE
→ IDLE
→ BUSY
→ DRAINING
→ OFFLINE

异常状态：
- UNHEALTHY
- DISCONNECTED
- DISABLED

## 16. 并发策略

第一期：
- 单 Worker 默认并发 1。
- 资源充足时允许配置为 2。
- Android 构建 Worker 默认并发 1。
- 单 Workspace 同一时刻仅允许一个写入执行者。

并发数量必须受 CPU、内存、磁盘和模型成本限制。

## 17. Worker 监控指标

- Worker 在线率。
- 任务领取数量。
- 执行成功率。
- 执行耗时。
- 平均恢复时间。
- Codex 调用次数。
- Token 使用量。
- 磁盘使用量。
- 测试通过率。
- 任务失败率。

## 18. 验收标准

1. Windows Worker 成功注册。
2. Linux Worker 成功注册。
3. 云端可以向 Worker 下发任务。
4. Worker 可以创建独立 Worktree。
5. Codex SDK 可以执行真实代码修改。
6. 流式事件实时返回。
7. Thread ID 持久化。
8. Worker 重启后可以恢复或安全终止任务。
9. 能够创建 GitHub PR。
10. 不同项目之间不能访问未经授权的工作区。
11. 取消任务可以停止执行。
12. 凭证和日志符合安全要求。

## 19. 技术边界

第一期不开发复杂的图形化远程桌面，不让 Worker 成为任意命令执行服务器，不允许通过模型提示词绕过容器权限。

所有 SDK 方法、事件类型和配置必须以锁定版本的官方 Codex SDK 文档为准。