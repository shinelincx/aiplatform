import type { Project, WorkerReport } from '@ado/shared';
import { readSection } from './api-client';
import { SectionReadError } from './section-feedback';
import { Icon } from './icons';
import { FleetStatus, isDiskPaused, WorkerResources, workerStatusLabels } from './metrics';
import { WorkerAccess } from './worker-access';

const heartbeat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', dateStyle: 'short', timeStyle: 'medium' });

export async function Workers({ project, manage }: { project: Project; manage: boolean }) {
  const { data: workers, issue } = await readSection<WorkerReport[]>(`/projects/${project.id}/workers`, Array.isArray);
  if (issue) return <SectionReadError label="项目 Worker" issue={issue} />;
  const diskScale = workers.reduce((scale, { capabilities }) => Math.max(scale,
    capabilities?.diskFreeBytes ?? 0, capabilities?.minFreeDiskBytes ?? 0), 0);
  return (
    <section aria-labelledby="workers-heading">
      <header className="page__head">
        <div>
          <p className="eyebrow">{project.code} / FLEET</p>
          <h1 id="workers-heading">执行节点</h1>
        </div>
        {manage && <WorkerAccess key={project.id} projectId={project.id}
          workers={workers.filter(({ status }) => status !== 'disabled')} />}
      </header>
      {workers.length ? <>
        <section className="panel fleet-distribution">
          <header className="panel__head"><h2 className="panel__title"><Icon name="workers" />节点状态</h2>
            <span className="panel__meta">{workers.length} 台</span></header>
          <FleetStatus workers={workers} />
        </section>
        <ul className="resource-grid">
          {workers.map((worker) => {
            const { id, name, status, capabilities, lastHeartbeatAt, credentialExpiresAt } = worker;
            const paused = isDiskPaused(worker);
            const expired = status !== 'disabled' && Date.parse(credentialExpiresAt) <= Date.now();
            return <li className="panel resource worker-module" key={id}>
              <header className="resource__head">
                <span className="resource__icon"><Icon name="workers" /></span>
                <div><h2>{name}</h2><small>{id.slice(0, 8)}{capabilities && ` · ${capabilities.os}/${capabilities.arch}`}</small></div>
                <span className="worker-status" data-status={paused ? 'paused' : status}>
                  {expired ? '凭证已过期' : paused ? '磁盘暂停' : workerStatusLabels[status]}
                </span>
              </header>
              {capabilities && <>
                <WorkerResources worker={worker} diskScale={diskScale} />
                <div className="module-tags">
                  <span className="module-tag">{capabilities.cpuCount} 核 CPU</span>
                  <span className="module-tag" data-tone={capabilities.codexVersion ? 'mint' : undefined}>
                    {capabilities.codexVersion ? `Codex ${capabilities.codexVersion}` : '仅心跳'}
                  </span>
                  {capabilities.mavenVerification && <span className="module-tag">Maven</span>}
                </div>
              </>}
              {lastHeartbeatAt && <footer className="module-foot"><span>最近心跳</span>
                <time dateTime={lastHeartbeatAt}>{heartbeat.format(new Date(lastHeartbeatAt))}</time></footer>}
              {credentialExpiresAt && status !== 'disabled' && <footer className="module-foot"><span>凭证到期</span>
                <time dateTime={credentialExpiresAt}>{heartbeat.format(new Date(credentialExpiresAt))}</time></footer>}
            </li>;
          })}
        </ul>
      </> : <div className="panel"><p className="empty">项目尚无 Worker</p></div>}
    </section>
  );
}
