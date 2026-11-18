import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { pushCandidate } from '../src/git-delivery';

it('publishes the tested patch to a create-only branch and recovers repeats without overwriting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ado-delivery-test-'));
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    git('init', '-q', '-b', 'main');
    const path = join(root, 'candidate.txt');
    writeFileSync(path, 'old\n');
    git('add', 'candidate.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
    const base = git('rev-parse', 'HEAD').toString().trim();
    writeFileSync(path, 'verified\n');
    const patch = git('diff', '--binary');
    const runId = '2cc800da-1fc0-4c48-8499-d0022c36d136';
    const branch = `ado/${runId}`;
    const candidate = {
      runId, remote: root, baseBranch: 'main', baseCommit: base, branch, patch,
      timestamp: '2026-01-02T03:04:05.000Z',
    };
    const ship = (input: typeof candidate) => pushCandidate(input, AbortSignal.timeout(12_000));
    const first = await ship(candidate);
    expect(git('show', `${branch}:candidate.txt`).toString()).toBe('verified\n');
    expect(await ship(candidate)).toBe(first);
    writeFileSync(path, 'different\n');
    await expect(ship({ ...candidate, patch: git('diff', '--binary') })).rejects.toMatchObject({ code: 'branch_conflict' });
    expect(git('rev-parse', branch).toString().trim()).toBe(first);
    expect(git('rev-parse', 'main').toString().trim()).toBe(base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
