# ADO PR 门禁与预发布

`main` 保留严格分支保护及必需检查 `checks` 和 `compose`。PR CI 使用 GitHub 托管 runner。ADO 保留任务批准、补丁评审和归档，PR 的审批与合并由独立的发布 App 执行。

## PR 放行

在 `release-gate` 环境中配置 `RELEASE_APP_ID`、`RELEASE_APP_KEY` 和 `RELEASE_GATE_SECRET`。发布 App 只安装到 `shinelincx/aiplatform`，其权限为 Contents、Pull requests 和 Checks 写入以及 Actions 读取。在预发布配置配对的 `ADO_RELEASE_GATE_SECRET` 和 ADO 项目 ID。

自动放行要求当前提交的 CI 通过，并匹配 ADO 已批准归档。门禁检查完整的 PR 差异，数据库文件、SQL、数据库访问或连接配置改动以及无法完整核验的差异交负责人处理。负责人可从 `main` 手动运行「ADO merge gate」，输入 PR 编号和核准的完整 SHA，为该提交签发门禁结果，随后人工合并。校验失败时检查该工作流日志和 PR 的检查详情。

先在一次低风险机器人 PR 上验证自动审批和合并。验证成功后，将 `ado-merge-gate` 加为 `main` 的必需检查，来源绑定发布 App。审批、门禁和测试均绑定当前 PR 提交。

## 自动部署

`main` 的 CI 构建并以生产启动方式检查镜像。主分支的 `publish` 作业发布同一个受测镜像到 GHCR。启用仓库变量 `STAGING_CD_ENABLED=true` 后，`deploy-staging` 经 SSH 传送镜像归档和 GHCR digest。预发布主机校验归档 SHA-256，导入本地镜像层，再用 GHCR digest 核对并启动版本。

`staging` 环境仅允许 `main`。环境变量 `STAGING_SSH_HOST_KEY` 保存已核验的 SSH 主机公钥。环境机密 `STAGING_SSH_KEY` 对应独立的服务器公钥，服务端为它配置 `restrict,command="/opt/ado-staging/config/deploy-staging-release.sh"`。服务端安装审阅过的发布脚本，并保留现有 Compose 启动器和回退版本。

待处理任务排空后才会切换 API 和 Web。切换后验证健康接口、生产页面、数据库版本、存储容器和此前在线的 Worker。失败时恢复上一个版本。数据库迁移、Worker 源码和 TLS 网关配置的调整使用单独的协调发布。
