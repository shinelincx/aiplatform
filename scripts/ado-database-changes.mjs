const databasePath = /(?:^|[/._-])(?:database|migrate|migrations?|postgres(?:ql)?|schema|seeds?|prisma)(?=[/._-]|$)|\.(?:sql|psql)$|^apps\/api\/src\/project-isolation\.ts$|^scripts\/compose-backup\.sh$/i;
const databaseAccess = /\b(?:db|database|pool|client)\s*\.\s*(?:query|projectQuery|transaction|projectTransaction|connect)\s*\(|\b(?:DATABASE_URL|POSTGRES_[A-Z_]+|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|ADO_DATABASE_[A-Z_]+)\b|["'](?:pg(?:-[\w-]+)?|postgres(?:ql)?|@prisma\/client|prisma)["']\s*:/;
const sql = /\b(?:SELECT\b[^\n;]*\bFROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?\S+|(?:CREATE|ALTER|DROP)\s+(?:TABLE|SCHEMA|INDEX|DATABASE|ROLE|POLICY|VIEW|FUNCTION|TRIGGER|EXTENSION)|(?:GRANT|REVOKE)\b[^\n;]*\b(?:ON|TO|FROM)|pg_advisory_\w+|postgres(?:ql)?:\/\/)\b/i;
const media = /\.(?:png|jpe?g|webp|gif|ico|avif|woff2?|ttf)$/i;

export function databaseReviewReasons(files) {
  return files.flatMap(({ filename, previous_filename: previous, patch, changes }) => {
    const paths = previous ? [filename, previous] : [filename];
    if (paths.some((path) => databasePath.test(path))) return [{ filename, reason: 'database path' }];
    if (!patch && changes === 0 && paths.every((path) => media.test(path))) return [];
    if (!patch || patch.split('\n').filter((line) => /^[+-]/.test(line)).length !== changes) {
      return [{ filename, reason: 'diff could not be fully checked' }];
    }
    if (/\.mdx?$/i.test(filename)) return [];
    // ponytail: scan diff context for SQL and DB clients. A static scan cannot infer arbitrary indirect database effects.
    if (databaseAccess.test(patch) || sql.test(patch)) return [{ filename, reason: 'database operation or configuration' }];
    return [];
  });
}
