# ADO Post-MVP Execution Package V1.0

状态：规划包；所有实施和外部资源状态 **未核实**。路线图是冻结的规划基线，不是完成证明。适用前提是 MVP 验收有可核验证据。来源：对话《Codex SDK 用途》，Post-MVP Evolution Roadmap V1.0；五项基础设计 V1.0。此包为派生执行计划，不替代原始批准文件。对话预览中的基础设计长消息有截断，完整的五项原文件必须在执行前取得、核对；找不到则记录缺口并阻止依赖它的决策。

## 执行顺序
1. 阅读本文件、`00-Governance/ROADMAP_BASELINE.md`、`EXECUTION_RULES.md`、`APPROVAL_POLICY.md`。
2. 使用 `06-Prompts/MASTER_KICKOFF_PROMPT.md`：只读检查授权的 ADO 和 Fitbest 仓库、批准文件、五项基础交付物和 MVP 验收证据；记录来源、版本、提交、访问限制、证据及未知项。缺少授权或材料时停止依赖该材料的工作并请求获取。
3. 建立事实/差距报告，确认 MVP 门；选择并建议一个批准范围内的 Fitbest 任务。没有具体任务的批准范围与实际状态证据前不得选定实现方案。
4. 依次执行 P1–P5 计划；阶段可以在不跨越前置门禁的条件下准备，阶段验收须按顺序通过。先完成 G1 需求、G2 设计，再实施及 G3 开发、G4 交付。
5. 从 `03-Backlog/issues/` 复制 Issue；用 `04-Configuration/backlog.json` 或 `.yaml` 机器读取。创建远程 Issue、分支或 PR 需确认环境授权；本包不声称它们已经存在。每次只执行已就绪且获适当授权的任务。
6. 使用 `05-Acceptance` 验证并记录证据、决策和审批；再使用 `06-Prompts` 的阶段或任务指令。

## 文件约定
- `00-Governance`：基线、规则、审批；`01-Execution-Plan`：逐阶段计划；`02-Agent-Instructions`：岗位；`03-Backlog`：可复制 Issues；`04-Configuration`：JSON 与等价 YAML 1.2（JSON 表达）；`05-Acceptance`：验收；`06-Prompts`：复制即用。
- 配置是静态计划数据，不能自行授予权限或假装连接了服务。每条任务初始 `planned`，代表包内计划，实际状态未知；以带证据的真实系统状态为准。优先级 P0/P1/P2 表示紧急程度，不是阶段 P1/P2。
- 状态标记：CONFIRMED＝对话明确的决策或路线图基线；PLANNED＝待实施；ASSUMPTION＝待验证；OPEN＝缺失信息；VERIFIED＝带证据核实；BLOCKED＝缺依赖或授权。禁止将计划或假设标为已完成。
- 基线变更需人工明确批准，先建立变更提案并保留原版本；Fitbest 冻结 PRD 不得直接编辑。版本号与周期均为路线图建议，并非真实发布或承诺。
