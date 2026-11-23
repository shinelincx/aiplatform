'use client';

import { workerCredentialLifetimeHours } from '@ado/shared';
import { useActionState, type ReactNode } from 'react';
import { changeWorkerAccess, type WorkerAccessState } from './actions';
import { ActionDialog } from './console-controls';

const idle: WorkerAccessState = {};
const lifetimeLabels = { 8: '8 小时', 168: '7 天', 720: '30 天' } as const;

function CredentialLifetime() {
  return <label>凭证有效期<select name="lifetimeHours">
    {workerCredentialLifetimeHours.map((hours) => <option key={hours} value={hours}>{lifetimeLabels[hours]}</option>)}
  </select></label>;
}

function WorkerForm({ projectId, children }: {
  projectId: string; children: (pending: boolean) => ReactNode;
}) {
  const [state, action, pending] = useActionState(changeWorkerAccess, idle);
  return <>
    <form className="fields" action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      {children(pending)}
    </form>
    {state.error && <p className="feedback" role="alert">{state.error}</p>}
    {state.notice && <p className="notice" role="status">{state.notice}</p>}
    {state.credential && <div className="credential-card" aria-label="注册凭证">
      <label>ADO_WORKER_ID<input readOnly value={state.credential.workerId} /></label>
      <label>ADO_WORKER_TOKEN<input readOnly value={state.credential.token} /></label>
      <p>有效期至 <time dateTime={state.credential.expiresAt}>
        {new Date(state.credential.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time></p>
      <p className="muted">关闭弹窗前复制凭证。更新凭证会使旧凭证失效。</p>
    </div>}
  </>;
}

export function WorkerAccess({ projectId, workers }: {
  projectId: string;
  workers: { id: string; name: string }[];
}) {
  return <div className="page-actions">
    <ActionDialog title="注册新 Worker" trigger="注册 Worker">
      <WorkerForm projectId={projectId}>{(pending) => <>
        <input type="hidden" name="operation" value="create" />
        <label>Worker 名称<input name="name" maxLength={100} required /></label>
        <CredentialLifetime />
        <div className="form-actions"><button disabled={pending}>生成注册凭证</button></div>
      </>}</WorkerForm>
    </ActionDialog>
    <ActionDialog title="授权已有 Worker" trigger="授权 Worker">
      <WorkerForm projectId={projectId}>{(pending) => <>
        <input type="hidden" name="operation" value="grant" />
        <label>Worker ID<input name="workerId" maxLength={36} required /></label>
        <div className="form-actions"><button disabled={pending}>授权</button></div>
      </>}</WorkerForm>
    </ActionDialog>
    {workers.length > 0 && <ActionDialog title="Worker 凭证与权限" trigger="凭证与权限">
      <WorkerForm projectId={projectId}>{(pending) => <>
        <label>Worker<select name="workerId">
          {workers.map(({ id, name }) => <option key={id} value={id}>{name} · {id.slice(0, 8)}</option>)}
        </select></label>
        <CredentialLifetime />
        <div className="form-actions">
          <button disabled={pending} name="operation" value="rotate">更新注册凭证</button>
          <button disabled={pending} name="operation" value="revoke" className="btn-danger">撤回项目权限</button>
        </div>
      </>}</WorkerForm>
    </ActionDialog>}
  </div>;
}
