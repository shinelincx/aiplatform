import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { decodeWorkerMessage, isWorkerId, workerDiskPressure, workerHeartbeatMs, workerMaxPayloadBytes, workerProtocolVersion,
  type WorkerCapabilities, type WorkerEnvelope, type WorkerHeartbeat, type WorkerMessageType, type WorkerResources } from '@ado/shared';
import { codexVersion, configureExecution, executeCodex, verifyCodexLogin } from './codex-execution';
import { WorkerJobs } from './jobs';
import { fetchRevisionArtifact } from './revision-artifact';

const exec = promisify(execFile);
const acknowledgementTimeoutMs = 10_000;
const bytesPerMiB = 1024 * 1024;

function configuredDiskThreshold() {
  const bytes = Number(process.env.ADO_MIN_FREE_DISK_MIB ?? '256') * bytesPerMiB;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Set a valid ADO_MIN_FREE_DISK_MIB');
  return bytes;
}

async function sampleResources(directory: string, minFreeDiskBytes: number): Promise<WorkerResources> {
  const disk = await statfs(directory).catch(() => null);
  return {
    diskFreeBytes: disk ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, disk.bavail * disk.bsize)) : 0,
    memoryFreeBytes: freemem(),
    minFreeDiskBytes,
  };
}

async function toolVersion(executable: string) {
  try {
    const { stdout } = await exec(executable, ['--version'], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      windowsHide: true, timeout: 3000, maxBuffer: 4096,
    });
    return stdout.trim().slice(0, 100) || null;
  } catch {
    return null;
  }
}

async function probe(): Promise<Omit<WorkerCapabilities, 'diskFreeBytes'>> {
  const os = process.platform;
  if (os !== 'win32' && os !== 'linux' && os !== 'darwin') throw new Error('Unsupported Worker platform');
  const [gitVersion, dockerVersion] = await Promise.all([toolVersion('git'), toolVersion('docker')]);
  return {
    os,
    arch: process.arch,
    nodeVersion: process.version,
    cpuCount: availableParallelism(),
    memoryBytes: totalmem(),
    gitVersion,
    dockerVersion,
  };
}

function gatewayUrl(baseUrl: string) {
  const url = new URL('/workers/ws', baseUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'wss:' && !(local && url.protocol === 'ws:')) || url.username || url.password) {
    throw new Error('Use WSS or HTTPS for a remote Worker API endpoint');
  }
  return url;
}

function connect(url: URL, workerId: string, token: string,
  capabilities: Omit<WorkerCapabilities, 'diskFreeBytes'>, sample: () => Promise<WorkerResources>,
  signal: AbortSignal, jobs?: WorkerJobs) {
  return new Promise<{ registered: boolean; rejected: boolean }>((resolve) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${workerId}.${token}` },
      handshakeTimeout: acknowledgementTimeoutMs,
      maxPayload: workerMaxPayloadBytes,
      perMessageDeflate: false,
    });
    const connection = new AbortController();
    let registered = false;
    let pending: { id: string; expected: WorkerMessageType; success: (payload: unknown) => void;
      failure: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
    const stop = () => socket.terminate();
    const finish = (rejected: boolean) => {
      connection.abort();
      if (pending) {
        clearTimeout(pending.timer);
        pending.failure(new Error('Worker connection closed'));
        pending = undefined;
      }
      signal.removeEventListener('abort', stop);
      resolve({ registered, rejected });
    };

    const send = (type: WorkerMessageType, expected: WorkerMessageType, payload: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || pending) return Promise.reject(new Error('Worker connection unavailable'));
      return new Promise<unknown>((success, failure) => {
        const message: WorkerEnvelope = {
          message_id: randomUUID(),
          worker_id: workerId,
          timestamp: new Date().toISOString(),
          message_type: type,
          correlation_id: null,
          payload,
          protocol_version: workerProtocolVersion,
        };
        pending = { id: message.message_id, expected, success, failure, timer: setTimeout(stop, acknowledgementTimeoutMs) };
        socket.send(JSON.stringify(message));
      });
    };

    const operate = async () => {
      let resources = await sample();
      const result = await send('WORKER_REGISTER', 'REGISTER_ACK', { ...capabilities, ...resources });
      const resourceHeartbeats = result !== null && typeof result === 'object' && result !== undefined
        && 'resourceHeartbeats' in result && result.resourceHeartbeats === true;
      if (result !== null && !resourceHeartbeats) throw new Error('Unexpected registration payload');
      registered = true;
      console.log(JSON.stringify({ service: 'ado-worker', event: 'registered', workerId, os: capabilities.os }));
      if (jobs?.runId) await jobs.reconcile(await send('WORKER_RECOVER', 'RECOVER_ACK', jobs.runId));
      let nextHeartbeat = Date.now() + workerHeartbeatMs;
      const heartbeat = async (latest: WorkerResources) => {
        const runId = jobs?.runId ?? null;
        const payload: WorkerHeartbeat | string | null = resourceHeartbeats ? { runId, resources: latest } : runId;
        const lease = await send('WORKER_HEARTBEAT', 'HEARTBEAT_ACK', payload);
        if (runId) {
          if (lease && typeof lease === 'object' && 'stop' in lease && lease.stop === false) jobs?.renew();
          else jobs?.cancel();
        }
        if (workerDiskPressure(latest) !== workerDiskPressure(resources)) {
          console.log(JSON.stringify({ service: 'ado-worker', workerId,
            event: workerDiskPressure(latest) ? 'disk_pressure' : 'disk_ready' }));
        }
        resources = latest;
        nextHeartbeat = Date.now() + workerHeartbeatMs;
      };
      while (!connection.signal.aborted) {
        if (Date.now() >= nextHeartbeat) await heartbeat(await sample());
        if (jobs?.runId) {
          await jobs.flush((event) => send('EXECUTION_EVENT', 'EXECUTION_ACK', event));
        } else if (jobs) {
          const latest = await sample();
          if (workerDiskPressure(latest) !== workerDiskPressure(resources)) await heartbeat(latest);
          if (!workerDiskPressure(latest)) {
            const offer = await send('WORKER_CLAIM', 'CLAIM_ACK', null);
            if (offer !== null) await jobs.start(offer);
          }
        }
        await delay(jobs?.runId ? 250 : jobs ? 2000 : Math.max(1, nextHeartbeat - Date.now()),
          undefined, { signal: connection.signal });
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    socket.on('error', stop);
    socket.on('close', (code) => finish(code === 4001 || code === 1008));
    socket.on('unexpected-response', (request, response) => {
      response.resume();
      finish(response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404);
      request.destroy();
    });
    socket.on('open', () => { void operate().catch(stop); });
    socket.on('message', (data, binary) => {
      const message = binary ? null : decodeWorkerMessage(data.toString());
      if (!pending || message?.correlation_id !== pending.id || message.message_type !== pending.expected
        || message.worker_id !== workerId) {
        socket.close(1008, 'Invalid gateway acknowledgement');
        return;
      }
      const response = pending;
      pending = undefined;
      clearTimeout(response.timer);
      response.success(message.payload);
    });
    if (signal.aborted) stop();
  });
}

export async function runAgent(baseUrl: string, workerId: string | undefined, token: string | undefined, signal: AbortSignal) {
  if (!isWorkerId(workerId) || !token || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error('Set a valid ADO_WORKER_ID and ADO_WORKER_TOKEN');
  }
  const endpoint = gatewayUrl(baseUrl);
  const capabilities = await probe();
  const runtime = await configureExecution();
  const minFreeDiskBytes = runtime ? configuredDiskThreshold() : 0;
  const sample = () => sampleResources(runtime?.root ?? process.cwd(), minFreeDiskBytes);
  if (runtime && !capabilities.gitVersion) throw new Error('Codex execution requires Git');
  if (runtime) await verifyCodexLogin(runtime);
  const authorization = `Bearer ${workerId}.${token}`;
  const artifactUrl = (runId: string, name: 'artifact' | 'revision-artifact') => {
    const url = new URL(`/worker-executions/${runId}/${name}`, endpoint);
    url.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    return url;
  };
  const jobs = runtime ? new WorkerJobs(runtime, workerId, async (runId, bytes, cancellation) => {
    const response = await fetch(artifactUrl(runId, 'artifact'), {
      method: 'PUT', body: bytes,
      headers: { Authorization: authorization, 'Content-Type': 'application/octet-stream' },
      redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(12_000), cancellation]),
    });
    await response.body?.cancel();
    if (response.status >= 500) throw new Error('Artifact storage unavailable');
    return response.ok;
  }, (configured, offer, report, cancellation) => executeCodex(configured, offer, report, cancellation,
    (runId, signal) => fetchRevisionArtifact(artifactUrl(runId, 'revision-artifact'), authorization, signal))) : undefined;
  if (runtime && jobs) {
    await jobs.load();
    capabilities.codexVersion = codexVersion;
    capabilities.verificationVersion = 1;
    capabilities.artifactVersion = 1;
    capabilities.revisionArtifactVersion = 1;
    if (runtime.supportsMaven) capabilities.mavenVerification = true;
  }
  let retryMs = 500;
  try {
    while (!signal.aborted) {
      const { registered, rejected } = await connect(endpoint, workerId, token, capabilities, sample, signal, jobs);
      if (signal.aborted) break;
      if (rejected) throw new Error('Worker credential or registration was rejected');
      retryMs = registered ? 500 : Math.min(retryMs * 2, 30_000);
      console.log(JSON.stringify({ service: 'ado-worker', event: 'reconnecting', retryMs }));
      await delay(retryMs + Math.random() * 250, undefined, { signal }).catch((error) => {
        if (!signal.aborted) throw error;
      });
    }
  } finally {
    jobs?.cancel();
  }
}
