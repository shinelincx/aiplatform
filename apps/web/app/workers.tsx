import { workerDiskPressure, type Project, type WorkerReport } from '@ado/shared';
import { read } from './api-client';
import { WorkerAccess } from './worker-access';

const statusText: Record<WorkerReport['status'], string> = {
  unregistered: '待注册', online: '在线', disconnected: '已断开', disabled: '已停用',
};

function availableMiB(bytes: number) {
  return Math.floor(bytes / 1024 / 1024).toLocaleString('zh-CN');
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore', timeZoneName: 'short' });
}

export async function Workers({ project, manage }: { project: Project; manage: boolean }) {
  const workers = await read<WorkerReport[]>(`/projects/${project.id}/workers`) ?? [];
  return (
    <section className="panel" aria-labelledby="workers-heading">
      <h2 id="workers-heading">项目 Worker</h2>
      {workers.length ? (
        <ul className="members">
          {workers.map(({ id, name, status, capabilities, lastHeartbeatAt, credentialExpiresAt }) => (
            <li key={id}>
              <div>
                <span>{name} <small>{id.slice(0, 8)}{capabilities && ` · ${capabilities.os}/${capabilities.arch}`}</small></span>
                {capabilities && <div><small>可用磁盘 {availableMiB(capabilities.diskFreeBytes)} MiB
                  {capabilities.memoryFreeBytes !== undefined && ` · 可用内存 ${availableMiB(capabilities.memoryFreeBytes)} MiB`}
                  {capabilities.codexVersion ? ' · 单任务执行' : ' · 仅注册和心跳'}
                  {capabilities.mavenVerification && ' · Maven'}
                </small></div>}
                {lastHeartbeatAt && <div><small>最后心跳 <time dateTime={lastHeartbeatAt}>{formatTimestamp(lastHeartbeatAt)}</time></small></div>}
                {credentialExpiresAt && status !== 'disabled' && <div><small>凭证到期 <time dateTime={credentialExpiresAt}>
                  {formatTimestamp(credentialExpiresAt)}</time></small></div>}
              </div>
              <small>{status !== 'disabled' && Date.parse(credentialExpiresAt) <= Date.now() ? '凭证已过期' : statusText[status]}
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
