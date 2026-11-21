import { BadRequestException, Body, Controller, Get, Inject, Injectable, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { agentRoleLabels, workerOfflineMs, type Account, type ModelRate, type ModelUsageRow, type ProjectAuditEntry,
  type ProjectOperations, type ProjectOverview } from '@ado/shared';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { objectInput } from './input';
import { ProjectsService } from './projects';
import { workerCanVerify, workerDiskReady, workerMatchesAssignment, workerOnline } from './workers';

const rateFields = `model, input_usd::text AS "inputUsdPerMillion", cached_input_usd::text AS "cachedInputUsdPerMillion",
  output_usd::text AS "outputUsdPerMillion"`;

function rateInput(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,6})?$/.test(value)) {
    throw new BadRequestException('Expected a non-negative decimal rate per million tokens');
  }
  return value;
}

@Injectable()
export class OperationsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async overview(actor: Account, projectId: string): Promise<ProjectOverview> {
    const project = await this.projects.access(actor.id, projectId);
    const { rows: [summary] } = await this.db.pool.query<ProjectOverview>(
      `WITH current_tasks AS (
        SELECT id, task_code, title, status, updated_at, archived_at FROM tasks WHERE project_id = $1
      ), latest_run AS (
        SELECT DISTINCT ON (task_id) task_id, id, status, cancel_requested, requested_worker_id,
          repository_id, check_plan, qa_assignment, developer_assignment FROM execution_runs WHERE project_id = $1
        ORDER BY task_id, created_at DESC, id DESC
      ), alerts AS (
        SELECT t.id AS "taskId", t.task_code AS code, t.title, t.updated_at,
          CASE
            WHEN t.status = 'FAILED' THEN 'worker_failed'
            WHEN t.status = 'TIMEOUT' THEN 'worker_timeout'
            WHEN t.status = 'PLANNING' AND plan.state = 'failed' THEN 'planning'
            WHEN t.status = 'TESTING' AND qa.state = 'failed' THEN 'qa'
            WHEN t.status = 'REVIEW' AND delivery.state = 'failed' THEN 'delivery'
            WHEN $4::boolean AND t.status = 'QUEUED' AND r.status = 'queued' AND NOT r.cancel_requested
              AND NOT EXISTS (
                SELECT 1 FROM worker_projects wp JOIN workers w ON w.id = wp.worker_id
                WHERE wp.project_id = $1 AND ${workerOnline} AND ${workerDiskReady}
                  AND w.capabilities ? 'codexVersion' AND ${workerMatchesAssignment} AND ${workerCanVerify}
              ) THEN 'worker_unavailable'
          END AS kind
        FROM current_tasks t LEFT JOIN latest_run r ON r.task_id = t.id
        LEFT JOIN repositories g ON g.id = r.repository_id AND g.project_id = $1
        LEFT JOIN task_agent_plans plan ON plan.task_id = t.id
        LEFT JOIN execution_qa qa ON qa.run_id = r.id
        LEFT JOIN execution_deliveries delivery ON delivery.run_id = r.id
        WHERE t.archived_at IS NULL
      )
      SELECT
        (SELECT jsonb_build_object(
          'open', count(*) FILTER (WHERE archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED')),
          'completed', count(*) FILTER (WHERE status = 'COMPLETED'),
          'approval', count(*) FILTER (WHERE status = 'WAITING_APPROVAL')
        ) FROM current_tasks) AS tasks,
        ($3::int - (SELECT count(*)::int FROM project_agent_settings WHERE project_id = $1 AND NOT enabled)) AS "agentsEnabled",
        (SELECT jsonb_build_object('online', count(*) FILTER (WHERE ${workerOnline}), 'total', count(*),
           'diskPaused', count(*) FILTER (WHERE ${workerOnline} AND NOT ${workerDiskReady} AND w.capabilities ? 'codexVersion'))
         FROM workers w JOIN worker_projects wp ON wp.worker_id = w.id WHERE wp.project_id = $1) AS workers,
        (SELECT jsonb_build_object(
           'queued', count(*) FILTER (WHERE status = 'queued'), 'running', count(*) FILTER (WHERE status = 'running'),
           'succeeded', count(*) FILTER (WHERE status = 'succeeded'), 'total', count(*)
         ) FROM execution_runs WHERE project_id = $1) AS executions,
        ARRAY(SELECT jsonb_build_object('taskId', "taskId", 'code', code, 'title', title, 'kind', kind)
          FROM alerts WHERE kind IS NOT NULL ORDER BY updated_at DESC, "taskId" LIMIT 10) AS alerts`,
      [projectId, workerOfflineMs, Object.keys(agentRoleLabels).length, project.status === 'active']);
    return summary;
  }

  async list(actor: Account, projectId: string): Promise<ProjectOperations> {
    const project = await this.projects.access(actor.id, projectId);
    const canManage = project.role === 'owner';
    const [usage, audit, rates] = await Promise.all([
      this.db.pool.query<ModelUsageRow>(
        `WITH usage_records AS (
          SELECT payload->>'role' AS role, payload->'usage'->>'model' AS model, payload->'usage' AS usage
          FROM task_events WHERE project_id = $1 AND event_type = 'agent.model_usage'
          UNION ALL
          SELECT r.developer_assignment->'agent'->>'role', NULLIF(r.developer_assignment->'agent'->>'model', ''),
            latest.payload->'usage'
          FROM execution_runs r JOIN LATERAL (
            SELECT payload FROM execution_events WHERE run_id = r.id AND kind IN ('result', 'turn', 'cancelled')
              AND payload ? 'usage' ORDER BY sequence DESC LIMIT 1
          ) latest ON true WHERE r.project_id = $1
         ), token_totals AS (
           SELECT role, model, SUM((usage->>'inputTokens')::numeric) AS inputs,
             SUM((usage->>'cachedInputTokens')::numeric) AS cached, SUM((usage->>'outputTokens')::numeric) AS outputs,
             bool_and((usage->>'cachedInputTokens')::numeric <= (usage->>'inputTokens')::numeric) AS valid
           FROM usage_records GROUP BY role, model
         )
         SELECT t.role, t.model, t.inputs::text AS "inputTokens", t.cached::text AS "cachedInputTokens", t.outputs::text AS "outputTokens",
           CASE WHEN t.valid THEN round(((t.inputs - t.cached) * r.input_usd + t.cached * r.cached_input_usd
             + t.outputs * r.output_usd) / 1000000, 12)::text END AS "estimatedUsd"
         FROM token_totals t LEFT JOIN project_model_rates r ON r.project_id = $1 AND r.model = t.model
         ORDER BY t.role, t.model`, [projectId]),
      canManage ? this.db.pool.query<ProjectAuditEntry>(
        `SELECT id, action, actor, "resourceId", "createdAt", details FROM (
          SELECT a.id::text, a.action, u.name AS actor, a.resource_id AS "resourceId", a.created_at AS "createdAt", a.details
          FROM audit_logs a JOIN users u ON u.id = a.actor_id WHERE a.project_id = $1
          UNION ALL
          SELECT 'task:' || t.id, t.event_type,
            COALESCE(w.name, t.payload->>'role',
              CASE WHEN t.event_type LIKE 'agent.qa_%' THEN 'QA_ENGINEER' ELSE 'Worker' END),
            t.task_id, t.created_at, NULL::jsonb
          FROM task_events t LEFT JOIN workers w ON w.id = (t.payload->>'workerId')::uuid
          WHERE t.project_id = $1 AND (
            t.event_type IN ('agent.step_completed','agent.plan_failed','agent.qa_completed','agent.qa_failed')
            OR (t.event_type = 'task.status_changed' AND t.payload ? 'workerId')
          )
         ) activity ORDER BY "createdAt" DESC, id DESC LIMIT 25`, [projectId]) : null,
      canManage ? this.db.pool.query<ModelRate>(
        `SELECT ${rateFields} FROM project_model_rates WHERE project_id = $1 ORDER BY model`, [projectId]) : null,
    ]);
    return { usage: usage.rows, audit: audit?.rows ?? null, rates: rates?.rows ?? null };
  }

  async saveRate(actor: Account, projectId: string, model: string, body: unknown) {
    if (!/^[\w.-]{1,100}$/.test(model)) throw new BadRequestException('Invalid model identifier');
    const input = objectInput(body);
    const rates = [rateInput(input.inputUsdPerMillion), rateInput(input.cachedInputUsdPerMillion), rateInput(input.outputUsdPerMillion)];
    return this.db.transaction(async (client) => {
      await this.projects.access(actor.id, projectId, { owner: true, active: true }, client);
      const { rows: [{ id, ...saved }] } = await client.query<ModelRate & { id: string }>(
        `INSERT INTO project_model_rates (project_id, model, input_usd, cached_input_usd, output_usd)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, model) DO UPDATE
         SET input_usd = EXCLUDED.input_usd, cached_input_usd = EXCLUDED.cached_input_usd, output_usd = EXCLUDED.output_usd
         RETURNING id, ${rateFields}`, [projectId, model, ...rates]);
      await this.projects.audit(client, actor.id, projectId, 'operations.model_rate_updated', id);
      return saved;
    });
  }
}

@Controller('projects/:projectId/operations')
@UseGuards(SessionGuard)
export class OperationsController {
  constructor(@Inject(OperationsService) private readonly operations: OperationsService) {}

  @Get()
  list(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.operations.list(actor, projectId);
  }

  @Get('overview')
  overview(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.operations.overview(actor, projectId);
  }

  @Put('rates/:model')
  saveRate(@CurrentAccount() actor: Account, @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('model') model: string, @Body() body: unknown) {
    return this.operations.saveRate(actor, projectId, model, body);
  }
}
