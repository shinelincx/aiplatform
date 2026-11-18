import { Controller, Get, Inject, Injectable, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { agentRoleLabels, workerOfflineMs, type Account, type ModelUsageRow, type ProjectAuditEntry,
  type ProjectOperations, type ProjectOverview } from '@ado/shared';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { ProjectsService } from './projects';
import { workerOnline } from './workers';

@Injectable()
export class OperationsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async overview(actor: Account, projectId: string): Promise<ProjectOverview> {
    await this.projects.access(actor.id, projectId);
    const { rows: [summary] } = await this.db.pool.query<ProjectOverview>(
      `WITH current_tasks AS (
        SELECT id, task_code, title, status, updated_at, archived_at FROM tasks WHERE project_id = $1
      ), latest_run AS (
        SELECT DISTINCT ON (task_id) task_id, id FROM execution_runs WHERE project_id = $1
        ORDER BY task_id, created_at DESC, id DESC
      ), alerts AS (
        SELECT t.id AS "taskId", t.task_code AS code, t.title, t.updated_at,
          CASE
            WHEN t.status = 'FAILED' THEN 'worker_failed'
            WHEN t.status = 'TIMEOUT' THEN 'worker_timeout'
            WHEN t.status = 'PLANNING' AND plan.state = 'failed' THEN 'planning'
            WHEN t.status = 'TESTING' AND qa.state = 'failed' THEN 'qa'
            WHEN t.status = 'REVIEW' AND delivery.state = 'failed' THEN 'delivery'
          END AS kind
        FROM current_tasks t LEFT JOIN latest_run r ON r.task_id = t.id
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
        (SELECT jsonb_build_object('online', count(*) FILTER (WHERE ${workerOnline}), 'total', count(*))
         FROM workers w JOIN worker_projects wp ON wp.worker_id = w.id WHERE wp.project_id = $1) AS workers,
        (SELECT jsonb_build_object(
           'queued', count(*) FILTER (WHERE status = 'queued'), 'running', count(*) FILTER (WHERE status = 'running'),
           'succeeded', count(*) FILTER (WHERE status = 'succeeded'), 'total', count(*)
         ) FROM execution_runs WHERE project_id = $1) AS executions,
        ARRAY(SELECT jsonb_build_object('taskId', "taskId", 'code', code, 'title', title, 'kind', kind)
          FROM alerts WHERE kind IS NOT NULL ORDER BY updated_at DESC, "taskId" LIMIT 10) AS alerts`,
      [projectId, workerOfflineMs, Object.keys(agentRoleLabels).length]);
    return summary;
  }

  async list(actor: Account, projectId: string): Promise<ProjectOperations> {
    const project = await this.projects.access(actor.id, projectId);
    const [usage, audit] = await Promise.all([
      this.db.pool.query<ModelUsageRow>(
        `WITH usage_records AS (
          SELECT payload->>'role' AS role, payload->'usage'->>'model' AS model, payload->'usage' AS usage
          FROM task_events WHERE project_id = $1 AND event_type = 'agent.model_usage'
          UNION ALL
          SELECT r.developer_assignment->'agent'->>'role', NULLIF(r.developer_assignment->'agent'->>'model', ''),
            latest.payload->'usage'
          FROM execution_runs r JOIN LATERAL (
            SELECT payload FROM execution_events WHERE run_id = r.id AND kind = 'result' ORDER BY sequence DESC LIMIT 1
          ) latest ON true WHERE r.project_id = $1
         )
         SELECT role, model, SUM((usage->>'inputTokens')::numeric)::text AS "inputTokens",
           SUM((usage->>'cachedInputTokens')::numeric)::text AS "cachedInputTokens",
           SUM((usage->>'outputTokens')::numeric)::text AS "outputTokens"
         FROM usage_records GROUP BY role, model ORDER BY role, model`, [projectId]),
      project.role === 'owner' ? this.db.pool.query<ProjectAuditEntry>(
        `SELECT id, action, actor, "resourceId", "createdAt" FROM (
          SELECT a.id::text, a.action, u.name AS actor, a.resource_id AS "resourceId", a.created_at AS "createdAt"
          FROM audit_logs a JOIN users u ON u.id = a.actor_id WHERE a.project_id = $1
          UNION ALL
          SELECT 'task:' || t.id, t.event_type,
            COALESCE(w.name, t.payload->>'role',
              CASE WHEN t.event_type LIKE 'agent.qa_%' THEN 'QA_ENGINEER' ELSE 'Worker' END),
            t.task_id, t.created_at
          FROM task_events t LEFT JOIN workers w ON w.id = (t.payload->>'workerId')::uuid
          WHERE t.project_id = $1 AND (
            t.event_type IN ('agent.step_completed','agent.plan_failed','agent.qa_completed','agent.qa_failed')
            OR (t.event_type = 'task.status_changed' AND t.payload ? 'workerId')
          )
         ) activity ORDER BY "createdAt" DESC, id DESC LIMIT 25`, [projectId]) : null,
    ]);
    return { usage: usage.rows, audit: audit?.rows ?? null };
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
}
