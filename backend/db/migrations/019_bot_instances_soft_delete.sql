-- Phase 3C: soft-delete instances (capital released + row retained for history)

ALTER TABLE bot_instances
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bot_instances_account_not_deleted
  ON bot_instances (account_id)
  WHERE is_deleted = false;
