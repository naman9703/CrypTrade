-- Phase 2A — account flags + paper system account shape

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS requires_api BOOLEAN NOT NULL DEFAULT true;

UPDATE accounts a
SET
  account_type = 'system',
  requires_api = false,
  label = 'Paper Trading'
FROM trading_modes tm,
     users u
WHERE a.mode_id = tm.id
  AND a.user_id = u.id
  AND u.username = '_paper_system'
  AND tm.slug = 'paper';
