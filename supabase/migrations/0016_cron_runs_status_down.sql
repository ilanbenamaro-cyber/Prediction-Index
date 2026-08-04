-- 0016_cron_runs_status_down.sql — reverse 0016_cron_runs_status.sql.
alter table public.cron_runs drop column if exists completed_at;
alter table public.cron_runs drop column if exists status;
