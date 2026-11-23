'use client';

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon, type IconName } from './icons';

const tabs = {
  summary: { label: '概览', icon: 'tasks' },
  plan: { label: '规划', icon: 'agents' },
  execution: { label: '执行与验收', icon: 'terminal' },
  activity: { label: '活动', icon: 'layers' },
} satisfies Record<string, { label: string; icon: IconName }>;

export type TaskDetailTab = keyof typeof tabs;

const tabOrder = Object.keys(tabs) as TaskDetailTab[];
const tabForHash: Record<string, TaskDetailTab> = {
  '#task-summary': 'summary',
  '#task-plan': 'plan',
  '#task-decisions': 'execution',
  '#execution-heading': 'execution',
  '#task-events': 'activity',
};
const executionDialogs = ['dispatch', 'worker-assignment', 'independent-evidence', 'evidence', 'review', 'publish', 'delivery-complete', 'delivery-cancel'];

export function TaskDetailTabs({ initialTab, panels }: { initialTab: TaskDetailTab; panels: Record<TaskDetailTab, ReactNode> }) {
  const id = useId();
  const dialog = useSearchParams().get('dialog');
  const [selected, select] = useState<TaskDetailTab>();
  const current = dialog && executionDialogs.includes(dialog) ? 'execution' : selected ?? initialTab;

  useEffect(() => {
    function syncHash() {
      const target = tabForHash[location.hash];
      if (target) select(target);
    }
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: tabOrder.length - index - 1 };
    if (!Object.hasOwn(offsets, event.key)) return;
    event.preventDefault();
    const next = tabOrder[(index + offsets[event.key] + tabOrder.length) % tabOrder.length];
    select(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  return <>
    <div className="task-detail__tabs" role="tablist" aria-label="任务详情">
      {tabOrder.map((key, index) => <button key={key} type="button" role="tab" id={`${id}-tab-${key}`}
        aria-selected={current === key} aria-controls={`${id}-panel-${key}`} tabIndex={current === key ? 0 : -1}
        onClick={() => select(key)} onKeyDown={(event) => handleKey(event, index)}>
        <Icon name={tabs[key].icon} />{tabs[key].label}
      </button>)}
    </div>
    <div className="task-detail__content">
      {tabOrder.map((key) => <section key={key} role="tabpanel" id={`${id}-panel-${key}`}
        className="task-detail__panel" aria-labelledby={`${id}-tab-${key}`} hidden={current !== key} tabIndex={0}>
        {panels[key]}
      </section>)}
    </div>
  </>;
}
