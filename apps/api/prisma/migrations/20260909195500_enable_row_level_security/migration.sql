-- Enable Row Level Security on every table in the public schema (D46).
--
-- WHY THIS IS A MIGRATION AND NOT A CONSOLE ACTION: D46 was applied by hand
-- against the live project, which left a fresh database provisioning itself
-- WITHOUT it. Supabase auto-exposes every public table over PostgREST using a
-- key whose whole purpose is to be shipped to browsers; before D46 that key
-- could read every table and, worse, PATCH and DELETE them — confirming an
-- arbitrary wallet or destroying the evidence chain. Every access control in
-- this codebase assumes Prisma-over-direct-Postgres is the only path to the
-- data, and PostgREST is a second door that answers to none of it.
--
-- Deliberately ENABLE and not FORCE: the table owner stays exempt, so Prisma's
-- connection is untouched. No policies are created, so the anon/authenticated
-- roles PostgREST uses are denied by default.
--
-- Written as a loop over the catalog rather than a fixed list of tables so a
-- table added later cannot silently miss it — which is exactly how
-- VendorMatchRequest would have been left open.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$;
