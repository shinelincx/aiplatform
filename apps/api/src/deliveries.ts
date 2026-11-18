import {
  ConflictException, Controller, HttpCode, Inject, Injectable, Logger, Param, ParseUUIDPipe,
  Post, ServiceUnavailableException, UseGuards, type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Account, ExecutionDelivery } from '@ado/shared';
import { ArtifactStore } from './artifacts';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { DeliveryError, pushCandidate } from './git-delivery';
import { GitHubApp } from './github';
import { ProjectsService } from './projects';
import { TasksService } from './tasks';

export const GIT_PUBLISH = Symbol('GIT_PUBLISH');

const deliveryColumns = `state, branch, base_branch AS "baseBranch", pull_number AS "pullNumber",
  pull_url AS "pullUrl", pull_state AS "pullState", error`;

type Publication = {
  runId: string;
  projectId: string;
  taskId: string;
  repository: string;
  installationId: string;
  externalId: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  patchHash: string;
  objectKey: string;
  size: number;
  createdAt: Date;
  code: string;
  title: string;
  lease: string;
};

@Injectable()
export class DeliveriesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DeliveriesService.name);
  private interval?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = new AbortController();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(GitHubApp) private readonly github: GitHubApp,
    @Inject(ArtifactStore) private readonly artifacts: ArtifactStore,
    @Inject(GIT_PUBLISH) private readonly push: typeof pushCandidate,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      if (this.busy || this.stopping.signal.aborted) return;
      this.busy = true;
      void this.publishNext().catch(() => this.log.warn('Delivery worker could not process its queue'))
        .finally(() => { this.busy = false; });
    }, 2000).unref();
  }

  onModuleDestroy() {
    clearInterval(this.interval);
    this.stopping.abort();
  }

  async enqueue(actor: Account, projectId: string, taskId: string, runId: string) {
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const task = await this.tasks.find(projectId, taskId, client);
      const { rows: [existing] } = await client.query<ExecutionDelivery>(
        `SELECT ${deliveryColumns} FROM execution_deliveries d JOIN execution_runs r ON r.id = d.run_id
         WHERE r.id = $1 AND r.project_id = $2 AND r.task_id = $3`, [runId, projectId, taskId],
      );
      if (existing && existing.state !== 'failed') return existing;
      if (task.status !== 'REVIEW') throw new ConflictException('Only an approved candidate in review can be published');
      const { rows: [candidate] } = await client.query<{
        repoId: string; baseBranch: string; baseCommit: string; patchHash: string;
      }>(
        `SELECT r.repository_id AS "repoId", COALESCE(r.source_branch, g.default_branch) AS "baseBranch",
           e.payload->>'baseCommit' AS "baseCommit", a.sha256 AS "patchHash"
         FROM execution_runs r JOIN execution_reviews h ON h.run_id = r.id AND h.decision = 'approved'
         JOIN repositories g ON g.id = r.repository_id AND g.project_id = r.project_id
         JOIN execution_artifacts a ON a.run_id = r.id AND a.sha256 = r.verification_report->>'patchHash'
         JOIN LATERAL (SELECT payload FROM execution_events WHERE run_id = r.id AND kind = 'result' AND payload->>'patchHash' = a.sha256
           ORDER BY sequence DESC LIMIT 1) e ON true
         WHERE r.project_id = $1 AND r.task_id = $2 AND r.id = $3 AND r.status = 'succeeded'
           AND r.verification_report->>'passed' = 'true'
           AND r.id = (SELECT id FROM execution_runs WHERE project_id = $1 AND task_id = $2
             ORDER BY created_at DESC, id DESC LIMIT 1)`,
        [projectId, taskId, runId],
      );
      if (!candidate) throw new ConflictException('Publish requires an approved, tested and archived patch');
      if (!this.github.configured) throw new ServiceUnavailableException('GitHub App delivery is not configured');
      const { rows: [delivery] } = await client.query<ExecutionDelivery>(
        `INSERT INTO execution_deliveries (run_id, repository_id, requested_by, patch_hash, base_commit, base_branch, branch, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')
         ON CONFLICT (run_id) DO UPDATE SET state = 'queued', error = NULL, updated_at = now(), requested_by = EXCLUDED.requested_by
         RETURNING ${deliveryColumns}`,
        [runId, candidate.repoId, actor.id, candidate.patchHash, candidate.baseCommit, candidate.baseBranch, `ado/${runId}`],
      );
      await this.projects.audit(client, actor.id, projectId, 'delivery.queued', runId);
      await this.tasks.event(client, task, 'task.delivery_queued', { runId, actorId: actor.id });
      return delivery;
    });
  }

  private async claim() {
    if (!this.github.configured) return null;
    const lease = randomUUID();
    return this.db.transaction(async (client) => {
      const { rows: [work] } = await client.query<Omit<Publication, 'lease'>>(
        `SELECT r.id AS "runId", r.project_id AS "projectId", r.task_id AS "taskId", r.created_at AS "createdAt",
           g.owner || '/' || g.repo_name AS repository, g.installation_id::text AS "installationId",
           g.github_repository_id::text AS "externalId", d.branch, d.base_branch AS "baseBranch", d.base_commit AS "baseCommit",
           d.patch_hash AS "patchHash", a.object_key AS "objectKey", a.size, t.task_code AS code, t.title
         FROM execution_deliveries d JOIN execution_runs r ON r.id = d.run_id
         JOIN projects p ON p.id = r.project_id AND p.status = 'active'
         JOIN tasks t ON t.id = r.task_id AND t.status = 'REVIEW'
         JOIN repositories g ON g.id = d.repository_id AND g.project_id = r.project_id
         JOIN execution_reviews h ON h.run_id = r.id AND h.decision = 'approved'
         JOIN execution_artifacts a ON a.run_id = r.id AND a.sha256 = d.patch_hash
         WHERE d.state = 'queued' OR (d.state = 'publishing' AND d.lease_expires_at < now())
         ORDER BY d.updated_at, d.run_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
      );
      if (!work) return null;
      await client.query(
        `UPDATE execution_deliveries SET state = 'publishing', lease_id = $2,
           lease_expires_at = now() + interval '4 minutes', updated_at = now() WHERE run_id = $1`,
        [work.runId, lease],
      );
      return { ...work, lease };
    });
  }

  private async publishNext() {
    const work = await this.claim();
    if (!work) return;
    try {
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(work.repository) || work.repository.endsWith('/.')
        || work.repository.endsWith('/..')) throw new DeliveryError('github_failed');
      const [patch, token] = await Promise.all([
        this.artifacts.get({ key: work.objectKey, sha256: work.patchHash, size: work.size }),
        this.github.deliveryToken(Number(work.installationId), Number(work.externalId)),
      ]);
      const signal = AbortSignal.any([AbortSignal.timeout(160_000), this.stopping.signal]);
      const commit = await this.push({
        remote: `https://github.com/${work.repository}.git`, token, baseBranch: work.baseBranch,
        baseCommit: work.baseCommit, branch: work.branch, patch, runId: work.runId, timestamp: work.createdAt.toISOString(),
      }, signal);
      const pr = await this.github.draftPull(token, work.repository, work.branch, work.baseBranch, commit,
        `[${work.code}] ${work.title}`.slice(0, 240), `ADO run ${work.runId}\n\nTested patch SHA-256: ${work.patchHash}`);
      await this.db.transaction(async (client) => {
        const result = await client.query(
          `UPDATE execution_deliveries SET state = 'published', error = NULL, pull_number = $3, pull_url = $4,
             pull_state = $5, commit_sha = $6, github_updated_at = $7, lease_id = NULL, lease_expires_at = NULL,
             updated_at = now() WHERE run_id = $1 AND lease_id = $2`,
          [work.runId, work.lease, pr.number, pr.url, pr.state, commit, pr.updatedAt],
        );
        if (!result.rowCount) return;
        const task = await this.tasks.find(work.projectId, work.taskId, client);
        await this.tasks.event(client, task, 'task.pull_request_created', { runId: work.runId, number: pr.number, url: pr.url });
        if (pr.state === 'merged') await this.markMerged(client, work.projectId, work.taskId, work.runId, pr.number);
      });
    } catch (error) {
      const code = error instanceof DeliveryError ? error.code : 'github_failed';
      if (!this.stopping.signal.aborted) {
        await this.db.pool.query(
          `UPDATE execution_deliveries SET state = 'failed', error = $3, updated_at = now(),
             lease_id = NULL, lease_expires_at = NULL WHERE run_id = $1 AND lease_id = $2`,
          [work.runId, work.lease, code],
        );
      }
    }
  }

  async markMerged(client: PoolClient, projectId: string, taskId: string, runId: string, pullNumber: number) {
    const task = await this.tasks.find(projectId, taskId, client);
    const changed = await client.query(
      `UPDATE tasks SET status = 'MERGED', updated_at = now() WHERE project_id = $1 AND id = $2 AND status = 'REVIEW'`,
      [projectId, taskId],
    );
    if (!changed.rowCount) return;
    await this.tasks.event(client, task, 'task.status_changed', { from: 'REVIEW', to: 'MERGED', runId, pullNumber });
    await client.query(`UPDATE tasks SET status = 'COMPLETED', updated_at = now() WHERE project_id = $1 AND id = $2`,
      [projectId, taskId]);
    await this.tasks.event(client, task, 'task.status_changed', { from: 'MERGED', to: 'COMPLETED', runId, pullNumber });
  }
}

@Controller('projects/:projectId/tasks/:taskId/executions/:runId/delivery')
@UseGuards(SessionGuard)
export class DeliveriesController {
  constructor(@Inject(DeliveriesService) private readonly deliveries: DeliveriesService) {}

  @Post()
  @HttpCode(202)
  enqueue(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.deliveries.enqueue(actor, projectId, taskId, runId);
  }
}
