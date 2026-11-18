# ADO 研发平台

Web 工作台支持登录、切换项目、管理成员、绑定 GitHub 仓库及维护研发任务。Worker 支持项目授权、注册、心跳和断线重连，任务派发和 Codex 执行仍在 M2 实现。

## 启动开发环境

在仓库根目录运行以下命令，需要 Docker Engine 或 Docker Desktop 和 Docker Compose v2（支持 `--wait`）。

```sh
docker compose up --build --wait
```

打开 [Web 控制台](http://127.0.0.1:3100) 查看 API 状态并登录。也可直接访问 [API 健康接口](http://127.0.0.1:3101/health)。

首次登录前，将 `.env.example` 复制为 `.env`，设置 `ADO_BOOTSTRAP_EMAIL` 和至少 12 字符的 `ADO_BOOTSTRAP_PASSWORD`，再启动 Compose。API 启动时自动执行 PostgreSQL 迁移。首次启动创建管理员后，可以清空启动账号环境变量并重启，现有账号与项目继续保存在 PostgreSQL。

管理员可创建 Fitbest、ADO 项目和用户账号。项目创建者拥有项目所有者权限，可添加成员或只读用户。项目列表和仓库信息按成员关系过滤。归档项目保留历史并停止接受设置变更。

仓库绑定使用安装到目标仓库的 GitHub App。仅授予已选目标仓库 `Metadata: Read` 和 `Contents: Read`，并在 `.env` 设置 `GITHUB_APP_ID` 与 `GITHUB_APP_PRIVATE_KEY` 后重启。管理员在自己拥有的项目中可选择安装、仓库与分支。API 会核实分支存在，同一个 GitHub 仓库只允许绑定到一个项目。

在项目中创建任务时，可以记录优先级、验收条件、仓库、父任务和前置任务。任务由草稿进入规划，提交后由项目所有者审批，所有状态变更保存在任务记录中。前置任务完成后才能批准关联任务进入待派发状态。

| 服务 | 宿主机端口 | 容器内地址或开发默认值 |
| --- | --- | --- |
| Web | 3100 | `web:3000` |
| NestJS API | 3101 | `api:3101` |
| PostgreSQL | 15432 | `postgres:5432`，数据库和用户均为 `ado` |
| Redis | 16379 | `redis:6379` |
| S3 兼容对象存储（SeaweedFS） | 19000 | `http://storage:8333`，桶为 `ado-dev` |

端口只绑定宿主机回环地址。在根目录的 `.env` 可以覆盖 `WEB_PORT`、`API_PORT`、`POSTGRES_PORT`、`REDIS_PORT` 和 `S3_PORT`。本地数据库密码默认为 `ado-local-dev`，对象存储开发密钥默认为 `ado-local` / `ado-local-dev`。首次启动前可设置 `POSTGRES_PASSWORD`、`S3_ACCESS_KEY` 和 `S3_SECRET_KEY`。

```sh
docker compose ps
docker compose exec api npm run dev -w @ado/worker
docker compose logs -f api web
docker compose down
```

API 和 Web 源码挂载到开发容器。修改共享包、依赖或配置后重新运行启动命令。数据库、Redis 和对象存储使用命名卷，普通 `docker compose down` 保留数据。

## 注册 Worker

项目所有者可在工作台的“项目 Worker”中生成注册凭证。将 `ADO_WORKER_ID` 和 `ADO_WORKER_TOKEN` 加入 Worker 进程的环境变量，从仓库根目录执行以下命令。

```sh
npm ci
npm run build:shared
npm run dev -w @ado/worker
```

默认 API 地址为 `http://127.0.0.1:3101`，可用 `API_BASE_URL` 覆盖。远程 Worker 使用 HTTPS 或 WSS 地址，由提供 TLS 的代理转发 `/workers/ws`。注册后可在项目工作台看到平台、架构和在线状态。凭证有效期为 8 小时，更新凭证会使旧凭证失效。项目所有者可撤回该项目的授权。

## Monorepo 与 CI

使用 Node.js 24 和 npm workspaces，在仓库根目录安装并验证所有包。

```sh
npm ci
npm run check
```

| Workspace | 目录 | 职责 |
| --- | --- | --- |
| `@ado/web` | `apps/web` | Next.js 开发控制台 |
| `@ado/api` | `apps/api` | NestJS API 和 `GET /health` |
| `@ado/worker` | `apps/worker` | Node.js Worker 注册、心跳、重连和连通检查 |
| `@ado/shared` | `packages/shared` | Web、API、Worker 共用的数据类型和协议 |

`npm run check` 依次执行 ESLint、TypeScript 类型检查、Vitest 单元测试和全部应用构建。GitHub Actions 在 push、pull request 或手动触发时运行同一组检查，并从干净的 Compose 环境验证 Web 登录、会话撤销、项目隔离和 Worker 注册及重连。集成验证脚本会创建测试用户和项目，建议在独立 Compose 实例中执行。
