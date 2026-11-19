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
```

```bash
export COMPOSE_FILE=compose.yaml:compose.staging.yaml
export COMPOSE_ENV_FILES=.env.staging
docker compose -p ado-staging up -d --build --wait
```

工作台和 `/health` 走 TLS 入口。发布到远端时，将 `ADO_STAGING_BIND` 设置为预发布主机的可达地址，并配置相应防火墙入口。基础 API、数据库、Redis 和对象存储端口绑定在主机回环地址。网关转发 Worker WebSocket、归档上传与签名 Webhook。 [Nginx WebSocket 转发](https://nginx.org/en/docs/http/websocket.html)

## 接入 Worker 与验收

按 [Windows + WSL2 Worker 安装与运行手册](windows-wsl-worker.md) 创建预发布专用实例。在预发布项目生成注册凭证，把 `API_BASE_URL` 设置为 HTTPS 网关地址，并在 Worker 上配置该证书的信任链。工作台中确认注册、心跳、Codex 能力和项目授权，然后派发一项人已审批的任务，检查 Worker 重连、离线检查、受测补丁和复验证据。

本机演练可通过 `ADO_VERIFY_WORKER_URL=https://127.0.0.1:3443` 和 `NODE_EXTRA_CA_CERTS` 运行 Worker 协议检查。`scripts/verify-workers.mjs` 通过回环 TCP 转发器测试断线重连，使用证书包含的回环主机名。`scripts/verify-executions.mjs` 可使用同一 Compose 网络的 HTTPS 网关地址，证书须包含所用名称。协议夹具覆盖 WebSocket 领任务、事件回传、HTTPS 补丁上传和人工审核。Node 需在启动时加载 CA。

```bash
ADO_VERIFY_API_URL=http://127.0.0.1:43101 \
ADO_VERIFY_WORKER_URL=https://127.0.0.1:3443 \
NODE_EXTRA_CA_CERTS=/absolute/path/to/staging-ca.crt \
  node --env-file=.env.staging scripts/verify-workers.mjs
```

## 检查运行异常和备份恢复

从网关探测 `/health` 并检查 `docker compose -p ado-staging ps`；将探测失败配置为部署环境的服务告警。工作台项目概览的「需要处理」列出规划、执行、QA 和发布失败，以及缺少兼容 Worker 的排队任务。处理时先核对 Worker 心跳、执行租约、错误分类和发布状态，再决定重试或重新分配。

备份命令会短暂停止该 Compose 项目中的写入服务。安排可接受的窗口，在继续使用同一组 Compose 文件和预发布环境配置时执行。

```bash
bash scripts/compose-backup.sh backup ado-staging /absolute/path/to/ado-staging-snapshot
WEB_PORT=53100 API_PORT=53101 POSTGRES_PORT=55432 REDIS_PORT=56379 S3_PORT=59000 ADO_STAGING_PORT=5443 \
  bash scripts/compose-backup.sh restore ado-staging-restore /absolute/path/to/ado-staging-snapshot
```

恢复目标使用新项目名和端口。核对项目、任务、执行记录、补丁摘要和复验证据，并尝试下载归档补丁。使用备份中的账号登入恢复实例。恢复流程会禁用外部模型和 GitHub 集成，重新接入由项目所有者决定。
