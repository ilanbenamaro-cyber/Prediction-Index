// lib/cron-batch.mjs — the snapshot cron's batch orchestration, pure of I/O (deps injected).
//
// Why this exists (INC 7, fix/cron-batch-ledger): app/api/snapshot ran its serve loop serially
// under Vercel's maxDuration=60 with the cron_runs ledger row written ONLY at the end. A hard
// kill at the cap — Vercel gives no graceful-shutdown hook, doc-confirmed — silently lost the
// run's tail AND the ledger row itself: no trace a run even started. This module fixes both:
//   1. the ledger row lands BEFORE any market is served (a killed run leaves a 'started' row
//      behind, not nothing), and
//   2. a soft time budget stops DISPATCHING new work with margin before the hard cap, so the
//      final ledger update (status + completed_at) has time to land.
// Pure orchestration — same extraction precedent as lib/serve-market.mjs: every I/O call is
// injected via `deps`, so every branch (dedup, pool concurrency, budget truncation, ledger
// failure) is unit-tested deterministically with fakes — no DB, no network, no real clock.
//
// deps = {
//   serve(id) → { status, body }                — the serveMarket-shaped call for one market
//   writeHistory(id, record, hour)               — persist a successful serve's history row
//   marketsSnapshottedOn(date, hour, ids) → Set  — dedup guard (today's already-served ids)
//   insertLedgerStart(row) → ledgerId            — cron_runs INSERT, status='started'
//   updateLedgerFinal(ledgerId, patch)           — cron_runs UPDATE: counts + status + completed_at
//   marketsNeedingBackfill(ids) → ids[]          — markets whose backfill never completed
//   fireBackfill(id)                             — POST /api/backfill for one market_id
// }

// Each serve() internally bursts several upstream calls (midpoints+prices batches, plus a
// Promise.all last-trade fetch per leg) — effective upstream pressure is POOL_SIZE × that burst.
// 3 keeps worst-case pressure at roughly what a single large serve already proves tolerable in
// production; raising it is a one-constant change, with the ledger (status='truncated') watching
// for any budget fallout that surfaces.
export const POOL_SIZE = 3;

// The marker string a soft-budget skip writes into failures[] — greppable, and distinct from a
// real per-market serve error.
export const BUDGET_EXHAUSTED = 'skipped: soft budget exhausted';

const BACKFILL_RETRY_LIMIT = 10;

/**
 * Run one snapshot cron batch: start-row ledger insert → dedup → pooled serve → soft-budget
 * truncation → backfill fan-out (only if budget remains) → final ledger update. Returns the same
 * summary shape app/api/snapshot has always logged/returned, plus `status`.
 * @param {{ids:string[], snapshotHour:number, today:string, startedAt:string, deps:object,
 *   now?:() => number, budgetMs:number}} args
 */
export async function runSnapshotBatch({ ids, snapshotHour, today, startedAt, deps, now = Date.now, budgetMs }) {
  const deadline = Date.parse(startedAt) + budgetMs;

  // Start row FIRST, before any serve — so a hard kill mid-batch still leaves a queryable trace.
  const ledgerId = await deps.insertLedgerStart({ started_at: startedAt, run_date: today, snapshot_hour: snapshotHour });

  const already = await deps.marketsSnapshottedOn(today, snapshotHour, ids);
  const todo = ids.filter((id) => !already.has(id));

  let success = 0;
  let failed = 0;
  let resolved = 0;
  const failures = [];

  // Pool of POOL_SIZE workers draining a shared cursor. The budget check happens BEFORE a worker
  // claims its next id — so work already in flight at the moment of exhaustion is left to finish
  // (never aborted mid-serve); everything the pool never got to is marked skipped below.
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (now() >= deadline) return;
      const idx = cursor;
      if (idx >= todo.length) return;
      cursor = idx + 1;
      const id = todo[idx];
      try {
        const { status, body } = await deps.serve(id);
        if (status !== 200 || !('record' in body) || !body.record) {
          const error = 'error' in body && body.error ? body.error : `serve status ${status}`;
          failed++;
          failures.push({ id, error });
          continue;
        }
        if (body.lifecycle_state === 'RESOLVED') {
          resolved++; // frozen — no new data to record
          continue;
        }
        await deps.writeHistory(id, body.record, snapshotHour);
        success++;
      } catch (e) {
        failed++;
        failures.push({ id, error: e.message });
      }
    }
  }

  const workerCount = Math.min(POOL_SIZE, todo.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  // Anything the pool never reached is a budget skip, not a serve failure — recorded distinctly
  // (BUDGET_EXHAUSTED marker) so the ledger and the operator can tell the two apart.
  let truncated = false;
  if (cursor < todo.length) {
    truncated = true;
    for (let i = cursor; i < todo.length; i++) {
      failed++;
      failures.push({ id: todo[i], error: BUDGET_EXHAUSTED });
    }
  }

  // Backfill fan-out only when budget remains — a truncated run already spent its margin serving
  // markets; firing more work on top would eat further into the shrinking gap before the hard kill.
  const backfill_retried = [];
  if (!truncated) {
    try {
      const needing = (await deps.marketsNeedingBackfill(ids)).slice(0, BACKFILL_RETRY_LIMIT);
      for (const id of needing) {
        try {
          await deps.fireBackfill(id);
          backfill_retried.push(id);
        } catch (e) {
          console.warn('[snapshot] backfill retry failed', id, e.message);
        }
      }
    } catch (e) {
      console.warn('[snapshot] backfill-retry query failed', e.message);
    }
  }

  const summary = {
    ok: true,
    started_at: startedAt,
    date: today,
    total: ids.length,
    skipped_already: already.size,
    skipped_resolved: resolved,
    success,
    failed,
    failures,
    backfill_retried,
    status: truncated ? 'truncated' : 'completed',
  };

  // NON-FATAL but LOUD (operator note 1): the run's actual work already happened above — a
  // ledger-update failure must never lose the summary. A false 'started' row (update failed but
  // the run actually completed) is the accepted cost: better to investigate a false orphan than
  // miss a real kill. The monitor disambiguates via ~2×maxDuration age + whether the run's
  // snapshots actually landed (primer.md INC 7 note).
  try {
    await deps.updateLedgerFinal(ledgerId, {
      total: ids.length,
      skipped_already: already.size,
      skipped_resolved: resolved,
      success,
      failed,
      failures,
      backfill_retried,
      status: summary.status,
      completed_at: new Date(now()).toISOString(),
    });
  } catch (e) {
    console.error(
      '[snapshot] cron_runs final update FAILED — ledger row remains status=started (false orphan, errs loud)',
      JSON.stringify({ ledgerId, error: e.message }),
    );
  }

  return summary;
}
