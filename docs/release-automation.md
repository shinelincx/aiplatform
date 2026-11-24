# ADO PR 门禁与预发布

`main` 保留严格分支保护及必需检查 `checks` 和 `compose`。PR CI 使用 GitHub 托管 runner。ADO 保留任务批准、补丁评审和归档，PR 的审批与合并由独立的发布 App 执行。

## PR 放行

在 `release-gate` 环境中配置 `RELEASE_APP_ID`、`RELEASE_APP_KEY` 和 `RELEASE_GATE_SECRET`。发布 App 只安装到 `shinelincx/aiplatform`，其权限为 Contents、Pull requests 和 Checks 写入以及 Actions 读取。在预发布配置配对的 `ADO_RELEASE_GATE_SECRET` 和 ADO 项目 ID。

自动放行要求当前提交的 CI 通过，并匹配 ADO 已批准归档。门禁检查完整的 PR 差异，数据库文件、SQL、数据库访问或连接配置改动以及无法完整核验的差异交负责人处理。负责人可从 `main` 手动运行「ADO merge gate」，输入 PR 编号和核准的完整 SHA，为该提交签发门禁结果，随后人工合并。校验失败时检查该工作流日志和 PR 的检查详情。

先在一次低风险机器人 PR 上验证自动审批和合并。验证成功后，将 `ado-merge-gate` 加为 `main` 的必需检查，来源绑定发布 App。审批、门禁和测试均绑定当前 PR 提交。

## 自动部署

`main` 的 CI 构建并以生产启动方式检查镜像。主分支的 `publish` 作业发布同一个受测镜像到 GHCR。启用仓库变量 `STAGING_CD_ENABLED=true` 后，`deploy-staging` 经 SSH 传送镜像归档和 GHCR digest。预发布主机校验归档 SHA-256，导入本地镜像层，再用 GHCR digest 核对并启动版本。

`staging` 环境仅允许 `main`。环境变量 `STAGING_SSH_HOST_KEY` 保存已核验的 SSH 主机公钥。环境机密 `STAGING_SSH_KEY` 对应独立的服务器公钥，服务端为它配置 `restrict,command="/opt/ado-staging/config/deploy-staging-release.sh"`。服务端安装审阅过的发布脚本，并保留现有 Compose 启动器和回退版本。

待处理任务排空后才会切换 API 和 Web。切换后验证健康接口、生产页面、数据库版本、存储容器和此前在线的 Worker。普通部署失败时恢复上一个版本。Worker 源码、TLS 网关或预发布 Compose 配置的调整由运维协调发布。

## 数据库迁移的发布审批

主分支发布镜像后，CI 对比运行中的版本，发现数据库迁移文件有变更时，会在「设置 → 系统任务 → 预发布审批」登记待办。系统管理员核对提交、镜像摘要、关联 PR、迁移差异和备份计划，再在维护窗口批准。批准触发独立的 **Staging migration** 工作流。驳回须填写原因。原业务任务的交付详情会显示发布状态、审批人和部署日志。

### 首次启用

1. 通过现有的 [预发布协调发布流程](staging.md) 安装包含审批表的版本。先备份再迁移，保留对应镜像和升级前快照。
2. 在预发布 API 配置 `ADO_STAGING_RELEASE_SECRET` 和 `ADO_STAGING_WORKFLOW_TOKEN`。前者是专用的高熵凭证，至少 32 个字符。后者是仅限此仓库、具有 Actions 写权限的凭证。重建 API 以加载配置。
3. 在 GitHub Actions 仓库机密中配置与 API 一致的 `STAGING_RELEASE_SECRET`。环境只允许 `main`，使用预发布环境相同的 `STAGING_SSH_HOST_KEY` 变量，并以 `STAGING_MIGRATION_SSH_KEY` 配置独立 SSH 密钥。按团队发布要求配置环境审阅人。
4. 在预发布主机安装审阅过的 `scripts/deploy-staging-release.sh`。普通密钥继续使用原有强制命令。迁移密钥使用 `restrict,command="ADO_STAGING_DEPLOY_MODE=migration /opt/ado-staging/config/deploy-staging-release.sh"`，只接受工作流发出的 `deploy-ado-migrate` 命令。确认 `/opt/ado-staging/compose.sh` 加载当前版本的 `compose.web-production.yaml`。
5. 确认主机和 API 已准备好后，将仓库变量 `STAGING_MIGRATION_ENABLED` 设为 `true`。下一次 `main` 的镜像发布会检查迁移差异。若部署尚未开始且提交仍是 `main`，管理员可以在原审批单重新触发。工作流只允许一次部署领取。

迁移时，主机校验提交仍在 `main` 且预发布仍是审批时的基线，排空队列后停写，并将数据库和对象存储备份保存在 `/opt/ado-staging/backups`。工作流使用获批镜像执行迁移。确认数据库未迁移时，主机尝试恢复旧应用。迁移可能已经生效时，保留快照并按 [预发布恢复手册](staging.md) 协调恢复。
