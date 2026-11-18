import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, join, sep } from 'node:path';
import { checkFailureStatuses, type CheckFailureReason, type CheckResult, type VerificationCheck } from '@ado/shared';

export interface VerificationSandbox {
  binary: string;
  env: Record<string, string>;
  worktree: string;
  profile: string[];
}

interface CheckExecution {
  result: CheckResult;
  diagnostic?: string;
}

const diagnosticBytes = 4096;

function diagnosticText(tail: Buffer) {
  const text = Array.from(tail.toString('utf8')).filter((character) =>
    character === '\n' || character === '\t' || character.charCodeAt(0) >= 32).join('').trim();
  const bytes = Buffer.from(text);
  let offset = Math.max(0, bytes.length - diagnosticBytes);
  while ((bytes[offset] & 0xc0) === 0x80) offset++;
  return bytes.toString('utf8', offset);
}

export async function runVerification(sandbox: VerificationSandbox, plan: VerificationCheck[], signal: AbortSignal) {
  const results: CheckExecution[] = [];
  for (const check of plan) {
    signal.throwIfAborted();
    results.push(await runCheck(sandbox, check, signal));
  }
  return results;
}

async function runCheck(sandbox: VerificationSandbox, check: VerificationCheck, signal: AbortSignal): Promise<CheckExecution> {
  const start = performance.now();
  const result = (reason?: CheckFailureReason, exitCode: number | null = null): CheckExecution => ({
    result: { name: check.name, status: reason ? checkFailureStatuses[reason] : 'passed',
      exitCode, durationMs: Math.round(performance.now() - start), ...(reason && { reason }) },
  });
  const directory = await realpath(join(sandbox.worktree, check.directory)).catch(() => null);
  if (!directory || (directory !== sandbox.worktree && !directory.startsWith(sandbox.worktree + sep))) return result('directory_unavailable');

  const [program, ...arguments_] = check.argv;
  const candidates = sandbox.env.PATH.split(delimiter).map((base) => join(base, program));
  let executable: string | undefined;
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
      executable = candidate;
      break;
    }
  }
  if (!executable) return result('executable_unavailable');
  signal.throwIfAborted();

  return new Promise<CheckExecution>((resolve, reject) => {
    const child = spawn(sandbox.binary, ['sandbox', ...sandbox.profile.flatMap((part) => ['-c', part]),
      '-P', 'ado-job', '--', '/usr/bin/env', `HOME=${sandbox.worktree}`,
      'npm_config_cache=/tmp/ado-npm-cache', 'CI=true', executable, ...arguments_], {
      cwd: directory, env: sandbox.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = Buffer.alloc(0);
    const capture = (chunk: Buffer) => {
      const recent = chunk.subarray(-diagnosticBytes);
      const remaining = diagnosticBytes - recent.length;
      tail = remaining ? Buffer.concat([tail.subarray(-remaining), recent]) : Buffer.from(recent);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    let timedOut = false;
    let finished = false;
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group may have already exited. */ }
    };
    const interrupt = () => {
      terminate();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => { timedOut = true; interrupt(); }, check.timeoutSeconds * 1000);
    signal.addEventListener('abort', interrupt, { once: true });
    const finish = (outcome: CheckExecution) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', interrupt);
      if (signal.aborted) reject(signal.reason);
      else resolve(outcome);
    };
    if (signal.aborted) interrupt();
    child.once('exit', terminate);
    child.once('error', () => finish(result('start_failed')));
    child.once('close', (code) => {
      if (timedOut) finish(result('timeout'));
      else if (code === null) finish(result('process_terminated'));
      else if (code === 0) finish(result(undefined, code));
      else {
        const diagnostic = diagnosticText(tail);
        finish({ ...result('nonzero_exit', code), ...(diagnostic && { diagnostic }) });
      }
    });
  });
}
