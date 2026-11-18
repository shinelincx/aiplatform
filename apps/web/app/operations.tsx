import { agentRoleLabels, type AgentRole, type Project, type ProjectOperations } from '@ado/shared';
import { read } from './api-client';

const actions: Record<string, string> = {
  'project.created': '创建项目', 'project.updated': '更新项目', 'project.archived': '归档项目',
  'agent.version_published': '发布 Agent 版本', 'agent.settings_updated': '变更 Agent 配置',
  'skill.version_published': '发布 Skill 版本', 'skill.settings_updated': '变更 Skill 配置',
  'task.approved': '批准任务方案', 'task.rejected': '驳回任务方案', 'execution.reviewed': '人工审核',
  'repository.checks_updated': '更新仓库检查与交付设置', 'delivery.queued': '提交发布请求',
  'agent.step_completed': '完成规划阶段', 'agent.plan_failed': '规划阶段失败',
  'agent.qa_completed': '提交 QA 意见', 'agent.qa_failed': 'QA 失败', 'task.status_changed': '更新执行状态',
};

function formatTokens(value: string) {
  return BigInt(value).toLocaleString('zh-CN');
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
        </li>
      ))}</ul> : <p className="muted">暂无模型用量。</p>}
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
