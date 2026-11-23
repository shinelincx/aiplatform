'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { taskPriorities, type Task, type TaskPriority } from '@ado/shared';
import { Icon } from './icons';
import { laneForStatus, taskLanes, taskStatusLabels, workspaceHref } from './workspace';

type BoardTask = Pick<Task, 'id' | 'code' | 'title' | 'priority' | 'status' | 'archivedAt'> & {
  developerLabel?: string;
  repository?: string;
};

export function TaskBoard({ projectId, items, canWrite, lane }: {
  projectId: string; items: BoardTask[]; canWrite: boolean; lane?: string;
}) {
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [showArchived, setShowArchived] = useState(false);
  const board = useRef<HTMLDivElement>(null);
  const keyword = query.trim().toLowerCase();
  const filtered = items.filter((task) => (showArchived || !task.archivedAt)
    && (!priority || task.priority === priority)
    && (!keyword || task.title.toLowerCase().includes(keyword) || task.code.toLowerCase().includes(keyword)));

  useEffect(() => {
    board.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [lane]);

  return <>
    <div className="toolbar">
      <label className="search"><Icon name="search" />
        <input type="search" aria-label="搜索任务或编号" placeholder="搜索任务 / 编号" value={query}
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="chips" role="group" aria-label="优先级">
        {(['', ...taskPriorities] as const).map((value) => <button className="filter-chip" key={value}
          type="button" aria-pressed={priority === value} onClick={() => setPriority(value)}>{value || '全部'}</button>)}
      </div>
      {items.some(({ archivedAt }) => archivedAt) && <label className="board-archive">
        <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />显示已归档
      </label>}
      {canWrite && <Link className="btn btn--primary board-create" href={workspaceHref(projectId, 'tasks', { create: 'task' })} scroll={false}>
        <Icon name="plus" />新建任务
      </Link>}
    </div>
    <div className="board" ref={board} role="region" aria-label="任务看板各阶段">
      {taskLanes.map((column) => {
        const tasks = filtered.filter(({ status }) => laneForStatus[status] === column.id);
        return <section className="lane" key={column.id} data-tone={column.tone} data-highlighted={lane === column.id}>
          <header className="lane__head">
            <span className="lane__dot" /><h2>{column.label}</h2><small>{column.caption}</small><b>{tasks.length}</b>
          </header>
          <div className="lane__body">
            {tasks.map((task) => <Link className="tcard" key={task.id}
              href={workspaceHref(projectId, 'tasks', { ...(lane && { lane }), task: task.id })} scroll={false}>
              <div className="tcard__top"><span title={task.code}>{task.code}</span><span className="prio" data-priority={task.priority}>{task.priority}</span></div>
              <h3>{task.title}</h3>
              {task.repository && <span className="tcard__repo" title={task.repository}>{task.repository}</span>}
              <div className="tcard__meta">
                <span className="badge" data-status={task.status}>{task.archivedAt ? '已归档' : taskStatusLabels[task.status]}</span>
                {task.developerLabel && <small>{task.developerLabel}</small>}
              </div>
            </Link>)}
            {!tasks.length && <p className="lane__empty">暂无任务</p>}
          </div>
        </section>;
      })}
    </div>
    {!filtered.length && <p className="empty" role="status">{items.length ? '没有符合条件的任务。' : '项目尚无任务。'}</p>}
  </>;
}
