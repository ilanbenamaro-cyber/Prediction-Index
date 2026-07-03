// lib/trigger-backfill.mjs — the shared fire-and-forget kick for the /api/backfill route.
//
// One implementation used by BOTH entry points that should reconstruct a market's history:
//   • addMarket (app/(app)/actions.ts) — a user adds a market to a watchlist;
//   • DetailData (components/zones/MarketDetailView.tsx) — a user BROWSES a market (search/⌘K or a
//     direct ?m= URL), so any viewed market loads its full history, not just watchlisted ones.
// Extracted here so the two call sites can never drift. Fire-and-forget: gated by CRON_SECRET
// (skips when unset — fails closed, never runs the job open), reads host/proto at REQUEST scope
// (passed in, so this is unit-testable without a request context), and any failure NEVER affects
// the caller (history simply backfills later, or via the cron retry of a null/'failed' status for
// watched markets).
//
// SERVER-ONLY — it reads CRON_SECRET and must never reach the client bundle. Kept as a plain .mjs
// (JSDoc-typed for the .ts/.tsx callers) so it is node-unit-testable, exactly like the other
// server-lib modules (lib/cache.mjs, lib/market-history.mjs): those document the server-only
// contract in prose rather than `import 'server-only'` (which throws under node --test). The
// service-side-only import graph (Server Action + Server Component) is the fence.

/**
 * Kick the backfill route for a market. Every call emits a structured `[backfill-trigger]` line —
 * one `attempt`, then exactly one outcome (`skipped` with a reason, `success`, or `failure`) — so a
 * missed backfill is observable in the deployment logs (Audit F2 + the observability pass).
 * @param {string} id the event slug
 * @param {string|null} host the request `host` header (null → skip: can't build the route URL)
 * @param {string} proto 'http' | 'https' for the route URL
 * @returns {Promise<void>}
 */
export async function triggerBackfill(id, host, proto) {
  const log = (level, event, extra = {}) =>
    console[level]('[backfill-trigger]', JSON.stringify({ id, event, ...extra }));

  log('log', 'attempt');
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log('warn', 'skipped', { reason: 'CRON_SECRET unset' }); // fail-closed: never run the job open
    return;
  }
  if (!host) {
    log('warn', 'skipped', { reason: 'no host header' });
    return;
  }
  try {
    const res = await fetch(`${proto}://${host}/api/backfill?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
    });
    if (res.ok) log('log', 'success', { route_status: res.status });
    else log('warn', 'failure', { route_status: res.status });
  } catch (e) {
    // fire-and-forget: a trigger failure NEVER affects the caller — but log it (the cron retries later).
    log('warn', 'failure', { error: (/** @type {Error} */ (e)).message });
  }
}
