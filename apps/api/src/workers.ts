import {
  BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Inject, Injectable, NotFoundException,
  Param, ParseUUIDPipe, Post, Put, UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isWorkerId, workerCredentialLifetimeHours, workerOfflineMs, type Account, type WorkerCapabilities, type WorkerCredential,
  type WorkerHeartbeat, type WorkerReport, type WorkerResources } from '@ado/shared';
import { AuthService, CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';

const hasActiveProject = 'ado_private.worker_has_active_project(w.id)';
export const workerOnline = `NOT w.disabled AND w.connection_id IS NOT NULL AND w.credential_expires_at > now()
  AND w.last_heartbeat_at >= now() - ($2 * interval '1 millisecond')`;
export const workerDiskReady = `COALESCE((w.capabilities->>'diskFreeBytes')::bigint
  >= (w.capabilities->>'minFreeDiskBytes')::bigint, true)`;
export const workerMatchesAssignment = `(r.requested_worker_id IS NULL OR r.requested_worker_id = w.id)`;
export const workerCanVerify = `(r.developer_assignment->>'revision' IS NULL OR w.capabilities->'revisionArtifactVersion' = '1'::jsonb)
  AND (jsonb_array_length(r.check_plan) = 0 OR (
  w.capabilities->'verificationVersion' = '1'::jsonb
  AND ((r.qa_assignment IS NULL AND NOT g.auto_draft_pr AND jsonb_array_length(r.independent_checks) = 0)
    OR w.capabilities->'artifactVersion' = '1'::jsonb)
  AND (w.capabilities @> '{"mavenVerification":true}'::jsonb
    OR NOT jsonb_path_exists(r.check_plan, '$[*].argv[0] ? (@ == "mvn")'))
))`;

function credentialHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function credentialExpiry(lifetime: unknown) {
  const hours = lifetime === undefined ? workerCredentialLifetimeHours[0]
    : workerCredentialLifetimeHours.find((option) => option === lifetime);
  if (hours === undefined) throw new BadRequestException('Invalid Worker credential lifetime');
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function parseWorkerCredentials(authorization?: string) {
  const match = /^Bearer ([a-f0-9-]+)\.([0-9a-f]{64})$/.exec(authorization ?? '');
  if (!match || !isWorkerId(match[1])) return null;
  return { workerId: match[1], hash: credentialHash(match[2]) };
}

export type WorkerIdentity = NonNullable<ReturnType<typeof parseWorkerCredentials>>;

function resourceNumber(input: Record<string, unknown>, key: string, min = 0) {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new BadRequestException(`Invalid ${key}`);
  }
  return value;
}

function parseResources(input: Record<string, unknown>): WorkerResources {
  return {
    diskFreeBytes: resourceNumber(input, 'diskFreeBytes'),
    memoryFreeBytes: resourceNumber(input, 'memoryFreeBytes'),
    minFreeDiskBytes: resourceNumber(input, 'minFreeDiskBytes'),
  };
}

export function parseWorkerHeartbeat(payload: unknown): WorkerHeartbeat {
  if (payload === null || isWorkerId(payload)) return { runId: payload };
  const { runId, resources } = objectInput(payload);
  if (runId !== null && !isWorkerId(runId)) throw new BadRequestException('Invalid heartbeat run ID');
  return { runId, resources: parseResources(objectInput(resources)) };
}

export function parseCapabilities(payload: unknown): WorkerCapabilities {
  const input = objectInput(payload);
  const { os } = input;
  if (os !== 'win32' && os !== 'linux' && os !== 'darwin') throw new BadRequestException('Unsupported worker OS');
  const resources = input.memoryFreeBytes === undefined && input.minFreeDiskBytes === undefined
    ? { diskFreeBytes: resourceNumber(input, 'diskFreeBytes') } : parseResources(input);
  const version = (key: string) => input[key] === null ? null : textInput(input[key], key, 100);
  return {
    os,
    arch: textInput(input.arch, 'arch', 30),
    nodeVersion: textInput(input.nodeVersion, 'nodeVersion', 40),
    cpuCount: resourceNumber(input, 'cpuCount', 1),
    memoryBytes: resourceNumber(input, 'memoryBytes', 1),
    ...resources,
    gitVersion: version('gitVersion'),
    dockerVersion: version('dockerVersion'),
    ...(input.codexVersion !== undefined && { codexVersion: textInput(input.codexVersion, 'codexVersion', 40) }),
    ...(input.verificationVersion === 1 && { verificationVersion: 1 as const }),
    ...(input.artifactVersion === 1 && { artifactVersion: 1 as const }),
    ...(input.revisionArtifactVersion === 1 && { revisionArtifactVersion: 1 as const }),
    ...(input.mavenVerification === true && { mavenVerification: true as const }),
  };
}

@Injectable()
export class WorkersService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async list(actor: Account, projectId: string) {
    await this.projects.access(actor.id, projectId);
    const { rows } = await this.db.projectQuery<WorkerReport>(projectId,
      `SELECT w.id, w.name, w.capabilities, w.last_heartbeat_at AS "lastHeartbeatAt",
         w.credential_expires_at AS "credentialExpiresAt",
         CASE
           WHEN w.disabled THEN 'disabled'
           WHEN w.last_heartbeat_at IS NULL THEN 'unregistered'
           WHEN ${workerOnline} THEN 'online'
           ELSE 'disconnected'
         END AS status
       FROM workers w JOIN worker_projects wp ON wp.worker_id = w.id
       WHERE wp.project_id = $1 ORDER BY w.name, w.id`, [projectId, workerOfflineMs],
    );
    return rows;
  }

  async create(actor: Account, projectId: string, body: unknown): Promise<WorkerCredential> {
    const input = objectInput(body);
    const name = textInput(input.name, 'name', 100);
    const expiresAt = credentialExpiry(input.lifetimeHours);
    const token = randomBytes(32).toString('hex');
    return this.db.transaction(async (client) => {
      await this.authorize(actor, projectId, client);
      const { rows: [worker] } = await client.query<{ id: string }>(
        `INSERT INTO workers (name, created_by, credential_hash, credential_expires_at)
         VALUES ($1, $2, $3, $4) RETURNING id`, [name, actor.id, credentialHash(token), expiresAt],
      );
      await client.query('INSERT INTO worker_projects (worker_id, project_id) VALUES ($1, $2)', [worker.id, projectId]);
      await this.projects.audit(client, actor.id, projectId, 'worker.created', worker.id);
      return { workerId: worker.id, token, expiresAt };
    });
  }

  async rotate(actor: Account, projectId: string, workerId: string, body: unknown): Promise<WorkerCredential> {
    const expiresAt = credentialExpiry(objectInput(body ?? {}).lifetimeHours);
    const token = randomBytes(32).toString('hex');
    await this.db.transaction(async (client) => {
      await this.authorize(actor, projectId, client);
      const result = await client.query(
        `UPDATE workers w SET credential_hash = $4, credential_expires_at = $5, connection_id = NULL
         FROM worker_projects wp WHERE w.id = $1 AND w.created_by = $2 AND wp.worker_id = w.id
           AND wp.project_id = $3 AND NOT w.disabled`,
        [workerId, actor.id, projectId, credentialHash(token), expiresAt],
      );
      if (!result.rowCount) throw new NotFoundException('Active Worker not found in this project');
      await this.projects.audit(client, actor.id, projectId, 'worker.credential_rotated', workerId);
    });
    return { workerId, token, expiresAt };
  }

  async grant(actor: Account, projectId: string, workerId: string) {
    await this.db.transaction(async (client) => {
      await this.authorize(actor, projectId, client);
      const owned = await client.query('SELECT id FROM workers WHERE id = $1 AND created_by = $2 AND NOT disabled FOR UPDATE',
        [workerId, actor.id]);
      if (!owned.rowCount) throw new NotFoundException('Active Worker not found');
      const result = await client.query(
        'INSERT INTO worker_projects (worker_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [workerId, projectId],
      );
      if (result.rowCount) await this.projects.audit(client, actor.id, projectId, 'worker.project_granted', workerId);
    });
  }

  async revoke(actor: Account, projectId: string, workerId: string) {
    await this.db.transaction(async (client) => {
      await this.authorize(actor, projectId, client, false);
      const result = await client.query('DELETE FROM worker_projects WHERE worker_id = $1 AND project_id = $2',
        [workerId, projectId]);
      if (!result.rowCount) throw new NotFoundException('Worker not found in this project');
      await this.projects.audit(client, actor.id, projectId, 'worker.project_revoked', workerId);
    });
  }

  async disable(actor: Account, projectId: string, workerId: string) {
    await this.db.transaction(async (client) => {
      await this.authorize(actor, projectId, client, false);
      const result = await client.query(
        `UPDATE workers w SET disabled = true, connection_id = NULL
         FROM worker_projects wp WHERE w.id = $1 AND w.created_by = $2 AND wp.worker_id = w.id AND wp.project_id = $3`,
        [workerId, actor.id, projectId],
      );
      if (!result.rowCount) throw new NotFoundException('Worker not found in this project');
      await this.projects.audit(client, actor.id, projectId, 'worker.disabled', workerId);
    });
  }

  private async authorize(actor: Account, projectId: string, client: PoolClient, active = true) {
    this.auth.requireAdmin(actor);
    await this.projects.access(actor.id, projectId, { owner: true, active }, client);
  }

  async valid({ workerId, hash }: WorkerIdentity) {
    const result = await this.db.pool.query(
      `SELECT 1 FROM workers w WHERE w.id = $1 AND w.credential_hash = $2
       AND w.credential_expires_at > now() AND NOT w.disabled AND ${hasActiveProject}`, [workerId, hash],
    );
    return result.rowCount === 1;
  }

  async register({ workerId, hash }: WorkerIdentity, connectionId: string, capabilities: WorkerCapabilities) {
    const result = await this.db.pool.query(
      `UPDATE workers w SET capabilities = $4, connection_id = $3, last_heartbeat_at = now()
       WHERE w.id = $1 AND w.credential_hash = $2 AND w.credential_expires_at > now()
         AND NOT w.disabled AND ${hasActiveProject}`, [workerId, hash, connectionId, capabilities],
    );
    return result.rowCount === 1;
  }

  async heartbeat({ workerId, hash }: WorkerIdentity, connectionId: string, resources?: WorkerResources) {
    const result = await this.db.pool.query(
      `UPDATE workers w SET last_heartbeat_at = now(),
         capabilities = CASE WHEN $4::jsonb IS NULL THEN capabilities ELSE capabilities || $4::jsonb END
       WHERE w.id = $1 AND w.credential_hash = $2 AND w.connection_id = $3 AND w.credential_expires_at > now()
         AND NOT w.disabled AND ${hasActiveProject}`, [workerId, hash, connectionId, resources ?? null],
    );
    return result.rowCount === 1;
  }

  async disconnect(workerId: string, connectionId: string) {
    await this.db.pool.query('UPDATE workers SET connection_id = NULL WHERE id = $1 AND connection_id = $2',
      [workerId, connectionId]);
  }
}

@Controller('projects/:id/workers')
@UseGuards(SessionGuard)
export class WorkersController {
  constructor(@Inject(WorkersService) private readonly workers: WorkersService) {}

  @Get()
  list(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string) {
    return this.workers.list(actor, id);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.workers.create(actor, id, body);
  }

  @Post(':workerId/credential')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  rotate(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('workerId', ParseUUIDPipe) workerId: string, @Body() body: unknown) {
    return this.workers.rotate(actor, id, workerId, body);
  }

  @Put(':workerId')
  @HttpCode(204)
  grant(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('workerId', ParseUUIDPipe) workerId: string) {
    return this.workers.grant(actor, id, workerId);
  }

  @Delete(':workerId')
  @HttpCode(204)
  revoke(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('workerId', ParseUUIDPipe) workerId: string) {
    return this.workers.revoke(actor, id, workerId);
  }

  @Post(':workerId/disable')
  @HttpCode(204)
  disable(@CurrentAccount() actor: Account, @Param('id', ParseUUIDPipe) id: string,
    @Param('workerId', ParseUUIDPipe) workerId: string) {
    return this.workers.disable(actor, id, workerId);
  }
}
