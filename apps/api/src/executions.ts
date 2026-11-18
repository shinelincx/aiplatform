import {
  BadRequestException, ConflictException, Controller, Get, HttpCode, Inject, Injectable,
  Logger, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards,
  type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  canTransitionTask, isWorkerId, workerOfflineMs, type Account, type ExecutionEvent,
  type ExecutionOffer, type ExecutionRun, type Task, type TaskStatus,
} from '@ado/shared';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { GitHubApp } from './github';
import { objectInput, textInput } from './input';
import { ProjectsService } from './projects';
import { TasksService } from './tasks';
import type { WorkerIdentity } from './workers';

const runColumns = `id, status, worker_id AS "workerId", thread_id AS "threadId",
  last_sequence AS "lastSequence", cancel_requested AS "cancelRequested", created_at AS "createdAt",
  finished_at AS "finishedAt"`;
type ClaimedRun = ExecutionRun & { projectId: string; taskId: string };
type WorkerLease = WorkerIdentity & { connectionId: string };
const failureCodes = ['source_unavailable', 'sandbox_rejected', 'codex_failed', 'no_changes', 'worker_timeout', 'worker_error'];

function executionEvent(body: unknown) {
  const data = objectInput(body);
  const { runId, sequence, kind } = data;
  if (!isWorkerId(runId) || typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1 || sequence > 100_000) {
    throw new BadRequestException('Invalid execution event identity');
  }
  const input = objectInput(data.payload);
  if (kind === 'thread') {
    const threadId = textInput(input.threadId, 'thread ID', 128);
    if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new BadRequestException('Invalid thread ID');
    return { runId, sequence, kind, payload: { threadId } };
  }
  if (kind === 'progress') {
    const stage = input.stage;
    if (stage !== 'checkout' && stage !== 'inference' && stage !== 'collecting') {
      throw new BadRequestException('Invalid execution stage');
    }
    return { runId, sequence, kind, payload: { stage } };
  }
  if (kind === 'item') {
    const { itemType, phase } = input;
    if (typeof itemType !== 'string' || !['agent_message', 'command_execution', 'file_change'].includes(itemType)
      || (phase !== 'started' && phase !== 'completed')) throw new BadRequestException('Invalid Codex item');
    return { runId, sequence, kind, payload: { itemType, phase } };
  }
  if (kind === 'failed') {
    if (typeof input.code !== 'string' || !failureCodes.includes(input.code)) throw new BadRequestException('Invalid error code');
    return { runId, sequence, kind, payload: { code: input.code } };
  }
  if (kind === 'cancelled') return { runId, sequence, kind, payload: {} };
  if (kind === 'result') {
    const baseCommit = textInput(input.baseCommit, 'base commit', 40);
    const patchHash = textInput(input.patchHash, 'patch hash', 64);
    if (!/^[0-9a-f]{40}$/.test(baseCommit) || !/^[0-9a-f]{64}$/.test(patchHash)
      || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100) {
      throw new BadRequestException('Invalid result metadata');
    }
    const files = input.files.map((value) => textInput(value, 'file', 350));
    const metrics = objectInput(input.usage);
    const usage = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens'].map((key) => {
      const value = metrics[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new BadRequestException('Invalid usage');
      }
      return [key, value];
    }));
    return { runId, sequence, kind, payload: { baseCommit, patchHash, files, usage } };
  }
  throw new BadRequestException('Unsupported execution event');
}

@Injectable()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private reaper?: ReturnType<typeof setInterval>;
  private readonly log = new Logger(ExecutionsService.name);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(GitHubApp) private readonly github: GitHubApp,
  ) {}

  onModuleInit() {
    this.reaper = setInterval(() => {
      void this.expire().catch(() => this.log.warn('Execution lease sweep failed'));
    }, 5000).unref();
  }

  onModuleDestroy() {
    clearInterval(this.reaper);
  }

  async list(actor: Account, projectId: string, taskId: string) {
    await this.tasks.get(actor, projectId, taskId);
    const { rows } = await this.db.pool.query<ExecutionRun>(
      `SELECT ${runColumns} FROM execution_runs WHERE project_id = $1 AND task_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 20`, [projectId, taskId],
    );
    return rows;
  }

  async events(actor: Account, projectId: string, taskId: string, runId: string) {
    await this.tasks.get(actor, projectId, taskId);
    const { rows } = await this.db.pool.query<ExecutionEvent>(
      `SELECT e.sequence, e.kind, e.payload, e.created_at AS "createdAt"
       FROM execution_events e JOIN execution_runs r ON r.id = e.run_id
       WHERE r.project_id = $1 AND r.task_id = $2 AND r.id = $3 ORDER BY e.sequence`, [projectId, taskId, runId],
    );
    return rows;
  }

  async queue(actor: Account, projectId: string, taskId: string) {
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const task = await this.tasks.find(projectId, taskId, client);
      if (task.archivedAt || !task.repositoryId || !['READY', 'FAILED', 'TIMEOUT'].includes(task.status)) {
        throw new ConflictException('An approved task and bound repository are required');
      }
      if (!task.acceptanceCriteria.length) throw new ConflictException('Acceptance criteria are required');
      if (task.status !== 'READY') {
        await this.move(client, task, 'RETRYING', { actorId: actor.id });
        task.status = 'RETRYING';
      }
      const { rows: [run] } = await client.query<ExecutionRun>(
        `INSERT INTO execution_runs (project_id, task_id, repository_id) VALUES ($1, $2, $3)
         RETURNING ${runColumns}`, [projectId, taskId, task.repositoryId],
      );
      await this.move(client, task, 'QUEUED', { runId: run.id, actorId: actor.id });
      return run;
    });
  }

  async cancel(actor: Account, projectId: string, taskId: string, runId: string) {
    await this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true }, client);
      const { rows: [run] } = await client.query<ExecutionRun>(
        `SELECT ${runColumns} FROM execution_runs WHERE id = $1 AND project_id = $2 AND task_id = $3 FOR UPDATE`,
        [runId, projectId, taskId],
      );
      if (!run) throw new NotFoundException('Execution run not found');
      if (run.cancelRequested || !['queued', 'running'].includes(run.status)) return;
      const task = await this.tasks.find(projectId, taskId, client);
      await client.query(
        `UPDATE execution_runs SET cancel_requested = true,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
         WHERE id = $1`, [runId],
      );
      await this.tasks.event(client, task, 'task.execution_cancel_requested', { runId, actorId: actor.id });
      if (run.status === 'queued') await this.move(client, task, 'CANCELLED', { runId, actorId: actor.id });
    });
  }

  private async lockWorker(client: PoolClient, worker: WorkerLease) {
    const result = await client.query<{ canExecute: boolean }>(
      `SELECT capabilities ? 'codexVersion' AS "canExecute" FROM workers
       WHERE id = $1 AND credential_hash = $2 AND connection_id = $3
         AND credential_expires_at > now() AND NOT disabled FOR UPDATE`,
      [worker.workerId, worker.hash, worker.connectionId],
    );
    return result.rows[0];
  }

  async claim(worker: WorkerLease): Promise<ExecutionOffer | null> {
    const claimed = await this.db.transaction(async (client) => {
      if (!(await this.lockWorker(client, worker))?.canExecute) return null;
      const assigned = await client.query(
        `SELECT id FROM execution_runs WHERE worker_id = $1 AND status = 'running'`, [worker.workerId],
      );
      if (assigned.rowCount) return null;
      const { rows: [offer] } = await client.query<ExecutionOffer & { installationId: string; githubId: string }>(
        `SELECT r.id, r.task_id AS "taskId", r.project_id AS "projectId", t.title, t.description,
           t.acceptance_criteria AS "acceptanceCriteria", g.owner || '/' || g.repo_name AS repository,
           g.default_branch AS "defaultBranch", g.installation_id::text AS "installationId",
           g.github_repository_id::text AS "githubId"
         FROM execution_runs r
         JOIN worker_projects wp ON wp.project_id = r.project_id AND wp.worker_id = $1
         JOIN projects p ON p.id = r.project_id AND p.status = 'active'
         JOIN tasks t ON t.id = r.task_id AND t.status = 'QUEUED'
         JOIN repositories g ON g.id = r.repository_id
         WHERE r.status = 'queued' AND NOT r.cancel_requested
         ORDER BY t.priority, r.created_at, r.id LIMIT 1 FOR UPDATE OF p, r SKIP LOCKED`, [worker.workerId],
      );
      if (!offer) return null;
      await client.query(
        `UPDATE execution_runs SET status = 'running', worker_id = $2, lease_expires_at = now() + ($3 * interval '1 millisecond')
         WHERE id = $1`, [offer.id, worker.workerId, workerOfflineMs],
      );
      const task = await this.tasks.find(offer.projectId, offer.taskId, client);
      await this.move(client, task, 'RUNNING', { runId: offer.id, workerId: worker.workerId });
      return offer;
    });
    if (!claimed) return null;
    const { githubId, installationId, ...offer } = claimed;
    if (this.github.configured) {
      // A scoped read credential is used solely for checkout. Public sources can still clone anonymously.
      offer.repositoryToken = await this.github.installationToken(Number(installationId), Number(githubId)).catch(() => undefined);
    }
    return offer;
  }

  async renew(worker: WorkerLease, runId: string) {
    return this.db.transaction(async (client) => {
      if (!await this.lockWorker(client, worker)) return false;
      const { rows: [run] } = await client.query<{ cancelRequested: boolean }>(
        `UPDATE execution_runs r SET lease_expires_at = now() + ($3 * interval '1 millisecond')
         FROM projects p, worker_projects wp WHERE r.id = $1 AND r.worker_id = $2 AND r.status = 'running'
           AND r.lease_expires_at > now() AND p.id = r.project_id AND p.status = 'active'
           AND wp.project_id = r.project_id AND wp.worker_id = $2
         RETURNING r.cancel_requested AS "cancelRequested"`, [runId, worker.workerId, workerOfflineMs],
      );
      return run ? !run.cancelRequested : false;
    });
  }

  async record(worker: WorkerLease, body: unknown) {
    const event = executionEvent(body);
    return this.db.transaction(async (client) => {
      if (!await this.lockWorker(client, worker)) return { stop: true, accepted: false };
      const { rows: [run] } = await client.query<ClaimedRun & { current: boolean }>(
        `SELECT ${runColumns}, r.project_id AS "projectId", r.task_id AS "taskId",
           r.lease_expires_at > now() AND EXISTS (
             SELECT 1 FROM worker_projects wp JOIN projects p ON p.id = wp.project_id AND p.status = 'active'
             WHERE wp.worker_id = $2 AND wp.project_id = r.project_id
           ) AS current
         FROM execution_runs r WHERE id = $1 AND worker_id = $2 FOR UPDATE`, [event.runId, worker.workerId],
      );
      if (!run) return { stop: true, accepted: false };
      if (event.sequence <= run.lastSequence) {
        const same = await client.query(
          'SELECT 1 FROM execution_events WHERE run_id = $1 AND sequence = $2 AND kind = $3 AND payload = $4',
          [event.runId, event.sequence, event.kind, event.payload],
        );
        if (!same.rowCount) return { stop: true, accepted: false };
        return { accepted: true, stop: run.cancelRequested || (run.status === 'running' && !run.current) };
      }
      if (run.status !== 'running' || !run.current || event.sequence !== run.lastSequence + 1) {
        return { stop: true, accepted: false };
      }
      if (run.cancelRequested && event.kind !== 'cancelled') return { stop: true, accepted: false };
      if (event.kind === 'thread' && run.threadId && run.threadId !== event.payload.threadId) {
        return { stop: true, accepted: false };
      }
      if (event.kind === 'result' && !run.threadId) return { stop: true, accepted: false };
      await client.query(
        'INSERT INTO execution_events (run_id, sequence, kind, payload) VALUES ($1,$2,$3,$4)',
        [event.runId, event.sequence, event.kind, event.payload],
      );
      await client.query(
        'UPDATE execution_runs SET last_sequence = $2, thread_id = coalesce($3, thread_id) WHERE id = $1',
        [event.runId, event.sequence, event.kind === 'thread' ? event.payload.threadId : null],
      );
      const status = event.kind === 'result' ? 'succeeded' : event.kind === 'failed' ? 'failed'
        : event.kind === 'cancelled' ? 'cancelled' : null;
      if (status) await this.finish(client, run, status);
      return { stop: false, accepted: true };
    });
  }

  private async expire() {
    await this.db.transaction(async (client) => {
      const { rows } = await client.query<ClaimedRun>(
        `SELECT ${runColumns}, project_id AS "projectId", task_id AS "taskId" FROM execution_runs
         WHERE status = 'running' AND lease_expires_at <= now() LIMIT 25 FOR UPDATE SKIP LOCKED`,
      );
      for (const run of rows) await this.finish(client, run, run.cancelRequested ? 'cancelled' : 'timed_out');
    });
  }

  private async finish(client: PoolClient, run: ClaimedRun, status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out') {
    await client.query('UPDATE execution_runs SET status = $2, finished_at = now(), lease_expires_at = NULL WHERE id = $1',
      [run.id, status]);
    const task = await this.tasks.find(run.projectId, run.taskId, client);
    const next = { succeeded: 'TESTING', failed: 'FAILED', cancelled: 'CANCELLED', timed_out: 'TIMEOUT' } as const;
    await this.move(client, task, next[status], { runId: run.id, workerId: run.workerId });
  }

  private async move(client: PoolClient, task: Task, to: TaskStatus, context: object) {
    if (!canTransitionTask(task.status, to)) throw new ConflictException('Invalid task transition');
    const updated = await client.query(
      `UPDATE tasks SET status = $3, updated_at = now()
       WHERE project_id = $1 AND id = $2 AND status = $4`, [task.projectId, task.id, to, task.status],
    );
    if (!updated.rowCount) throw new ConflictException('Task status changed concurrently');
    await this.tasks.event(client, task, 'task.status_changed', { from: task.status, to, ...context });
  }
}

@Controller('projects/:projectId/tasks/:taskId/executions')
@UseGuards(SessionGuard)
export class ExecutionsController {
  constructor(@Inject(ExecutionsService) private readonly executions: ExecutionsService) {}

  @Get()
  list(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.executions.list(actor, projectId, taskId);
  }

  @Post()
  queue(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.executions.queue(actor, projectId, taskId);
  }

  @Get(':runId/events')
  events(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.executions.events(actor, projectId, taskId, runId);
  }

  @Post(':runId/cancel')
  @HttpCode(204)
  cancel(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.executions.cancel(actor, projectId, taskId, runId);
  }
}
