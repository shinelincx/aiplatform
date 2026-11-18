# ADO 研发平台

M0 工程基线。Web 和 Worker 可以检查控制面 API 的连通性。Worker 在本阶段是一次性自检命令，注册、心跳和任务执行在 M2 接入。

## 启动开发环境

在仓库根目录运行以下命令，需要 Docker Engine 或 Docker Desktop 和 Docker Compose v2（支持 `--wait`）。

```sh
docker compose up --build --wait
```

打开 [Web 控制台](http://127.0.0.1:3100)，点击“重新检查”可获取最新 API 状态。也可以直接访问 [API 健康接口](http://127.0.0.1:3101/health)。

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
| `@ado/worker` | `apps/worker` | Node.js Worker 入口及 API 连通检查 |
| `@ado/shared` | `packages/shared` | Web、API、Worker 共用的健康响应契约 |

`npm run check` 依次执行 ESLint、TypeScript 类型检查、Vitest 单元测试和全部应用构建。GitHub Actions 在 push、pull request 或手动触发时运行同一组检查，并在独立任务中从干净环境启动 Compose、验证 Web 到 API 及 Worker 到 API 的连通性。
