import { checkApiHealth, type Account, type Project, type ProjectMember, type ProjectOverview } from '@ado/shared';
import Link from 'next/link';
import { login, logout } from './actions';
import { Agents } from './agents';
import { read, readSection } from './api-client';
import { Operations } from './operations';
import { CreateAccount, ProjectDetails, ProjectSidebar } from './projects';
import { Repositories } from './repositories';
import { DataPanel, SectionReadError } from './section-feedback';
import { Tasks } from './tasks';
import { Workers } from './workers';

export const dynamic = 'force-dynamic';

const issues: Record<string, string> = {
  login: '登录失败，请检查邮箱和密码。',
  expired: '会话已失效，请重新登录。',
  offline: '无法连接控制面 API，请稍后重试。',
  forbidden: '当前账号没有执行此操作的权限。',
  conflict: '数据已存在或项目已归档，请检查后重试。',
  project: '无法保存项目，请检查输入。',
  user: '无法创建账号，请检查输入。',
  member: '无法更新成员，请刷新页面后重试。',
  repository: '无法绑定仓库，请确认 GitHub App 的仓库权限和分支名。',
  verification: '检查配置保存失败。请核对 JSON、检查名称、工作目录和命令参数。',
  review: '审核提交失败。选择驳回时请填写原因。',
  revision: '修订派发失败。请核对最新驳回记录，并确认有支持读取前序归档的 Worker。',
  evidence: '证据保存失败。请核对当前补丁、证据数量和链接格式。',
  delivery: '发布请求失败。请确认当前补丁已归档并通过检查和审核。',
  'delivery-refresh': '无法同步 GitHub PR 状态。请检查 GitHub App 和目标仓库访问权限。',
  'github-delivery-config': '发布需要配置具有目标仓库写权限的 GitHub App。',
  task: '无法保存任务，请检查输入、任务关联和当前状态。',
  'task-conflict': '操作与当前数据冲突，请检查任务状态、编号和前置任务。',
  'worker-assignment': '无法分配 Worker，请检查任务是否仍在排队，以及 Worker 的项目授权和执行能力。',
  'model-rate': '无法保存费率，请核对模型标识和每百万 token 的非负美元金额。',
  'agent-config': '请配置规划 Agent 的 API 密钥和模型。',
  'agent-plan': '无法运行 Agent 规划，请检查仓库、需求和规划角色配置。',
  'agent-settings': '无法保存 Agent 或 Skill 配置，请检查模型、版本和输入。',
  'agent-qa': '无法重试 QA，请检查当前任务及检查报告。',
};

export default async function Home({ searchParams }: {
  searchParams: Promise<{ project?: string; issue?: string; notice?: string; installation?: string; task?: string; section?: string; requirementResult?: string }>;
}) {
  const query = await searchParams;
  const [connection, accountResult] = await Promise.allSettled([
    checkApiHealth(process.env.API_BASE_URL ?? 'http://127.0.0.1:3101'),
    read<Account>('/auth/session'),
  ]);
  const reachable = connection.status === 'fulfilled' && connection.value;
  const account = accountResult.status === 'fulfilled' ? accountResult.value : null;
  const admin = account?.systemRole === 'admin';
  const projects = account ? await read<Project[]>('/projects') : null;
  const selected = projects?.find((project) => project.id === query.project) ?? projects?.[0];
  const [members, users, overviewResult] = await Promise.all([
    selected?.role === 'owner' ? read<ProjectMember[]>(`/projects/${selected.id}/members`) : null,
    admin ? read<Account[]>('/users') : null,
    selected ? readSection<ProjectOverview>(`/projects/${selected.id}/operations/overview`,
      (data) => Boolean(data.tasks && data.workers && data.executions && Array.isArray(data.alerts))) : null,
  ]);
  const overview = overviewResult?.data;

  return (
    <>
      <header className="app-header">
        <div className="brand"><strong>ADO</strong><span>研发管理平台</span></div>
        {account && selected && <nav className="top-nav" aria-label="工作台导航">
          <a href="#project-heading">项目</a>
          <a href="#tasks-heading">任务</a>
          <a href="#tasks-heading">审批</a>
          <a href="#agent-heading">Agent</a>
          <a href="#workers-heading">Worker</a>
        </nav>}
        {account && <form className="header-session" action={logout}>
          <span>{account.name}</span><button className="secondary">退出</button>
        </form>}
      </header>
      <main className={account ? 'workspace' : undefined}>
        {!account && <div className="heading">
          <h1>{account ? '项目工作台' : '登录研发平台'}</h1>
          <p className="connection" data-offline={!reachable}>
            控制面 API · {reachable ? '连接正常' : '连接失败'}
          </p>
        </div>}
        {query.issue && Object.hasOwn(issues, query.issue) && <p role="alert" className="feedback">{issues[query.issue]}</p>}
        {query.notice === 'user-created' && account && <p role="status">账号已创建。</p>}
        {query.notice === 'checks-saved' && account && <p role="status">检查与交付设置已保存。</p>}
        {account ? (
          <div className="workspace-grid">
            <div className="workspace-sidebar">
              <div className="workspace-title"><h1>项目工作台</h1><p className="connection" data-offline={!reachable}>控制面 API · {reachable ? '连接正常' : '连接失败'}</p></div>
              <ProjectSidebar projects={projects ?? []} selected={selected} admin={admin} />
            </div>
            <div className="workspace-panels">
              {selected && <ProjectDetails key={selected.id} project={selected} members={members ?? []} users={users ?? []}
                overview={overview ?? null} overviewFeedback={overviewResult?.issue &&
                  <SectionReadError label="项目运行概览" issue={overviewResult.issue} />} taskId={query.task} live={!query.task && query.section !== 'operations'} />}
              {selected && query.section === 'operations' && <div className="inline-fields"><Link href={`/?project=${selected.id}${query.task ? `&task=${encodeURIComponent(query.task)}#task-detail` : '#tasks-heading'}`}>返回项目工作台</Link></div>}
              {selected && query.section === 'operations' && <DataPanel key={selected.id} id="operations"
                headingId="operations-heading" title="项目用量与审计">
                <Operations project={selected} />
              </DataPanel>}
              {selected && <Tasks project={selected} selectedId={query.task} requirementResult={query.requirementResult} notice={query.notice} />}
              {selected && <DataPanel key={`repositories:${selected.id}:${query.installation ?? ''}`} headingId="repository-heading" title="GitHub 仓库">
                <Repositories project={selected} installation={query.installation}
                  manage={admin && selected.role === 'owner' && selected.status === 'active'} />
              </DataPanel>}
              {selected && <DataPanel key={`agents:${selected.id}`} id="agent-registry" headingId="agent-heading" title="Agent 与 Skill">
                <Agents project={selected} />
              </DataPanel>}
              {selected && <DataPanel key={`workers:${selected.id}`} headingId="workers-heading" title="项目 Worker">
                <Workers project={selected} manage={admin && selected.role === 'owner' && selected.status === 'active'} />
              </DataPanel>}
              {admin && <CreateAccount users={users ?? []} />}
            </div>
            {selected && overview && <aside className="status-sidebar" aria-label="运行状态">
              <h2>运行状态</h2>
              <section><h3>任务</h3><dl><div><dt>进行中</dt><dd>{overview.tasks.open} 项</dd></div><div><dt>已完成</dt><dd>{overview.tasks.completed} 项</dd></div></dl></section>
              <section><h3>审批</h3><dl><div><dt>待审批方案</dt><dd>{overview.tasks.approval} 项</dd></div></dl></section>
              <section><h3>Agent</h3><dl><div><dt>已启用</dt><dd>{overview.agentsEnabled} 个</dd></div></dl></section>
              <section><h3>Worker</h3><dl><div><dt>在线</dt><dd>{overview.workers.online} / {overview.workers.total}</dd></div></dl></section>
            </aside>}
          </div>
        ) : (
          <form className="panel fields login" action={login}>
            <label>邮箱<input name="email" type="email" autoComplete="username" maxLength={255} required /></label>
            <label>密码<input name="password" type="password" autoComplete="current-password" maxLength={256} required /></label>
            <button>登录</button>
          </form>
        )}
      </main>
    </>
  );
}
