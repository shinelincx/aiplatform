import { checkApiHealth, type Account, type Project, type ProjectMember, type ProjectOverview } from '@ado/shared';
import Link from 'next/link';
import { login, logout } from './actions';
import { Agents } from './agents';
import { read } from './api-client';
import { Operations } from './operations';
import { CreateAccount, ProjectDetails, ProjectSidebar } from './projects';
import { Repositories } from './repositories';
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
  delivery: '发布请求失败。请确认当前补丁已归档并通过检查和审核。',
  'github-delivery-config': '发布需要配置具有目标仓库写权限的 GitHub App。',
  task: '无法保存任务，请检查输入、任务关联和当前状态。',
  'task-conflict': '操作与当前数据冲突，请检查任务状态、编号和前置任务。',
  'worker-assignment': '无法分配 Worker，请检查任务是否仍在排队，以及 Worker 的项目授权和执行能力。',
  requirement: '无法保存需求来源，请核对 HTTPS 链接、标题和批准内容摘录。',
  'model-rate': '无法保存费率，请核对模型标识和每百万 token 的非负美元金额。',
  'agent-config': '请配置规划 Agent 的 API 密钥和模型。',
  'agent-plan': '无法运行 Agent 规划，请检查仓库、需求和规划角色配置。',
  'agent-settings': '无法保存 Agent 或 Skill 配置，请检查模型、版本和输入。',
  'agent-qa': '无法重试 QA，请检查当前任务及检查报告。',
};

export default async function Home({ searchParams }: {
  searchParams: Promise<{ project?: string; issue?: string; notice?: string; installation?: string; task?: string; section?: string }>;
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
  const [members, users, overview] = await Promise.all([
    selected?.role === 'owner' ? read<ProjectMember[]>(`/projects/${selected.id}/members`) : null,
    admin ? read<Account[]>('/users') : null,
    selected ? read<ProjectOverview>(`/projects/${selected.id}/operations/overview`) : null,
  ]);

  return (
    <>
      <header>
        <strong>ADO</strong><span>研发管理平台</span>
        {account && <form className="header-session" action={logout}>
          <span>{account.name}</span><button className="secondary">退出</button>
        </form>}
      </header>
      <main className={account ? 'workspace' : undefined}>
        <div className="heading">
          <h1>{account ? '项目工作台' : '登录研发平台'}</h1>
          <p className="connection" data-offline={!reachable}>
            控制面 API · {reachable ? '连接正常' : '连接失败'}
          </p>
        </div>
        {query.issue && Object.hasOwn(issues, query.issue) && <p role="alert" className="feedback">{issues[query.issue]}</p>}
        {query.notice === 'user-created' && account && <p role="status">账号已创建。</p>}
        {query.notice === 'checks-saved' && account && <p role="status">检查与交付设置已保存。</p>}
        {account ? (
          <div className="workspace-grid">
            <ProjectSidebar projects={projects ?? []} selected={selected} admin={admin} />
            <div className="workspace-panels">
              {selected && <ProjectDetails key={selected.id} project={selected} members={members ?? []} users={users ?? []}
                overview={overview} live={!query.task && query.section !== 'operations'} />}
              {selected && <div className="inline-fields">
                {query.section === 'operations'
                  ? <Link href={`/?project=${selected.id}`}>返回项目工作台</Link>
                  : <Link href={`/?project=${selected.id}&section=operations#operations`}>项目用量与审计</Link>}
              </div>}
              {selected && query.section === 'operations' && <Operations project={selected} />}
              {selected && <Repositories project={selected} installation={query.installation}
                manage={admin && selected.role === 'owner' && selected.status === 'active'} />}
              {selected && <Tasks project={selected} selectedId={query.task} />}
              {selected && <Agents project={selected} />}
              {selected && <Workers project={selected} manage={admin && selected.role === 'owner' && selected.status === 'active'} />}
              {admin && <CreateAccount users={users ?? []} />}
            </div>
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
