import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class DeliveryError extends Error {
  constructor(readonly code: 'base_changed' | 'patch_rejected' | 'branch_conflict' | 'git_failed' | 'github_failed') {
    super(code);
  }
}

export interface GitCandidate {
  remote: string;
  token?: string;
  baseBranch: string;
  baseCommit: string;
  branch: string;
  patch: Buffer;
  timestamp: string;
  runId: string;
}

export async function pushCandidate(candidate: GitCandidate, signal: AbortSignal) {
  if (!/^ado\/[0-9a-f-]{36}$/.test(candidate.branch) || candidate.branch !== `ado/${candidate.runId}`
    || candidate.baseBranch === candidate.branch || !/^[0-9a-f]{40}$/.test(candidate.baseCommit)
    || !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,254}$/.test(candidate.baseBranch)) {
    throw new DeliveryError('patch_rejected');
  }
  const cwd = await mkdtemp(join(tmpdir(), 'ado-publish-'));
  const blank = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: cwd, TEMP: cwd, TMP: cwd,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HOME: cwd, GIT_CONFIG_GLOBAL: blank, GIT_CONFIG_SYSTEM: blank, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'ADO Platform', GIT_AUTHOR_EMAIL: 'ado@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'ADO Platform', GIT_COMMITTER_EMAIL: 'ado@users.noreply.github.com',
    GIT_AUTHOR_DATE: candidate.timestamp, GIT_COMMITTER_DATE: candidate.timestamp,
    ...(candidate.token && {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${candidate.token}`).toString('base64')}`,
    }),
  };
  const git = async (args: string[], timeout = 15_000) => (await exec('git',
    ['-c', 'http.followRedirects=false', ...args], { cwd, env, timeout, signal, maxBuffer: 1024 * 1024 })).stdout.trim();

  try {
    await git(['init', '--quiet', '--template=']);
    await git(['remote', 'add', 'origin', candidate.remote]);
    await git(['fetch', '--no-tags', 'origin', `refs/heads/${candidate.baseBranch}`], 80_000);
    try {
      await git(['merge-base', '--is-ancestor', candidate.baseCommit, 'FETCH_HEAD']);
    } catch {
      throw new DeliveryError('base_changed');
    }
    try {
      await git(['read-tree', candidate.baseCommit]);
      const patchPath = join(cwd, 'candidate.patch');
      await writeFile(patchPath, candidate.patch, { mode: 0o600, flag: 'wx' });
      await git(['apply', '--cached', '--check', '--binary', '--', patchPath]);
      await git(['apply', '--cached', '--binary', '--', patchPath]);
    } catch {
      throw new DeliveryError('patch_rejected');
    }
    const tree = await git(['write-tree']);
    if (tree === await git(['rev-parse', `${candidate.baseCommit}^{tree}`])) throw new DeliveryError('patch_rejected');
    const commit = await git(['commit-tree', tree, '-p', candidate.baseCommit, '-m', `ADO candidate ${candidate.runId}`]);
    const ref = `refs/heads/${candidate.branch}`;
    const remoteHead = async () => (await git(['ls-remote', '--refs', 'origin', ref])).split(/\s+/)[0];
    const existing = await remoteHead();
    if (existing && existing !== commit) throw new DeliveryError('branch_conflict');
    if (!existing) {
      try {
        // Empty expected value makes this a create-only ref update.
        await git(['push', `--force-with-lease=${ref}:`, 'origin', `${commit}:${ref}`], 45_000);
      } catch {
        const current = await remoteHead();
        if (!current) throw new DeliveryError('git_failed');
        if (current !== commit) throw new DeliveryError('branch_conflict');
      }
    }
    return commit;
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError('git_failed');
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
