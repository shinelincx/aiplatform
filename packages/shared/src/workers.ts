export const workerProtocolVersion = 1;
export const workerHeartbeatMs = 15_000;
export const workerOfflineMs = 3 * workerHeartbeatMs;

export const workerMessageTypes = [
  'WORKER_REGISTER', 'REGISTER_ACK', 'WORKER_HEARTBEAT', 'HEARTBEAT_ACK',
  'WORKER_CLAIM', 'CLAIM_ACK', 'EXECUTION_EVENT', 'EXECUTION_ACK',
] as const;
export type WorkerMessageType = (typeof workerMessageTypes)[number];

export interface WorkerEnvelope {
  message_id: string;
  worker_id: string;
  timestamp: string;
  message_type: WorkerMessageType;
  correlation_id: string | null;
  payload: unknown;
  protocol_version: typeof workerProtocolVersion;
}

export function isWorkerId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

export function decodeWorkerMessage(raw: string): WorkerEnvelope | null {
  let message: Partial<WorkerEnvelope> | null;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!message || !isWorkerId(message.message_id) || !isWorkerId(message.worker_id)
    || (message.correlation_id !== null && !isWorkerId(message.correlation_id))
    || !message.message_type || !workerMessageTypes.includes(message.message_type)
    || typeof message.timestamp !== 'string' || !Number.isFinite(Date.parse(message.timestamp))
    || message.protocol_version !== workerProtocolVersion || !Object.hasOwn(message, 'payload')) {
    return null;
  }
  return message as WorkerEnvelope;
}

export interface WorkerCapabilities {
  os: 'win32' | 'linux' | 'darwin';
  arch: string;
  nodeVersion: string;
  cpuCount: number;
  memoryBytes: number;
  diskFreeBytes: number;
  gitVersion: string | null;
  dockerVersion: string | null;
  codexVersion?: string;
  verificationVersion?: 1;
}

export interface WorkerReport {
  id: string;
  name: string;
  status: 'unregistered' | 'online' | 'disconnected' | 'disabled';
  lastHeartbeatAt: string | null;
  capabilities: WorkerCapabilities | null;
}

export interface WorkerCredential {
  workerId: string;
  token: string;
  expiresAt: string;
}
