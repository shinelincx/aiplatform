// The ADO event timestamp is used only to count records without a provider time.
export const monthlyUsage = `
  WITH month AS (
    SELECT COALESCE(($2::text || '-01')::date, date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS starts
  ), readings AS (
    SELECT e.created_at, e.payload->'usage' AS usage,
      CASE WHEN e.payload->'usage'->>'providerCreatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
        AND pg_input_is_valid(e.payload->'usage'->>'providerCreatedAt','timestamp with time zone')
        THEN (e.payload->'usage'->>'providerCreatedAt')::timestamptz END AS provider_at
    FROM task_events e WHERE e.project_id=$1 AND e.event_type='agent.model_usage'
  ), priced AS (
    SELECT u.provider_at, CASE
      WHEN rate.source_url IS NOT NULL AND u.usage->>'serviceTier' = 'default'
        AND tokens.inputs >= tokens.cached AND tokens.cached >= 0 AND tokens.outputs >= 0
        AND (u.usage->>'model' NOT IN ('gpt-6.1-terra','gpt-6.2-sol') OR tokens.inputs <= 272000)
      THEN ((tokens.inputs-tokens.cached)*rate.input_usd + tokens.cached*rate.cached_input_usd
        + tokens.outputs*rate.output_usd)/1000000 END AS usd
    FROM readings u CROSS JOIN month m
    CROSS JOIN LATERAL (
      SELECT CASE WHEN u.usage->>'inputTokens' ~ '^[0-9]{1,16}$' THEN (u.usage->>'inputTokens')::numeric END AS inputs,
        CASE WHEN u.usage->>'cachedInputTokens' ~ '^[0-9]{1,16}$' THEN (u.usage->>'cachedInputTokens')::numeric END AS cached,
        CASE WHEN u.usage->>'outputTokens' ~ '^[0-9]{1,16}$' THEN (u.usage->>'outputTokens')::numeric END AS outputs
    ) tokens
    LEFT JOIN LATERAL (
      SELECT input_usd, cached_input_usd, output_usd, source_url
      FROM project_model_rate_versions
      WHERE project_id=$1 AND model=u.usage->>'model' AND effective_at<=u.provider_at
      ORDER BY effective_at DESC, version DESC LIMIT 1
    ) rate ON true
    WHERE COALESCE(u.provider_at, u.created_at)>=m.starts::timestamp AT TIME ZONE 'UTC'
      AND COALESCE(u.provider_at, u.created_at)<(m.starts::timestamp+interval '1 month') AT TIME ZONE 'UTC'
  ), totals AS (
    SELECT count(*)::int AS records, count(usd)::int AS matched, sum(usd) AS total,
      count(*) FILTER (WHERE provider_at IS NULL)::int AS undated
    FROM priced
  )
  SELECT to_char(m.starts,'YYYY-MM') AS month, b.amount_usd::text AS "budgetUsd",
    round(t.total,12)::text AS "estimatedUsd", t.records, t.matched, t.undated,
    CASE WHEN b.amount_usd IS NULL THEN 'unset'
      WHEN t.total IS NULL THEN 'unknown'
      WHEN t.total>=b.amount_usd THEN 'reached'
      WHEN t.total>=b.amount_usd*0.8 THEN 'warning'
      ELSE 'below' END AS notice
  FROM month m CROSS JOIN totals t
  LEFT JOIN project_monthly_budgets b ON b.project_id=$1 AND b.month_start=m.starts
`;
