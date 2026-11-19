# Windows + WSL2 Worker 安装与运行手册

Worker 在 WSL2 中以普通 Linux 用户执行任务。Windows 任务计划程序在当前 Windows 用户登录时启动 Worker，包括电脑重启后的首次登录。每个项目使用自己的 Worker 凭证、工作目录和 Codex 登录目录。

## 1. 准备 Windows 和 WSL2

在 PowerShell 查看发行版名称和 WSL 版本。新机器可先安装 Debian，完成 Windows 提示的重启和 Debian 用户初始化。

```powershell
wsl --list --verbose
wsl --install -d Debian
wsl -d Debian
```

在 Debian 或 Ubuntu 内安装 Git、Bash 和 `flock`。在 Linux 中按仓库 `.nvmrc` 准备 Node.js 24 和 npm。将离线检查所用的 Node、npm 及其他工具安装到 `/usr/local/bin` 或 `/usr/bin`，让任务沙箱可以找到它们。运行 Maven 检查的 Worker 还需安装与目标仓库匹配的 JDK 和 Maven。

```bash
sudo apt-get update
sudo apt-get install git bash util-linux ca-certificates
node --version
npm --version
whoami
```

Worker 的运行文件、登录、缓存和工作目录都存放在 WSL 用户的 Linux 主目录。Windows 仓库检出可用于调用安装脚本。部署版本以调用时的 Git 提交为准。 [WSL 安装说明](https://learn.microsoft.com/en-us/windows/wsl/install)

## 2. 安装并注册 Worker

在 WSL 进入 ADO 仓库。下例使用 `ado` 作为本机实例名。Fitbest 可使用 `fitbest`，并在对应项目生成独立的注册凭证。

```bash
bash scripts/install-wsl-worker.sh ado
worker="$HOME/.local/share/ado-workers/ado"
```

安装脚本使用提交对应的锁文件安装依赖和原生 Codex，构建 Worker 并生成启动入口。同一提交可以重复安装，现有 `worker.env`、Codex 登录、缓存和任务数据会继续使用。若已有该提交的 npm 缓存，可用 `bash scripts/install-wsl-worker.sh ado --offline` 安装 Worker 软件。使用专用缓存时，在命令前加 `npm_config_cache=/absolute/path/to/cache`。目标仓库的测试缓存按第 4 节准备。

在目标项目的「项目 Worker」中生成注册凭证，用编辑器填写 `$worker/worker.env` 中的 `ADO_WORKER_ID`、`ADO_WORKER_TOKEN` 和 `API_BASE_URL`。该文件权限为 `600`。本机 Docker 控制面运行在同一 WSL 发行版时，可从 WSL 验证 `http://127.0.0.1:3101/health`。远程控制面使用其 HTTPS 地址。控制面须已启动并允许 Worker 与 `/workers/ws` 建立连接。

在当前版本，Worker 注册凭证有效期为 8 小时。轮换前先确认当前任务已结束，停止对应启动任务，在同一项目更新凭证并编辑 `worker.env`，随后启动任务并确认新心跳。Worker 配置和凭证只保存在 WSL 私有目录。

控制面使用私有 CA 签发 HTTPS 证书时，将可信 CA 的 PEM 证书保存为 `$worker/ca.crt`，然后启动或重启 Worker。启动脚本在 Node 运行前加载此文件，HTTPS 归档上传和 WSS 心跳使用同一信任链。 [Node.js 证书配置](https://nodejs.org/download/release/v24.7.0/docs/api/cli.html#node_extra_ca_certsfile)

## 3. Codex 认证和代理

每个实例可用 ChatGPT 登录或设置 `ADO_CODEX_API_KEY`。ChatGPT 登录使用脚本指定的独立状态目录。浏览器登录回调不便时，先在对应 ChatGPT 账户或工作区启用设备代码登录，再使用 `--device-auth`。

```bash
"$worker/run" login
"$worker/run" login status
# 设备代码方式
"$worker/run" login --device-auth
```

登录缓存位于 `$worker/codex/auth.json`，按凭证管理。此目录使用 CLI 默认配置。应用通过启动探测确认固定 Codex 版本和文件隔离。

GitHub 签出或模型请求需要代理时，在 `worker.env` 设置 `ADO_CODEX_HTTPS_PROXY`。该地址必须能从 WSL 访问。NAT 下可使用 WSL 可达的 Windows 虚拟网卡地址及现有代理的受限监听入口。若重启后连接失败，在 WSL 检查 `ip route show default`，并核对 Windows 上的监听地址。若代理 URL 含有认证，按 URL 规则编码用户名及密码，并将配置留在 `worker.env` 中。控制面连接使用 `API_BASE_URL`，控制面自身的模型与发布代理由它的 Docker 配置管理。 [Codex 认证文档](https://learn.chatgpt.com/docs/auth) · [WSL 网络说明](https://learn.microsoft.com/en-us/windows/wsl/networking)

首次安装依赖或预热缓存需要联网时，可通过 WSL 账户的 npm 配置设置 `https-proxy`，或从本机凭证配置注入 `npm_config_https_proxy`。

## 4. 预热仓库的离线检查缓存

从受信任的仓库检出、在与 Worker 相同的平台准备缓存。缓存子目录名使用绑定仓库的 `owner/repo`。在预热用的检出中执行安装，随后在 Worker 的仓库检查计划中启用对应离线检查。

```bash
# 在 ADO 预热用的可信检出中执行
npm ci --ignore-scripts --no-audit --no-fund \
  --cache "$worker/cache/npm/shinelincx/aiplatform"
```

启用 npm 缓存时，在 `worker.env` 把 `ADO_NPM_CACHE_ROOT` 设置为 `$worker/cache/npm` 展开后的绝对路径。在仓库检查计划中把 `npm ci --offline --ignore-scripts --no-audit --no-fund` 放在 Lint、类型检查和单测前。Fitbest 的前端包需要在各子包目录用同一个 `owner/repo` 缓存预热。

Maven 同样可按仓库预热。在 Fitbest 的 `fitbest-server` 可信检出中使用 `mvn --batch-mode --no-transfer-progress -Dmaven.repo.local="$worker/cache/maven/shinelincx/fitbest/repository" test`，并把 `ADO_MAVEN_CACHE_ROOT` 设置为 `$worker/cache/maven` 展开后的绝对路径。依赖锁文件、目标平台或工具版本更新后重新预热。启用缓存根目录时，为对应 Worker 承接检查的仓库准备其独立缓存。Worker 将需要的缓存复制给任务，检查阶段在无网络沙箱中执行。

## 5. 注册 Windows 登录自启动

在同一 Windows 用户登录的 PowerShell 中，从 ADO 仓库根目录运行。用 `wsl --list --verbose` 和 WSL 中的 `whoami` 确认参数。自启动任务在 Windows 登录后打开一个长期运行的 WSL Worker，无需先手工打开 Debian。使用自定义 Linux 主目录时可传 `-LinuxHome`。

```powershell
.\scripts\register-wsl-worker-startup.ps1 -Distribution Debian -LinuxUser admin -Name ado -Start
Get-ScheduledTask -TaskName 'ADO Worker Debian admin ado' | Select-Object TaskName, State
```

实例日志位于 `$worker/worker.log`，在 WSL 中用 `tail -n 50 "$worker/worker.log"` 查看。启动任务在 Worker 异常退出后按计划重试。控制面的 Worker 页面会显示注册状态、Codex 能力和最后心跳。

## 6. 重启与任务验收

先在工作台确认没有执行中的任务，记录最后心跳，再在 PowerShell 重启这一项计划任务。

```powershell
$task = 'ADO Worker Debian admin ado'
Stop-ScheduledTask -TaskName $task
Start-ScheduledTask -TaskName $task
```

核对任务计划程序显示 `Running`，工作台显示该 Worker 在线，最后心跳晚于重启前。从同一项目选一项已审批的测试任务，指定该 Worker 派发。记录工作台的任务编号、执行线程、签出、离线检查与归档补丁结果。发布 PR 由项目所有者在候选进入审核后另行决定。

如需在隔离环境验收整个发行版冷启动，先停止测试 Worker 的计划任务和同发行版内的演练服务，再按需运行 `wsl --terminate <测试发行版>`。随后启动计划任务或重新登录 Windows，观察上述结果。共享发行版中的 Docker 和其他 Worker 会受终止影响。

升级时，先确认当前任务已结束。停止对应计划任务，切到批准的 ADO Git 版本，在 WSL 重跑第 2 节的安装命令，再启动计划任务并复验。排查时依次看 `worker.log`、控制面健康接口、工作台的凭证和心跳、Codex 登录状态、代理入口以及仓库离线依赖。 [Windows 计划任务登录触发器](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger)
