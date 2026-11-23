import { deepStrictEqual } from 'node:assert';
import { test } from 'vitest';
import { databaseReviewReasons } from './ado-database-changes.mjs';

test('holds database changes and allows unrelated additions, deletions and assets', () => {
  const changes = [
    { filename: 'apps/web/app/settings/status.tsx', patch: '+export const status = "ready";', changes: 1 },
    { filename: 'apps/web/app/legacy-banner.tsx', patch: '-export const text = "legacy";', changes: 1 },
    { filename: 'apps/web/public/logo.png', changes: 0 },
    { filename: 'apps/api/src/auth.ts', patch: "+await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);", changes: 1 },
    { filename: 'apps/api/src/project-isolation.ts', patch: '+GRANT UPDATE (system_role) ON public.users TO ado_api;', changes: 1 },
    { filename: 'scripts/old-name.txt', previous_filename: 'migrations/010.sql', changes: 0 },
    { filename: 'compose.yaml', patch: '  POSTGRES_PASSWORD: local\n-  PGPORT: 5432\n+  PGPORT: 5433', changes: 2 },
    { filename: 'apps/api/src/large-diff.ts', patch: '+const x = 1;', changes: 3 },
  ];
  deepStrictEqual(databaseReviewReasons(changes), [
    { filename: 'apps/api/src/auth.ts', reason: 'database operation or configuration' },
    { filename: 'apps/api/src/project-isolation.ts', reason: 'database path' },
    { filename: 'scripts/old-name.txt', reason: 'database path' },
    { filename: 'compose.yaml', reason: 'database operation or configuration' },
    { filename: 'apps/api/src/large-diff.ts', reason: 'diff could not be fully checked' },
  ]);
});
