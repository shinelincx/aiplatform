import { Controller, Get, Inject, Injectable, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { Account, ModelUsageRow, ProjectAuditEntry, ProjectOperations } from '@ado/shared';
import { CurrentAccount, SessionGuard } from './auth';
import { Database } from './database';
import { ProjectsService } from './projects';

@Injectable()
export class OperationsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

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
}
