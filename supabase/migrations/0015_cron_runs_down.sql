-- 0015_cron_runs_down.sql — reverse 0015_cron_runs.sql.
drop index if exists public.cron_runs_run_date_idx;
drop table if exists public.cron_runs;
