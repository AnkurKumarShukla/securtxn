-- Re-assert Row Level Security across the public schema (D46).
--
-- The RLS migrations loop over pg_tables AS THEY RUN, so each covers only the
-- tables existing at that moment. The settlement, securities and evidence-anchor
-- tables were created by migrations that landed afterwards, leaving them exposed
-- to PostgREST under the browser-shipped publishable key.
--
-- That is not cosmetic here: HtlcSettlement holds preimage custody and
-- EvidenceAnchor holds the Merkle roots the audit trail rests on. A writable
-- anchor row lets someone claim a batch was committed that never was.
--
-- Idempotent for tables already enabled, so this is the pattern to repeat after
-- any migration that adds a table.
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
