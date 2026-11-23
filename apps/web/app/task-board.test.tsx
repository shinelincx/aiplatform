import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { TaskBoard } from './task-board';

test('renders expanded stages in order with requirement titles and creation times', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  try {
    const boundary = `${'需'.repeat(17)} ，👩‍💻`;
    const items = [
      { id: 'approved', title: '审批任务', status: 'WAITING_APPROVAL', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'draft', title: boundary, status: 'CREATED', createdAt: '2025-12-31T16:05:00Z' },
      { id: 'plan', title: `${boundary}e\u0301`, status: 'PLANNING', createdAt: '2025-12-31T15:59:00Z' },
    ] as const;
    const boardItems = items.map((task) => ({ ...task, code: 'NOT-SHOWN', priority: 'P1', archivedAt: null }) as const);
    const html = renderToStaticMarkup(<TaskBoard projectId="project" items={boardItems} canWrite={false} />);
    const cards = [...html.matchAll(/<a class="tcard"[^>]*>(.*?)<\/a>/g)].map(([, content]) => content);

    expect(html.match(/aria-expanded="true"/g)).toHaveLength(7);
    expect(html).not.toContain(' hidden=""');
    expect(cards).toEqual([
      `<h3>${boundary}</h3><time dateTime="2025-12-31T16:05:00Z">01-01 00:05</time>`,
      `<h3 title="${boundary}e\u0301">${boundary}…</h3><time dateTime="2025-12-31T15:59:00Z">2025-12-31 23:59</time>`,
      '<h3>审批任务</h3><time dateTime="2026-01-01T00:00:00Z">01-01 08:00</time>',
    ]);
    expect(boardItems[2].title).toBe(`${boundary}e\u0301`);
  } finally {
    vi.useRealTimers();
  }
});
