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
//
// THIN SHELL (fix/cron-batch-ledger, INC 7): the actual serve loop — pooled concurrency, the
// soft time budget, the start-then-final ledger writes — lives in lib/cron-batch.mjs
// (runSnapshotBatch), pure of I/O and unit-tested with injected fakes. This route only does
// auth, builds the id list, wires the real deps, and returns the batch's summary.

import { timingSafeEqual } from 'node:crypto';
import { DEPS } from '@/lib/market-deps.mjs';
import { serveMarket } from '@/lib/serve-market.mjs';
import { allWatchedMarketIds, marketsSnapshottedOn, writeHistory, marketsNeedingBackfill, insertCronRunStart, updateCronRunFinal } from '@/lib/market-history.mjs';
import { runSnapshotBatch } from '@/lib/cron-batch.mjs';

// Node runtime: core/ + the service-role Supabase client require Node APIs (not edge).
export const runtime = 'nodejs';
// Never statically optimize — this is a side-effecting job, run only when invoked.
export const dynamic = 'force-dynamic';
// The batch fans out one verified serve per watched market; give it room (raise with the
// Vercel plan limit as the watchlist grows — 60s is the Hobby cap).
export const maxDuration = 60;

const NO_STORE = { 'cache-control': 'no-store' } as const;
// Soft budget: runSnapshotBatch stops DISPATCHING new markets this many ms after start, leaving
// margin before Vercel's hard kill at maxDuration — there is no graceful-shutdown hook
// (doc-confirmed), so anything not accounted for by this margin is lost silently, ledger row
// included. Tied to the `maxDuration` export above; keep the two in sync.
const SOFT_BUDGET_MS = (maxDuration - 5) * 1000;

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

  const origin = new URL(req.url).origin;
  const secret = process.env.CRON_SECRET as string; // authorized() passed ⇒ secret is set

  let summary;
  try {
    summary = await runSnapshotBatch({
      ids,
      snapshotHour,
      today,
      startedAt,
      budgetMs: SOFT_BUDGET_MS,
      deps: {
        serve: (id: string) => serveMarket({ id, deps: DEPS }),
        writeHistory,
        marketsSnapshottedOn,
        insertLedgerStart: insertCronRunStart,
        updateLedgerFinal: updateCronRunFinal,
        marketsNeedingBackfill,
        fireBackfill: async (id: string) => {
          await fetch(`${origin}/api/backfill?id=${encodeURIComponent(id)}`, {
            method: 'POST', headers: { authorization: `Bearer ${secret}` }, cache: 'no-store',
          });
        },
      },
    });
  } catch (e) {
    return Response.json({ error: `snapshot batch failed: ${(e as Error).message}` }, { status: 500, headers: NO_STORE });
  }

  // Observable in Vercel deployment logs (success/failed/skipped counts + per-market errors).
  console.log('[snapshot]', JSON.stringify(summary));
  return Response.json(summary, { status: 200, headers: NO_STORE });
}
