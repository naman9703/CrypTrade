-- Phase 1A — 013: database roles (run as superuser / migration owner)
-- Optional: set SKIP_DB_ROLES=1 when running db:migrate.mjs to skip this file on hosts where you cannot CREATE ROLE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_role') THEN
    CREATE ROLE readonly_role NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_role;
GRANT USAGE ON SCHEMA public TO readonly_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_role;

REVOKE INSERT, UPDATE, DELETE ON TABLE audit_log FROM app_role;
GRANT INSERT ON TABLE audit_log TO app_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO readonly_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO readonly_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO readonly_role;

-- Production: create a login role and grant membership, e.g.:
-- CREATE ROLE trading_app LOGIN PASSWORD '...' IN ROLE app_role;
