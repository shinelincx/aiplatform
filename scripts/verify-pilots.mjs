import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
import { verifyWorkflow } from './pilot-workflow-evidence.mjs';

const args = process.argv.slice(2);
const preflight = args[0] === '--preflight';
const [fitbestCode, adoCode, ...extra] = preflight ? [] : args;
const pilots = [
  { projectCode: 'FITBEST', repository: 'shinelincx/fitbest', taskCode: fitbestCode },
  { projectCode: 'ADO', repository: 'shinelincx/aiplatform', taskCode: adoCode },
];
const api = URL.parse(process.env.ADO_VERIFY_API_URL ?? `http://127.0.0.1:${process.env.API_PORT || 3101}`);
const email = process.env.ADO_VERIFY_EMAIL || process.env.ADO_BOOTSTRAP_EMAIL;
const password = process.env.ADO_VERIFY_PASSWORD || process.env.ADO_BOOTSTRAP_PASSWORD;
const githubToken = process.env.ADO_VERIFY_GITHUB_TOKEN;
const issues = [];
let sessionToken;

function check(condition, message) {
  if (!condition) issues.push(message);
  return Boolean(condition);
}

async function fetchOk(url, init) {
  const response = await globalThis.fetch(url, {
    ...init, redirect: 'error', signal: globalThis.AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname} 返回 HTTP ${response.status}`);
  return response;
}

async function request(path, { method = 'GET', body, binary = false } = {}) {
  const response = await fetchOk(new URL(path, api), {
    method,
    headers: {
      ...(sessionToken && { Authorization: `Bearer ${sessionToken}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return;
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function readGitHub(path) {
  const response = await fetchOk(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      ...(githubToken && { Authorization: `Bearer ${githubToken}` }),
    },
  });
  return response.json();
}

async function verifyPull(repository, delivery) {
  const pull = await readGitHub(`/repos/${repository}/pulls/${delivery.pullNumber}`);
  const matches = pull.number === delivery.pullNumber && pull.merged === true
    && pull.head?.sha === delivery.commitSha && pull.head?.ref === delivery.branch
    && pull.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase()
    && pull.base?.ref === delivery.baseBranch && pull.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase();
  return matches ? pull : null;
}

async function verifyTask(pilot, path, taskCode, repositoryId) {
  const label = `${pilot.projectCode}/${taskCode}`;
  const task = (await request(`${path}/tasks`)).find(({ code }) => code === taskCode);
  if (!check(task, `${label} 找不到任务`)) return;
  const taskPath = `${path}/tasks/${task.id}`;
  const [planResponse, runs, history] = await Promise.all([
    request(`${taskPath}/agent-plan`), request(`${taskPath}/executions`), request(`${taskPath}/events`),
  ]);
  const plan = planResponse.plan;
  check(task.repositoryId === repositoryId, `${label} 任务未使用指定仓库`);
  check(task.status === 'COMPLETED', `${label} 任务状态为 ${task.status}`);
  check(task.developer?.version > 0 && task.acceptanceCriteria.length > 0, `${label} 缺少责任 Agent 或验收标准`);
  check(plan?.state === 'completed'
    && plan.steps.map(({ role }) => role).join(',') === 'PROJECT_DIRECTOR,PRODUCT_MANAGER,ARCHITECT',
  `${label} 缺少已完成的 Agent 规划`);
  if (pilot.projectCode === 'FITBEST') check(plan?.requirement?.id && plan.requirement.referenceUrl, `${label} 缺少已批准需求出处`);
  check(history.some(({ eventType, payload }) => eventType === 'task.status_changed' && payload.to === 'READY' && payload.actorId),
    `${label} 缺少人工批准任务记录`);

  const run = runs[0];
  if (!check(run?.id, `${label} 缺少执行记录`)) return;
  const runPath = `${taskPath}/executions/${run.id}`;
  const events = await request(`${runPath}/events`);
  const report = run.report;
  check(run.status === 'succeeded' && run.workerId && run.threadId
    && events.some(({ kind, payload }) => kind === 'thread' && payload.threadId === run.threadId)
    && events.some(({ kind, payload }) => kind === 'progress' && payload.stage === 'inference'),
  `${label} 缺少 Worker 和 Codex 流式执行证据`);
  check(report?.passed && report.checks.length > 0 && report.checks.every(({ status }) => status === 'passed')
    && events.some(({ kind, payload }) => kind === 'result' && payload.patchHash === report.patchHash && payload.files?.length),
  `${label} 缺少补丁变更或通过的自动检查`);
  check(run.qa?.state === 'completed' && run.qa.patchHash === report?.patchHash, `${label} 缺少与受测补丁匹配的 QA 审查`);
  check(run.review?.decision === 'approved', `${label} 缺少人工批准变更的记录`);

  if (check(run.artifact && run.artifact.sha256 === report?.patchHash, `${label} 缺少受测补丁归档`)) {
    const patch = await request(`${runPath}/artifact`, { binary: true });
    check(patch.length === run.artifact.size && createHash('sha256').update(patch).digest('hex') === run.artifact.sha256,
      `${label} 受测补丁校验失败`);
  }

  const delivery = run.delivery;
  if (check(delivery?.state === 'published' && delivery.pullState === 'merged' && delivery.branch === `ado/${run.id}`
    && Number.isSafeInteger(delivery.pullNumber)
    && delivery.pullNumber > 0 && /^[a-f0-9]{40}$/.test(delivery.commitSha ?? ''), `${label} 缺少已合并的交付记录`)) {
    check(history.some(({ eventType, payload }) => eventType === 'task.delivery_queued' && payload.runId === run.id && payload.automatic === true),
      `${label} 缺少通过审核后自动排队生成 PR 的记录`);
    check(history.some(({ eventType, payload }) => eventType === 'task.status_changed' && payload.to === 'COMPLETED' && payload.runId === run.id),
      `${label} 缺少与交付执行对应的完成事件`);
    try {
      const pull = await verifyPull(pilot.repository, delivery);
      if (check(pull, `${label} GitHub PR 的合并状态、来源、目标分支或提交与执行记录不一致`)) {
        const workflow = await verifyWorkflow(readGitHub, pilot, delivery, pull);
        process.stdout.write(`${label} · GitHub PR #${delivery.pullNumber} · ${delivery.commitSha} · Actions #${workflow}\n`);
      }
    } catch (error) {
      issues.push(`${label} ${error.message}`);
    }
  }
}

async function inspectInstallation(pilot, path, binding) {
  const label = pilot.projectCode;
  try {
    const { configured, installations } = await request(`${path}/repositories/installations`);
    if (!check(configured, `${label} 尚未配置 GitHub App`)) return;
    if (!check(installations.length > 0, `${label} 的 GitHub App 暂无有效安装`) || !binding) return;
    const installation = installations.find(({ id }) => String(id) === binding.installationId);
    if (!check(installation, `${label} 绑定的 GitHub App 安装失效或已暂停`)) return;
    check(installation.canPublish === true, `${label} GitHub App 安装缺少 Contents: Write 或 Pull requests: Write 权限`);
    const accessible = await request(`${path}/repositories/installations/${installation.id}`);
    check(accessible.some((repo) => String(repo.id) === binding.githubId && repo.fullName.toLowerCase() === pilot.repository),
      `${label} 的 GitHub App 安装无法访问已绑定仓库`);
  } catch (error) {
    issues.push(`${label} 无法核对 GitHub App 安装 · ${error.message}`);
  }
}

async function inspectPilot(pilot, projects, workerIds) {
  const project = projects.find(({ code }) => code === pilot.projectCode);
  if (!check(project?.id, `${pilot.projectCode} 项目不存在或当前账号无权查看`)) return;
  const path = `/projects/${project.id}`;
  const [bindings, workers] = await Promise.all([request(`${path}/repositories`), request(`${path}/workers`)]);
  const binding = bindings.find(({ fullName }) => fullName.toLowerCase() === pilot.repository.toLowerCase());
  check(binding, `${pilot.projectCode} 尚未绑定 ${pilot.repository}`);
  if (pilot.taskCode) {
    for (const worker of workers) if (worker.capabilities?.codexVersion) workerIds.add(worker.id);
    await verifyTask(pilot, path, pilot.taskCode, binding?.id);
    return;
  }

  check(project.status === 'active', `${pilot.projectCode} 项目须处于启用状态`);
  const owner = check(project.role === 'owner', `${pilot.projectCode} 须以项目所有者账号进行预检`);
  if (binding) {
    check(binding.checks.length > 0, `${pilot.projectCode} 仓库尚未配置自动检查计划`);
    check(binding.autoDraftPr === true, `${pilot.projectCode} 仓库尚未启用自动草稿 PR`);
  }
  const [registry, sources] = await Promise.all([
    request(`${path}/agent-registry`), request(`${path}/requirements`),
    owner && inspectInstallation(pilot, path, binding),
  ]);
  check(registry.modelConfigured, `${pilot.projectCode} 尚未配置规划模型认证`);
  const roles = new Set(registry.agents.filter(({ enabled }) => enabled).map(({ role }) => role));
  for (const role of ['PROJECT_DIRECTOR', 'PRODUCT_MANAGER', 'ARCHITECT', 'QA_ENGINEER']) {
    check(roles.has(role), `${pilot.projectCode} 试点岗位 ${role} 未启用`);
  }
  check(roles.has('FRONTEND_DEVELOPER') || roles.has('BACKEND_DEVELOPER'), `${pilot.projectCode} 须启用至少一个开发岗位`);
  const needsMaven = binding?.checks.some(({ argv }) => argv[0] === 'mvn');
  const online = workers.filter(({ status, capabilities }) => status === 'online' && capabilities?.codexVersion);
  const eligible = online.filter(({ capabilities }) => capabilities.verificationVersion === 1 && capabilities.artifactVersion === 1
    && capabilities.diskFreeBytes >= (capabilities.minFreeDiskBytes ?? 0) && (!needsMaven || capabilities.mavenVerification === true));
  if (check(online.length > 0, `${pilot.projectCode} 没有在线的 Codex 执行 Worker`)) {
    check(eligible.length > 0,
      `${pilot.projectCode} 在线 Worker 须支持自动检查、补丁归档${needsMaven ? '和 Maven' : ''}，并具备足够磁盘空间`);
  }
  for (const worker of eligible) workerIds.add(worker.id);
  if (pilot.projectCode === 'FITBEST') check(sources.length > 0, 'FITBEST 尚未登记已批准的试点需求');
  if (!preflight) check(false, `${pilot.projectCode} 缺少待验证的试点任务编号`);
}

try {
  assert(preflight ? args.length === 1 : extra.length === 0 && args.every((value) => !value.startsWith('--')),
    '用法：node --env-file=.env scripts/verify-pilots.mjs [--preflight | Fitbest任务编号 ADO任务编号]');
  assert(email && password, '请配置 ADO_VERIFY_EMAIL 和 ADO_VERIFY_PASSWORD，或使用已有本地管理员配置');
  assert(api && !api.username && !api.password && (api.protocol === 'https:'
    || (api.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname))),
  '请使用本地 HTTP 或远程 HTTPS 工作台 API 地址');
  ({ token: sessionToken } = await request('/auth/session', { method: 'POST', body: { email, password } }));
  const projects = await request('/projects');
  const workerIds = new Set();
  for (const pilot of pilots) {
    await inspectPilot(pilot, projects, workerIds).catch((error) => issues.push(`${pilot.projectCode} ${error.message}`));
  }
  check(workerIds.size >= 2, preflight ? '两个试点合计可用的在线 Codex 执行 Worker 少于两台' : '两个项目可见的 Codex 执行 Worker 少于两台');
  if (issues.length) {
    for (const issue of issues) process.stderr.write(`待验收 · ${issue}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(preflight ? 'Fitbest 和 ADO 试点的启动前配置检查通过。\n'
      : '两个试点任务的规划、审批、执行、受测补丁、GitHub Actions 和合并证据均已核对。\n');
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (sessionToken) await request('/auth/session', { method: 'DELETE' }).catch(() => undefined);
}
