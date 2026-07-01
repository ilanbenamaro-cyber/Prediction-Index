// lib/decide-cache-action.mjs — the cache read-path decision, as PURE functions.
//
// Why this exists: the cache×resolution interaction is the correctness trap of
// Phase 2 (ARCHITECTURE §3.1) — a market that resolves after being cached must
// NEVER be served as stale "live" data. The decision logic is isolated here, with
// no I/O, so every branch is unit-tested deterministically; the serverless handler
// does the actual fetches/DB writes around it.
//
// Precedence (highest first):
//   1. RESOLVED is authoritative & monotonic → serve the frozen final record
//      forever, no probe, no Polymarket call.
//   2. A cached OPEN/CLOSED_PENDING record past CACHE_TTL → RECOMPUTE (the
//      recompute re-classifies lifecycle from gamma meta, so resolution is caught).
//   3. A cached OPEN/CLOSED_PENDING record within CACHE_TTL → confirm it has not
//      resolved before serving: PROBE (cheap gamma meta) unless a probe ran within
//      PROBE_TTL, in which case trust it and SERVE_FRESH.
//   4. No cached row → COMPUTE (miss).

export const CACHE_TTL_MS = 15 * 60 * 1000; // OPEN-market cache RECOMPUTE window (not the trust-staleness
                                            // threshold — that's core/freshness.js's 17h; see the note there)
export const PROBE_TTL_MS = 60 * 1000; // dedup the resolution probe under bursty traffic

/**
 * Decide what to do BEFORE doing any network I/O, from the cached row alone.
 *   input: { lifecycleState|null, cachedAtMs|null, lastCheckedAtMs|null, nowMs,
 *            ttlMs=CACHE_TTL_MS, probeTtlMs=PROBE_TTL_MS }
 * Returns one of: 'COMPUTE' | 'SERVE_FINAL' | 'RECOMPUTE' | 'PROBE' | 'SERVE_FRESH'.
 */
export function decideBeforeProbe({
  lifecycleState = null,
  cachedAtMs = null,
  lastCheckedAtMs = null,
  nowMs,
  ttlMs = CACHE_TTL_MS,
  probeTtlMs = PROBE_TTL_MS,
}) {
  if (lifecycleState == null || cachedAtMs == null) return 'COMPUTE'; // cache miss
  if (lifecycleState === 'RESOLVED') return 'SERVE_FINAL'; // final & monotonic
  // OPEN / CLOSED_PENDING:
  const age = nowMs - cachedAtMs;
  if (age >= ttlMs) return 'RECOMPUTE'; // stale by TTL; recompute re-classifies lifecycle
  // Within TTL — but resolution is authoritative, so confirm still-open unless a
  // probe ran recently.
  const probedRecently = lastCheckedAtMs != null && nowMs - lastCheckedAtMs < probeTtlMs;
  return probedRecently ? 'SERVE_FRESH' : 'PROBE';
}

/**
 * Decide AFTER a gamma resolution probe of a within-TTL cached OPEN record.
 *   probeLifecycleState: the freshly classified state ('OPEN'|'CLOSED_PENDING'|'RESOLVED')
 * A market that has since left OPEN must NOT be served from the OPEN cache.
 */
export function decideAfterProbe(probeLifecycleState) {
  return probeLifecycleState === 'OPEN' ? 'SERVE_FRESH' : 'RECOMPUTE';
}
