// lib/serve-market.mjs — the request orchestration, with I/O injected as deps.
//
// Why this exists: the read→decide→probe→compute→write→serve flow is the wiring
// that the pure decideCacheAction can't cover. Isolating it with injected deps
// (cache + Polymarket + compute) lets every branch be unit-tested deterministically
// (cache-hit serves with NO compute; a since-resolved market is never served
// stale-live; a miss computes+writes) without a live DB. api/market.mjs is then a
// thin HTTP shell that injects the real implementations.

import { decideBeforeProbe, decideAfterProbe } from './decide-cache-action.mjs';

// Gamma event slugs are lowercase alnum + hyphens; dot/underscore tolerated; length-bounded. This
// also rejects query-injection characters (&, #, %, /) before the slug reaches the gamma URL.
export const MARKET_ID_RE = /^[a-z0-9][a-z0-9._-]{0,199}$/i;

/** Map an internal error to an HTTP status — never leak unvalidated data. */
export function statusFor(err) {
  if (Number.isInteger(err.code)) return err.code; // 404 / 409 from compute
  if (/^Record invalid/.test(err.message)) return 422; // failed validateRecord — never cached
  if (/Gamma API returned no events/.test(err.message)) return 404; // slug not in gamma catalog (typo or delisted)
  if (/→ \d{3}\b|Gamma API|CLOB/.test(err.message)) return 502; // Polymarket upstream
  return 500;
}

function serveBody(marketId, cached, record, lifecycleState, nowMs) {
  const asOf = Date.parse(record.snapshot.fetched_at);
  return {
    market_id: marketId,
    cached,
    age_seconds: Math.max(0, Math.round((nowMs - asOf) / 1000)),
    lifecycle_state: lifecycleState,
    record,
  };
}

/**
 * Resolve one market request. Returns { status, body }. Pure of HTTP; all I/O is
 * injected via deps = { readCache, probeLifecycle, computeMarketRecord, writeRecord,
 * touchProbe, writeTransitionHistory? }, and the clock via now() (defaults to Date.now).
 * writeTransitionHistory is OPTIONAL (no-op when absent) — called exactly once, right after a
 * RESOLVED-with-prior compute persists (a genuine resolution transition, not a SERVE_FINAL cache
 * hit and not the no-prior first-ever browse, which never had history to append to).
 */
export async function serveMarket({ id, deps, now = Date.now }) {
  if (!id || typeof id !== 'string' || !id.trim()) {
    return { status: 400, body: { error: 'missing ?id=<event_slug>' } };
  }
  const marketId = id.trim();
  if (!MARKET_ID_RE.test(marketId)) {
    return { status: 400, body: { error: 'invalid market id' } };
  }
  try {
    const { snapshot, market } = await deps.readCache(marketId);
    let decision = decideBeforeProbe({
      lifecycleState: snapshot?.lifecycle_state ?? null,
      cachedAtMs: snapshot ? Date.parse(snapshot.cached_at) : null,
      lastCheckedAtMs: market?.last_checked_at ? Date.parse(market.last_checked_at) : null,
      nowMs: now(),
    });

    // Within-TTL OPEN/CLOSED_PENDING: confirm it hasn't resolved before serving
    // (resolution authoritative over the cache).
    if (decision === 'PROBE') {
      const { lifecycle } = await deps.probeLifecycle(marketId);
      await deps.touchProbe(marketId, lifecycle.state, lifecycle.resolved_outcome);
      decision = decideAfterProbe(lifecycle.state); // SERVE_FRESH | RECOMPUTE
    }

    if (decision === 'SERVE_FINAL' || decision === 'SERVE_FRESH') {
      return { status: 200, body: serveBody(marketId, true, snapshot.record, snapshot.lifecycle_state, now()) };
    }

    // COMPUTE (miss) or RECOMPUTE (TTL-expired, or probe found it left OPEN).
    const prior = snapshot?.record ?? null;
    const { record, lifecycle, config, writeReplace } = await deps.computeMarketRecord({ id: marketId, prior });
    await deps.writeRecord(marketId, record, lifecycle, config, { replace: writeReplace });
    // A resolution just transitioned (a prior existed, and it's RESOLVED now) — stamp ONE final
    // history row so the series' last point is the settled outcome, not silence. Never fires for a
    // SERVE_FINAL cache hit (that returns earlier, above) or a no-prior browse (nothing to append to).
    // NON-FATAL (review P2): the AUTHORITATIVE record already persisted above — failing the serve
    // here would 500 the viewer over an observability write, and the row would never retry (the
    // next serve is SERVE_FINAL). Warn loud and still serve; matches the cron_runs ledger posture
    // (authoritative write fail-loud, observability write warn-loud).
    if (lifecycle.state === 'RESOLVED' && prior && deps.writeTransitionHistory) {
      try {
        await deps.writeTransitionHistory(marketId, record);
      } catch (err) {
        console.warn('[resolved-transition] transition history write failed', JSON.stringify({ id: marketId, error: err.message }));
      }
    }
    return { status: 200, body: serveBody(marketId, false, record, lifecycle.state, now()) };
  } catch (err) {
    return { status: statusFor(err), body: { error: err.message } };
  }
}
