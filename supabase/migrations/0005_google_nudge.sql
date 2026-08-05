-- Cooldown for reconnect-nudge DMs so unconnected partners aren't nagged twice
-- every weekday; claimed via conditional UPDATE (race-safe across the two crons).
alter table partners add column if not exists google_nudged_at timestamptz;
