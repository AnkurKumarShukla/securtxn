-- Re-assert Row Level Security across the public schema (D46).
--
-- The earlier RLS migration loops over pg_tables AS IT RUNS, so it covers only
-- the tables that existed at that moment. WorldIdVerification was created after
-- it, and would otherwise sit exposed to PostgREST under the browser-shipped
-- publishable key — readable, and worse, writable. A forged row there is not
-- cosmetic: it is an enrollment, and an attacker who can insert one chooses
-- which World ID the continuity check compares against.
--
-- Running the same loop again is idempotent for tables already enabled, so this
-- doubles as the pattern to repeat after any migration that adds a table.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$;
