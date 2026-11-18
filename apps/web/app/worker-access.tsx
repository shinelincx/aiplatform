'use client';

import { useActionState } from 'react';
import { changeWorkerAccess, type WorkerAccessState } from './actions';

const idle: WorkerAccessState = {};

export function WorkerAccess({ projectId, workers }: {
  projectId: string;
  workers: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(changeWorkerAccess, idle);
  return (
    <>
      <details>
        <summary>注册新 Worker</summary>
        <form className="fields" action={action}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="operation" value="create" />
          <label>Worker 名称<input name="name" maxLength={100} required /></label>
          <button disabled={pending}>生成注册凭证</button>
        </form>
      </details>
      {workers.length > 0 && <details>
        <summary>更新凭证或撤回权限</summary>
        <form className="fields" action={action}>
          <input type="hidden" name="projectId" value={projectId} />
          <label>Worker<select name="workerId">
            {workers.map(({ id, name }) => <option key={id} value={id}>{name} · {id.slice(0, 8)}</option>)}
          </select></label>
          <div className="inline-fields">
            <button disabled={pending} name="operation" value="rotate">更新注册凭证</button>
            <button disabled={pending} name="operation" value="revoke" className="secondary">撤回项目权限</button>
          </div>
        </form>
      </details>}
      <details>
        <summary>授权已有 Worker</summary>
        <form className="fields" action={action}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="operation" value="grant" />
          <label>Worker ID<input name="workerId" maxLength={36} required /></label>
          <button disabled={pending}>授权</button>
        </form>
      </details>
      {state.error && <p className="feedback" role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {state.credential && <div className="fields">
        <p>复制此凭证到 Worker 的环境变量。刷新后凭证将隐藏，更新凭证会使旧凭证失效。</p>
        <label>ADO_WORKER_ID<input readOnly value={state.credential.workerId} /></label>
        <label>ADO_WORKER_TOKEN<input readOnly value={state.credential.token} /></label>
        <p>有效期至 <time dateTime={state.credential.expiresAt}>{state.credential.expiresAt}</time></p>
      </div>}
    </>
  );
}
