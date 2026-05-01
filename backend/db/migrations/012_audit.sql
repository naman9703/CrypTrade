-- Phase 1A — 012: append-only audit_log + triggers on all other public tables

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  row_id TEXT NOT NULL,
  user_id UUID REFERENCES users (id),
  old_data JSONB,
  new_data JSONB,
  ip_address INET,
  session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_table_row ON audit_log (table_name, row_id, created_at DESC);
CREATE INDEX idx_audit_user_time ON audit_log (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row_id TEXT;
  v_old JSONB;
  v_new JSONB;
  j JSONB;
BEGIN
  IF TG_TABLE_NAME = 'audit_log' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    j := to_jsonb(OLD);
    v_old := j;
    v_new := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    j := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
    v_new := j;
  ELSE
    j := to_jsonb(NEW);
    v_old := NULL;
    v_new := j;
  END IF;

  -- PK is usually `id` (UUID/bigserial); schema_migrations uses `version` (no id).
  v_row_id := COALESCE(j->>'id', j->>'version', j::text);

  INSERT INTO audit_log (table_name, operation, row_id, user_id, old_data, new_data)
  VALUES (TG_TABLE_NAME, TG_OP, v_row_id, NULL, v_old, v_new);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT IN ('audit_log', 'schema_migrations')
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_audit_%I ON public.%I',
      r.tbl,
      r.tbl
    );
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE PROCEDURE audit_trigger_func()',
      r.tbl,
      r.tbl
    );
  END LOOP;
END;
$$;
