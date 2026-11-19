import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex } from '@openai/codex-sdk';
import { WebSocketServer } from 'ws';
import { configureExecution, isolatedProfile, summarizeItem } from '../apps/worker/dist/codex-execution.js';
import { checkTempDirectory, runVerification } from '../apps/worker/dist/verification.js';

const fixtureKey = 'ado-local-sdk-fixture';
const revisions = ['implemented by SDK fixture', 'repaired by SDK fixture'];
const commandSeconds = 6;
const usage = { input_tokens: 12, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 17 };
const quote = (path) => "'" + path.replaceAll("'", "'\\''") + "'";

async function verify() {
  assert(process.env.ADO_CODEX_BIN, 'Set ADO_CODEX_BIN to the pinned native Linux Codex binary');
  const root = await mkdtemp(join(await realpath(homedir()), 'ado-sdk-proof-'));
  const server = createServer((_, response) => { response.writeHead(404); response.end(); });
  const gateway = new WebSocketServer({ server, path: '/v1/responses' });
  try {
    const modelProxyHost = 'ado-model-proxy.invalid';
    server.on('connect', (request, socket) => {
      if (request.url === `${modelProxyHost}:443`) server.emit('modelProxyConnect');
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const proxyUrl = 'http://127.0.0.1:' + server.address().port;
    const jobs = join(root, 'jobs');
    const state = join(root, 'codex');
    const seed = join(root, 'seed');
    const source = join(root, 'source.git');
    const checkout = join(root, 'checkout');
    const outside = join(root, 'outside.txt');
    await Promise.all([mkdir(jobs), mkdir(state), writeFile(outside, 'outside fixture')]);
    const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--initial-branch=main', seed]);
    await writeFile(join(seed, 'fixture.txt'), 'baseline\n');
    git(['add', '--', 'fixture.txt'], seed);
    git(['-c', 'user.name=ADO fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'baseline'], seed);
    git(['clone', '--bare', '--no-hardlinks', '--', seed, source]);
    git(['--git-dir', source, 'worktree', 'add', '-b', 'fixture', '--', checkout, 'HEAD']);
    Object.assign(process.env, {
      ADO_EXECUTION_ROOT: jobs, ADO_CODEX_STATE_DIR: state, ADO_CODEX_API_KEY: '', ADO_NPM_CACHE_ROOT: '', ADO_MAVEN_CACHE_ROOT: '',
      ADO_CODEX_HTTPS_PROXY: proxyUrl,
    });
    const runtime = await configureExecution();
    assert.equal(runtime.codexEnv.HTTPS_PROXY, proxyUrl);
    assert.equal(runtime.env.HTTPS_PROXY, undefined);
    const tempDirectory = join(root, checkTempDirectory);
    await mkdir(tempDirectory);
    const [check, failure] = await runVerification({
      binary: runtime.binary, env: runtime.env, worktree: checkout, tempDirectory,
      profile: isolatedProfile(checkout, source, runtime.binary, tempDirectory),
    }, [{
      name: 'temporary-directory', kind: 'static', directory: '.', timeoutSeconds: 5,
      argv: ['sh', '-c', 'test "$TMPDIR" = "$1" && test -z "$HTTPS_PROXY" && test ! -w /tmp && printf ok > "$TMPDIR/proof"',
        'ado-check', tempDirectory],
    }, {
      name: 'failure-output', kind: 'static', directory: '.', timeoutSeconds: 5,
      argv: ['node', '-e', 'console.error(process.argv[1]); process.exitCode = 7', 'check diagnostics'],
    }], globalThis.AbortSignal.timeout(10000));
    assert.equal(check?.result.status, 'passed');
    assert.equal(await readFile(join(tempDirectory, 'proof'), 'utf8'), 'ok');
    assert.equal(failure?.result.exitCode, 7);
    assert.equal(failure?.diagnostic, 'check diagnostics');
    let sequence = 0;
    let revision = 0;
    let shellTool;
    let pending;
    let fixtureError;
    let cancelling = false;

    function nextItem(body) {
      shellTool = body.tools?.find(({ name }) => name === 'exec_command' || name === 'shell_command')?.name ?? shellTool;
      if (body.generate === false) return;
      if (pending) {
        const output = body.input.find(({ type, call_id }) => type === 'function_call_output' && call_id === pending);
        const result = JSON.stringify(output?.output ?? null);
        assert(result.includes('local-fixture-written'), 'Sandbox or fixture check failed on turn '
          + (revision + 1) + ': ' + result.slice(0, 500));
        pending = undefined;
        revision++;
        return { id: 'msg_' + revision, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Updated the local fixture.', annotations: [] }] };
      }
      assert(cancelling || revision < revisions.length);
      assert(shellTool, 'Codex did not advertise a shell tool');
      const command = (cancelling ? [
        'printf "started\n" > cancellation-started',
        '/bin/sleep ' + commandSeconds,
        'printf "late write\n" > cancellation-late-write',
      ] : [
        '(test ! -r ' + quote(outside) + ' || exit 21)',
        '(test -z "$OPENAI_API_KEY" && test -z "$CODEX_API_KEY" && test -z "$HTTPS_PROXY" || exit 22)',
        '( (printf no > ' + quote(outside + '.new') + ') 2>/dev/null || :)',
        '/bin/bash --noprofile --norc -c true',
        '(if /bin/bash --noprofile --norc -c ' + quote('true >/dev/tcp/127.0.0.1/' + server.address().port)
          + ' 2>/dev/null; then exit 24; fi)',
        'printf "%s\\n" ' + quote(revisions[revision]) + ' > fixture.txt',
        'printf "local-fixture-written\\n"',
      ]).join(' && ');
      pending = 'call_' + revision;
      const args = shellTool === 'exec_command' ? { cmd: command } : { command };
      return { id: 'fc_' + revision, type: 'function_call', name: shellTool, call_id: pending,
        arguments: JSON.stringify(args), status: 'completed' };
    }

    gateway.on('connection', (socket) => socket.on('message', (raw) => {
      try {
        const body = JSON.parse(raw.toString());
        assert.equal(body.type, 'response.create');
        const item = nextItem(body);
        const id = 'resp_' + (++sequence);
        const frame = (status, output, tokenUsage) => ({ id, object: 'response', model: body.model,
          created_at: Math.floor(Date.now() / 1000), status, output, usage: tokenUsage,
          error: null, incomplete_details: null, metadata: {} });
        const send = (type, payload) => socket.send(JSON.stringify({ type, ...payload }));
        send('response.created', { response: frame('in_progress', [], null) });
        if (item) {
          send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } });
          send('response.output_item.done', { output_index: 0, item });
        }
        send('response.completed', { response: frame('completed', item ? [item] : [], usage) });
      } catch (error) {
        fixtureError = error;
        socket.close(1011, 'Fixture validation failed');
      }
    }));

    const profile = isolatedProfile(checkout, source, runtime.binary);
    const codex = new Codex({
      codexPathOverride: runtime.binary, env: runtime.codexEnv, apiKey: fixtureKey,
      baseUrl: proxyUrl + '/v1', configOverrides: profile,
    });
    const thread = codex.startThread({ workingDirectory: checkout, approvalPolicy: 'never', webSearchMode: 'disabled',
      model: 'gpt-5.4' });
    let originalThreadId;
    for (const [index, expected] of revisions.entries()) {
      const { events } = await thread.runStreamed(index === 0 ? 'Update the fixture file.' : 'Repair the fixture file.', {
        signal: globalThis.AbortSignal.timeout(45000),
      });
      let started = false;
      let completed = false;
      let commandPassed = false;
      try {
        for await (const event of events) {
          if (event.type === 'turn.started') started = true;
          if (event.type === 'turn.completed') completed = event.usage.input_tokens > 0;
          const item = summarizeItem(event, true);
          if (item?.itemType === 'command_execution' && item.exitCode === 0) commandPassed = true;
        }
      } catch (error) {
        throw fixtureError ?? error;
      }
      assert(thread.id && started && completed && commandPassed, 'Expected SDK thread, turn, usage, and command events');
      originalThreadId ??= thread.id;
      assert.equal(thread.id, originalThreadId);
      assert.equal(await readFile(join(checkout, 'fixture.txt'), 'utf8'), expected + '\n');
      assert(git(['diff', '--', 'fixture.txt'], checkout).includes('+' + expected));
      await assert.rejects(readFile(outside + '.new'), { code: 'ENOENT' });
    }
    assert.equal(revision, revisions.length);
    assert.equal(await readFile(outside, 'utf8'), 'outside fixture');

    cancelling = true;
    const stop = new globalThis.AbortController();
    const signal = globalThis.AbortSignal.any([stop.signal, globalThis.AbortSignal.timeout(15000)]);
    const { events } = await thread.runStreamed('Start the long-running fixture command.', { signal });
    const stream = (async () => {
      for await (const event of events) assert.notEqual(event.type, 'turn.completed', 'Expected the turn to be cancelled');
    })();
    const ended = stream.then(() => null, (error) => error);
    try {
      const marker = join(checkout, 'cancellation-started');
      while (await readFile(marker).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }) === null) await delay(50, undefined, { signal });
      stop.abort();
      const stopped = await ended;
      assert.equal(stopped?.name, 'AbortError', 'Expected the SDK stream to stop when the command was running');
      await delay(commandSeconds * 1000 + 500);
      await assert.rejects(readFile(join(checkout, 'cancellation-late-write')), { code: 'ENOENT' });
    } finally {
      stop.abort();
      await ended;
    }
    const proxyOnlyCodex = new Codex({
      codexPathOverride: runtime.binary, env: runtime.codexEnv, apiKey: fixtureKey,
      baseUrl: `https://${modelProxyHost}/v1`, configOverrides: profile,
    });
    const proxyThread = proxyOnlyCodex.startThread({ workingDirectory: checkout, approvalPolicy: 'never', model: 'gpt-5.4' });
    const stopProxy = new globalThis.AbortController();
    const probeSignal = globalThis.AbortSignal.any([stopProxy.signal, globalThis.AbortSignal.timeout(12000)]);
    const connection = once(server, 'modelProxyConnect', { signal: probeSignal });
    const proxyRun = proxyThread.run('Check whether the HTTPS proxy is reachable.', { signal: probeSignal }).catch(() => null);
    try {
      await connection;
    } finally {
      stopProxy.abort();
      await proxyRun;
    }
    console.log('Native Codex SDK streaming, same-thread repair, sandbox isolation, cancellation, and HTTPS proxy passed.');
  } finally {
    for (const socket of gateway.clients) socket.terminate();
    gateway.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

await verify();
