create table public.tracked_orgs (
  id         uuid     primary key default gen_random_uuid(),
  org_name   text     not null,
  channel_id text     not null,
  created_at timestamptz default now()
);

-- Prevent duplicate (org, channel) pairs and speed up lookups
create unique index tracked_orgs_org_channel_idx
  on public.tracked_orgs (org_name, channel_id);

-- Index for querying by org_name (used on every GitHub webhook)
create index tracked_orgs_org_name_idx
  on public.tracked_orgs (org_name);
