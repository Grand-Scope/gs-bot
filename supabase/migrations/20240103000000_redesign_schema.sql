-- Drop old tables
DROP TABLE IF EXISTS tracked_orgs;
DROP TABLE IF EXISTS tracked_repos;

-- New repo-level tracking table
CREATE TABLE tracked_repos (
  id         bigint generated always as identity primary key,
  org_name   text        not null,
  repo_full_name text    not null,
  channel_id text        not null,
  created_at timestamptz not null default now()
);

CREATE UNIQUE INDEX tracked_repos_repo_channel_idx ON tracked_repos (repo_full_name, channel_id);
CREATE INDEX tracked_repos_repo_full_name_idx      ON tracked_repos (repo_full_name);
CREATE INDEX tracked_repos_org_name_idx            ON tracked_repos (org_name);
