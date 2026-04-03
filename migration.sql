-- Rename legacy `login_sessions` → `auth_tokens` when upgrading; no-op if already migrated.
DO $$
BEGIN
  IF to_regclass('public.login_sessions') IS NOT NULL AND to_regclass('public.auth_tokens') IS NULL THEN
    ALTER TABLE "login_sessions" RENAME TO "auth_tokens";
  END IF;
END
$$;
