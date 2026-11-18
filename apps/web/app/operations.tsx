import { agentRoleLabels, type AgentRole, type Project, type ProjectOperations } from '@ado/shared';
import { saveModelRate } from './actions';
import { read } from './api-client';

const actions: Record<string, string> = {
  'project.created': '创建项目', 'project.updated': '更新项目', 'project.archived': '归档项目',
  'agent.version_published': '发布 Agent 版本', 'agent.settings_updated': '变更 Agent 配置',
  'skill.version_published': '发布 Skill 版本', 'skill.settings_updated': '变更 Skill 配置',
  'task.approved': '批准任务方案', 'task.rejected': '驳回任务方案', 'execution.reviewed': '人工审核',
  'repository.checks_updated': '更新仓库检查与交付设置', 'delivery.queued': '提交发布请求',
  'execution.worker_reassigned': '调整 Worker 分配',
  'requirement.approved': '登记已批准需求', 'requirement.retired': '撤下需求来源',
  'operations.model_rate_updated': '更新模型费率',
  'agent.step_completed': '完成规划阶段', 'agent.plan_failed': '规划阶段失败',
  'agent.qa_completed': '提交 QA 意见', 'agent.qa_failed': 'QA 失败', 'task.status_changed': '更新执行状态',
};

function formatTokens(value: string) {
  return BigInt(value).toLocaleString('zh-CN');
}

function displayRate(value: string) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export async function Operations({ project }: { project: Project }) {
  const operations = await read<ProjectOperations>(`/projects/${project.id}/operations`);
  if (!operations) return null;
  return (
    <section id="operations" className="panel" aria-labelledby="operations-heading">
      <h2 id="operations-heading">项目用量与审计</h2>
      <h3>已记录的模型用量</h3>
      {operations.usage.length ? <ul className="members">{operations.usage.map((usage) => (
        <li key={`${usage.role}/${usage.model}`}>
          <span>{usage.role ? agentRoleLabels[usage.role] : 'Codex'} · {usage.model ?? 'Worker 默认模型'}</span>
          <small>输入 {formatTokens(usage.inputTokens)} · 缓存 {formatTokens(usage.cachedInputTokens)}
            {' '}· 输出 {formatTokens(usage.outputTokens)} tokens</small>
          <small>{usage.estimatedUsd === null ? '暂无估算' : `估算费用 US$${displayRate(usage.estimatedUsd)}`}</small>
        </li>
      ))}</ul> : <p className="muted">暂无模型用量。</p>}
      {operations.rates && <details>
        <summary>模型费率</summary>
        <p className="muted">按项目当前费率和已记录用量估算，费率单位为每百万 token 的美元金额。</p>
        {operations.rates.length > 0 && <ul className="members">{operations.rates.map((rate) => (
          <li key={rate.model}>
            <span>{rate.model}</span>
            <small>输入 {displayRate(rate.inputUsdPerMillion)} · 缓存 {displayRate(rate.cachedInputUsdPerMillion)}
              {' '}· 输出 {displayRate(rate.outputUsdPerMillion)}</small>
          </li>
        ))}</ul>}
        {project.status === 'active' && <form action={saveModelRate} className="fields">
          <input type="hidden" name="projectId" value={project.id} />
          <label>模型 ID<input name="model" list="usage-models" maxLength={100} required /></label>
          <datalist id="usage-models">
            {[...new Set(operations.usage.map(({ model }) => model))].map((model) =>
              model && <option key={model} value={model} />)}
          </datalist>
          <label>输入费率<input name="inputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
          <label>缓存输入费率<input name="cachedInputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
          <label>输出费率<input name="outputUsdPerMillion" inputMode="decimal" maxLength={16} required /></label>
          <button>保存费率</button>
        </form>}
      </details>}
      {operations.audit && <>
        <h3>最近审计记录</h3>
        {operations.audit.length ? <ol className="members">{operations.audit.map((entry) => (
          <li key={entry.id}>
            <div>
              <span>{actions[entry.action] ?? entry.action} · {Object.hasOwn(agentRoleLabels, entry.actor)
                ? agentRoleLabels[entry.actor as AgentRole] : entry.actor}</span>
              <small className="description">{entry.resourceId}</small>
            </div>
            <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</time>
          </li>
        ))}</ol> : <p className="muted">暂无审计记录。</p>}
      </>}
    </section>
  );
}
