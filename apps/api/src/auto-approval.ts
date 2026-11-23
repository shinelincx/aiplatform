import type { AutoApprovalSettings } from '@ado/shared';

export const autoApprovalActor = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'ADO Auto Approval',
};

export const readAutoApproval = `
  SELECT COALESCE(settings->'autoApproval'->'READY' = 'true'::jsonb, false) AS "READY",
         COALESCE(settings->'autoApproval'->'REVIEW' = 'true'::jsonb, false) AS "REVIEW"
  FROM projects WHERE id = $1`;

export const defaultAutoApproval: AutoApprovalSettings = { READY: false, REVIEW: false };
