-- Phase 1D minimal — per-user cosmetic UI preferences (theme, layout, etc.)

ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
