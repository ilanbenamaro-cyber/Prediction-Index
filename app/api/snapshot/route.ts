// app/api/snapshot/route.ts — the daily history snapshot cron (Phase 1).
//
// Invoked by Vercel Cron once daily (02:00 UTC, configured in vercel.json). For every
// market on ANY user's watchlist it runs the SAME authoritative serveMarket pipeline
// /api/market uses (verified core/ compute → resolution probe → cache), then writes ONE
// row per market per UTC day into market_history. That stored series is what later powers
// the velocity/dispersion/trend cards the on-demand single-snapshot model could never show.
//
// SECURITY (this is a write-capable, watchlist-enumerating job — it must NOT be publicly
// callable): authorized via CRON_SECRET using a TIMING-SAFE Bearer comparison (mirrors
// Vercel's own cron dispatcher, verified via Context7). We FAIL CLOSED — if CRON_SECRET is
// unset we return 401 rather than running open (stricter than Vercel's default, matching the
// middleware loud-check / invite-hook fail-closed posture). Set CRON_SECRET in Vercel
// Preview AND Production scopes; Vercel attaches the Bearer header to cron invocations.

import { timingSafeEqual } from 'node:crypto';
import { DEPS } from '@/lib/market-deps.mjs';
import { serveMarket } from '@/lib/serve-market.mjs';
import { allWatchedMarketIds, marketsSnapshottedOn, writeHistory, marketsNeedingBackfill, writeCronRun } from '@/lib/market-history.mjs';

// Node runtime: core/ + the service-role Supabase client require Node APIs (not edge).
export const runtime = 'nodejs';
// Never statically optimize — this is a side-effecting job, run only when invoked.
export const dynamic = 'force-dynamic';
// The batch fans out one verified serve per watched market; give it room (raise with the
// Vercel plan limit as the watchlist grows — 60s is the Hobby cap).
export const maxDuration = 60;

const NO_STORE = { 'cache-control': 'no-store' } as const;
// Cap the per-run backfill retries so a large backlog drains over successive daily runs without
// blowing the cron's budget (each retry only FIRES /api/backfill, which owns the actual rebuild).
const BACKFILL_RETRY_LIMIT = 10;

/** Timing-safe `Authorization: Bearer <CRON_SECRET>` check. Fails CLOSED when the secret
 *  is unset (never run unauthenticated) or on any length/content mismatch. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — no secret configured ⇒ no run
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const startedAt = new Date().toISOString();
  const today = startedAt.slice(0, 10); // UTC date
  // Increment 2: two daily crons (02:00 + 18:00 UTC) — the run hour keys the history row so both
  // coexist, and the US-hours (18:00) capture is later preferred for velocity/dispersion.
  const snapshotHour = new Date(startedAt).getUTCHours();

  let ids: string[];
  try {
    ids = await allWatchedMarketIds();
  } catch (e) {
    return Response.json({ error: `watchlist read failed: ${(e as Error).message}` }, { status: 500, headers: NO_STORE });
  }

  // Dedup guard: skip markets already snapshotted in THIS hour-slot (idempotent re-runs after a
  // partial failure don't recompute the ones that succeeded; the 18:00 run does NOT skip the 02:00
  // rows). writeHistory upserts anyway, so this is a cost optimization, not the correctness guarantee.
  const already = await marketsSnapshottedOn(today, snapshotHour, ids);
  const todo = ids.filter((id) => !already.has(id));

  let success = 0;
  let failed = 0;
  let resolved = 0;
  const failures: { id: string; error: string }[] = [];

  // One failure must not stop the batch (a single bad market shouldn't lose every other
  // market's daily datapoint).
  for (const id of todo) {
    try {
      const { status, body } = await serveMarket({ id, deps: DEPS });
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
      await writeHistory(id, body.record, snapshotHour);
      success++;
    } catch (e) {
      failed++;
      failures.push({ id, error: (e as Error).message });
    }
  }

  // Retry markets whose backfill never completed (status null = the add-time trigger never ran,
  // e.g. added before CRON_SECRET was set; or 'failed'). We FIRE the dedicated /api/backfill route
  // (its own time budget; it ACKs 202 and rebuilds in its own after()) rather than backfill inline,
  // so this cron stays within maxDuration. Bounded per run so a large backlog drains over days.
  const backfill_retried: string[] = [];
  try {
    const needing = (await marketsNeedingBackfill(ids)).slice(0, BACKFILL_RETRY_LIMIT);
    const origin = new URL(req.url).origin;
    const secret = process.env.CRON_SECRET as string; // authorized() passed ⇒ secret is set
    for (const id of needing) {
      try {
        await fetch(`${origin}/api/backfill?id=${encodeURIComponent(id)}`, {
          method: 'POST', headers: { authorization: `Bearer ${secret}` }, cache: 'no-store',
        });
        backfill_retried.push(id);
      } catch (e) {
        console.warn('[snapshot] backfill retry failed', id, (e as Error).message);
      }
    }
  } catch (e) {
    console.warn('[snapshot] backfill-retry query failed', (e as Error).message);
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
  };

  // Permanent, queryable ledger of this invocation (migration 0015) — Vercel deployment logs roll
  // off, this table doesn't. The run itself must NOT fail because its OWN ledger write failed: log
  // loud and still return the summary (the console.log line below is the fallback record either way).
  try {
    await writeCronRun({
      started_at: startedAt,
      run_date: today,
      snapshot_hour: snapshotHour,
      total: ids.length,
      skipped_already: already.size,
      skipped_resolved: resolved,
      success,
      failed,
      failures,
      backfill_retried,
    });
  } catch (e) {
    console.warn('[snapshot] cron_runs insert failed', (e as Error).message);
  }

  // Observable in Vercel deployment logs (success/failed/skipped counts + per-market errors).
  console.log('[snapshot]', JSON.stringify(summary));
  return Response.json(summary, { status: 200, headers: NO_STORE });
}
