
export const stagingRepository = 'shinelincx/aiplatform';
export const stagingMigrationFiles = [
  'apps/api/src/database.ts', 'apps/api/src/migrate.ts', 'apps/api/src/project-isolation.ts',
] as const;
export type StagingReleaseState = 'pending' | 'approved' | 'rejected' | 'deploying' | 'succeeded' | 'failed';
export interface StagingRelease {
  sha: string;
  baseSha: string;
  image: string;
  sourceRun: string;
  pulls: number[];
  files: string[];
  state: StagingReleaseState;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  deploymentRun: string | null;
}

export type StagingReleaseStatus = Pick<StagingRelease, 'state' | 'decidedAt' | 'decidedBy' | 'deploymentRun'>;
