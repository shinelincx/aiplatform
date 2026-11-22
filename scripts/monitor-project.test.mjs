import { expect, it, vi } from 'vitest';
import { monitorProject } from './monitor-project.mjs';

const env = {
  ADO_MONITOR_API_URL: 'http://127.0.0.1:3101',
  ADO_MONITOR_PROJECT_ID: '6d5c708a-cdbc-4bff-92d0-cad7adee114a',
  ADO_MONITOR_EMAIL: 'monitor@example.test',
  ADO_MONITOR_PASSWORD: 'synthetic-monitor-secret',
  ADO_MONITOR_REPOSITORY: 'fixture/ado',
  ADO_MONITOR_WORKFLOW: 'ci.yml',
  GITHUB_TOKEN: 'synthetic-read-only-token',
};
const snapshot = {
  project: 'ADO',
  current: { planningFailures: 0, qaFailures: 0, deliveryFailures: 0, workerFailures: 1, workerTimeouts: 0, queuedExecutions: 5 },
  recentAffectedTasks: 2,
  incidents: [{ stage: 'qa', category: 'rate_limited', occurrences: 4, affectedTasks: 2 }],
};
const run = {
  id: 421, event: 'push', head_branch: 'main', head_repository: { full_name: 'fixture/ado' },
  head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure',
};

function json(body, status = 200) {
  return new globalThis.Response(JSON.stringify(body), { status });
}

function sources({
  monitoring = json(snapshot), bindings = [{ fullName: 'fixture/ado', defaultBranch: 'main' }],
  ci = json({ workflow_runs: [run] }),
} = {}) {
  return vi.fn(async (url, options) => {
    expect(options.redirect).toBe('error');
    if (url.hostname === 'api.github.com') {
      expect(url.pathname).toBe('/repos/fixture/ado/actions/workflows/ci.yml/runs');
      expect(url.searchParams.get('branch')).toBe('main');
      expect(url.searchParams.get('event')).toBe('push');
      expect(options.headers.Authorization).toBe('Bearer synthetic-read-only-token');
      return ci;
    }
    expect(url.origin).toBe(env.ADO_MONITOR_API_URL);
    if (options.method === 'POST') return json({ token: 'b'.repeat(64) });
    expect(options.headers.Authorization).toBe('Bearer ' + 'b'.repeat(64));
    if (options.method === 'DELETE') return new globalThis.Response(null, { status: 204 });
    if (url.pathname.endsWith('/repositories')) return json(bindings);
    expect(url.pathname).toBe('/projects/' + env.ADO_MONITOR_PROJECT_ID + '/operations/monitoring');
    return monitoring;
  });
}

it('reports current failures separately from historic failures and ties CI to the matching commit', async () => {
  const read = sources();
  const report = await monitorProject(env, read);
  expect(report.current).toEqual(snapshot.current);
  expect(report.ci).toMatchObject({ state: 'failure', revision: run.head_sha, runId: 421 });
  expect(report.suggestions.map(({ key, impact }) => [key, impact])).toEqual([
    ['recent-agent-failures', { affectedTasks: 2 }],
    ['current-failed-work', { failures: 1 }],
    ['default-branch-ci-failure', { revision: run.head_sha, runId: 421 }],
  ]);
  expect(read.mock.lastCall[1].method).toBe('DELETE');
});

it('preserves project denial and closes the session', async () => {
  const read = sources({ monitoring: json({}, 404) });
  await expect(monitorProject(env, read)).rejects.toThrow('ADO project monitoring returned HTTP 404');
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.lastCall[1].method).toBe('DELETE');
});

it('refuses to query GitHub for a repository outside the monitored project', async () => {
  const read = sources({ bindings: [{ fullName: 'fixture/fitbest', defaultBranch: 'main' }] });
  await expect(monitorProject(env, read)).rejects.toThrow('not bound to the selected project');
  expect(read.mock.calls.every(([url]) => url.hostname === '127.0.0.1')).toBe(true);
  expect(read.mock.lastCall[1].method).toBe('DELETE');
});

it('keeps an unavailable CI source separate from an empty run list', async () => {
  const empty = await monitorProject(env, sources({ ci: json({ workflow_runs: [] }) }));
  const unavailable = await monitorProject(env, sources({ ci: json({}, 503) }));
  const unrelated = await monitorProject(env, sources({ ci: json({ workflow_runs: [{ ...run, head_branch: 'other' }] }) }));
  expect([empty.ci.state, unavailable.ci.state, unrelated.ci.state]).toEqual(['no_runs', 'unavailable', 'unavailable']);
});

it('rejects non-loopback plaintext before sending credentials', async () => {
  const read = sources();
  await expect(monitorProject({ ...env, ADO_MONITOR_API_URL: 'http://ado.example.test' }, read)).rejects.toThrow('HTTPS origin');
  expect(read).not.toHaveBeenCalled();
});
