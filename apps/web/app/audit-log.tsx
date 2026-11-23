'use client';

import { agentRoleLabels, type AgentRole, type ProjectAuditEntry } from '@ado/shared';
import { useState } from 'react';
import { ActionDialog } from './console-controls';
import { Icon } from './icons';

const categories: Record<string, { label: string; tone: string }> = {
  task: { label: '任务', tone: 'ice' },
  agent: { label: 'Agent', tone: 'violet' },
  skill: { label: 'Skill', tone: 'violet' },
  execution: { label: '执行', tone: 'mint' },
  repository: { label: '仓库', tone: 'teal' },
  delivery: { label: '交付', tone: 'teal' },
  project: { label: '项目', tone: 'mute' },
  requirement: { label: '需求', tone: 'ice' },
  operations: { label: '用量', tone: 'amber' },
};

const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', dateStyle: 'short' });
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', timeStyle: 'medium', hour12: false });

export function AuditLog({ entries }: { entries: (ProjectAuditEntry & { title: string })[] }) {
  const [filter, setFilter] = useState('');
  const grouped = entries.map((entry) => {
    const group = entry.action.split('.')[0];
    return { ...entry, group: Object.hasOwn(categories, group) ? group : 'other' };
  });
  const groups = [...new Set(grouped.map(({ group }) => group))];
  const activeFilter = groups.includes(filter) ? filter : '';
  const visible = grouped.filter(({ group }) => !activeFilter || group === activeFilter);

  return <>
    {groups.length > 1 && <div className="chips audit-filters" role="group" aria-label="审计事件类别">
      {['', ...groups].map((group) => <button key={group} type="button" className="filter-chip"
        aria-pressed={group === activeFilter} onClick={() => setFilter(group)}>{group ? categories[group]?.label ?? '其他' : '全部'}</button>)}
    </div>}
    {visible.length ? <ul className="audit-list" aria-label="审计记录">
      {visible.map(({ id, action, actor, createdAt, resourceId, group, title, details }) => {
        const category = categories[group];
        const actorLabel = Object.hasOwn(agentRoleLabels, actor) ? agentRoleLabels[actor as AgentRole] : actor;
        const dateTime = new Date(createdAt);
        return <li key={id}>
          <ActionDialog title={title} className="audit-row" trigger={<>
            <time dateTime={createdAt}><span>{date.format(dateTime)}</span><b>{time.format(dateTime)}</b></time>
            <span className="audit-row__event"><span className="module-tag" data-tone={category?.tone}>{category?.label ?? '其他'}</span>
              <strong>{title}</strong><small>{actorLabel}</small></span>
            <Icon name="chevron" />
          </>}>
            <dl className="modal-facts">
              <div><dt>事件</dt><dd><code>{action}</code></dd></div>
              <div><dt>操作者</dt><dd>{actorLabel}</dd></div>
              <div><dt>时间</dt><dd><time dateTime={createdAt}>{date.format(dateTime)} {time.format(dateTime)} UTC+8</time></dd></div>
              <div><dt>资源 ID</dt><dd><code>{resourceId}</code></dd></div>
              {details?.role && <div><dt>Agent</dt><dd>{agentRoleLabels[details.role]}</dd></div>}
              {details?.version && <div><dt>版本</dt><dd>v{details.version}</dd></div>}
              {details?.month && <div><dt>预算月份（UTC）</dt><dd>{details.month} · {details.budgetUsd == null ? '未设置' : `US$${details.budgetUsd}`}</dd></div>}
              {details?.enabled !== undefined && <div><dt>状态</dt><dd>{details.enabled ? '启用' : '停用'}</dd></div>}
            </dl>
          </ActionDialog>
        </li>;
      })}
    </ul> : <p className="empty">暂无审计记录</p>}
  </>;
}
