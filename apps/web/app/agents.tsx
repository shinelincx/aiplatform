import { agentRoleLabels, isPlanningFailureCategory, planningFailureMessages, type AgentPlan, type AgentRegistry, type Project } from '@ado/shared';
import { retryAgentPlan, updateAgent, updateSkill } from './actions';
import { read } from './api-client';
import { RefreshExecution } from './refresh-execution';

export async function Agents({ project }: { project: Project }) {
  const registry = await read<AgentRegistry>(`/projects/${project.id}/agent-registry`);
  if (!registry) return null;
  const { agents, skills } = registry;
  const manage = project.role === 'owner' && project.status === 'active';
  const projectInput = <input type="hidden" name="projectId" value={project.id} />;
  return (
    <section id="agent-registry" className="panel" aria-labelledby="agent-heading">
      <h2 id="agent-heading">Agent 与 Skill</h2>
      {!registry.modelConfigured && <p className="muted">规划 API 密钥尚未配置。</p>}
      {agents.map((agent) => {
        const active = agent.versions.find(({ version }) => version === agent.activeVersion)!;
        const roleInput = <>{projectInput}<input type="hidden" name="role" value={agent.role} /></>;
        return <details key={agent.role}>
          <summary>{agentRoleLabels[agent.role]} · v{agent.activeVersion} · {agent.enabled ? '已启用' : '已停用'}</summary>
          <p className="description">{agent.template}</p>
          {active.instructions && <p className="description">{active.instructions}</p>}
          <p className="muted">模型 · {active.model || '使用服务默认模型'}</p>
          {manage && <div className="fields">
            <form className="inline-fields" action={updateAgent}>
              {roleInput}
              <input type="hidden" name="enabled" value={String(!agent.enabled)} />
              <button className="secondary" name="operation" value="toggle">{agent.enabled ? '停用' : '启用'}</button>
            </form>
            {agent.versions.length > 1 && <form className="inline-fields" action={updateAgent}>
              {roleInput}
              <label>历史版本<select name="version" defaultValue={active.version}>
                {agent.versions.map(({ version, model }) => (
                  <option key={version} value={version}>v{version}{model && ` · ${model}`}</option>
                ))}
              </select></label>
              <button className="secondary" name="operation" value="activate">启用所选版本</button>
            </form>}
            <form className="fields" action={updateAgent}>
              {roleInput}
              <label>模型标识<input name="model" maxLength={100} defaultValue={active.model} /></label>
              <label>项目指令<textarea name="instructions" maxLength={8000} defaultValue={active.instructions} /></label>
              {skills.map((skill) => {
                const linked = active.skills.find(({ id }) => id === skill.id);
                return (
                <label key={skill.id}>{skill.name}{!skill.enabled && '（已停用）'}
                  <select name="skills" defaultValue={linked ? `${skill.id}:${linked.version}` : ''}>
                    <option value="">无</option>
                    {skill.versions.map(({ version }) => <option key={version} value={`${skill.id}:${version}`}>v{version}</option>)}
                  </select>
                </label>
                );
              })}
              <button name="operation" value="publish">发布 Agent 版本</button>
            </form>
          </div>}
        </details>;
      })}
      {skills.map((skill) => (
        <details key={skill.id}>
          <summary>Skill · {skill.name} · {skill.enabled ? '已启用' : '已停用'}</summary>
          <ul>
            {skill.versions.map(({ version, instructions }) => <li key={version}>
              <strong>v{version}</strong><p className="description">{instructions}</p>
            </li>)}
          </ul>
          {manage && <div className="fields">
            <form action={updateSkill}>
              {projectInput}<input type="hidden" name="skillId" value={skill.id} />
              <input type="hidden" name="enabled" value={String(!skill.enabled)} />
              <button className="secondary" name="operation" value="toggle">{skill.enabled ? '停用 Skill' : '启用 Skill'}</button>
            </form>
            <form className="fields" action={updateSkill}>
              {projectInput}<input type="hidden" name="skillId" value={skill.id} />
              <label>指令<textarea name="instructions" maxLength={4000} defaultValue={skill.versions[0]?.instructions} required /></label>
              <button>发布 Skill 版本</button>
            </form>
          </div>}
        </details>
      ))}
      {manage && <details><summary>新建 Skill</summary>
        <form className="fields" action={updateSkill}>
          {projectInput}
          <label>名称<input name="name" maxLength={100} required /></label>
          <label>指令<textarea name="instructions" maxLength={4000} required /></label>
          <button>创建 Skill</button>
        </form>
      </details>}
    </section>
  );
}

const planStates: Record<AgentPlan['state'], string> = {
  queued: '等待运行', running: '运行中', failed: '失败', completed: '已生成方案', cancelled: '已结束',
};

const fieldLabels: Record<string, string> = {
  objective: '目标', constraints: '约束与待确认事项', title: '标题', userStory: '用户故事',
  requirements: '需求', acceptanceCriteria: '验收条件', developer: '开发角色',
  steps: '实施步骤', risks: '风险', testApproach: '验证思路',
};

export function PlanProgress({ projectId, plan, canRetry, showDiagnosis }: {
  projectId: string; plan: AgentPlan; canRetry: boolean; showDiagnosis: boolean;
}) {
  const diagnosis = showDiagnosis && plan.state === 'failed' && plan.error === 'planning_step_failed'
    ? planningFailureMessages[isPlanningFailureCategory(plan.failureCategory) ? plan.failureCategory : 'unknown']
    : null;
  return (
    <section aria-labelledby="agent-plan-heading">
      <h4 id="agent-plan-heading">Agent 规划</h4>
      {plan.requirement && <>
        <p>需求来源 · <a href={plan.requirement.referenceUrl} rel="noreferrer">{plan.requirement.title}</a></p>
        <details>
          <summary>规划使用的批准摘录</summary>
          <p className="description">{plan.requirement.excerpt}</p>
          <small>登记人 · {plan.requirement.approvedBy}</small>
        </details>
      </>}
      <p role="status">{planStates[plan.state]}{plan.stage && plan.state !== 'cancelled' && ` · ${agentRoleLabels[plan.stage]}`}</p>
      {(plan.state === 'queued' || plan.state === 'running') && <RefreshExecution />}
      {diagnosis && <p><strong>{diagnosis.label}</strong> · {diagnosis.hint}</p>}
      {plan.state === 'failed' && <p>当前阶段未生成可用结果。重试将从该阶段继续。</p>}
      {plan.state === 'failed' && canRetry && <form action={retryAgentPlan}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="taskId" value={plan.taskId} />
        <button className="secondary">重试规划</button>
      </form>}
      {plan.steps.map(({ role, version, model, output }) => (
        <details key={role} open={role === 'ARCHITECT'}>
          <summary>{agentRoleLabels[role]} · v{version} · {model}</summary>
          <dl>
            {Object.entries(output).map(([field, value]) => (
              <div key={field}>
                <dt><strong>{fieldLabels[field]}</strong></dt>
                <dd>{Array.isArray(value) ? <ul>{value.map((text, index) => <li key={index}>{text}</li>)}</ul>
                  : field === 'developer' ? agentRoleLabels[value as keyof typeof agentRoleLabels] : value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
    </section>
  );
}
