create table public.tracked_repos (
  id         uuid     primary key default gen_random_uuid(),
  repo_name  text     not null,
  channel_id text     not null,
  created_at timestamptz default now()
);

-- Prevent duplicate (repo, channel) pairs and speed up lookups
create unique index tracked_repos_repo_channel_idx
  on public.tracked_repos (repo_name, channel_id);

-- Index for querying by repo_name (used on every GitHub webhook)
create index tracked_repos_repo_name_idx
  on public.tracked_repos (repo_name);
