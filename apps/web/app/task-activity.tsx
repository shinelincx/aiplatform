'use client';

import { useId, useState } from 'react';
import { Icon } from './icons';
import { RetrySection } from './refresh-execution';

export type ActivityItem = {
  id: string;
  at: string;
  label: string;
  group: string;
  tone?: 'mint' | 'rose' | 'amber';
  detail?: string;
  files?: string[];
};

const limit = 30;
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Singapore', dateStyle: 'short', timeStyle: 'medium' });

export function TaskActivity({ title, items, live = false }: { title: string; items: ActivityItem[]; live?: boolean }) {
  const id = useId();
  const [group, setGroup] = useState('');
  const [paused, setPaused] = useState<ActivityItem[] | null>(null);
  const [shown, setShown] = useState(limit);
  const shownItems = paused ?? items;
  const groups = [...new Set(shownItems.map((item) => item.group))];
  const selected = groups.includes(group) ? group : '';
  const matching = selected ? shownItems.filter((item) => item.group === selected) : shownItems;
  const mostRecentSeen = paused?.[0]?.id;
  const pending = paused ? items.findIndex((item) => item.id === mostRecentSeen) : 0;
  const unseen = pending < 0 ? items.length : pending;

  return <section className="task-activity" aria-labelledby={id}>
    <header className="task-activity__head">
      <div><h4 id={id}><Icon name="terminal" />{title}</h4>
        <p>{live ? '前台每 3 秒刷新' : '最新记录在前'}<span aria-hidden="true"> · </span>{shownItems.length} 条</p>
      </div>
      <div className="task-activity__tools">
        {(live || paused) && <button type="button" className="secondary" onClick={() => setPaused(paused ? null : items)}>
          {paused ? '恢复显示' : '暂停显示'}
        </button>}
        <RetrySection label={title} buttonLabel="刷新" />
      </div>
    </header>
    {paused && <p className="task-activity__pause" role="status">显示已暂停{unseen > 0 && ` · ${unseen} 条新记录`}</p>}
    {groups.length > 1 && <div className="task-activity__filters" role="group" aria-label="筛选记录">
      {['', ...groups].map((key) => <button key={key} type="button" aria-pressed={selected === key}
        onClick={() => { setGroup(key); setShown(limit); }}>{key || '全部'}</button>)}
    </div>}
    {matching.length ? <ol className="task-activity__list">
      {matching.slice(0, shown).map(({ id: rowId, at, label, group: kind, tone, detail, files }) => <li key={rowId} data-tone={tone}>
        <time dateTime={at} title={dateTime.format(new Date(at))}>{time.format(new Date(at))}</time>
        <span className="task-activity__kind">{kind}</span>
        <div className="task-activity__body"><strong>{label}</strong>
          {detail && <small>{detail}</small>}
          {Boolean(files?.length) && <ul className="file-chips">{files?.map((file, index) => <li key={`${file}-${index}`}>{file}</li>)}</ul>}
        </div>
      </li>)}
    </ol> : <p className="task-detail__empty">{live ? '等待第一条记录。' : '暂无记录。'}</p>}
    {matching.length > shown && <button type="button" className="secondary task-activity__more" onClick={() => setShown(shown + limit)}>
      查看较早记录（{matching.length - shown}）
    </button>}
  </section>;
}
