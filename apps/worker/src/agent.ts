import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { decodeWorkerMessage, isWorkerId, workerHeartbeatMs, workerProtocolVersion,
  type WorkerCapabilities, type WorkerEnvelope, type WorkerMessageType } from '@ado/shared';

const exec = promisify(execFile);
const acknowledgementTimeoutMs = 10_000;

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

async function probe(): Promise<WorkerCapabilities> {
  const os = process.platform;
  if (os !== 'win32' && os !== 'linux' && os !== 'darwin') throw new Error('Unsupported Worker platform');
  const [disk, gitVersion, dockerVersion] = await Promise.all([
    statfs(process.cwd()), toolVersion('git'), toolVersion('docker'),
  ]);
  return {
    os,
    arch: process.arch,
    nodeVersion: process.version,
    cpuCount: availableParallelism(),
    memoryBytes: totalmem(),
    diskFreeBytes: disk.bavail * disk.bsize,
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
  capabilities: WorkerCapabilities, signal: AbortSignal) {
  return new Promise<{ registered: boolean; rejected: boolean }>((resolve) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${workerId}.${token}` },
      handshakeTimeout: acknowledgementTimeoutMs,
      maxPayload: 8192,
      perMessageDeflate: false,
    });
    let registered = false;
    let pendingId: string | undefined;
    let acknowledgement: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => socket.terminate();
    const finish = (rejected: boolean) => {
      clearTimeout(acknowledgement);
      clearInterval(heartbeat);
      signal.removeEventListener('abort', stop);
      resolve({ registered, rejected });
    };

    const send = (type: WorkerMessageType, payload: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || pendingId) return;
      const message: WorkerEnvelope = {
        message_id: randomUUID(),
        worker_id: workerId,
        timestamp: new Date().toISOString(),
        message_type: type,
        correlation_id: null,
        payload,
        protocol_version: workerProtocolVersion,
      };
      pendingId = message.message_id;
      socket.send(JSON.stringify(message));
      acknowledgement = setTimeout(stop, acknowledgementTimeoutMs);
    };

    signal.addEventListener('abort', stop, { once: true });
    socket.on('error', () => socket.terminate());
    socket.on('close', (code) => finish(code === 4001 || code === 1008));
    socket.on('unexpected-response', (request, response) => {
      response.resume();
      finish(response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404);
      request.destroy();
    });
    socket.on('open', () => send('WORKER_REGISTER', capabilities));
    socket.on('message', (data, binary) => {
      const message = binary ? null : decodeWorkerMessage(data.toString());
      const expected = registered ? 'HEARTBEAT_ACK' : 'REGISTER_ACK';
      if (!pendingId || message?.correlation_id !== pendingId || message.message_type !== expected
        || message.worker_id !== workerId || message.payload !== null) {
        socket.close(1008, 'Invalid gateway acknowledgement');
        return;
      }
      clearTimeout(acknowledgement);
      pendingId = undefined;
      if (!registered) {
        registered = true;
        console.log(JSON.stringify({ service: 'ado-worker', event: 'registered', workerId, os: capabilities.os }));
        heartbeat = setInterval(() => send('WORKER_HEARTBEAT', null), workerHeartbeatMs);
      }
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
  let retryMs = 500;
  while (!signal.aborted) {
    const { registered, rejected } = await connect(endpoint, workerId, token, capabilities, signal);
    if (signal.aborted) break;
    if (rejected) throw new Error('Worker credential or registration was rejected');
    retryMs = registered ? 500 : Math.min(retryMs * 2, 30_000);
    console.log(JSON.stringify({ service: 'ado-worker', event: 'reconnecting', retryMs }));
    await delay(retryMs + Math.random() * 250, undefined, { signal }).catch((error) => {
      if (!signal.aborted) throw error;
    });
  }
}
