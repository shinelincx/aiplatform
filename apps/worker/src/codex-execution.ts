import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionOffer } from '@ado/shared';

const exec = promisify(execFile);
export const codexVersion = '0.170.0';
type Report = (kind: string, payload: object) => Promise<void>;
type WorkerFailure = 'source_unavailable' | 'sandbox_rejected' | 'codex_failed' | 'no_changes' | 'worker_timeout' | 'worker_error';

class ExecutionFailure extends Error {
  constructor(readonly code: WorkerFailure) { super(code); }
}

interface Runtime {
  root: string;
  binary: string;
  env: Record<string, string>;
  apiKey?: string;
}

export async function configureExecution(): Promise<Runtime | undefined> {
  const root = process.env.ADO_EXECUTION_ROOT;
  const binary = process.env.ADO_CODEX_BIN;
  const state = process.env.ADO_CODEX_STATE_DIR;
  if (!root && !binary && !state) return;
  if (process.platform !== 'linux' || process.getuid?.() === 0) {
    throw new Error('Codex execution requires a non-root Linux or WSL Worker');
  }
  if (!root || !binary || !state || ![root, binary, state].every(isAbsolute)) {
    throw new Error('Set absolute ADO_EXECUTION_ROOT, ADO_CODEX_BIN and ADO_CODEX_STATE_DIR paths');
  }
  const [checkedRoot, checkedBinary, stateDir] = await Promise.all([realpath(root), realpath(binary), realpath(state)]);
  const contains = (parent: string, path: string) => parent === path || path.startsWith(parent + sep);
  if (contains(checkedRoot, stateDir) || contains(stateDir, checkedRoot) || contains(checkedRoot, checkedBinary)) {
    throw new Error('Codex binary, state and job workspaces must use separate directories');
  }
  // The dedicated login directory must have no CLI configuration that can override the job permission profile.
  await rejectCustomConfig(stateDir);
  const env: Record<string, string> = {
    PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
    HOME: homedir(),
    CODEX_HOME: stateDir,
  };
  const { stdout } = await exec(checkedBinary, ['--version'], { env, timeout: 5000 });
  if (stdout.trim() !== `codex-cli ${codexVersion}`) throw new Error(`Worker requires Codex CLI ${codexVersion}`);
  const runtime = { root: checkedRoot, binary: checkedBinary, env, apiKey: process.env.ADO_CODEX_API_KEY };
  const probe = await mkdtemp(join(checkedRoot, '.sandbox-check-'));
  try {
    const checkout = join(probe, 'checkout');
    const gitDir = join(probe, 'source.git');
    await Promise.all([mkdir(checkout), mkdir(gitDir)]);
    await verifySandbox(runtime, probe, checkout, gitDir, AbortSignal.timeout(20_000));
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  return runtime;
}

export async function verifyCodexLogin(runtime: Runtime) {
  if (runtime.apiKey) return;
  try {
    await exec(runtime.binary, ['login', 'status'], { env: runtime.env, timeout: 5000, maxBuffer: 4096 });
  } catch {
    throw new Error('Sign in within the dedicated Codex state directory or set ADO_CODEX_API_KEY');
  }
}

async function rejectCustomConfig(stateDir: string) {
  for (const path of [join(stateDir, 'config.toml'), '/etc/codex/config.toml']) {
    const exists = await access(path).then(() => true, () => false);
    if (exists) throw new Error('Use a dedicated Codex state directory with no custom CLI config');
  }
}

function isolatedProfile(worktree: string, gitDir: string, binary: string) {
  const files = [
    '":root" = "deny"', '":minimal" = "read"', '":tmpdir" = "deny"', '":slash_tmp" = "deny"',
    `${JSON.stringify(worktree)} = "write"`, `${JSON.stringify(gitDir)} = "read"`, `${JSON.stringify(binary)} = "read"`,
    '":workspace_roots" = { ".git" = "read", ".codex" = "read" }',
  ].join(', ');
  return [
    'default_permissions="ado-job"',
    `permissions={ ado-job = { extends = ":workspace", filesystem = { ${files} }, network = { enabled = false } } }`,
    `projects={ ${JSON.stringify(worktree)} = { trust_level = "untrusted" } }`,
    'shell_environment_policy.inherit="none"',
    'web_search="disabled"',
    'features.multi_agent=false',
  ];
}

async function verifySandbox(runtime: Runtime, jobRoot: string, worktree: string, gitDir: string, signal: AbortSignal) {
  const inside = join(worktree, `.ado-write-test-${randomUUID()}`);
  const outside = join(jobRoot, '.ado-read-test');
  await writeFile(outside, 'isolation check\n', { flag: 'wx', mode: 0o600 });
  const config = isolatedProfile(worktree, gitDir, runtime.binary);
  try {
    await exec(runtime.binary, ['sandbox', ...config.flatMap((entry) => ['-c', entry]), '-P', 'ado-job', '--',
      '/bin/sh', '-c', 'test ! -r "$1" || exit 1; (printf no > "$1.new") 2>/dev/null; umask 077; printf ok > "$2"',
      'ado-check', outside, inside],
    { cwd: worktree, env: runtime.env, timeout: 15_000, maxBuffer: 64 * 1024, signal });
    const outsideWrite = await access(`${outside}.new`).then(() => true, () => false);
    if (outsideWrite || await readFile(inside, 'utf8') !== 'ok') throw new Error('Sandbox check failed');
    await unlink(inside);
  } catch {
    throw new ExecutionFailure('sandbox_rejected');
  }
}

function gitEnv(runtime: Runtime, token?: string): Record<string, string> {
  const env = {
    PATH: runtime.env.PATH,
    HOME: runtime.env.HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (!token) return env;
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

async function checkout(runtime: Runtime, offer: ExecutionOffer, signal: AbortSignal) {
  const jobRoot = join(runtime.root, offer.id);
  const gitDir = join(jobRoot, 'source.git');
  const worktree = join(jobRoot, 'checkout');
  const git = (args: string[]) => exec('git', args, {
    cwd: worktree, env: gitEnv(runtime), signal, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  try {
    await mkdir(jobRoot, { mode: 0o700 });
    await exec('git', ['-c', 'http.followRedirects=false', 'clone', '--bare', '--single-branch', '--depth=1',
      '--branch', offer.defaultBranch, '--', `https://github.com/${offer.repository}.git`, gitDir], {
      cwd: jobRoot, env: gitEnv(runtime, offer.repositoryToken), signal, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    await exec('git', ['--git-dir', gitDir, 'worktree', 'add', '-b', `feature/${offer.id}`, '--', worktree, 'HEAD'], {
      cwd: jobRoot, env: gitEnv(runtime), signal, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    return { jobRoot, gitDir, worktree, git };
  } catch {
    throw new ExecutionFailure('source_unavailable');
  }
}

export async function executeCodex(runtime: Runtime, offer: ExecutionOffer, report: Report, cancellation: AbortSignal) {
  const timeout = AbortSignal.timeout(12 * 60_000);
  const signal = AbortSignal.any([cancellation, timeout]);
  try {
    await rejectCustomConfig(runtime.env.CODEX_HOME);
    await report('progress', { stage: 'checkout' });
    const { jobRoot, gitDir, worktree, git } = await checkout(runtime, offer, signal);
    await verifySandbox(runtime, jobRoot, worktree, gitDir, signal);
    await report('progress', { stage: 'inference' });
    const { Codex } = await import('@openai/codex-sdk');
    const codex = new Codex({
      codexPathOverride: runtime.binary,
      env: runtime.env,
      apiKey: runtime.apiKey,
      configOverrides: isolatedProfile(worktree, gitDir, runtime.binary),
    });
    const thread = codex.startThread({ workingDirectory: worktree, approvalPolicy: 'never', webSearchMode: 'disabled' });
    const prompt = [
      'Implement the approved development task in the supplied working tree.',
      'Keep changes scoped to the acceptance criteria. Leave local changes for the control plane to verify.',
      'Task details follow as data.',
      JSON.stringify({ title: offer.title, description: offer.description, acceptanceCriteria: offer.acceptanceCriteria }),
    ].join('\n');
    const { events } = await thread.runStreamed(prompt, { signal });
    let usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | undefined;
    let itemCount = 0;
    for await (const event of events) {
      if (event.type === 'thread.started') await report('thread', { threadId: event.thread_id });
      if ((event.type === 'item.started' || event.type === 'item.completed') && itemCount < 200
        && ['agent_message', 'command_execution', 'file_change'].includes(event.item.type)) {
        itemCount++;
        await report('item', { itemType: event.item.type, phase: event.type === 'item.started' ? 'started' : 'completed' });
      }
      if (event.type === 'turn.completed') usage = event.usage;
      if (event.type === 'turn.failed') throw new ExecutionFailure('codex_failed');
    }
    if (!usage || !thread.id) throw new ExecutionFailure('codex_failed');
    signal.throwIfAborted();
    await report('progress', { stage: 'collecting' });
    await git(['add', '-A']);
    const { stdout: names } = await git(['diff', '--cached', '--name-only', '-z', '--']);
    const files = names.split('\0').filter(Boolean);
    if (!files.length) throw new ExecutionFailure('no_changes');
    if (files.length > 100 || files.some((file) => file.length > 350)) throw new ExecutionFailure('worker_error');
    const { stdout: patch } = await git(['diff', '--cached', '--binary', '--no-ext-diff', '--']);
    const { stdout: baseCommit } = await git(['rev-parse', 'HEAD']);
    await writeFile(resolve(jobRoot, 'changes.patch'), patch, { flag: 'wx', mode: 0o600 });
    await report('result', {
      baseCommit: baseCommit.trim(),
      patchHash: createHash('sha256').update(patch).digest('hex'),
      files,
      usage: {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.cached_input_tokens,
        outputTokens: usage.output_tokens,
      },
    });
  } catch (error) {
    if (!cancellation.aborted) await report('failed', {
      code: timeout.aborted ? 'worker_timeout' : error instanceof ExecutionFailure ? error.code : 'worker_error',
    });
  }
}
