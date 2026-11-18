import { workerDiskPressure, type Project, type WorkerReport } from '@ado/shared';
import { read } from './api-client';
import { WorkerAccess } from './worker-access';

const statusText: Record<WorkerReport['status'], string> = {
  unregistered: '待注册', online: '在线', disconnected: '已断开', disabled: '已停用',
};

function availableMiB(bytes: number) {
  return Math.floor(bytes / 1024 / 1024).toLocaleString('zh-CN');
}

export async function Workers({ project, manage }: { project: Project; manage: boolean }) {
  const workers = await read<WorkerReport[]>(`/projects/${project.id}/workers`) ?? [];
  return (
    <section className="panel" aria-labelledby="workers-heading">
      <h2 id="workers-heading">项目 Worker</h2>
      {workers.length ? (
        <ul className="members">
          {workers.map(({ id, name, status, capabilities }) => (
            <li key={id}>
              <div>
                <span>{name} <small>{id.slice(0, 8)}{capabilities && ` · ${capabilities.os}/${capabilities.arch}`}</small></span>
                {capabilities && <div><small>可用磁盘 {availableMiB(capabilities.diskFreeBytes)} MiB
                  {capabilities.memoryFreeBytes !== undefined && ` · 可用内存 ${availableMiB(capabilities.memoryFreeBytes)} MiB`}
                  {capabilities.codexVersion ? ' · 单任务执行' : ' · 仅注册和心跳'}
                </small></div>}
              </div>
              <small>{statusText[status]}
                {status === 'online' && capabilities?.codexVersion && workerDiskPressure(capabilities) && ' · 磁盘空间不足，暂停领取'}
              </small>
            </li>
          ))}
        </ul>
      ) : <p className="muted">项目尚无 Worker。</p>}
      {manage && <WorkerAccess key={project.id} projectId={project.id} workers={workers.filter(({ status }) => status !== 'disabled')} />}
    </section>
  );
}
