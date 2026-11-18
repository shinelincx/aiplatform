# AI Development Organization
## MVP Development Backlog V1.0

**Document ID:** ADO-BACKLOG-001  
**Version:** 1.0  
**Status:** Initial Baseline  
**Primary Pilot:** Fitbest  
**Secondary Pilot:** AI Development Organization

---

## 1. MVP 目标

完成一个可以真实运行的 AI 研发管理平台，实现：

- 多项目管理。
- GitHub 仓库绑定。
- Agent 角色管理。
- Worker 注册和任务调度。
- Codex SDK 执行。
- 研发任务流转。
- 自动测试。
- PR 创建。
- 人工审批。
- 执行日志和数据持久化。

## 2. 项目实施顺序

### 第一阶段：平台基础能力
建立多项目管理、数据库、GitHub 和 Worker 基础。

### 第二阶段：Codex 执行能力
实现真实代码执行和流式事件回传。

### 第三阶段：Agent 协作
建立产品、架构、开发、测试角色和工作流。

### 第四阶段：交付闭环
实现测试、PR、审批和监控。

### 第五阶段：Fitbest 试点
由研发平台承接真实业务研发任务。

### 第六阶段：平台自我迭代
将研发管理平台自身作为第二试点项目。

---

## 3. 任务优先级定义

P0：第一期必须完成。

P1：第一期基础闭环完成后实施。

P2：后续扩展。

## 4. 开发任务明细

### EPIC-01：工程基础

**ADO-001：创建 GitHub Repository**
- 创建研发平台代码仓库。
- 配置默认分支。
- 配置保护规则。
- 配置 GitHub Actions。

**ADO-002：建立 Monorepo**
- Next.js。
- NestJS。
- Worker。
- Shared Packages。
- TypeScript 配置。

**ADO-003：Docker 开发环境**
- PostgreSQL。
- Redis。
- Object Storage。
- API Server。
- Web Dashboard。

**ADO-004：CI 基础**
- Lint。
- Type Check。
- Unit Test。
- Build Check。

验收：本地开发环境一键启动，CI 基础检查通过。

### EPIC-02：用户和多项目管理

**ADO-010：用户认证**
- 登录。
- Session。
- 用户管理。

**ADO-011：权限系统**
- RBAC。
- Project Membership。
- Project Access Guard。

**ADO-012：项目管理**
- 创建项目。
- 编辑项目。
- 归档项目。
- 项目切换。

**ADO-013：GitHub 仓库绑定**
- GitHub App 授权。
- 仓库列表。
- 仓库绑定。
- 默认分支设置。

**ADO-014：项目 Dashboard**
- 项目状态。
- 任务数量。
- Agent 状态。
- 执行统计。

验收：创建 Fitbest 和 ADO 两个项目，分别绑定独立仓库。

### EPIC-03：Agent Registry

**ADO-020：Agent 岗位管理**
- 岗位模板。
- Agent 实例。
- Agent 启停。

**ADO-021：Agent Version**
- Prompt 版本。
- 模型配置。
- 配置发布。
- 回滚。

**ADO-022：Skill Registry**
- Skill 上传。
- 版本管理。
- 关联 Agent。
- 项目级启用。

**ADO-023：Agent Permission**
- 工具权限。
- 项目授权。
- 执行权限。

验收：不同项目可以使用相同岗位模板和不同 Agent 实例。

### EPIC-04：Task Service

**ADO-030：任务 CRUD**
- 创建。
- 编辑。
- 删除或归档。
- 查询。

**ADO-031：任务依赖**
- 父子任务。
- 前置任务。
- 依赖检查。

**ADO-032：任务分配**
- Agent 分配。
- Worker 分配。
- 优先级。

**ADO-033：任务状态机**
- 状态定义。
- 合法状态转换。
- 状态事件。

**ADO-034：任务事件记录**
- 状态变化。
- 执行日志。
- 结果摘要。

验收：任务生命周期完整可追踪。

### EPIC-05：Worker Gateway

**ADO-040：Worker 注册**
- 注册协议。
- Worker 身份。
- 认证。

**ADO-041：Worker Heartbeat**
- 心跳。
- 在线状态。
- 资源监控。

**ADO-042：Worker Capabilities**
- OS。
- 工具。
- 语言。
- 并发能力。

**ADO-043：Worker Task Dispatch**
- 任务下发。
- 任务领取。
- 任务确认。
- 任务取消。

**ADO-044：Worker Reconnect**
- 断线检测。
- 自动重连。
- 消息补发。

验收：Windows 和 Linux Worker 能够注册、领取任务、反馈状态。

### EPIC-06：Codex Execution

**ADO-050：Codex SDK Integration**
- 安装并锁定 SDK 版本。
- 接入 Codex CLI。
- 建立执行接口。

**ADO-051：Thread Manager**
- 创建 Thread。
- 保存 Thread ID。
- 恢复 Thread。
- 查询执行状态。

**ADO-052：Workspace Manager**
- Clone Repository。
- Git Worktree。
- Branch Management。
- Workspace Cleanup。

**ADO-053：Streaming Event Collector**
- 接收事件。
- 事件编号。
- 事件持久化。
- 实时回传。

**ADO-054：Execution Result Parser**
- 任务结果。
- 文件变更。
- 错误摘要。
- 执行状态。

**ADO-055：Execution Security**
- Docker 隔离。
- 文件权限。
- 网络策略。
- 命令权限。

验收：从 Web 提交真实代码开发任务，Codex 在独立工作区修改代码并返回结果。

### EPIC-07：Agent Orchestrator

**ADO-060：Project Director Agent**
- 用户需求入口。
- 意图识别。
- 项目识别。
- 任务分配。

**ADO-061：Product Manager Agent**
- 需求分析。
- 用户故事。
- 验收标准。

**ADO-062：Architect Agent**
- 技术分析。
- 方案生成。
- 架构评审。

**ADO-063：Developer Agent**
- 调用 Codex。
- 加载技能。
- 执行开发任务。

**ADO-064：QA Agent**
- 测试用例。
- 自动测试。
- 缺陷报告。

**ADO-065：Workflow Orchestration**
- Agent 交接。
- 工作流执行。
- 任务依赖。
- 失败恢复。

验收：输入自然语言需求后，系统能够组织产品、架构、开发和测试岗位完成任务。

### EPIC-08：GitHub Integration

**ADO-070：GitHub App**
- 安装授权。
- Installation Token。
- Repository Access。

**ADO-071：Branch Management**
- 创建任务分支。
- 分支状态查询。
- 推送代码。

**ADO-072：Pull Request**
- 自动创建 PR。
- 关联任务。
- 生成变更摘要。

**ADO-073：Webhook**
- PR Event。
- Push Event。
- Check Event。
- Signature Validation。
- Event Deduplication。

验收：Codex 完成代码任务后，自动创建 GitHub PR。

### EPIC-09：Testing & Approval

**ADO-080：Test Runner**
- Unit Test。
- API Test。
- Static Analysis。

**ADO-081：Test Report**
- 测试结果。
- 失败原因。
- 报告存储。

**ADO-082：Auto Repair Loop**
- 失败反馈。
- 修复任务。
- 有限重试。
- 复测。

**ADO-083：Approval Center**
- 审批申请。
- 同意。
- 拒绝。
- 审批记录。

验收：测试失败能够触发修复，测试通过后进入人工审核。

### EPIC-10：Monitoring & Stability

**ADO-090：Execution Monitoring**
- 实时任务进度。
- Worker 状态。
- Codex 事件。

**ADO-091：Error Management**
- 错误分类。
- 超时。
- 重试。
- 告警。

**ADO-092：Model Usage**
- Token。
- 模型。
- 项目。
- Agent 成本。

**ADO-093：Audit Log**
- 用户操作。
- Agent 操作。
- Worker 操作。
- 审批记录。

**ADO-094：Backup & Recovery**
- PostgreSQL Backup。
- Object Storage Backup。
- 恢复验证。

验收：系统可以监控任务执行，Worker 中断后不会造成不可追踪的数据丢失。

---

## 5. 任务依赖关系

建议按以下顺序实施：

ADO-001 → ADO-002 → ADO-003 → ADO-004

ADO-010 → ADO-011 → ADO-012 → ADO-013

ADO-020 → ADO-021 → ADO-022 → ADO-023

ADO-030 → ADO-031 → ADO-032 → ADO-033 → ADO-034

ADO-040 → ADO-041 → ADO-042 → ADO-043 → ADO-044

ADO-050 → ADO-051 → ADO-052 → ADO-053 → ADO-054

ADO-055 必须在真实代码执行之前完成基础安全验证。

ADO-060 → ADO-061 / ADO-062 → ADO-063 → ADO-064

ADO-070 → ADO-071 → ADO-072 → ADO-073

ADO-080 → ADO-081 → ADO-082 → ADO-083

ADO-090 至 ADO-094 与其他模块并行推进。

注意：上述为逻辑依赖，不代表必须串行开发所有任务。完成共享接口定义后，可将不同模块分配给不同 Worker。

## 6. 初步里程碑

M0：工程基础
- Monorepo。
- Docker。
- CI。

M1：多项目管理
- 用户权限。
- 项目管理。
- GitHub 绑定。

M2：Worker + Codex
- Worker 注册。
- 任务执行。
- Thread 管理。
- 流式事件。

M3：Agent 协作
- 产品。
- 架构。
- 开发。
- 测试。
- 工作流。

M4：研发闭环
- GitHub PR。
- 自动测试。
- 自动修复。
- 人工审批。

M5：Fitbest 试点
- 选择真实业务需求。
- 生成研发任务。
- 完成开发。
- 完成测试。
- 交付真实代码。

M6：平台自我迭代
- 将 ADO 平台后续开发任务交给自己的 Agent 团队。
- 验证多项目协同。
- 验证自主研发能力。

## 7. 试点项目任务规划

### Pilot 01：Fitbest

先选择一个边界明确、可以端到端验收的真实功能需求。

建议优先考虑：
- 一个训练计划相关业务功能。
- 对应前端页面。
- 后端 API。
- 数据库变更。
- 自动化测试。
- 代码 PR。

具体试点功能必须从 Fitbest 当前批准的 PRD 和开发状态中选取，不由 ADO 自行发明新需求。

### Pilot 02：ADO

第二阶段验证：
- 多项目切换。
- Agent 任务管理。
- Codex Worker 稳定性。
- 多 Worker 调度。
- 自动任务闭环。
- 自身代码迭代。

## 8. MVP 总体验收

必须完成：

1. 两个独立项目。
2. 两个独立 GitHub 仓库。
3. 多 Worker 注册。
4. Codex SDK 真实执行。
5. 流式事件反馈。
6. Agent 角色协作。
7. 任务状态管理。
8. 自动化测试。
9. GitHub PR。
10. 人工审批。
11. 执行日志。
12. 项目隔离。
13. 异常恢复。
14. 基本用量统计。
15. 真实业务研发交付。

## 9. 第一阶段不做

- 全自动生产发布。
- 完全自主的项目管理决策。
- 大规模 Agent 群体协商。
- 复杂向量数据库。
- 多云容灾。
- 企业级复杂组织管理。
- 全自动 UI 设计到代码生成的无人审核流程。

## 10. 最终交付标准

所有任务必须具备：

- 任务编号。
- 责任 Agent。
- 任务描述。
- 输入和输出。
- 验收标准。
- 依赖关系。
- 代码分支。
- 测试结果。
- PR 关联。
- 完成状态。

开发完成不能仅以 Agent 宣称完成为依据，必须有代码、测试和交付证据。