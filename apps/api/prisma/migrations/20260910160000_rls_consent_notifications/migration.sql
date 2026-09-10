-- Re-assert RLS across the public schema (D46).
--
-- PayeeConsent, Notification and IdentityBlock were created after the previous
-- RLS loops ran. PayeeConsent is the one that matters most: it holds the
-- signature that authorises a payment, and a writable consent row through the
-- browser-shipped key would let anyone manufacture the payee's agreement.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$;
