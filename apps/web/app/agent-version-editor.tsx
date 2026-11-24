'use client';

import { useState, type ReactNode } from 'react';
import { agentReasoningEfforts, type AgentRole, type AgentVersion } from '@ado/shared';
import { updateAgent } from './actions';

type EditableVersion = Pick<AgentVersion, 'version' | 'model' | 'reasoningEffort' | 'instructions'> & { canActivate: boolean };

export function AgentVersionEditor({ projectId, role, activeVersion, versions, toggle, children }: {
  projectId: string;
  role: AgentRole;
  activeVersion: number;
  versions: EditableVersion[];
  toggle: ReactNode;
  children: ReactNode;
}) {
  const [version, setVersion] = useState(activeVersion);
  const selected = versions.find(item => item.version === version);
  const roleInput = <>
    <input type="hidden" name="projectId" value={projectId} />
    <input type="hidden" name="role" value={role} />
  </>;

  return <>
    <div className="modal-group modal-group--inline">
      {toggle}
      {versions.length > 1 && <form className="inline-fields" action={updateAgent}>
        {roleInput}
        <label>历史版本<select name="version" value={version}
          onChange={event => setVersion(Number(event.currentTarget.value))}>
          {versions.map(item => <option key={item.version} value={item.version}>
            v{item.version}{item.model && ` · ${item.model}`}{item.reasoningEffort && ` · ${item.reasoningEffort}`}{!item.canActivate && ' · 技能版本不可用'}
          </option>)}
        </select></label>
        <button className="secondary" name="operation" value="activate" disabled={!selected?.canActivate}>启用所选版本</button>
      </form>}
    </div>
    {selected ? <form className="fields modal-group" action={updateAgent} key={selected.version}>
      <h3>发布新版本</h3>
      {roleInput}
      {typeof selected.model === 'string' && <label>模型标识<input name="model" maxLength={100} defaultValue={selected.model} /></label>}
      <label><span id={`effort-label-${role}`}>推理强度</span>
        <select name="reasoningEffort" defaultValue={selected.reasoningEffort ?? ''}
          aria-labelledby={`effort-label-${role}`} aria-describedby={`effort-hint-${role}`}>
          <option value="">使用默认强度</option>
          {agentReasoningEfforts(role).map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select>
        <small id={`effort-hint-${role}`}>请选择所用模型支持的档位。</small>
      </label>
      {typeof selected.instructions === 'string' && <label>项目指令<textarea name="instructions" maxLength={8000} defaultValue={selected.instructions} /></label>}
      {children}
      <div className="form-actions"><button name="operation" value="publish">发布 Agent 版本</button></div>
    </form> : <p className="feedback" role="alert">历史版本加载失败。</p>}
  </>;
}
