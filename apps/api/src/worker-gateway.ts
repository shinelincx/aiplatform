import { HttpException, Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeWorkerMessage, isWorkerId, workerMaxPayloadBytes, workerOfflineMs, workerProtocolVersion,
  type WorkerEnvelope, type WorkerMessageType } from '@ado/shared';
import { parseCapabilities, parseWorkerCredentials, parseWorkerHeartbeat, WorkersService, type WorkerIdentity } from './workers';
import { ExecutionsService } from './executions';

@Injectable()
export class WorkerGateway implements OnModuleDestroy {
  private readonly log = new Logger(WorkerGateway.name);
  private readonly gateway = new WebSocketServer({ noServer: true, maxPayload: workerMaxPayloadBytes });
  private server?: Server;

  constructor(
    @Inject(WorkersService) private readonly workers: WorkersService,
    @Inject(ExecutionsService) private readonly executions: ExecutionsService,
  ) {}

  attach(server: Server) {
    this.server = server;
    server.on('upgrade', this.upgrade);
  }

  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void this.authenticate(request, socket, head).catch(() => {
      this.log.error('Worker authentication unavailable');
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    });
  };

  private async authenticate(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);
    if (request.url !== '/workers/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const identity = parseWorkerCredentials(request.headers.authorization);
    if (!identity || !(await this.workers.valid(identity))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    if (socket.destroyed) return;
    this.gateway.handleUpgrade(request, socket, head, (ws) => {
      socket.off('error', onSocketError);
      this.bind(ws, identity);
    });
  }

  private bind(socket: WebSocket, identity: WorkerIdentity) {
    const connectionId = randomUUID();
    const lease = { ...identity, connectionId };
    let registered = false;
    let busy = false;
    const onIdle = () => socket.terminate();
    let idle = setTimeout(onIdle, 10_000).unref();
    const disconnect = () => this.workers.disconnect(identity.workerId, connectionId).catch(() => {
      this.log.warn('Worker disconnect could not be persisted');
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(idle);
      if (registered) void disconnect();
    });

    const handle = async (message: WorkerEnvelope) => {
      if (!registered) {
        if (message.message_type !== 'WORKER_REGISTER') {
          socket.close(1008, 'Register first');
          return;
        }
        const capabilities = parseCapabilities(message.payload);
        registered = await this.workers.register(identity, connectionId, capabilities);
        if (!registered) {
          socket.close(4001, 'Worker authorization ended');
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
          await disconnect();
          return;
        }
        this.ack(socket, identity, message, 'REGISTER_ACK', capabilities.minFreeDiskBytes === undefined
          ? null : { resourceHeartbeats: true });
        clearTimeout(idle);
        idle = setTimeout(onIdle, workerOfflineMs).unref();
        return;
      }

      if (message.message_type === 'WORKER_CLAIM' && message.payload === null) {
        const offer = await this.executions.claim(lease);
        this.ack(socket, identity, message, 'CLAIM_ACK', offer);
        return;
      }
      if (message.message_type === 'EXECUTION_EVENT') {
        const result = await this.executions.record(lease, message.payload);
        this.ack(socket, identity, message, 'EXECUTION_ACK', result);
        return;
      }
      if (message.message_type === 'WORKER_RECOVER' && isWorkerId(message.payload)) {
        const checkpoint = await this.executions.recover(lease, message.payload);
        this.ack(socket, identity, message, 'RECOVER_ACK', checkpoint);
        return;
      }
      if (message.message_type !== 'WORKER_HEARTBEAT') {
        socket.close(1008, 'Invalid heartbeat');
        return;
      }
      const { runId, resources } = parseWorkerHeartbeat(message.payload);
      if (!await this.workers.heartbeat(identity, connectionId, resources)) {
        socket.close(4001, 'Worker authorization ended');
        return;
      }
      if (socket.readyState === WebSocket.OPEN) {
        idle.refresh();
        const payload = runId === null ? null : { stop: !await this.executions.renew(lease, runId) };
        this.ack(socket, identity, message, 'HEARTBEAT_ACK', payload);
      }
    };

    socket.on('message', (data, binary) => {
      const message = binary ? null : decodeWorkerMessage(data.toString());
      if (busy || !message || message.worker_id !== identity.workerId || message.correlation_id !== null) {
        socket.close(1008, 'Invalid worker message');
        return;
      }
      busy = true;
      void handle(message).catch((error: unknown) => {
        if (error instanceof HttpException) {
          socket.close(1008, 'Invalid worker payload');
          return;
        }
        this.log.error('Worker message could not be processed');
        socket.close(1011, 'Worker gateway unavailable');
      }).finally(() => { busy = false; });
    });
  }

  private ack(socket: WebSocket, { workerId }: WorkerIdentity, request: WorkerEnvelope,
    messageType: WorkerMessageType, payload: unknown = null) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const response: WorkerEnvelope = {
      message_id: randomUUID(),
      worker_id: workerId,
      timestamp: new Date().toISOString(),
      message_type: messageType,
      correlation_id: request.message_id,
      payload,
      protocol_version: workerProtocolVersion,
    };
    socket.send(JSON.stringify(response));
  }

  onModuleDestroy() {
    this.server?.off('upgrade', this.upgrade);
    for (const socket of this.gateway.clients) socket.terminate();
    this.gateway.close();
  }
}
