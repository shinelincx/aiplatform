export const monitoringSnapshot = `
  WITH latest_run AS (
    SELECT DISTINCT ON (task_id) task_id, id, status
    FROM execution_runs WHERE project_id = $1
    ORDER BY task_id, created_at DESC, id DESC
  ), current_tasks AS (
    SELECT t.status, plan.state AS planning, r.status AS execution, qa.state AS qa, d.state AS delivery
    FROM tasks t
    LEFT JOIN latest_run r ON r.task_id = t.id
    LEFT JOIN task_agent_plans plan ON plan.task_id = t.id
    LEFT JOIN execution_qa qa ON qa.run_id = r.id
    LEFT JOIN execution_deliveries d ON d.run_id = r.id
    WHERE t.project_id = $1 AND t.archived_at IS NULL
  ), recent AS (
    SELECT task_id, created_at,
      CASE event_type WHEN 'agent.qa_failed' THEN 'qa' ELSE 'planning' END AS stage,
      CASE WHEN event_type = 'agent.qa_failed' THEN 'QA'
        WHEN (payload->>'role') = ANY($2::text[]) THEN payload->>'role'
        ELSE 'unclassified' END AS role,
      CASE WHEN (payload->>'error') = ANY($3::text[]) THEN payload->>'error'
        ELSE 'unclassified' END AS category
    FROM task_events WHERE project_id = $1 AND created_at >= now() - interval '72 hours'
      AND created_at <= now() AND event_type IN ('agent.plan_failed','agent.qa_failed')
  ), grouped AS (
    SELECT stage, role, category, count(*)::int AS occurrences, count(DISTINCT task_id)::int AS "affectedTasks",
      max(created_at) AS "latestAt"
    FROM recent GROUP BY stage, role, category
  )
  SELECT now() AS "checkedAt", now() - interval '72 hours' AS "windowStart",
    (SELECT jsonb_build_object(
      'planningFailures', count(*) FILTER (WHERE status = 'PLANNING' AND planning = 'failed'),
      'qaFailures', count(*) FILTER (WHERE status = 'TESTING' AND qa = 'failed'),
      'deliveryFailures', count(*) FILTER (WHERE status = 'REVIEW' AND delivery = 'failed'),
      'workerFailures', count(*) FILTER (WHERE status = 'FAILED'),
      'workerTimeouts', count(*) FILTER (WHERE status = 'TIMEOUT'),
      'queuedExecutions', count(*) FILTER (WHERE execution = 'queued')
    ) FROM current_tasks) AS current,
    (SELECT count(DISTINCT task_id)::int FROM recent) AS "recentAffectedTasks",
    ARRAY(SELECT to_jsonb(g) FROM grouped g ORDER BY stage, role, category) AS incidents
`;
