'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { taskPriorities, type Task, type TaskPriority } from '@ado/shared';
import { Icon } from './icons';
import { laneForStatus, taskLanes, workspaceHref, type TaskLane } from './workspace';

type BoardTask = Pick<Task, 'id' | 'code' | 'title' | 'priority' | 'status' | 'archivedAt' | 'createdAt'> & {
  failure?: string | null;
  pending?: number;
};

const titleSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const boardDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function TaskBoard({ projectId, items, canWrite, lane }: {
  projectId: string; items: BoardTask[]; canWrite: boolean; lane?: string;
}) {
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<Partial<Record<TaskLane, boolean>>>({});
  const boardId = useId();
  const currentYear = boardDate.format(new Date()).slice(0, 4);
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
        const expanded = !collapsed[column.id];
        const listId = `${boardId}-${column.id}`;
        return <section className="lane" key={column.id} data-tone={column.tone} data-highlighted={lane === column.id}>
          <header className="lane__head">
            <span className="lane__dot" aria-hidden="true" /><h2>{column.label}</h2><small>{column.caption}</small><b>{tasks.length}</b>
            <button type="button" className="lane__toggle" aria-expanded={expanded} aria-controls={listId}
              aria-label={`${expanded ? '收缩' : '展开'}${column.label}`}
              onClick={() => setCollapsed((previous) => ({ ...previous, [column.id]: !previous[column.id] }))}>
              {expanded ? '收缩' : '展开'}
            </button>
          </header>
          <div className="lane__body" id={listId} hidden={!expanded}>
            {tasks.map((task) => {
              const cutoff = [...titleSegmenter.segment(task.title)][20]?.index;
              const createdAt = boardDate.format(new Date(task.createdAt));
              return <Link className="tcard" key={task.id}
                href={workspaceHref(projectId, 'tasks', { ...(lane && { lane }), task: task.id })} scroll={false}>
                <h3 title={cutoff === undefined ? undefined : task.title}>
                  {cutoff === undefined ? task.title : `${task.title.slice(0, cutoff)}…`}
                </h3>
                <time dateTime={task.createdAt}>{createdAt.slice(0, 4) === currentYear ? createdAt.slice(5) : createdAt}</time>
                {task.failure && <p className="tcard__reason">{task.failure}</p>}
                {!!task.pending && <p className="tcard__reason warning-text">{task.pending} 项待人工确认</p>}
              </Link>;
            })}
            {!tasks.length && <p className="lane__empty">暂无任务</p>}
          </div>
        </section>;
      })}
    </div>
    {!filtered.length && <p className="empty" role="status">{items.length ? '没有符合条件的任务。' : '项目尚无任务。'}</p>}
  </>;
}
