# Master Backlog

所有条目为计划，真实状态未核实。完整 Issue 和字段见 `issues/`、`../04-Configuration/backlog.json`。标签是建议值，尚未创建。

| ID | 阶段 | 任务 | 角色 | 优先级 | 依赖 |
|---|---|---|---|---|---|
| [B00](issues/B00.md) | MVP | 核查 MVP 与两项目基线 | PROJECT_DIRECTOR | P0 | — |
| [P1-01](issues/P1-01.md) | P1 | 接入核查与项目隔离 | PROJECT_DIRECTOR | P0 | B00 |
| [P1-02](issues/P1-02.md) | P1 | 核对冻结 PRD 与选择试点 | PRODUCT_MANAGER | P0 | P1-01 |
| [P1-03](issues/P1-03.md) | P1 | 架构和接口方案 | ARCHITECT | P0 | P1-02 |
| [P1-04](issues/P1-04.md) | P1 | 用户流程与设计核对 | UI_UX | P1 | P1-02 |
| [P1-05](issues/P1-05.md) | P1 | 实现前端增量 | DEVELOPER | P1 | P1-03, P1-04 |
| [P1-06](issues/P1-06.md) | P1 | 实现后端与接口增量 | DEVELOPER | P1 | P1-03 |
| [P1-07](issues/P1-07.md) | P1 | 独立端到端 QA | QA | P0 | P1-05, P1-06 |
| [P1-08](issues/P1-08.md) | P1 | PR、人工验收与交付 | RELEASE | P0 | P1-07 |
| [P2-01](issues/P2-01.md) | P2 | 岗位标准与重复性评估 | PROJECT_DIRECTOR | P1 | P1-08 |
| [P2-02](issues/P2-02.md) | P2 | 技能生命周期 | ARCHITECT | P1 | P2-01 |
| [P2-03](issues/P2-03.md) | P2 | 设计系统治理 | UI_UX | P1 | P2-01 |
| [P2-04](issues/P2-04.md) | P2 | 自动质量门禁 | QA | P0 | P2-01 |
| [P2-05](issues/P2-05.md) | P2 | 项目知识治理 | ARCHITECT | P0 | P2-01 |
| [P2-06](issues/P2-06.md) | P2 | 能力阶段验收 | QA | P0 | P2-02, P2-03, P2-04, P2-05 |
| [P3-01](issues/P3-01.md) | P3 | 选择 ADO 升级并评估权限 | PRODUCT_MANAGER | P0 | P2-06 |
| [P3-02](issues/P3-02.md) | P3 | 平台增量设计与实现 | DEVELOPER | P1 | P3-01 |
| [P3-03](issues/P3-03.md) | P3 | 双项目与 Worker 故障测试 | QA | P0 | P3-02 |
| [P3-04](issues/P3-04.md) | P3 | 自我迭代交付与验收 | RELEASE | P0 | P3-03 |
| [P4-01](issues/P4-01.md) | P4 | 资源池与调度设计 | ARCHITECT | P1 | P3-04 |
| [P4-02](issues/P4-02.md) | P4 | 项目接入与隔离验证 | DEVELOPER | P0 | P4-01 |
| [P4-03](issues/P4-03.md) | P4 | 成本预算与资源冲突 | DEVELOPER | P1 | P4-01 |
| [P4-04](issues/P4-04.md) | P4 | 规模化阶段验收 | QA | P0 | P4-02, P4-03 |
| [P5-01](issues/P5-01.md) | P5 | 监测与改进建议 | PRODUCT_MANAGER | P1 | P4-04 |
| [P5-02](issues/P5-02.md) | P5 | 自主权限与风险策略 | ARCHITECT | P0 | P5-01 |
| [P5-03](issues/P5-03.md) | P5 | 受控低风险执行试验 | DEVELOPER | P1 | P5-02 |
| [P5-04](issues/P5-04.md) | P5 | 主动研发阶段验收 | QA | P0 | P5-03 |
