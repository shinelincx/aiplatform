import Link from 'next/link';
import { agentRoleLabels, type Project, type ProjectOperations, type ProjectOverview, type Task, type WorkerReport } from '@ado/shared';
import type { ReactNode } from 'react';
import { ConsoleClock } from './console-controls';
import { Icon, type IconName } from './icons';
import { FleetStatus, formatTokens, isDiskPaused, tokenTotal, UsageChart, workerStatusLabels } from './metrics';
import { auditActionLabel } from './operations';
import { laneForStatus, taskLanes, workspaceHref } from './workspace';

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', timeStyle: 'medium' });

export function Metric({ label, children, tone }: { label: string; children: ReactNode; tone?: 'amber' }) {
  return <div className="headstat" data-tone={tone}><small>{label}</small><strong>{children}</strong></div>;
}

function Panel({ title, caption, icon, meta, className = '', children }: {
  title: string; caption: string; icon: IconName; meta?: ReactNode; className?: string; children: ReactNode;
}) {
  return <section className={`panel ${className}`}>
    <header className="panel__head">
      <h2 className="panel__title"><Icon name={icon} /><span>{title}</span><em>{caption}</em></h2>
      {meta}
    </header>
    {children}
  </section>;
}

export function Dashboard({ project, tasks, overview, operations, workers, reachable }: {
  project: Project; tasks: Task[]; overview: ProjectOverview | null; operations: ProjectOperations | null;
  workers: WorkerReport[]; reachable: boolean;
}) {
  const current = tasks.filter(({ archivedAt }) => !archivedAt);
  const awaiting = current.filter(({ status }) => status === 'WAITING_APPROVAL');
  const events = operations?.audit;
  const usage = operations?.usage ?? [];
  const executions = overview?.executions;
  const done = current.filter(({ status }) => status === 'COMPLETED').length;

  return <>
    <header className="page__head" id="project-heading">
      <div>
        <p className="eyebrow">{project.code} / MISSION CONTROL</p>
        <h1>研发流水线</h1>
      </div>
      <div className="page__meta">
        <Metric label="任务完成率">{current.length ? `${Math.round(done / current.length * 100)}%` : '—'}</Metric>
        <Metric label="AGENTS">{overview?.agentsEnabled ?? '—'}<i>/{Object.keys(agentRoleLabels).length}</i></Metric>
        <Metric label="执行中">{executions?.running ?? '—'}</Metric>
        <Metric label="执行成功率">{executions?.total ? `${Math.round(executions.succeeded / executions.total * 100)}%` : '—'}</Metric>
      </div>
    </header>
    <Panel title="执行流水线" caption="PIPELINE" icon="layers" className="panel--pipeline"
      meta={<span className="panel__meta">{current.length} WORK ITEMS</span>}>
      <div className="pipeline">
        {taskLanes.map((lane, index) => <Link className="pipe" data-tone={lane.tone} key={lane.id}
          href={workspaceHref(project.id, 'tasks', { lane: lane.id })}>
          <span className="pipe__idx">{String(index + 1).padStart(2, '0')}</span>
          <span className="pipe__dot" />
          <span className="pipe__label">{lane.label}</span>
          <span className="pipe__count">{current.filter(({ status }) => laneForStatus[status] === lane.id).length}</span>
          <span className="pipe__hint">{lane.caption}</span>
        </Link>)}
      </div>
    </Panel>
    <div className="ogrid">
      <Panel title="执行事件流" caption="STREAM" icon="terminal"
        meta={reachable && <span className="live"><i />LIVE</span>}>
        <div className="feed">
          {events?.length ? [...events].reverse().map((entry) => (
            <div className="feed__line" key={entry.id} data-tone={entry.action.includes('failed') ? 'rose' : 'mint'}>
              <time className="feed__time" dateTime={entry.createdAt}>{timeFormat.format(new Date(entry.createdAt))}</time>
              <span className="feed__kind">{entry.action.split('.')[0]}</span>
              <span className="feed__text">{auditActionLabel(entry.action)} · {entry.actor}</span>
            </div>
          )) : <p className="empty">{events ? '暂无执行事件。' : '执行事件仅向项目所有者开放。'}</p>}
        </div>
      </Panel>
      <Panel title="待审批" caption="QUEUE" icon="shield" meta={<Link className="linkbtn"
        href={workspaceHref(project.id, 'approvals')}>全部 <Icon name="arrow" /></Link>}>
        <div className="apprlist">
          {awaiting.length ? awaiting.slice(0, 4).map((task) => <Link key={task.id} className="appr"
            href={workspaceHref(project.id, 'approvals', { task: task.id })}>
            <span className="appr__risk" data-tone="amber" />
            <span className="appr__body"><b>{task.title}</b><small>{task.code} · 方案审批</small></span>
            <Icon name="chevron" />
          </Link>) : <p className="empty">暂无待审批方案。</p>}
        </div>
      </Panel>
      <Panel title="执行节点" caption="FLEET" icon="workers" meta={<Link className="linkbtn"
        href={workspaceHref(project.id, 'workers')}>{overview?.workers.online ?? 0}/{workers.length} ONLINE <Icon name="arrow" /></Link>}>
        {workers.length ? <><FleetStatus workers={workers} /><ul className="fleetmini">{workers.slice(0, 5).map((worker) => {
          const paused = isDiskPaused(worker);
          return <li className="nodemini" key={worker.id} data-status={paused ? 'paused' : worker.status}>
            <span className="nodemini__dot" /><strong>{worker.name}</strong>
            <small>{worker.capabilities ? `${worker.capabilities.os}/${worker.capabilities.arch}` : worker.id.slice(0, 8)}</small>
            <small>{paused ? '磁盘暂停' : workerStatusLabels[worker.status]}</small>
          </li>;
        })}</ul></> : <p className="empty">项目尚无 Worker</p>}
      </Panel>
      <Panel title="模型用量" caption="TOKENS" icon="chart" className="panel--usage" meta={<Link className="linkbtn"
        href={workspaceHref(project.id, 'operations')}>用量明细 <Icon name="arrow" /></Link>}>
        <div className="usage__hero"><strong>{formatTokens(tokenTotal(usage))}</strong><small>累计 TOKENS</small></div>
        <UsageChart usage={usage} limit={4} compact />
      </Panel>
    </div>
  </>;
}

export function Telemetry({ project, overview, reachable, workers, events }: {
  project?: Project; overview: ProjectOverview | null; reachable: boolean;
  workers?: WorkerReport[]; events?: ProjectOperations['audit'];
}) {
  const ratio = overview?.workers.total ? overview.workers.online / overview.workers.total : 0;
  return <aside className="telemetry" aria-label="运行遥测">
    <div className="tele__head">
      <p className="rail__label">TELEMETRY</p>
      <span className="live" data-offline={!reachable}><i />{reachable ? 'LIVE' : 'OFFLINE'}</span>
    </div>
    <ConsoleClock large code={project?.code} />
    {overview && project ? <>
      <section className="tele__block" aria-label="运行指标">
        <div className="tele__row"><span>QUEUE DEPTH</span><b>{overview.executions.queued}</b></div>
        <div className="tele__row"><span>RUNNING</span><b>{overview.executions.running}</b></div>
        <div className="tele__row"><span>DISK PAUSED</span><b>{overview.workers.diskPaused}</b></div>
        <div className="tele__row"><span>ONLINE NODES</span><b>{overview.workers.online}/{overview.workers.total}</b></div>
        <div className="telbar" aria-hidden="true"><i style={{ width: `${ratio * 100}%` }} /></div>
      </section>
      {workers && <section className="tele__block" aria-label="节点信号">
        <p className="tele__title">NODE SIGNAL</p>
        {workers.length ? <ul className="tele__nodes">
          {workers.slice(0, 12).map((worker) => <li key={worker.id} className="tsig" data-status={worker.status}>
            <i aria-hidden="true" /><span>{worker.name}</span><small data-status={worker.status} className="worker-status">
              {workerStatusLabels[worker.status]}
            </small>
          </li>)}
        </ul> : <p className="empty">项目尚无 Worker。</p>}
      </section>}
      <section className="tele__block tele__block--grow" aria-label={events ? '运行告警与事件' : '运行告警'}>
        {overview.alerts.length > 0 && <>
          <p className="tele__title">ALERTS</p>
          <div className="tape">
            {overview.alerts.map((alert) => <Link key={alert.taskId} href={workspaceHref(project.id, 'tasks', { task: alert.taskId })}>
              <span>{alert.code}</span><strong>{alert.title}</strong>
            </Link>)}
          </div>
        </>}
        {events ? <>
          <p className="tele__title">EVENT TAPE</p>
          {events.length ? <ul className="tape">
            {events.slice(0, 8).map((event) => <li className="tape__line" key={event.id}>
              <time dateTime={event.createdAt}>{timeFormat.format(new Date(event.createdAt))}</time>
              <span>{auditActionLabel(event.action)}</span>
            </li>)}
          </ul> : <p className="empty">暂无执行事件。</p>}
        </> : !overview.alerts.length && <p className="empty">暂无运行告警。</p>}
      </section>
      <footer className="tele__foot"><span>WORKER GATEWAY</span><span>{overview.workers.online} NODES</span></footer>
    </> : <p className="empty">选择项目后显示运行状态。</p>}
  </aside>;
}
