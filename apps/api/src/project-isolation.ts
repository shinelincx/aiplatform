// V20. Keep these selectors in the migration so the metadata access is reviewable.
// A selector only returns routing IDs. Business reads and writes use the selected project.
export const projectIsolation = `
  CREATE SCHEMA ado_private;
  REVOKE ALL ON SCHEMA ado_private FROM PUBLIC;

  CREATE FUNCTION ado_private.project_scope() RETURNS uuid
    LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
      SELECT CASE WHEN pg_input_is_valid(current_setting('ado.project_id', true), 'uuid')
        THEN current_setting('ado.project_id', true)::uuid END
    $$;

  DO $$
  DECLARE relation text;
  BEGIN
    FOREACH relation IN ARRAY ARRAY[
      'project_members', 'audit_logs', 'repositories', 'tasks', 'task_dependencies', 'task_events',
      'worker_projects', 'execution_runs', 'project_agent_settings', 'project_agent_versions',
      'project_skills', 'project_skill_versions', 'task_agent_plans', 'project_requirements',
      'project_model_rates', 'project_knowledge', 'project_knowledge_versions'
    ] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation);
      EXECUTE format('CREATE POLICY project_scope ON public.%I USING (project_id = ado_private.project_scope())', relation);
    END LOOP;
    FOREACH relation IN ARRAY ARRAY[
      'execution_events', 'execution_reviews', 'execution_artifacts', 'execution_deliveries', 'execution_qa'
    ] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation);
      EXECUTE format('CREATE POLICY project_scope ON public.%1$I USING (
        EXISTS (SELECT 1 FROM public.execution_runs r WHERE r.id = %1$I.run_id AND r.project_id = ado_private.project_scope())
      )', relation);
    END LOOP;
  END
  $$;

  ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
  CREATE POLICY project_scope ON public.projects USING (id = ado_private.project_scope());
  CREATE POLICY platform_audit_write ON public.audit_logs FOR INSERT WITH CHECK (
    project_id IS NULL AND actor_id::text = current_setting('ado.audit_admin', true)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = actor_id AND u.system_role = 'admin' AND u.status = 'active')
  );

  CREATE FUNCTION ado_private.member_projects(account_id uuid, project uuid)
    RETURNS TABLE (id uuid, code varchar, name varchar, description text, status text, role text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT p.id, p.code, p.name, p.description, p.status, m.role
      FROM public.projects p JOIN public.project_members m ON m.project_id = p.id
      WHERE m.user_id = account_id AND (project IS NULL OR p.id = project)
      ORDER BY p.status, p.code
    $$;

  CREATE FUNCTION ado_private.worker_has_active_project(worker uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT EXISTS (SELECT 1 FROM public.worker_projects wp JOIN public.projects p ON p.id = wp.project_id
        WHERE wp.worker_id = worker AND p.status = 'active')
    $$;

  CREATE FUNCTION ado_private.worker_run_project(worker uuid, credential text, run uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT r.project_id FROM public.execution_runs r JOIN public.workers w ON w.id = r.worker_id
      WHERE r.id = run AND w.id = worker AND w.credential_hash = credential
        AND w.credential_expires_at > now() AND NOT w.disabled
    $$;

  CREATE FUNCTION ado_private.worker_candidate(worker uuid, credential text, connection uuid)
    RETURNS TABLE (id uuid, project_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT r.id, r.project_id FROM public.execution_runs r
      JOIN public.worker_projects wp ON wp.project_id = r.project_id AND wp.worker_id = worker
      JOIN public.workers w ON w.id = wp.worker_id
      JOIN public.projects p ON p.id = r.project_id AND p.status = 'active'
      JOIN public.tasks t ON t.id = r.task_id AND t.status = 'QUEUED'
      JOIN public.repositories g ON g.id = r.repository_id
      WHERE r.status = 'queued' AND NOT r.cancel_requested
        AND w.credential_hash = credential AND w.connection_id = connection
        AND w.credential_expires_at > now() AND NOT w.disabled
        AND NOT EXISTS (SELECT 1 FROM public.execution_runs x WHERE x.worker_id = worker AND x.status = 'running')
        AND (r.requested_worker_id IS NULL OR r.requested_worker_id = w.id)
        AND (r.developer_assignment->>'revision' IS NULL OR w.capabilities->'revisionArtifactVersion' = '1'::jsonb)
        AND (jsonb_array_length(r.check_plan) = 0 OR (
          w.capabilities->'verificationVersion' = '1'::jsonb
          AND ((r.qa_assignment IS NULL AND NOT g.auto_draft_pr AND jsonb_array_length(r.independent_checks) = 0)
            OR w.capabilities->'artifactVersion' = '1'::jsonb)
          AND (w.capabilities @> '{"mavenVerification":true}'::jsonb
            OR NOT jsonb_path_exists(r.check_plan, '$[*].argv[0] ? (@ == "mvn")'))
        ))
      ORDER BY t.priority, r.created_at, r.id LIMIT 1 FOR UPDATE OF p, r SKIP LOCKED
    $$;

  CREATE FUNCTION ado_private.expired_execution() RETURNS TABLE (id uuid, project_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT r.id, r.project_id FROM public.execution_runs r
      WHERE r.status = 'running' AND r.lease_expires_at <= now()
      LIMIT 1 FOR UPDATE OF r SKIP LOCKED
    $$;

  CREATE FUNCTION ado_private.planning_candidate() RETURNS TABLE (id uuid, project_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT a.task_id, a.project_id FROM public.task_agent_plans a
      JOIN public.projects p ON p.id = a.project_id AND p.status = 'active'
      WHERE a.state = 'queued' OR (a.state = 'running' AND a.lease_expires_at < now())
      ORDER BY a.updated_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED
    $$;

  CREATE FUNCTION ado_private.qa_candidate() RETURNS TABLE (id uuid, project_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT q.run_id, r.project_id FROM public.execution_qa q JOIN public.execution_runs r ON r.id = q.run_id
      JOIN public.projects p ON p.id = r.project_id AND p.status = 'active'
      JOIN public.tasks t ON t.id = r.task_id AND t.status = 'TESTING'
      JOIN public.execution_artifacts a ON a.run_id = q.run_id AND a.sha256 = q.patch_hash
      WHERE q.state = 'queued' OR (q.state = 'running' AND q.lease_expires_at < now())
      ORDER BY q.updated_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED
    $$;

  CREATE FUNCTION ado_private.delivery_candidate() RETURNS TABLE (id uuid, project_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT d.run_id, r.project_id FROM public.execution_deliveries d JOIN public.execution_runs r ON r.id = d.run_id
      JOIN public.projects p ON p.id = r.project_id AND p.status = 'active'
      JOIN public.tasks t ON t.id = r.task_id AND t.status = 'REVIEW'
      JOIN public.repositories g ON g.id = d.repository_id AND g.project_id = r.project_id
      JOIN public.execution_reviews h ON h.run_id = r.id AND h.decision = 'approved'
      JOIN public.execution_artifacts a ON a.run_id = r.id AND a.sha256 = d.patch_hash
      WHERE (d.state = 'queued' OR (d.state = 'publishing' AND d.lease_expires_at < now()))
        AND EXISTS (SELECT 1 FROM public.execution_events e
          WHERE e.run_id = r.id AND e.kind = 'result' AND e.payload->>'patchHash' = d.patch_hash)
      ORDER BY d.updated_at, d.run_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED
    $$;

  CREATE FUNCTION ado_private.webhook_project(repository bigint, installation bigint) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      SELECT g.project_id FROM public.repositories g
      WHERE g.github_repository_id = repository AND g.installation_id = installation
    $$;

  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ado_private FROM PUBLIC;
`;

// Reapply after a restore that deliberately omits cluster roles and ACLs.
export const runtimePermissions = `
  DROP POLICY IF EXISTS self_service_audit_write ON public.audit_logs;
  CREATE POLICY self_service_audit_write ON public.audit_logs FOR INSERT WITH CHECK (
    current_user = 'ado_api'
    AND project_id IS NULL AND actor_id = resource_id AND actor_id::text = current_setting('ado.audit_account', true)
    AND action IN ('user.profile_updated', 'user.password_changed')
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = actor_id AND u.status = 'active')
  );
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON SCHEMA ado_private FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ado_private FROM PUBLIC, ado_api;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ado_api;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ado_api;
  GRANT USAGE ON SCHEMA public, ado_private TO ado_api;
  GRANT EXECUTE ON FUNCTION ado_private.project_scope(), ado_private.member_projects(uuid, uuid),
    ado_private.worker_has_active_project(uuid), ado_private.worker_run_project(uuid, text, uuid),
    ado_private.worker_candidate(uuid, text, uuid), ado_private.expired_execution(), ado_private.planning_candidate(),
    ado_private.qa_candidate(), ado_private.delivery_candidate(), ado_private.auto_approval_candidate(), ado_private.webhook_project(bigint, bigint) TO ado_api;
  GRANT SELECT ON public.schema_migrations TO ado_api;
  GRANT SELECT, INSERT ON public.staging_releases TO ado_api;
  GRANT UPDATE (state, decided_by_id, decided_by, decided_at, note, deployment_run, deployment_attempt)
    ON public.staging_releases TO ado_api;
  GRANT SELECT, INSERT ON public.users, public.audit_logs, public.task_events, public.project_agent_versions,
    public.execution_events, public.execution_reviews, public.execution_artifacts, public.github_webhook_deliveries TO ado_api;
  GRANT UPDATE (name, password_hash, system_role, status, updated_at) ON public.users TO ado_api;
  GRANT SELECT, INSERT, UPDATE ON public.projects, public.repositories, public.tasks, public.workers,
    public.execution_runs, public.execution_deliveries, public.project_agent_settings, public.project_skills,
    public.project_skill_versions, public.task_agent_plans, public.execution_qa, public.project_requirements,
    public.project_model_rates, public.project_knowledge, public.project_knowledge_versions TO ado_api;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_members, public.worker_projects, public.task_dependencies TO ado_api;
  GRANT SELECT, INSERT, DELETE ON public.sessions TO ado_api;
  GRANT SELECT, INSERT ON public.project_model_rate_versions TO ado_api;
  GRANT SELECT, INSERT, UPDATE ON public.project_monthly_budgets TO ado_api;
`;
