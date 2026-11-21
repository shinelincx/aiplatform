import { migrate } from './database';

void migrate(process.env.ADO_DATABASE_PASSWORD ?? '').catch((error: unknown) => {
  console.error('Database migration failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
