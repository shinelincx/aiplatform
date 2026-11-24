import { checkApiHealth, type Account, type AutoApprovalSettings, type Project, type ProjectMember, type ProjectOperations, type ProjectOverview,
  type RepositoryBinding, type Task, type WorkerReport } from '@ado/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AccountFooter } from './account-footer';
import { login } from './actions';
import { Agents } from './agents';
import { read, readSection } from './api-client';
import { CommandButton, CommandPalette, ConsoleClock, MobileMenu, ProjectSwitcher, type ConsoleCommand } from './console-controls';
import { Dashboard, Metric, Telemetry } from './dashboard';
import { issues, notices } from './feedback';
import { BootMark, BrandMark, Icon, IconSprite } from './icons';
import { KnowledgePanel } from './knowledge';
import { DataPanel, SectionReadError } from './section-feedback';
import { Operations } from './operations';
import { ProjectDetails } from './projects';
import { Repositories } from './repositories';
import { Tasks } from './tasks';
import { ThemeToggle } from './theme';
import { Workers } from './workers';
import { settingsHref, settingsPath, workspaceHref, workspaceViews, type WorkspaceView } from './workspace';

export const dynamic = 'force-dynamic';

type Query = { project?: string; issue?: string; notice?: string; installation?: string;
  task?: string; section?: string; lane?: string; create?: string; dialog?: string; month?: string; requirementResult?: string;
  skill?: string; skillVersion?: string; skillResult?: string; knowledgeQuery?: string; knowledgeKind?: string;
  knowledgeHistory?: string; knowledgeEntry?: string; knowledgeVersion?: string; knowledgeResult?: string };

function resolveView(query: Query): WorkspaceView {
  const view = workspaceViews.find(({ id }) => id === query.section);
  if (view?.id === 'knowledge' || view?.id === 'operations') return view.id;
  if (query.task) return view?.id === 'approvals' ? 'approvals' : 'tasks';
  if (query.installation || query.notice === 'checks-saved') return 'repositories';
  if (query.create === 'task') return 'tasks';
  return view?.id ?? 'overview';
}

function LoginScreen({ reachable, issue, passwordChanged }: { reachable: boolean; issue?: string; passwordChanged: boolean }) {
  return <main className="boot">
    <div className="boot__grid" aria-hidden="true" />
    <div className="boot__theme"><ThemeToggle /></div>
    <section className="boot__core">
      <div className="boot__mark"><BootMark /></div>
      <p className="boot__kicker">AI DEVELOPMENT ORGANIZATION</p>
      <h1 className="boot__title">CONTROL<br />PLANE</h1>
      <p className="live" data-offline={!reachable}><i />{reachable ? '控制面 API · 连接正常' : '控制面 API · 连接失败'}</p>
      {issue && Object.hasOwn(issues, issue) && <p role="alert" className="feedback">{issues[issue]}</p>}
      {passwordChanged && <p role="status" className="notice">{notices['password-changed']}</p>}
      <form className="fields login-form" action={login}>
        <label>邮箱<input name="email" type="email" autoComplete="username" maxLength={255} required /></label>
        <label>密码<input name="password" type="password" autoComplete="current-password" maxLength={256} required /></label>
        <div className="form-actions"><button className="boot__enter">进入控制面 <Icon name="arrow" /></button></div>
      </form>
      <footer className="boot__foot"><span>ADO · CONTROL PLANE</span><span>使用平台账号登录</span></footer>
    </section>
  </main>;
}

function WorkspaceNav({ project, section, overview }: {
  project: Project; section: WorkspaceView; overview: ProjectOverview | null;
}) {
  return <nav className="nav" aria-label="工作区">
    {workspaceViews.map(({ id, label, caption, icon }, index) => {
      const badge = id === 'tasks' ? overview?.tasks.open : id === 'approvals' ? overview?.tasks.approval : undefined;
      return <Link className="nav__item" href={workspaceHref(project.id, id)} key={id} aria-current={section === id ? 'page' : undefined}>
        <span className="nav__idx" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><Icon name={icon} />
        <span className="nav__text"><b>{label}</b><small>{caption}</small></span>
        {Boolean(badge) && <span className="nav__badge" data-tone={id === 'approvals' ? 'amber' : 'mute'}>{badge}</span>}
      </Link>;
    })}
  </nav>;
}

export default async function Home({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  if (query.section === 'system') {
    const section = query.dialog === 'project-create' ? 'projects' : query.dialog === 'accounts' ? 'accounts' : 'account';
    const params = new URLSearchParams();
    for (const field of ['dialog', 'issue', 'notice'] as const) {
      if (typeof query[field] === 'string') params.set(field, query[field]);
    }
    redirect(`${settingsPath(section)}${params.size ? `?${params}` : ''}`);
  }
  const [connection, accountResult] = await Promise.allSettled([
    checkApiHealth(process.env.API_BASE_URL ?? 'http://127.0.0.1:3101'),
    read<Account>('/auth/session'),
  ]);
  const reachable = connection.status === 'fulfilled' && connection.value;
  const account = accountResult.status === 'fulfilled' ? accountResult.value : null;

  if (!account) return <>
    <title>登录 · ADO 控制面</title><IconSprite /><LoginScreen reachable={reachable} issue={query.issue}
      passwordChanged={query.notice === 'password-changed'} />
  </>;

  const admin = account.systemRole === 'admin';
  const projects = await read<Project[]>('/projects') ?? [];
  const section = resolveView(query);
  const selected = projects.find((project) => project.id === query.project) ?? projects[0];
  const feedback = query.issue && Object.hasOwn(issues, query.issue) ? issues[query.issue] : undefined;
  const notice = query.notice && Object.hasOwn(notices, query.notice) ? notices[query.notice] : undefined;
  const overviewPage = section === 'overview';
  const projectPath = selected && `/projects/${selected.id}`;
  const [overviewResult, bindingsResult, members, users, tasksResult, operationsResult, workersResult, autoApprovalResult] = await Promise.all([
    projectPath ? readSection<ProjectOverview>(`${projectPath}/operations/overview`, data => Boolean(data.tasks && data.executions && data.workers && Array.isArray(data.alerts))) : null,
    projectPath ? readSection<RepositoryBinding[]>(`${projectPath}/repositories`, Array.isArray) : null,
    projectPath && overviewPage && selected.role === 'owner' ? read<ProjectMember[]>(`${projectPath}/members`) : null,
    admin && overviewPage && selected?.role === 'owner' ? read<Account[]>('/users') : null,
    projectPath && (overviewPage || section === 'tasks' || section === 'approvals') ? readSection<Task[]>(`${projectPath}/tasks`, Array.isArray) : null,
    projectPath && overviewPage ? readSection<ProjectOperations>(`${projectPath}/operations`, data => Array.isArray(data.usage)) : null,
    projectPath && overviewPage ? readSection<WorkerReport[]>(`${projectPath}/workers`, Array.isArray) : null,
    projectPath && overviewPage ? readSection<AutoApprovalSettings>(`${projectPath}/auto-approval`, settings =>
      typeof settings.READY === 'boolean' && typeof settings.REVIEW === 'boolean') : null,
  ]);
  const overview = overviewResult?.data ?? null;
  const bindings = bindingsResult?.data ?? [];
  const tasks = tasksResult?.data ?? [];
  const operations = operationsResult?.data ?? null;
  const workers = workersResult?.data;
  const createHref = selected?.status === 'active' && selected.role !== 'viewer'
    ? workspaceHref(selected.id, 'tasks', { create: 'task' }) : undefined;
  const commands: ConsoleCommand[] = selected ? workspaceViews.map(({ id, label, caption, icon }) => ({
    label, hint: caption, icon, href: workspaceHref(selected.id, id),
  })) : [];
  commands.push({ label: '设置', hint: 'SETTINGS', icon: 'shield', href: settingsHref });
  if (createHref) commands.push({ label: '新建任务', hint: 'NEW TASK', icon: 'plus', href: createHref });
  for (const project of projects) {
    if (project.id !== selected?.id) commands.push({ label: project.name, hint: project.code, icon: 'layers',
      href: workspaceHref(project.id, section) });
  }

  return <>
    <title>{selected ? `${selected.name} · ADO` : '工作台 · ADO'}</title><IconSprite />
    <div className="shell" data-view={section}>
      <header className="topbar">
        <Link href={selected ? workspaceHref(selected.id) : '/'} className="brand" aria-label="ADO 控制面首页">
          <BrandMark /><span className="brand__text"><strong>ADO</strong><small>CONTROL PLANE</small></span>
        </Link>
        {projects.length > 0 && <ProjectSwitcher value={selected ? workspaceHref(selected.id, section) : ''}
          projects={projects.map(({ id, name, code }) => ({ name, code, href: workspaceHref(id, section) }))} />}
        {selected && <div className="topstats" aria-label="项目指标">
          <Metric label="OPEN">{overview?.tasks.open ?? '—'}</Metric>
          <Metric label="ACTIVE">{overview ? overview.executions.running + overview.executions.queued : '—'}</Metric>
          <Metric label="NODES">{overview?.workers.online ?? '—'}{overview && <i>/{overview.workers.total}</i>}</Metric>
          <Metric label="APPROVAL" tone="amber">{overview?.tasks.approval ?? '—'}</Metric>
        </div>}
        <div className="topbar__right">
          <ThemeToggle /><CommandButton /><ConsoleClock />
          {selected && <MobileMenu><WorkspaceNav project={selected} section={section} overview={overview} /></MobileMenu>}
        </div>
      </header>
      <aside className="rail" aria-label="项目与导航">
        {selected && <>
          <div className="rail__proj">
            <p className="rail__label">PROJECT</p>
            <Link className="rail__projcard" href={workspaceHref(selected.id)}>
              <strong className="rail__projcode">{selected.code}</strong>
              <p title={selected.name}>{bindings?.[0]?.fullName ?? selected.name}</p>
              <div className="rail__projmeta">
                <span><i className={reachable ? 'led led--on' : 'led'} />{bindings?.[0]?.defaultBranch ?? (selected.status === 'active' ? 'ACTIVE' : 'ARCHIVED')}</span>
                {overview && <span>{overview.tasks.open} OPEN</span>}
              </div>
            </Link>
          </div>
          <div><p className="rail__label">WORKSPACE</p><WorkspaceNav project={selected} section={section} overview={overview} /></div>
        </>}
        <div className="rail__quick">
          <p className="rail__label">QUICK</p>
          {createHref && <Link className="quickbtn" href={createHref} scroll={false}><Icon name="plus" /><span>新建任务</span><kbd>N</kbd></Link>}
          <CommandButton quick />
        </div>
      </aside>

      <main className="main" id="workspace">
        <div className="page" key={selected?.id}>
          {feedback && <p role="alert" className="feedback workspace-feedback">{feedback}</p>}
          {notice && <p role="status" className="notice workspace-feedback">{notice}</p>}
          {selected ? <>
            {overviewPage && <>
              {overviewResult?.issue && <SectionReadError label="项目运行概览" issue={overviewResult.issue} />}
              <Dashboard project={selected} tasks={tasks} overview={overview} operations={operations} workers={workers ?? []} reachable={reachable} />
              <ProjectDetails key={selected.id} project={selected} autoApproval={autoApprovalResult?.data ?? null} members={members ?? []} users={users ?? []} overview={overview} live reachable={reachable} />
            </>}
            {(section === 'tasks' || section === 'approvals') && <Tasks project={selected} tasks={tasks} taskIssue={tasksResult?.issue}
              repositories={bindings} repositoryIssue={bindingsResult?.issue} selectedId={query.task} lane={query.lane}
              create={query.create === 'task'} approvals={section === 'approvals'} feedback={feedback} notice={notice} requirementResult={query.requirementResult}
              workerUnavailable={overview?.alerts.some(alert => alert.taskId === query.task && alert.kind === 'worker_unavailable')} />}
            {section === 'repositories' && <Repositories project={selected} bindings={bindings} bindingIssue={bindingsResult?.issue} installation={query.installation}
              manage={admin && selected.role === 'owner' && selected.status === 'active'} />}
            {section === 'agents' && <Agents project={selected} selectedSkill={query.skill} selectedVersion={query.skillVersion} skillResult={query.skillResult} />}
            {section === 'workers' && <Workers project={selected} manage={admin && selected.role === 'owner' && selected.status === 'active'} />}
            {section === 'knowledge' && <DataPanel id="project-knowledge" headingId="knowledge-heading" title="项目知识">
              <KnowledgePanel project={selected} taskId={query.task} search={query.knowledgeQuery} kind={query.knowledgeKind}
                history={query.knowledgeHistory} entryId={query.knowledgeEntry} versionId={query.knowledgeVersion} result={query.knowledgeResult} />
            </DataPanel>}
            {section === 'operations' && <Operations project={selected} month={query.month} task={query.task} />}
          </> : <section className="panel">
            <p className="eyebrow">PROJECT</p><h1>还没有可用项目</h1>
            <p className="muted">{admin ? '请在项目目录中创建项目。' : '获得项目授权后即可查看任务与执行。'}</p>
            {admin && <Link className="utility-btn" href={settingsPath('projects')}>项目目录</Link>}
          </section>}
        </div>
      </main>
      <Telemetry project={selected} overview={overview} reachable={reachable} workers={workers ?? undefined} events={operations?.audit} />
      <AccountFooter account={account} />
    </div>
    <CommandPalette commands={commands} createHref={createHref} />
  </>;
}
