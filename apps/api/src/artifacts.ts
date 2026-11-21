import {
  BadRequestException, ConflictException, Controller, Get, Header, Headers, Inject,
  Injectable, NotFoundException, Param, ParseUUIDPipe, PayloadTooLargeException,
  Put, Req, Res, ServiceUnavailableException, StreamableFile, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { maxPatchBytes, type Account, type PatchArtifact } from '@ado/shared';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { TasksService } from './tasks';
import { parseWorkerCredentials, type WorkerIdentity } from './workers';

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

type Artifact = PatchArtifact & { key: string };
type Target = { projectId: string; hash: string | null };
type RevisionArtifact = Artifact & { previousRunId: string; baseCommit: string };

@Injectable()
export class ArtifactStore {
  private readonly bucket = process.env.ADO_S3_BUCKET;
  private readonly client: S3Client | undefined;

  constructor() {
    const endpoint = process.env.ADO_S3_ENDPOINT;
    const accessKeyId = process.env.ADO_S3_ACCESS_KEY;
    const secretAccessKey = process.env.ADO_S3_SECRET_KEY;
    if (endpoint && this.bucket && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        region: process.env.ADO_S3_REGION ?? 'us-east-1',
        endpoint, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true,
        maxAttempts: 2, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      });
    }
  }

  private storage() {
    if (!this.client || !this.bucket) throw new ServiceUnavailableException('Artifact storage is not configured');
    return { client: this.client, bucket: this.bucket };
  }

  async put(artifact: Artifact, body: Buffer) {
    const { client, bucket } = this.storage();
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: artifact.key, Body: body, ContentLength: body.length,
      ContentType: 'application/octet-stream', Metadata: { sha256: artifact.sha256 },
    }), { abortSignal: AbortSignal.timeout(10_000) }).catch(() => {
      throw new ServiceUnavailableException('Artifact upload failed');
    });
  }

  async get(artifact: Artifact) {
    const { client, bucket } = this.storage();
    try {
      const { Body, ContentLength } = await client.send(new GetObjectCommand({
        Bucket: bucket, Key: artifact.key,
      }), { abortSignal: AbortSignal.timeout(10_000) });
      if (!Body || ContentLength !== artifact.size || artifact.size > maxPatchBytes) {
        if (Body && 'destroy' in Body && typeof Body.destroy === 'function') Body.destroy();
        throw new Error('Invalid artifact length');
      }
      const bytes = Buffer.from(await Body.transformToByteArray());
      if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error('Artifact integrity mismatch');
      return bytes;
    } catch {
      throw new ServiceUnavailableException('Artifact is unavailable or failed integrity validation');
    }
  }
}

@Injectable()
export class ArtifactsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ArtifactStore) private readonly store: ArtifactStore,
  ) {}

  private async target(runId: string, worker: WorkerIdentity, client: Pool | PoolClient) {
    const { rows: [candidate] } = await client.query<Target>(
      `SELECT r.project_id AS "projectId",
         COALESCE(r.candidate_hash, r.verification_report->>'patchHash') AS hash
       FROM execution_runs r JOIN workers w ON w.id = r.worker_id
       JOIN projects p ON p.id = r.project_id AND p.status = 'active'
       JOIN worker_projects wp ON wp.worker_id = w.id AND wp.project_id = r.project_id
       WHERE r.id = $1 AND w.id = $2 AND w.credential_hash = $3 AND NOT w.disabled
         AND w.credential_expires_at > now() AND NOT r.cancel_requested
         AND ((r.status = 'running' AND r.lease_expires_at > now())
           OR (r.status = 'succeeded' AND r.verification_report->>'passed' = 'true'))`,
      [runId, worker.workerId, worker.hash],
    );
    if (!candidate) throw new NotFoundException('Execution artifact target not found');
    if (!candidate.hash) throw new ConflictException('A candidate must be recorded before upload');
    return { ...candidate, hash: candidate.hash };
  }

  async upload(runId: string, worker: WorkerIdentity, request: IncomingMessage) {
    const candidate = await this.target(runId, worker, this.db.pool);
    if (request.headers['content-type'] !== 'application/octet-stream') {
      throw new BadRequestException('Expected a binary patch');
    }
    const length = request.headers['content-length'];
    if (typeof length !== 'string' || !/^[0-9]+$/.test(length) || Number(length) < 1) {
      throw new BadRequestException('Content-Length is required');
    }
    const size = Number(length);
    if (size > maxPatchBytes) throw new PayloadTooLargeException('Patch exceeds the size limit');
    const body = Buffer.allocUnsafe(size);
    let received = 0;
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk) || received + chunk.length > size) throw new PayloadTooLargeException();
      chunk.copy(body, received);
      received += chunk.length;
    }
    if (received !== size) throw new BadRequestException('Incomplete patch');
    const hash = sha256(body);
    if (hash !== candidate.hash) throw new ConflictException('Patch digest does not match the candidate');
    const artifact = { sha256: hash, size, key: `projects/${candidate.projectId}/executions/${runId}/${hash}.patch` };
    await this.store.put(artifact, body);

    return this.db.transaction(async (client) => {
      await client.query('SELECT id FROM execution_runs WHERE id = $1 FOR UPDATE', [runId]);
      if ((await this.target(runId, worker, client)).hash !== hash) {
        throw new ConflictException('Candidate changed while the patch was uploaded');
      }
      await client.query(
        `INSERT INTO execution_artifacts (run_id, sha256, size, object_key)
         VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, sha256) DO NOTHING`, [runId, hash, size, artifact.key],
      );
      return { sha256: hash, size };
    });
  }

  async download(actor: Account, projectId: string, taskId: string, runId: string) {
    await this.tasks.get(actor, projectId, taskId);
    const { rows: [artifact] } = await this.db.pool.query<Artifact>(
      `SELECT a.sha256, a.size, a.object_key AS key FROM execution_artifacts a
       JOIN execution_runs r ON r.id = a.run_id WHERE r.project_id = $1 AND r.task_id = $2 AND r.id = $3
         AND a.sha256 = COALESCE(r.candidate_hash, r.verification_report->>'patchHash')`,
      [projectId, taskId, runId],
    );
    if (!artifact) throw new NotFoundException('Patch artifact not found');
    return this.store.get(artifact);
  }

  private async revisionSource(runId: string, worker: WorkerIdentity) {
    const { rows: [artifact] } = await this.db.pool.query<RevisionArtifact>(
      `SELECT a.sha256, a.size, a.object_key AS key, prior.id AS "previousRunId", result."baseCommit"
       FROM execution_runs r
       JOIN workers w ON w.id = r.worker_id
       JOIN projects p ON p.id = r.project_id AND p.status = 'active'
       JOIN worker_projects wp ON wp.worker_id = w.id AND wp.project_id = r.project_id
       JOIN execution_runs prior ON prior.id::text = r.developer_assignment #>> '{revision,runId}'
         AND prior.project_id = r.project_id AND prior.task_id = r.task_id AND prior.repository_id = r.repository_id
       JOIN execution_reviews review ON review.run_id = prior.id AND review.decision = 'rejected'
       JOIN execution_artifacts a ON a.run_id = prior.id AND a.sha256 = r.developer_assignment #>> '{revision,patchHash}'
       JOIN LATERAL (
         SELECT payload->>'baseCommit' AS "baseCommit" FROM execution_events
         WHERE run_id = prior.id AND kind = 'result' AND payload->>'patchHash' = a.sha256
         ORDER BY sequence DESC LIMIT 1
       ) result ON true
       WHERE r.id = $1 AND w.id = $2 AND w.credential_hash = $3 AND NOT w.disabled
         AND w.credential_expires_at > now() AND w.capabilities->'revisionArtifactVersion' = '1'::jsonb
         AND r.status = 'running' AND r.lease_expires_at > now() AND NOT r.cancel_requested
         AND prior.status = 'succeeded' AND prior.verification_report->'passed' = 'true'::jsonb
         AND prior.verification_report->>'patchHash' = a.sha256 AND a.sha256 ~ '^[0-9a-f]{64}$'
         AND result."baseCommit" ~ '^[0-9a-f]{40}$' AND a.size BETWEEN 1 AND $4`,
      [runId, worker.workerId, worker.hash, maxPatchBytes],
    );
    if (!artifact) throw new NotFoundException('Revision artifact not found');
    return artifact;
  }

  async downloadRevision(runId: string, worker: WorkerIdentity) {
    const artifact = await this.revisionSource(runId, worker);
    const bytes = await this.store.get(artifact);
    const current = await this.revisionSource(runId, worker);
    if (current.previousRunId !== artifact.previousRunId || current.baseCommit !== artifact.baseCommit
      || current.sha256 !== artifact.sha256 || current.size !== artifact.size || current.key !== artifact.key) {
      throw new NotFoundException('Revision artifact not found');
    }
    return { bytes, baseCommit: artifact.baseCommit };
  }
}

@Controller()
export class ArtifactsController {
  constructor(@Inject(ArtifactsService) private readonly artifacts: ArtifactsService) {}

  @Put('worker-executions/:runId/artifact')
  @Header('Cache-Control', 'no-store')
  upload(@Param('runId', ParseUUIDPipe) runId: string, @Headers('authorization') authorization: string | undefined,
    @Req() request: IncomingMessage) {
    const actor = parseWorkerCredentials(authorization);
    if (!actor) throw new UnauthorizedException();
    return this.artifacts.upload(runId, actor, request);
  }

  @Get('worker-executions/:runId/revision-artifact')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadRevision(@Param('runId', ParseUUIDPipe) runId: string, @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: ServerResponse) {
    const worker = parseWorkerCredentials(authorization);
    if (!worker) throw new UnauthorizedException();
    const { bytes, baseCommit } = await this.artifacts.downloadRevision(runId, worker);
    response.setHeader('X-ADO-Base-Commit', baseCommit);
    return new StreamableFile(bytes, { type: 'application/octet-stream', length: bytes.length });
  }

  @Get('projects/:projectId/tasks/:taskId/executions/:runId/artifact')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    const bytes = await this.artifacts.download(actor, projectId, taskId, runId);
    return new StreamableFile(bytes, { type: 'application/octet-stream', disposition: `attachment; filename="${runId}.patch"` });
  }
}
