export const knowledgeKinds = ['project_document', 'design_rule'] as const;
export const maxPlanKnowledgeVersions = 8;
export type KnowledgeKind = typeof knowledgeKinds[number];

export interface KnowledgeSnapshot {
  id: string;
  entryId: string;
  version: number;
  kind: KnowledgeKind;
  title: string;
  excerpt: string;
  sourceUrl: string;
  sourceRevision: string;
  excerptHash: string;
}

export interface DesignEvidence {
  repositoryId: string;
  repositoryUrl: string;
  implementationCommit: string;
  reportUrl: string;
  archive?: { taskId: string; runId: string; patchHash: string };
}

export interface KnowledgeVersion extends KnowledgeSnapshot {
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
  decidedAt: string | null;
  designEvidence: DesignEvidence | null;
  versionNote: string;
}

export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  title: string;
  activeVersionId: string | null;
  version: number;
  matchedVersionId: string;
}
