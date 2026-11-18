import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

const migrations = [
  `CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar(255) NOT NULL UNIQUE,
    name varchar(100) NOT NULL,
    password_hash text NOT NULL,
    system_role text NOT NULL CHECK (system_role IN ('admin', 'user')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX sessions_user_id ON sessions (user_id);
  CREATE INDEX sessions_expires_at ON sessions (expires_at);
  CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code varchar(50) NOT NULL UNIQUE,
    name varchar(200) NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    settings jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE project_members (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX project_members_user_id ON project_members (user_id, project_id);
  CREATE TABLE audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid REFERENCES projects(id),
    actor_id uuid NOT NULL REFERENCES users(id),
    action text NOT NULL,
    resource_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX audit_logs_project ON audit_logs (project_id, created_at);`,
  `CREATE TABLE repositories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    github_repository_id bigint NOT NULL UNIQUE,
    owner varchar(100) NOT NULL,
    repo_name varchar(150) NOT NULL,
    repository_url text NOT NULL,
    default_branch varchar(255) NOT NULL,
    installation_id bigint NOT NULL,
    UNIQUE (project_id, github_repository_id)
  );`,
  `ALTER TABLE repositories ADD UNIQUE (project_id, id);
  CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id),
    repository_id uuid,
    parent_task_id uuid,
    task_code varchar(50) NOT NULL,
    title varchar(255) NOT NULL,
    description text NOT NULL,
    priority text NOT NULL CHECK (priority IN ('P0', 'P1', 'P2')),
    status text NOT NULL DEFAULT 'CREATED' CHECK (status IN (
      'CREATED','PLANNING','WAITING_APPROVAL','READY','QUEUED','RUNNING','TESTING',
      'REVIEW','MERGED','COMPLETED','BLOCKED','FAILED','TIMEOUT','CANCELLED','REJECTED','RETRYING'
    )),
    acceptance_criteria jsonb NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (project_id, task_code),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, repository_id) REFERENCES repositories(project_id, id),
    FOREIGN KEY (project_id, parent_task_id) REFERENCES tasks(project_id, id)
  );
  CREATE INDEX tasks_project_status ON tasks (project_id, status);
  CREATE TABLE task_dependencies (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    depends_on_task_id uuid NOT NULL CHECK (depends_on_task_id <> task_id),
    PRIMARY KEY (project_id, task_id, depends_on_task_id),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
    FOREIGN KEY (project_id, depends_on_task_id) REFERENCES tasks(project_id, id)
  );
  CREATE TABLE task_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    event_type varchar(80) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id)
  );
  CREATE INDEX task_events_task ON task_events (project_id, task_id, id);`,
  `CREATE TABLE workers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(100) NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    credential_hash text NOT NULL UNIQUE,
    credential_expires_at timestamptz NOT NULL,
    disabled boolean NOT NULL DEFAULT false,
    capabilities jsonb,
    connection_id uuid,
    last_heartbeat_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE worker_projects (
    worker_id uuid NOT NULL REFERENCES workers(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    PRIMARY KEY (worker_id, project_id)
  );
  CREATE INDEX worker_projects_project_id ON worker_projects (project_id, worker_id);`,
  `CREATE TABLE execution_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    worker_id uuid REFERENCES workers(id),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out')),
    cancel_requested boolean NOT NULL DEFAULT false,
    lease_expires_at timestamptz,
    thread_id text,
    last_sequence integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
    FOREIGN KEY (project_id, repository_id) REFERENCES repositories(project_id, id)
  );
  CREATE UNIQUE INDEX execution_active_task ON execution_runs (task_id) WHERE status IN ('queued', 'running');
  CREATE UNIQUE INDEX execution_active_worker ON execution_runs (worker_id) WHERE status = 'running';
  CREATE INDEX execution_queue ON execution_runs (project_id, status, created_at);
  CREATE TABLE execution_events (
    run_id uuid NOT NULL REFERENCES execution_runs(id),
    sequence integer NOT NULL CHECK (sequence > 0),
    kind text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, sequence)
  );`,
  `ALTER TABLE repositories ADD COLUMN check_plan jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE execution_runs ADD COLUMN check_plan jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN candidate_hash text, ADD COLUMN verification_report jsonb;
  CREATE TABLE execution_reviews (
    run_id uuid PRIMARY KEY REFERENCES execution_runs(id),
    reviewer_id uuid NOT NULL REFERENCES users(id),
    reviewer_name text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
    comment text NOT NULL,
    reviewed_at timestamptz NOT NULL DEFAULT now()
  );`,
  `ALTER TABLE execution_runs ADD COLUMN source_branch text, ADD COLUMN archive_patch boolean NOT NULL DEFAULT false;
  CREATE TABLE execution_artifacts (
    run_id uuid NOT NULL REFERENCES execution_runs(id),
    sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size integer NOT NULL CHECK (size > 0 AND size <= 16777216),
    object_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, sha256)
  );
  CREATE TABLE execution_deliveries (
    run_id uuid PRIMARY KEY REFERENCES execution_runs(id),
    repository_id uuid NOT NULL REFERENCES repositories(id),
    requested_by uuid NOT NULL REFERENCES users(id),
    patch_hash varchar(64) NOT NULL,
    base_commit varchar(40) NOT NULL,
    base_branch text NOT NULL,
    branch text NOT NULL,
    state text NOT NULL CHECK (state IN ('queued', 'publishing', 'published', 'failed')),
    pull_number integer,
    pull_url text,
    pull_state text CHECK (pull_state IN ('open', 'closed', 'merged', 'changed')),
    commit_sha varchar(40),
    error text,
    lease_id uuid,
    lease_expires_at timestamptz,
    github_updated_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (run_id, patch_hash) REFERENCES execution_artifacts(run_id, sha256),
    UNIQUE (repository_id, branch),
    UNIQUE (repository_id, pull_number)
  );
  CREATE INDEX execution_delivery_queue ON execution_deliveries (state, updated_at);
  CREATE TABLE github_webhook_deliveries (
    id uuid PRIMARY KEY,
    received_at timestamptz NOT NULL DEFAULT now()
  );`,
  `CREATE TABLE project_agent_settings (
    project_id uuid NOT NULL REFERENCES projects(id),
    role text NOT NULL CHECK (role IN ('PROJECT_DIRECTOR','PRODUCT_MANAGER','ARCHITECT','UI_UX_DESIGNER',
      'FRONTEND_DEVELOPER','BACKEND_DEVELOPER','QA_ENGINEER','RELEASE_ENGINEER')),
    enabled boolean NOT NULL,
    active_version integer NOT NULL CHECK (active_version > 0),
    PRIMARY KEY (project_id, role)
  );
  CREATE TABLE project_agent_versions (
    project_id uuid NOT NULL,
    role text NOT NULL,
    version integer NOT NULL CHECK (version > 1),
    model varchar(100) NOT NULL,
    instructions text NOT NULL,
    skills jsonb NOT NULL,
    PRIMARY KEY (project_id, role, version),
    FOREIGN KEY (project_id, role) REFERENCES project_agent_settings(project_id, role)
  );
  CREATE TABLE project_skills (
    project_id uuid NOT NULL REFERENCES projects(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name varchar(100) NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    PRIMARY KEY (project_id, id),
    UNIQUE (project_id, name)
  );
  CREATE TABLE project_skill_versions (
    project_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    instructions text NOT NULL,
    PRIMARY KEY (project_id, skill_id, version),
    FOREIGN KEY (project_id, skill_id) REFERENCES project_skills(project_id, id)
  );
  CREATE TABLE task_agent_plans (
    task_id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','running','failed','completed','cancelled')),
    input jsonb NOT NULL,
    assignments jsonb NOT NULL,
    steps jsonb NOT NULL DEFAULT '[]',
    lease_id uuid,
    lease_expires_at timestamptz,
    error text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id)
  );
  CREATE INDEX task_agent_plan_queue ON task_agent_plans (state, updated_at);
  ALTER TABLE execution_runs ADD COLUMN developer_assignment jsonb;`,
  `ALTER TABLE execution_runs ADD COLUMN qa_assignment jsonb;
  CREATE TABLE execution_qa (
    run_id uuid PRIMARY KEY REFERENCES execution_runs(id),
    patch_hash varchar(64) NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','running','failed','completed','cancelled')),
    assessment jsonb,
    partial_patch boolean NOT NULL DEFAULT false,
    lease_id uuid,
    lease_expires_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (run_id, patch_hash) REFERENCES execution_artifacts(run_id, sha256)
  );
  CREATE INDEX execution_qa_queue ON execution_qa (state, updated_at);`,
];

@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? '15432'),
    database: process.env.PGDATABASE ?? 'ado',
    user: process.env.PGUSER ?? 'ado',
    password: process.env.PGPASSWORD,
    connectionTimeoutMillis: 5000,
  });

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleInit() {
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(17430)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)');
      const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map(({ version }) => version));
      for (const [index, migration] of migrations.entries()) {
        if (applied.has(index + 1)) continue;
        await client.query(migration);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [index + 1]);
      }
    });
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}

export function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
