-- Per-partner Google OAuth (replaces the need for domain-wide delegation).
-- The refresh token is readable only via the service-role key: RLS is enabled
-- on partners with no policies, so anon/authenticated roles see nothing.
alter table partners
  add column if not exists google_refresh_token text;
