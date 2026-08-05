-- In-flight claim for meeting briefing: prevents the 06:45 recheck (or any
-- concurrent run) from double-briefing a meeting the 05:00 run is still working on.
alter table meetings add column if not exists briefing_started_at timestamptz;
