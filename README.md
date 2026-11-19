# ADO 研发平台

Web 工作台支持登录、项目权限、仓库绑定、任务审批、派发和执行记录。Worker 支持项目授权、注册、心跳和断线重连。

## 启动开发环境

在仓库根目录运行以下命令，需要 Docker Engine 或 Docker Desktop 和 Docker Compose v2（支持 `--wait`）。

```sh
docker compose up --build --wait
```

打开 [Web 控制台](http://127.0.0.1:3100) 查看 API 状态并登录。也可直接访问 [API 健康接口](http://127.0.0.1:3101/health)。

首次登录前，将 `.env.example` 复制为 `.env`，设置 `ADO_BOOTSTRAP_EMAIL` 和至少 12 字符的 `ADO_BOOTSTRAP_PASSWORD`，再启动 Compose。API 启动时自动执行 PostgreSQL 迁移。首次启动创建管理员后，可以清空启动账号环境变量并重启，现有账号与项目继续保存在 PostgreSQL。

管理员可创建 Fitbest、ADO 项目和用户账号。项目创建者拥有项目所有者权限，可添加成员或只读用户。项目列表和仓库信息按成员关系过滤。归档项目保留历史并停止接受设置变更。

项目概览汇总待审批任务、已启用 Agent、在线 Worker 和执行队列。近期规划、开发、QA 和 PR 发布异常可从“需要处理”进入对应任务。

排队任务缺少符合分配、检查计划和磁盘条件的在线 Worker 时，也会显示在“需要处理”。Worker 恢复或调整分配后，告警会在概览刷新时消失。

仓库绑定使用安装到目标仓库的 GitHub App。仅授予已选目标仓库 `Metadata: Read` 和 `Contents: Read`，并在 `.env` 设置 `GITHUB_APP_ID` 与 `GITHUB_APP_PRIVATE_KEY` 后重启。管理员在自己拥有的项目中可选择安装、仓库与分支。API 会核实分支存在，同一个 GitHub 仓库只允许绑定到一个项目。

在项目中创建任务时，可以记录优先级、验收条件、仓库、父任务和前置任务。任务由草稿进入规划，提交后由项目所有者审批，所有状态变更保存在任务记录中。前置任务完成后才能批准关联任务进入待派发状态。

项目所有者审批人工录入的任务时可选择已启用的前端或后端 Agent。API 调用省略角色时优先使用后端 Agent。通过 Agent 规划的任务沿用架构方案选定的角色。审批后固定责任 Agent 的版本、模型和 Skill，后续派发和重试沿用该配置。

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

## Agent 规划与角色配置

在 `.env` 设置 `ADO_AGENT_API_KEY` 和支持 Structured Outputs 的 `ADO_AGENT_MODEL`，再重启 API。项目成员可在“用 Agent 规划需求”选择项目仓库并输入需求。控制面将需求和仓库标识发给 OpenAI Responses API，由项目总监、产品经理和架构师依次整理范围、验收条件、实施步骤与风险。任务工作台会保留各阶段结果。失败时可从失败阶段重试，项目所有者审批后才可派发。

OpenAI 请求需要经代理时，在 `.env` 设置 `ADO_API_HTTPS_PROXY`，地址须能从 API 容器访问。GitHub 和本地 Compose 服务保持直连。

Fitbest 试点使用当前已批准的 Issue 或 PRD。项目所有者可在研发任务中登记来源链接与批准摘录，再从规划表单选择该需求。任务保存所选版本，规划、开发和 QA 都使用同一份摘录。撤下来源只影响新任务，现有任务仍可查看已采用的链接与摘录。

项目所有者可在“Agent 与 Skill”启停角色、发布和切换 Agent 版本，以及将 Skill 的指定版本关联到 Agent。规划开始时固定角色、模型和 Skill 内容，已批准的实施方案与开发者配置会随任务交给 Worker。规划角色在控制面只生成结构化文本。开发角色配置使用 Worker 已有的 Codex 执行权限。

## 执行已审批任务

在非 root Linux 或 WSL 上使用 Node.js 24、Bash、Git 和 Codex CLI `0.170.0`。如果 CLI 自带 bubblewrap，安装时保留它的 `codex-resources` 目录。从 npm 安装依赖后，为 Worker 设置以下环境变量。

| 变量 | 用途 |
| --- | --- |
| `ADO_EXECUTION_ROOT` | 专用工作目录的绝对路径，需预先创建 |
| `ADO_CODEX_BIN` | Codex CLI 原生可执行文件的绝对路径 |
| `ADO_CODEX_STATE_DIR` | 独立 Codex 状态目录的绝对路径，需预先创建，且位于工作目录之外 |
| `ADO_CODEX_API_KEY` | 可选，设定后用于模型认证。也可通过 Codex CLI 在独立状态目录中登录 |
| `ADO_CODEX_HTTPS_PROXY` | 可选，Worker 可访问的 HTTP(S) 代理地址，仅传给发起模型请求的 Codex CLI |
| `ADO_MIN_FREE_DISK_MIB` | 执行目录的最低可用磁盘空间，默认 256 MiB |
| `ADO_NPM_CACHE_ROOT` | 可选，存放各仓库 npm 缓存的绝对路径 |
| `ADO_MAVEN_CACHE_ROOT` | 可选，存放各仓库 Maven 缓存的绝对路径 |

Worker 启动时验证 CLI 版本和文件隔离，领到任务后还会在实际 Git worktree 中验证隔离。状态目录使用默认配置。测试代码、密钥和其他项目文件应放在工作目录之外。生产部署可在独立 Worker 服务上设置 CPU、内存和磁盘配额。

Worker 随心跳上报可用磁盘和内存。工作目录低于磁盘阈值时，Worker 继续处理已领取的任务并暂停领取新任务。工作台显示暂停状态，可用空间恢复后自动恢复领取。每个执行 Worker 同一时间运行一个任务。

项目所有者可在已绑定仓库的任务通过审批后点击“派发任务”。PostgreSQL 保存队列、租约和有序事件。候选补丁摘要、变更文件列表和用量入库后进入“待测试”。补丁位于 Worker 工作目录的 `<runId>/changes.patch`，各轮补丁另存为 `attempt-N.patch`。

可由符合条件的 Worker 自动领取，也可指定一个已获项目授权的 Worker。在队列中可以更换指定 Worker 或恢复自动分配。仓库启用自动草稿 PR 或任务需要 QA 时，带检查计划的任务由支持补丁归档的 Worker 领取。

检查计划以 `mvn` 为命令时，自动领取和指定分配都要求 Worker 在启动时通过沙箱内的 `mvn --version` 探测。安装或更新 Java 和 Maven 后重启 Worker，工作台会显示重新探测的能力。排队任务沿用派发时保存的检查计划。

同一 Worker 身份及工作目录只启动一个进程。Worker 将事件写入持久化检查点，断线重连或进程重启后会向控制面核对运行租约和最后确认的事件，再补发剩余记录。重启时中断的 Codex 调用会记录为失败，由项目所有者决定是否重新派发。租约过期时由控制面记录超时。普通执行退出并收到终态确认后会清理本次 Git 工作区，保留补丁和执行记录。

执行记录显示每轮 Codex 的状态和耗时、命令退出码、文件变更数量及工具调用状态。Worker 和控制面只保留这些结构化字段，以便重连后重放并定位失败。[OpenAI Codex SDK 流式事件](https://learn.chatgpt.com/docs/codex-sdk)

在已安装依赖的 Linux 或 WSL Worker 上，可以用本地 Responses 夹具验证原生 CLI、SDK 流式事件、同线程修复、Git 工作区隔离和取消正在运行的命令。

```sh
npm run build:shared
npm run build -w @ado/worker
ADO_CODEX_BIN=/absolute/path/to/codex node scripts/verify-codex-sdk.mjs
```

## 检查和人工审核

项目所有者可在仓库绑定的“检查计划”中保存最多八项检查。设置 `kind` 为 `unit`、`api` 或 `static`，在 `argv` 中分别填写可执行文件和参数。应用同时支持仓库相对目录和每项检查超时。

```json
[
  {"name": "unit", "kind": "unit", "argv": ["node", "--test"], "timeoutSeconds": 60},
  {"name": "types", "kind": "static", "directory": "apps/api", "argv": ["npm", "run", "typecheck"]}
]
```

派发时会保存该任务的检查计划快照。Worker 在无网络沙箱中执行检查，并确认检查前后的候选补丁一致。检查工具通过 `TMPDIR` 使用任务内的临时目录，该目录位于 Git 工作区外。检查所需工具和依赖须已在隔离环境中可用。普通检查失败可在同一工作区和 Codex 线程内修复两次。每项失败检查最多提供 4 KiB 诊断尾部给修复轮次，控制面只记录状态、原因分类、退出码和耗时。超时、工具不可用或候选补丁被检查命令改动时结束运行。

使用 npm 的项目可以在与 Worker 同平台的可信检出目录预热该仓库的专用缓存。例如在已检出的 Fitbest 目录中运行 `npm --prefix fit-best-trainer ci --ignore-scripts --no-audit --no-fund --cache /srv/ado-caches/shinelincx/fitbest`，并设置 Worker 的 `ADO_NPM_CACHE_ROOT=/srv/ado-caches`。为其他使用到的 npm 子包重复预热，使用同一个仓库缓存。

将对应目录的 `["npm","ci","--offline","--ignore-scripts","--no-audit","--no-fund"]` 放在依赖它的检查前。Worker 仅将选中仓库的 `_cacache` 复制到当前任务的检查沙箱。缓存写入保留在该任务内，检查仍运行在无网络沙箱中。请在仓库中忽略安装生成的 `node_modules`。 [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci) · [npm 缓存](https://docs.npmjs.com/cli/v11/commands/npm-cache)

ADO 自身的沙箱检查在仓库根目录依次离线安装依赖、运行 `npm run lint`、`npm run typecheck` 和 `npm test`。GitHub Actions 再执行生产构建、Compose 联调和备份恢复。

对 Maven 项目，在 Worker 的系统目录安装 JDK 和 Maven，使 `java` 和 `mvn` 可从系统 `PATH` 找到。在可信检出目录预热与检查对应的依赖和插件。以 Fitbest 为例，在 `fitbest-server` 目录用 Java 21 运行 `mvn --batch-mode --no-transfer-progress -Dmaven.repo.local=/srv/ado-maven/shinelincx/fitbest/repository test`，然后设置 `ADO_MAVEN_CACHE_ROOT=/srv/ado-maven`。Worker 复制该仓库的 `repository` 到任务目录，并为 `mvn` 自动设置离线模式、依赖路径和 JVM 临时目录。[Maven CLI](https://maven.apache.org/ref/3.9.11/maven-embedder/cli.html)

Fitbest 的沙箱检查可使用下面的检查计划。测试 JVM 从任务缓存显式加载 Mockito，数据库和浏览器联调由 Fitbest 的 GitHub Actions 执行。[Mockito Java 21 配置](https://github.com/mockito/mockito/blob/v5.17.0/mockito-core/src/main/java/org/mockito/Mockito.java#L168)

```json
[
  {
    "name": "server-tests",
    "kind": "api",
    "directory": "fitbest-server",
    "argv": ["mvn", "--batch-mode", "--no-transfer-progress", "-DargLine=-javaagent:../../.maven-cache/repository/org/mockito/mockito-core/5.17.0/mockito-core-5.17.0.jar", "test"],
    "timeoutSeconds": 150
  }
]
```

全部检查通过后，项目所有者可批准或驳回该候选补丁，驳回需填写原因。检查计划为空的任务停在“待测试”，配置计划后可重新派发。

通过 Agent 规划的任务由支持补丁归档的 Worker 运行检查。全部检查通过后，QA Agent 会向 OpenAI Responses API 发送已校验的补丁内容（最多 64 KiB）、验收条件和检查报告，返回建议验证用例和发现。QA 结果进入工作台后由项目所有者决定是否批准。QA 失败可使用同一补丁重试。

项目工作台的“项目用量与审计”按岗位和模型汇总已记录的输入、缓存和输出 token。每轮 Codex 完成后保存累计用量，汇总时每次运行只计入已回传的最新值。失败、无变更或取消的运行也计入已报告的用量。项目所有者还可查看最近的配置、审批、Agent 和 Worker 记录。

项目所有者可在该页面为模型配置每百万 token 的美元费率，分别填写普通输入、缓存输入和输出。成本按已记录用量和当前费率估算。运行记录缺少模型标识或该模型费率时，页面显示暂无估算。

## 发布到 GitHub

支持归档的 Worker 会在提交通过报告前将补丁存入 S3 兼容对象存储。工作台的“下载受测补丁”会校验长度和 SHA-256。项目所有者可在仓库的“检查与交付设置”启用自动草稿 PR，人工批准受测补丁时会自动排队发布。关闭自动发布时，审核后仍可手动发布。PR 正文会附上变更文件、检查结果和补丁摘要。

发布需要目标仓库的 GitHub App 安装具备 `Contents: Write` 和 `Pull requests: Write`。控制面只为选定仓库签发短期发布凭证。发布从受测基准提交重建代码，创建 `ado/<runId>` 分支，并将草稿 PR 关联到执行记录。重试会检查已有分支和 PR，分支包含不同提交时将显示冲突。

GitHub App 可把 Pull requests、Push 和 Check runs 事件发送到控制面的 HTTPS `/github/webhook`。在同一 GitHub App 设置与 `GITHUB_WEBHOOK_SECRET` 一致的密钥。控制面验证签名并忽略重复交付。合并的 PR 必须指向受测提交，任务才会进入“已完成”。

在本地试点或 Webhook 延迟时，项目所有者可以在执行记录中点击“同步 GitHub PR 状态”。控制面使用该仓库的只读安装凭证查询 PR，并核对来源分支、目标分支和受测提交后记录合并结果。[GitHub PR 查询权限](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)

## 备份与恢复

在 Bash 或 WSL 中运行 `scripts/compose-backup.sh`。备份会短暂停止控制面和对象存储，生成 PostgreSQL 逻辑备份、SeaweedFS 数据卷归档和 SHA-256 清单，随后恢复原本运行的服务。请把备份存到仓库之外，为备份目录保留项目数据所需的访问权限。

```sh
bash scripts/compose-backup.sh backup ado-platform /absolute/path/ado-snapshot
WEB_PORT=23100 API_PORT=23101 POSTGRES_PORT=25432 REDIS_PORT=26379 S3_PORT=29000 \
  bash scripts/compose-backup.sh restore ado-restore /absolute/path/ado-snapshot
```

恢复使用同一版 Compose 配置和对象存储凭据，并要求新的 Compose 项目名。恢复实例首次启动时禁用外部模型和 GitHub 集成。成功后可以用备份中的账号登录，核对项目、任务和受测补丁。需要启用集成时，请为恢复实例单独配置。

## 试点验收

试点开始前，用拥有两个项目的管理员账号运行预检。

```sh
node --env-file=.env scripts/verify-pilots.mjs --preflight
```

预检会核对仓库绑定、GitHub App 安装和写权限、自动检查和草稿 PR 配置、Agent 岗位、模型配置以及 Fitbest 批准的需求。两个项目都须有能够运行各自检查并归档补丁的在线 Worker，合计至少两台不同 Worker。[GitHub App 安装权限](https://docs.github.com/en/rest/apps/apps#list-installations-for-the-authenticated-app)

有实际交付记录后，依次传入 Fitbest 和 ADO 的任务编号。脚本会核对规划、人工审批、Codex 事件、自动检查、QA、补丁摘要、自动排队的草稿 PR、GitHub 合并提交和 PR 对应的 GitHub Actions 运行。Fitbest 需要通过前端、浏览器及数据库联调步骤，ADO 需要通过 `checks` 和 `compose` 作业及备份恢复步骤。两种模式都逐条报告失败项并返回非零退出码。

可使用 `ADO_VERIFY_EMAIL` 和 `ADO_VERIFY_PASSWORD` 指定项目所有者账号。私有仓库可设置具备 `Pull requests: Read` 和 `Actions: Read` 权限的 `ADO_VERIFY_GITHUB_TOKEN`。[GitHub PR 查询](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) · [GitHub Actions 运行查询](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)

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

`npm run check` 依次执行 ESLint、TypeScript 类型检查、Vitest 单元测试和全部应用构建。GitHub Actions 从干净的 Compose 环境验证登录、项目隔离、Agent 规划、Worker 派发、检查与审核、签名 Webhook，以及备份恢复后的补丁完整性。Git 交付测试使用本地仓库，模型、GitHub API 和 Worker 协议测试使用夹具。
