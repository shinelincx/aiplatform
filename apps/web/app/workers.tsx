import type { Project, WorkerReport } from '@ado/shared';
import { read } from './api-client';
import { WorkerAccess } from './worker-access';

const statusText: Record<WorkerReport['status'], string> = {
  unregistered: '待注册', online: '在线', disconnected: '已断开', disabled: '已停用',
};

export async function Workers({ project, manage }: { project: Project; manage: boolean }) {
  const workers = await read<WorkerReport[]>(`/projects/${project.id}/workers`) ?? [];
  return (
    <section className="panel" aria-labelledby="workers-heading">
      <h2 id="workers-heading">项目 Worker</h2>
      {workers.length ? (
        <ul className="members">
          {workers.map(({ id, name, status, capabilities }) => (
            <li key={id}>
              <span>{name} <small>{id.slice(0, 8)}{capabilities && ` · ${capabilities.os}/${capabilities.arch}`}</small></span>
              <small>{statusText[status]}</small>
            </li>
          ))}
        </ul>
      ) : <p className="muted">项目尚无 Worker。</p>}
      {manage && <WorkerAccess key={project.id} projectId={project.id} workers={workers.filter(({ status }) => status !== 'disabled')} />}
    </section>
  );
}
