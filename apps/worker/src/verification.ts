import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, join, sep } from 'node:path';
import type { CheckResult, VerificationCheck } from '@ado/shared';

export interface VerificationSandbox {
  binary: string;
  env: Record<string, string>;
  worktree: string;
  profile: string[];
}

export async function runVerification(sandbox: VerificationSandbox, plan: VerificationCheck[], signal: AbortSignal) {
  const results: CheckResult[] = [];
  for (const check of plan) {
    signal.throwIfAborted();
    results.push(await runCheck(sandbox, check, signal));
  }
  return results;
}

async function runCheck(sandbox: VerificationSandbox, check: VerificationCheck, signal: AbortSignal): Promise<CheckResult> {
  const start = performance.now();
  const result = (status: CheckResult['status'], exitCode: number | null = null) => ({
    name: check.name, status, exitCode, durationMs: Math.round(performance.now() - start),
  });
  const directory = await realpath(join(sandbox.worktree, check.directory)).catch(() => null);
  if (!directory || (directory !== sandbox.worktree && !directory.startsWith(sandbox.worktree + sep))) return result('unavailable');

  const [program, ...arguments_] = check.argv;
  const candidates = sandbox.env.PATH.split(delimiter).map((base) => join(base, program));
  let executable: string | undefined;
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
      executable = candidate;
      break;
    }
  }
  if (!executable) return result('unavailable');
  signal.throwIfAborted();

  return new Promise<CheckResult>((resolve, reject) => {
    const child = spawn(sandbox.binary, ['sandbox', ...sandbox.profile.flatMap((part) => ['-c', part]),
      '-P', 'ado-job', '--', '/usr/bin/env', `HOME=${sandbox.worktree}`,
      'npm_config_cache=/tmp/ado-npm-cache', 'CI=true', executable, ...arguments_], {
      cwd: directory, env: sandbox.env, detached: true, stdio: 'ignore',
    });
    let timedOut = false;
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group may have already exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, check.timeoutSeconds * 1000);
    signal.addEventListener('abort', terminate, { once: true });
    const finish = (outcome: CheckResult) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', terminate);
      if (signal.aborted) reject(signal.reason);
      else resolve(outcome);
    };
    if (signal.aborted) terminate();
    child.once('error', () => finish(result('unavailable')));
    child.once('close', (code) => {
      terminate();
      if (timedOut) finish(result('timed_out'));
      else if (code === null) finish(result('unavailable'));
      else finish(result(code === 0 ? 'passed' : 'failed', code));
    });
  });
}
