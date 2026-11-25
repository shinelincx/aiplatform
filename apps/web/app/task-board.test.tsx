import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { TaskBoard } from './task-board';

function taskCards(html: string) {
  return [...html.matchAll(/<a\s+([^>]+)>(.*?)<\/a>/gs)]
    .filter(([, attributes]) => attributes.includes('class="tcard"'))
    .map(([, attributes, content]) => ({ href: attributes.match(/\bhref="([^"]+)"/)?.[1].replaceAll('&amp;', '&') ?? '', content }));
}

function taskCard(html: string, id: string) {
  const cards = taskCards(html).filter(({ href }) => href === `/?project=project&section=tasks&task=${id}`);
  expect(cards).toHaveLength(1);
  return cards[0].content;
}

function field(label: string, value: string) {
  return '<span class="tcard__field">'
    + `<span class="sr-only">${label}：</span><span class="tcard__value" title="${value}">${value}</span></span>`;
}

test('renders expanded stages in order with requirement titles and creation times', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  try {
    const boundary = `${'需'.repeat(17)} ，👩‍💻`;
    const items = [
      { id: 'approved', title: '优先级：审批状态：待审批', priority: 'P0', status: 'WAITING_APPROVAL', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'draft', title: boundary, priority: 'P1', status: 'CREATED', createdAt: '2025-12-31T16:05:00Z' },
      { id: 'plan', title: `${boundary}e\u0301`, priority: 'P2', status: 'PLANNING', createdAt: '2025-12-31T15:59:00Z' },
    ] as const;
    const boardItems = items.map((task) => ({ ...task, code: 'NOT-SHOWN', archivedAt: null }));
    const html = renderToStaticMarkup(<TaskBoard projectId="project" items={boardItems} canWrite={false} />);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(7);
    expect(html).not.toContain(' hidden=""');
    expect([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(([, title]) => title))
      .toEqual(['规划', '审批', '待派发', '执行', '测试', '评审', '完成']);
    expect(taskCards(html).map(({ href }) => new URLSearchParams(href.slice(2)).get('task')))
      .toEqual(['draft', 'plan', 'approved']);

    const expected = [
      ['draft', boundary, boundary, 'P1', '草稿', '01-01 00:05'],
      ['plan', `${boundary}e\u0301`, `${boundary}…`, 'P2', '规划中', '2025-12-31 23:59'],
      ['approved', items[0].title, items[0].title, 'P0', '待审批', '01-01 08:00'],
    ];
    for (const [id, title, visibleTitle, priority, status, time] of expected) {
      const card = taskCard(html, id);
      expect(card).toBe('<div class="tcard__headline">'
        + field('优先级', priority)
        + `<h3 aria-label="${title}" title="${title}">${visibleTitle}</h3>`
        + field('状态', status)
        + `</div><time dateTime="${items.find((task) => task.id === id)?.createdAt}">${time}</time>`);
      expect(card).not.toMatch(/<(a|button|input)\b|tabindex=/i);
    }
    expect(boardItems[2].title).toBe(`${boundary}e\u0301`);
  } finally {
    vi.useRealTimers();
  }
});

test('keeps execution failures and pending decisions visible on timeline cards', () => {
  const base = { priority: 'P1', status: 'FAILED', archivedAt: null, createdAt: '2026-01-01T00:00:00Z' } as const;
  const items = [
    { ...base, id: 'failed', code: 'FA-1', title: '执行失败', failure: '执行超时' },
    { ...base, id: 'pending', code: 'FA-2', title: '等待决策', pending: 1 },
  ];
  const html = renderToStaticMarkup(<TaskBoard projectId="project" items={items} canWrite={false} />);
  expect(taskCard(html, 'failed')).toContain('</time><p class="tcard__reason">执行超时</p>');
  expect(taskCard(html, 'pending')).toContain('</time><p class="tcard__reason warning-text">1 项待人工确认</p>');
});

test('displays missing and unknown fields independently and groups unmatched tasks once', () => {
  const longStatus = 'UnknownStatus'.repeat(30);
  const base = { title: '异常字段任务', code: 'FIELD', archivedAt: null, createdAt: '2026-01-01T00:00:00Z' };
  const items = [
    { ...base, id: 'missing-priority', status: 'FAILED', failure: '执行超时' },
    { ...base, id: 'null-priority', priority: null, status: 'CREATED' },
    { ...base, id: 'empty-priority', priority: '', status: 'PLANNING' },
    { ...base, id: 'unknown-priority', priority: 'toString', status: 'CREATED' },
    { ...base, id: 'missing-status', priority: 'P0', pending: 1 },
    { ...base, id: 'null-status', priority: 'P1', status: null },
    { ...base, id: 'empty-status', priority: 'P2', status: '' },
    { ...base, id: 'inherited-status', priority: 'P0', status: 'toString' },
    { ...base, id: 'long-status', priority: longStatus, status: longStatus },
    { ...base, id: 'archived-status', priority: 'P0', status: 'unknown', archivedAt: base.createdAt },
  ];
  const html = renderToStaticMarkup(<TaskBoard projectId="project" items={items} canWrite />);
  const expected = [
    ['missing-priority', '—', '失败'],
    ['null-priority', '—', '草稿'],
    ['empty-priority', '—', '规划中'],
    ['unknown-priority', 'toString', '草稿'],
    ['missing-status', 'P0', '—'],
    ['null-status', 'P1', '—'],
    ['empty-status', 'P2', '—'],
    ['inherited-status', 'P0', 'toString'],
    ['long-status', longStatus, longStatus],
  ];
  for (const [id, priority, status] of expected) {
    const card = taskCard(html, id);
    expect(card).toContain(field('优先级', priority)
      + '<h3 aria-label="异常字段任务" title="异常字段任务">异常字段任务</h3>'
      + field('状态', status)
      + `</div><time dateTime="${base.createdAt}">`);
  }
  expect(taskCard(html, 'missing-priority')).toContain('执行超时');
  expect(taskCard(html, 'missing-status')).toContain('1 项待人工确认');
  expect(html).not.toContain('task=archived-status');
  expect(html).toContain('显示已归档');
  const neutral = html.slice(html.indexOf('<h2>未归类任务</h2>'));
  expect(html.indexOf('<h2>完成</h2>')).toBeLessThan(html.indexOf('<h2>未归类任务</h2>'));
  expect(neutral).toContain('<h2>未归类任务</h2><b>5</b>');
  const listId = neutral.match(/aria-expanded="true" aria-controls="([^"]+)" aria-label="收缩未归类任务"/)?.[1];
  expect(listId).toBeDefined();
  expect(neutral).toContain(`<div class="lane__body" id="${listId}">`);
  expect(taskCards(neutral).map(({ href }) => new URLSearchParams(href.slice(2)).get('task')))
    .toEqual(['missing-status', 'null-status', 'empty-status', 'inherited-status', 'long-status']);
});

test('keeps the board available when all tasks are uncategorized', () => {
  const html = renderToStaticMarkup(<TaskBoard projectId="project" canWrite={false} items={[
    { id: 'unknown', code: 'UNKNOWN', title: '未归类', archivedAt: null, createdAt: '2026-01-01T00:00:00Z' },
  ]} />);

  expect(html).toContain('<h2>未归类任务</h2><b>1</b>');
  expect(html).not.toContain('role="status"');
  expect(taskCard(html, 'unknown')).toContain(field('优先级', '—')
    + '<h3 aria-label="未归类" title="未归类">未归类</h3>'
    + field('状态', '—'));
});
