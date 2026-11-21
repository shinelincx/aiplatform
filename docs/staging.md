# ADO 预发布环境

预发布环境使用独立的 Compose 项目名、端口、镜像标签、数据卷和凭证。入口为 HTTPS，Worker 通过同一地址建立 WSS 连接。

## 启动控制面

将 TLS 证书链和私钥分别保存为私有目录中的 `tls.crt`、`tls.key`。证书签发名称应与 Worker 和浏览器使用的域名一致。本机演练可使用受测试客户端信任的临时 CA。工作台启用 Secure Cookie。

在 WSL 或 Linux 把下面的配置按需填入私有 `.env.staging`，为数据库、对象存储和工作台使用独立的密码。管理 GitHub 绑定和模型调用前，为预发布单独配置安装范围和模型凭证。

```dotenv
WEB_PORT=43100
API_PORT=43101
POSTGRES_PORT=45432
REDIS_PORT=46379
S3_PORT=49000
ADO_STAGING_PORT=3443
ADO_STAGING_BIND=127.0.0.1
ADO_STAGING_TLS_DIR=/absolute/path/to/staging-tls
POSTGRES_PASSWORD=<迁移账号密码>
ADO_DATABASE_PASSWORD=<API 账号的独立密码，至少 12 字符>
```

```bash
export COMPOSE_FILE=compose.yaml:compose.staging.yaml
export COMPOSE_ENV_FILES=.env.staging
docker compose -p ado-staging up -d --build --wait
```

Compose 先运行一次性 `migrate` 服务，用现有 `POSTGRES_PASSWORD` 执行数据库迁移，并配置独立的 `ado_api` 账号。API 使用 `ADO_DATABASE_PASSWORD`。如果 `migrate` 失败，先查看 `docker compose -p ado-staging logs migrate`。API 启动时验证数据库角色和 schema 版本。

从 V19 升级到 V20 时，先排空队列，用旧版本的备份工具生成 PostgreSQL 和对象存储快照，再用新版 Compose 停写切换。迁移后核查 API 健康、项目用量和归档读取，并确认受限账号只在授权项目范围内读写。回退时停止写入，用 V19 程序和配置恢复升级前快照到独立实例，核对数据和归档后再切换入口。回退快照之后产生的数据需按回退决策单独处理。

工作台和 `/health` 走 TLS 入口。发布到远端时，将 `ADO_STAGING_BIND` 设置为预发布主机的可达地址，并配置相应防火墙入口。基础 API、数据库、Redis 和对象存储端口绑定在主机回环地址。网关转发 Worker WebSocket、归档上传与签名 Webhook。 [Nginx WebSocket 转发](https://nginx.org/en/docs/http/websocket.html)

预发布容器随 Docker 恢复运行。网关通过 Compose 的 DNS 跟踪 API 和 Web 容器地址，容器重建后仍使用原来的入口域名。主动停止的服务用 `docker compose -p ado-staging up -d --wait` 恢复。 [Docker 容器重启策略](https://docs.docker.com/engine/containers/start-containers-automatically/) · [Nginx 动态解析上游](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#resolve)

## 接入 Worker 与验收

按 [Windows + WSL2 Worker 安装与运行手册](windows-wsl-worker.md) 创建预发布专用实例。在预发布项目生成注册凭证，把 `API_BASE_URL` 设置为 HTTPS 网关地址。若使用私有 CA，将 CA 证书保存为实例目录下的 `ca.crt`。从独立 Worker 主机接入后，在工作台确认两个项目各自的注册、心跳、Codex 能力和项目授权。分别派发一项已人工审批的业务任务，记录需求链接、Worker 心跳、离线检查结果、补丁哈希和人工复验证据。

跨主机验收时，从 Worker 主机运行下节的 HTTPS 探针。记录控制面和 Worker 的主机标识以及重启前后的心跳时间。任务执行完成后，在审批当前候选前录入与补丁哈希对应的人工复验证据。只演练到候选审批时，在预发布的仓库绑定中关闭自动草稿 PR。

在预发布控制面主机上，用两个项目的管理员账号运行预检。只演练到候选审批时，GitHub App 安装只需读取两个目标仓库的 Contents 权限。预检检查只读签出权限、自动草稿 PR 已关闭、已登记的需求、规划模型、离线检查计划以及符合条件的两台 Worker。 [GitHub App 安装权限](https://docs.github.com/en/rest/apps/apps#list-installations-for-the-authenticated-app)

```bash
node --env-file=.env.staging scripts/verify-pilots.mjs --staging --preflight
```

试运行完成后，依次传入 Fitbest 和 ADO 的任务编号以核对结果。

```bash
node --env-file=.env.staging scripts/verify-pilots.mjs --staging FITBEST_TASK_CODE ADO_TASK_CODE
```

脚本检查两项需求出处、人工审批、两台不同的在线执行 Worker、离线检查计划、QA 和归档补丁。它下载归档校验 SHA-256，并核对人工证据是否记录在当前候选上。API 默认通过预发布环境的 `API_PORT` 在本机访问，可用 `ADO_VERIFY_API_URL` 指定地址。查看正式交付的 GitHub 证据时，使用 README 中的试点验收命令。

CI 的 `compose` 作业通过 HTTPS 网关验证 Secure Cookie、Worker 注册与重连、领任务、事件回传、补丁上传、人工审核、探测失败和备份恢复。本机可用下面的命令复验 Worker 协议。`scripts/verify-workers.mjs` 通过回环 TCP 转发器测试断线重连，证书须包含测试使用的回环地址。Node 在进程启动时加载 CA。

```bash
ADO_VERIFY_API_URL=http://127.0.0.1:43101 \
ADO_VERIFY_WORKER_URL=https://127.0.0.1:3443 \
NODE_EXTRA_CA_CERTS=/absolute/path/to/staging-ca.crt \
  node --env-file=.env.staging scripts/verify-workers.mjs
```

## 检查运行异常和备份恢复

用以下命令从待部署网络探测 HTTPS 入口。它校验 TLS 证书，并在 `/health` 或工作台首页未返回 HTTP 200 时以非零状态退出。可将该退出状态接入部署环境的告警。私有 CA 环境设置 `CURL_CA_BUNDLE=/absolute/path/to/staging-ca.crt`。

```bash
bash scripts/probe-staging.sh https://staging.example.com:3443
```

检查 `docker compose -p ado-staging ps` 确认组件健康。工作台项目概览的「需要处理」列出规划、执行、QA 和发布失败，以及缺少兼容 Worker 的排队任务。处理时先核对 Worker 心跳、执行租约、错误分类和发布状态，再决定重试或重新分配。

备份命令会短暂停止该 Compose 项目中的写入服务。安排可接受的窗口，在继续使用同一组 Compose 文件和预发布环境配置时执行。

```bash
bash scripts/compose-backup.sh backup ado-staging /absolute/path/to/ado-staging-snapshot
WEB_PORT=53100 API_PORT=53101 POSTGRES_PORT=55432 REDIS_PORT=56379 S3_PORT=59000 ADO_STAGING_PORT=5443 \
  bash scripts/compose-backup.sh restore ado-staging-restore /absolute/path/to/ado-staging-snapshot
```

恢复目标使用新项目名和端口。核对项目、任务、执行记录、补丁摘要和复验证据，并尝试下载归档补丁。使用备份中的账号登入恢复实例。恢复流程会禁用外部模型和 GitHub 集成，重新接入由项目所有者决定。
