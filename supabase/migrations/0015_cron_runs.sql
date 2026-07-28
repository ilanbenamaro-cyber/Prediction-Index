-- 0015_cron_runs.sql — a permanent ledger of every snapshot cron invocation
-- (fix/resolved-transition-settled-truth, Part 2).
--
-- Why this exists: app/api/snapshot (the daily history cron) already computes a `summary`
-- (total/skipped_already/skipped_resolved/success/failed/failures/backfill_retried) and logs it via
-- console.log — but Vercel deployment logs roll off and are not queryable history. This table
-- stores that SAME summary permanently, one row per invocation, so "did the cron run today, and did
-- it silently degrade" is an auditable SQL query, not an archaeology exercise through log retention.
-- Insert-only (a run's summary never changes after the fact); no table it writes to is touched by
-- any compute/serve path — purely additive observability. Reversible via 0015_cron_runs_down.sql.
--
-- RLS MODEL — deliberately MIRRORS market_history (0006): RLS enabled, NO policies = deny-all to
-- anon/authenticated. The ONLY reader/writer is the SERVICE ROLE (the snapshot route's own client).
-- We do NOT add an authenticated-SELECT policy: no other cache/ledger table has one, and adding a
-- client-readable path here would be a new, untested RLS surface for what is purely an operator
-- diagnostic table.

create table if not exists public.cron_runs (
  id                 bigint generated always as identity primary key,
  started_at         timestamptz not null,             -- when THIS invocation began
  run_date           date not null,                     -- UTC date of the run (matches summary.date)
  snapshot_hour      smallint not null,                 -- UTC hour of the run (02 off-peak / 18 US-peak)
  total              int not null,                       -- watched markets considered
  skipped_already    int not null,                       -- already snapshotted this hour-slot (dedup)
  skipped_resolved   int not null,                       -- RESOLVED — frozen, no new datapoint
  success            int not null,                       -- history rows successfully written
  failed             int not null,                       -- markets that errored this run
  failures           jsonb not null default '[]',        -- [{ id, error }] — per-market failure detail
  backfill_retried   jsonb not null default '[]',        -- market_ids the run re-fired /api/backfill for
  created_at         timestamptz not null default now()
);

-- Runs are always queried "most recent N", or "runs for this UTC date".
create index if not exists cron_runs_run_date_idx
  on public.cron_runs (run_date desc, started_at desc);

-- Lock down: RLS on, NO policies → anon/authenticated denied; service_role bypasses RLS
-- (same posture as public.market_history / public.market_snapshots).
alter table public.cron_runs enable row level security;
