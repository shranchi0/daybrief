-- M1 nightly pipeline additions.

alter table partners
  add column if not exists timezone text not null default 'America/Los_Angeles',
  add column if not exists slack_user_id text,
  add column if not exists active boolean not null default true;

alter table meetings
  add column if not exists raw_event jsonb,
  add column if not exists resolved_domain text,
  add column if not exists resolution_confidence text check (resolution_confidence in ('high','medium','low','unresolved')),
  add column if not exists brief_artifact_id uuid references artifacts(id),
  add column if not exists meeting_date date;

create index if not exists meetings_partner_date_idx on meetings (partner_id, meeting_date);

-- Seed the first partner (idempotent).
insert into partners (email, name)
  values ('shri@categoryvc.com', 'Shri Kolanukuduru')
  on conflict (email) do nothing;
