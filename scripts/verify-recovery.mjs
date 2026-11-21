import assert from 'node:assert/strict';
import process from 'node:process';
import pg from 'pg';
import { ArtifactStore } from '../apps/api/src/artifacts.ts';

const fixtureDatabasePassword = process.env.ADO_VERIFY_MIGRATION_PASSWORD;
assert(fixtureDatabasePassword, 'Provide the migration password of the isolated restore fixture');
const db = new pg.Pool({ user: 'ado', password: fixtureDatabasePassword, options: '-c default_transaction_read_only=on' });
const store = new ArtifactStore();
try {
  const { rows: artifacts } = await db.query(
    `SELECT a.sha256, a.size, a.object_key AS key
     FROM execution_artifacts a JOIN execution_qa q ON q.run_id = a.run_id AND q.patch_hash = a.sha256
     JOIN execution_runs r ON r.id = a.run_id JOIN tasks t ON t.id = r.task_id
     WHERE q.state = 'completed' AND t.status = 'REVIEW'`,
  );
  assert(artifacts.length > 0, 'Expected the completed QA fixture in the restored database');
  for (const artifact of artifacts) {
    const content = await store.get(artifact);
    assert.equal(content.length, artifact.size);
  }
  process.stdout.write(`Recovered ${artifacts.length} verified patch artifact(s) from PostgreSQL and object storage.\n`);
} finally {
  await db.end();
}
