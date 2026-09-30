-- Least-privilege login for the API in the local Docker Compose stack (docker-compose.yml runs this after every
-- `migrate deploy`, as the schema owner). Idempotent. The password is local-only, like the database's own.
-- One transaction, so the API never sees the moment between REVOKE and GRANT.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'payments_app') THEN
    CREATE ROLE payments_app LOGIN PASSWORD 'payments_app';
  END IF;
END
$$;

-- Start from nothing on every run, so a schema or table privilege granted by hand to payments_app never lingers.
REVOKE ALL ON SCHEMA public FROM payments_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM payments_app;
GRANT USAGE ON SCHEMA public TO payments_app;
-- No DELETE: payments are never removed by the API.
GRANT SELECT, INSERT, UPDATE ON TABLE payments TO payments_app;
-- Append-only evidence: INSERT ... ON CONFLICT DO NOTHING needs INSERT alone.
GRANT INSERT ON TABLE provider_anomalies TO payments_app;

COMMIT;
