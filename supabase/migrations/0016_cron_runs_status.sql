-- 0016_cron_runs_status.sql — cron_runs gains a lifecycle status (fix/cron-batch-ledger, INC 7).
--
-- Why this exists: app/api/snapshot's cron_runs row (0015) was written ONLY at the end of the
-- batch — a Vercel hard kill at maxDuration (no graceful-shutdown hook, doc-confirmed) lost the
-- tail of the run AND the ledger row itself, silently: no trace a run even started. The batch
-- orchestration (lib/cron-batch.mjs runSnapshotBatch) now inserts the ledger row FIRST, before
-- any market is served, and updates it at the end — these two columns carry that lifecycle.
--
-- status: 'started' at insert time; flipped by the final update to 'completed' (every dispatched
-- market served, or skipped as already-snapshotted/resolved) or 'truncated' (the soft time budget
-- stopped dispatching new work before the list was exhausted — see failures[] for which ids were
-- skipped, marker 'skipped: soft budget exhausted'). A row that STAYS 'started' is the signature
-- of a hard kill: the process died before its own final update ran. Pre-existing rows default
-- 'completed' — truthful, since every row before this migration only ever landed via the OLD
-- end-of-run insert (it could not exist unless the run that wrote it completed).
--
-- completed_at: when the final update landed; null while status='started'.
--
-- Reversible via 0016_cron_runs_status_down.sql. DO NOT APPLY without operator go-ahead.

alter table public.cron_runs add column if not exists status text not null default 'completed';
alter table public.cron_runs add column if not exists completed_at timestamptz;
