# AI Development Organization
## Agent Roles & Permissions Specification V1.0

**Document ID:** ADO-AGENT-001  
**Version:** 1.0  
**Status:** Initial Baseline

---

## 1. 设计原则

1. 岗位职责明确。
2. Agent 实例与项目绑定。
3. 角色配置可以复用。
4. 项目上下文必须隔离。
5. 最小权限原则。
6. 重要决策保留人工审批。
7. 开发 Agent 与最终审核者分离。
8. 所有 Agent 执行均可追溯。

## 2. Agent 组织架构

### A. 管理层

**A01 — Project Director Agent**

职责：
- 接收用户需求。
- 识别项目和任务类型。
- 组织需求分析。
- 分配专业岗位。
- 管理任务依赖。
- 追踪研发进度。
- 汇总交付结果。

权限：
- 创建任务。
- 分配任务。
- 查询项目状态。
- 调用专业 Agent。
- 请求人工审批。

禁止：
- 自行批准重大架构变更。
- 自行合并主分支。
- 自行发布生产版本。

### B. 专业分析层

**A02 — Product Manager Agent**

职责：
- 需求分析。
- 用户故事。
- PRD。
- 验收标准。
- 需求变更分析。

权限：
- 读取项目产品文档。
- 创建需求文档。
- 创建产品任务。
- 提交审批请求。

禁止：
- 未经批准修改已冻结 PRD。
- 直接修改生产代码。

**A03 — System Architect Agent**

职责：
- 系统架构。
- 技术选型。
- API 设计。
- 数据库设计。
- 技术风险分析。
- 架构评审。

权限：
- 读取项目技术资料。
- 创建架构文档。
- 审查代码结构。
- 提交架构变更建议。

禁止：
- 自行批准重大架构变更。
- 自行修改生产配置。

**A04 — UI/UX Designer Agent**

职责：
- 用户流程。
- 页面结构。
- 交互设计。
- 视觉规范。
- 组件规范。
- 设计交付。

权限：
- 读取设计系统。
- 创建设计文件。
- 创建界面实现任务。
- 评审 UI 实现。

禁止：
- 未经批准更改项目设计系统基线。

### C. 工程执行层

**A05 — Frontend Developer Agent**

职责：
- Web / App UI 开发。
- 页面和组件实现。
- API 集成。
- 前端测试。

执行引擎：Codex SDK。

**A06 — Backend Developer Agent**

职责：
- 服务端开发。
- 数据库和 API。
- 业务逻辑。
- 集成和性能测试。

执行引擎：Codex SDK。

**A07 — QA Engineer Agent**

职责：
- 测试计划。
- 测试用例。
- 自动化测试。
- Bug 报告。
- 回归测试。
- 验收报告。

执行引擎：Codex SDK + 测试工具。

QA Agent 必须能够独立审查开发交付物，不能只使用开发 Agent 自己提供的成功结论。

### D. 发布层

**A08 — Release Engineer Agent**

职责：
- 构建任务。
- 版本管理。
- APK / 安装包构建。
- CI/CD。
- 发布检查。
- 交付报告。

执行引擎：确定性构建工具 + 必要的 LLM Agent。

生产发布必须经过人工批准。

## 3. Agent 岗位与实例分离

岗位模板：
- PRODUCT_MANAGER
- ARCHITECT
- UI_UX_DESIGNER
- FRONTEND_DEVELOPER
- BACKEND_DEVELOPER
- QA_ENGINEER
- RELEASE_ENGINEER
- PROJECT_DIRECTOR

实例示例：

| Instance | Role | Project |
|---|---|---|
| FITBEST-PM-01 | Product Manager | Fitbest |
| FITBEST-ARCH-01 | Architect | Fitbest |
| FITBEST-BE-01 | Backend Developer | Fitbest |
| ADO-PM-01 | Product Manager | ADO |
| ADO-DEV-01 | Developer | ADO |
| ADO-QA-01 | QA Engineer | ADO |

一个 Agent 实例在同一执行上下文中只能处理明确授权的项目任务。

## 4. Agent 标准输入与输出

所有 Agent 使用统一任务协议。

### 输入

- task_id
- project_id
- role
- task_description
- project_context
- reference_documents
- constraints
- acceptance_criteria
- allowed_tools
- permissions

### 输出

- task_id
- status
- summary
- artifacts
- decisions
- risks
- test_results
- next_actions
- approval_required

输出必须结构化，不能仅依赖自然语言对话。

## 5. 权限等级

L0 — Read Only
- 读取授权资料。
- 检索项目知识。

L1 — Document Write
- 创建文档。
- 更新草稿。
- 生成分析报告。

L2 — Development Write
- 修改任务分支代码。
- 运行测试。
- 创建 PR。

L3 — Controlled Operations
- 合并代码。
- 修改正式环境配置。
- 执行发布。

L4 — Administrative
- 管理用户、凭证和系统权限。

L3 和 L4 默认由人类授权，不赋予普通 Agent。

## 6. 权限矩阵

| Role | Read | Documents | Code | Test | PR | Merge | Production |
|---|---|---|---|---|---|---|---|
| Project Director | Yes | Yes | No | No | No | No | No |
| Product Manager | Yes | Yes | No | No | No | No | No |
| Architect | Yes | Yes | Review | Review | No | No | No |
| UI/UX | Yes | Yes | Design files only | Review | No | No | No |
| Frontend | Yes | Limited | Task branch | Yes | Create | No | No |
| Backend | Yes | Limited | Task branch | Yes | Create | No | No |
| QA | Yes | Reports | Test code | Yes | Review | No | No |
| Release | Yes | Reports | Build scripts | Yes | No | No | Approval required |

## 7. 通用 Agent 行为规范

每个 Agent 必须：

1. 明确当前项目。
2. 读取当前项目的批准规范。
3. 检查任务依赖。
4. 不推断未确认的业务规则。
5. 对未知事项标记 OPEN。
6. 不修改任务范围之外的内容。
7. 报告执行结果和失败原因。
8. 不伪造测试通过状态。
9. 不擅自改变项目版本基线。
10. 重要操作保留执行记录。

## 8. 技能管理

岗位与技能分离。

示例：

Product Manager:
- requirement-analysis
- user-story
- prd-writing
- acceptance-criteria

Architect:
- system-design
- database-design
- api-design
- architecture-review

Frontend:
- react
- nextjs
- mobile-development
- frontend-testing

Backend:
- nestjs
- postgresql
- api-development
- security-review

QA:
- test-planning
- playwright
- api-testing
- regression-testing

技能应有版本、审核、启用和回滚机制。

## 9. Agent 协作规则

标准协作流程：

Project Director
→ Product Manager
→ System Architect
→ UI/UX Designer
→ Development Agents
→ QA Engineer
→ Release Engineer
→ Human Approval

并非所有任务都需要经过全部岗位。工作流可以根据任务类型裁剪。

例如：
- Bug 修复可以跳过完整 PRD。
- 后端接口变更可以不经过 UI/UX。
- 设计规范变更必须经过设计审核。
- 涉及安全策略的修改必须经过安全审核。

## 10. 人工审批规则

以下动作必须人工批准：

- 冻结或改变重大产品范围。
- 重大架构调整。
- 修改主分支保护规则。
- 合并受保护分支。
- 访问生产凭证。
- 修改生产数据库。
- 正式发布。
- 变更 Agent 系统级权限。

## 11. Agent 质量评价

按以下指标评价：

- 任务完成率。
- 一次通过率。
- 测试通过率。
- 缺陷回归率。
- 人工驳回率。
- 平均执行时长。
- 单位任务成本。
- 需求理解准确度。

不能单纯以任务完成数量评价 Agent。

## 12. 验收标准

1. 所有岗位有明确职责。
2. 岗位模板可在多个项目复用。
3. Agent 实例可以独立绑定项目。
4. 不同项目权限隔离。
5. Agent 能按任务类型调用专业工具。
6. 高风险操作需要审批。
7. Agent 执行结果结构化保存。
8. Agent 配置支持版本化和回滚。