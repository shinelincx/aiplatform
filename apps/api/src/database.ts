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
