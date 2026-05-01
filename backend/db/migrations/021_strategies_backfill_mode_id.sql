-- Strategies created before 018_strategy_mode.sql may have mode_id NULL.
-- listStrategies filters with `AND tm.slug = $modeSlug`, which excludes those rows
-- (LEFT JOIN trading_modes yields NULL slug). Backfill so per-mode API returns them.

UPDATE strategies s
SET mode_id = (
  SELECT tm.id
  FROM trading_modes tm
  WHERE tm.slug = ANY (COALESCE(s.tags, ARRAY[]::text[]))
  ORDER BY tm.id
  LIMIT 1
)
WHERE s.mode_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM trading_modes tm2
    WHERE tm2.slug = ANY (COALESCE(s.tags, ARRAY[]::text[]))
  );

UPDATE strategies s
SET mode_id = (SELECT id FROM trading_modes WHERE slug = 'paper' LIMIT 1)
WHERE s.mode_id IS NULL;
