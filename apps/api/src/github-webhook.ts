import {
  BadRequestException, Controller, Headers, HttpCode, Inject, Post, Req, ServiceUnavailableException,
  UnauthorizedException, type RawBodyRequest,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isWorkerId } from '@ado/shared';
import { Database } from './database';
import { DeliveriesService } from './deliveries';
import { TasksService } from './tasks';

type Delivery = {
  runId: string;
  projectId: string;
  taskId: string;
  pullNumber: number;
  commitSha: string;
  baseBranch: string;
  pullState: 'open' | 'closed' | 'merged' | 'changed';
  updatedAt: Date | null;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

@Controller('github/webhook')
export class GitHubWebhookController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DeliveriesService) private readonly deliveries: DeliveriesService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  @Post()
  @HttpCode(204)
  async handle(
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-delivery') id: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Req() request: RawBodyRequest<IncomingMessage & { body: unknown }>,
  ) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('GitHub webhook is not configured');
    if (!request.rawBody || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new UnauthorizedException();
    const actual = Buffer.from(signature.slice(7), 'hex');
    const expected = createHmac('sha256', secret).update(request.rawBody).digest();
    if (!timingSafeEqual(actual, expected)) throw new UnauthorizedException();
    if (!isWorkerId(id)) throw new BadRequestException('Invalid GitHub delivery ID');
    if (event !== 'pull_request' && event !== 'push' && event !== 'check_run') return;
    const body = object(request.body);
    const repository = object(body.repository).id;
    const installation = object(body.installation).id;
    if (!Number.isSafeInteger(repository) || !Number.isSafeInteger(installation)) return;
    const pull = object(body.pull_request);
    const head = object(pull.head);
    const base = object(pull.base);
    const check = object(body.check_run);
    const branch = event === 'pull_request' && typeof head.ref === 'string' ? head.ref
      : event === 'push' && typeof body.ref === 'string' && body.ref.startsWith('refs/heads/') ? body.ref.slice(11) : null;
    const sha = event === 'check_run' ? check.head_sha : event === 'push' ? body.after : head.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return;
    if (event === 'pull_request' && !Number.isSafeInteger(pull.number)) return;
    if (event !== 'check_run' && (!branch || !/^ado\/[0-9a-f-]{36}$/.test(branch))) return;

    await this.db.transaction(async (client) => {
      const inserted = await client.query(
        'INSERT INTO github_webhook_deliveries (id) VALUES ($1) ON CONFLICT DO NOTHING', [id],
      );
      if (!inserted.rowCount) return;
      const { rows } = await client.query<Delivery>(
        `SELECT d.run_id AS "runId", r.project_id AS "projectId", r.task_id AS "taskId",
           d.pull_number AS "pullNumber", d.commit_sha AS "commitSha", d.base_branch AS "baseBranch", d.pull_state AS "pullState",
           d.github_updated_at AS "updatedAt"
         FROM execution_deliveries d JOIN execution_runs r ON r.id = d.run_id
         JOIN repositories g ON g.id = d.repository_id
         WHERE d.state = 'published' AND g.github_repository_id = $1 AND g.installation_id = $2
           AND (CASE WHEN $3 = 'check_run' THEN d.commit_sha = $5
                ELSE d.branch = $4 AND ($3 <> 'pull_request' OR d.pull_number = $6) END)
         FOR UPDATE OF d`,
        [repository, installation, event, branch, sha, event === 'pull_request' ? pull.number : null],
      );
      for (const delivery of rows) {
        if (delivery.pullState === 'merged') continue;
        const task = await this.tasks.find(delivery.projectId, delivery.taskId, client);
        if (event === 'check_run') {
          await this.tasks.event(client, task, 'task.github_check', {
            runId: delivery.runId,
            status: typeof check.status === 'string' ? check.status.slice(0, 40) : null,
            conclusion: typeof check.conclusion === 'string' ? check.conclusion.slice(0, 40) : null,
          });
          continue;
        }
        if (event === 'push') {
          if (delivery.commitSha !== sha && delivery.pullState !== 'changed') {
            await client.query("UPDATE execution_deliveries SET pull_state = 'changed', updated_at = now() WHERE run_id = $1",
              [delivery.runId]);
            await this.tasks.event(client, task, 'task.github_branch_changed', { runId: delivery.runId, pullNumber: delivery.pullNumber });
          }
          continue;
        }
        if (typeof pull.updated_at !== 'string' || !Number.isFinite(Date.parse(pull.updated_at))
          || (delivery.updatedAt && Date.parse(pull.updated_at) < delivery.updatedAt.getTime())) continue;
        if (pull.state !== 'open' && pull.state !== 'closed') continue;
        const next = delivery.commitSha !== sha || delivery.baseBranch !== base.ref ? 'changed'
          : pull.state === 'closed' && pull.merged === true ? 'merged' : pull.state;
        await client.query(
          `UPDATE execution_deliveries SET pull_state = $2, github_updated_at = $3,
             updated_at = now() WHERE run_id = $1`, [delivery.runId, next, pull.updated_at],
        );
        if (next !== delivery.pullState) await this.tasks.event(client, task, 'task.github_pull_request', {
          runId: delivery.runId, number: delivery.pullNumber, state: next,
        });
        if (next === 'merged') {
          await this.deliveries.markMerged(client, delivery.projectId, delivery.taskId, delivery.runId, delivery.pullNumber);
        }
      }
    });
  }
}
