// lib/cache.mjs — Supabase-backed verified-snapshot cache (SERVER-ONLY).
//
// Why this exists: persists core/-produced, validated, hashed records so a popular
// market is served from cache, not recomputed/ re-fetched every request. Uses the
// SERVICE-ROLE key — this module must NEVER be imported into client code. The cache
// only ever STORES what core/ produced; it never recomputes the hash or a metric.
// The only write path is writeRecord(), which is fed a validated record by lib/compute.mjs.

import { createClient } from '@supabase/supabase-js';
import { collapseConfidenceTier } from '../core/confidence.js';

let _client = null;
function db() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // write-capable; server-only
  if (!url || !key) throw new Error('cache: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

const statusOf = (lifecycleState) => lifecycleState.toLowerCase(); // OPEN→open, etc.

/** Read the latest cached snapshot + the market row (for last_checked_at / status). */
export async function readCache(marketId) {
  const [snap, mkt] = await Promise.all([
    db().from('market_latest').select('*').eq('market_id', marketId).maybeSingle(),
    db().from('markets').select('*').eq('id', marketId).maybeSingle(),
  ]);
  if (snap.error) throw new Error(`cache read (snapshot): ${snap.error.message}`);
  if (mkt.error) throw new Error(`cache read (market): ${mkt.error.message}`);
  return { snapshot: snap.data ?? null, market: mkt.data ?? null };
}

/** Record that we just probed resolution for a market (probe-TTL dedup). */
export async function touchProbe(marketId, lifecycleState, resolvedOutcome = null) {
  const { error } = await db().from('markets').update({
    last_checked_at: new Date().toISOString(),
    resolution_status: statusOf(lifecycleState),
    resolved_outcome: resolvedOutcome,
    updated_at: new Date().toISOString(),
  }).eq('id', marketId);
  if (error) throw new Error(`cache touchProbe: ${error.message}`);
}

/**
 * Persist a validated record: upsert the market row + insert the snapshot
 * (idempotent on (market_id, fetched_at)). Returns the stored snapshot shape.
 *
 * `client` is an OPTIONAL test-only override for the Supabase client (defaults to the real db()
 * singleton) — the minimal seam needed to stub the upsert response in tests without touching a
 * live database (mirrors the injected-deps pattern used elsewhere in lib/).
 */
export async function writeRecord(marketId, record, lifecycle, config, { replace = false, client = null } = {}) {
  const c = client ?? db();
  const d = record.snapshot.derived;
  const isFinal = lifecycle.state === 'RESOLVED';
  const nowISO = new Date().toISOString();

  const up = await c.from('markets').upsert({
    id: marketId,
    title: config?.name ?? record.asset?.name ?? marketId,
    kind: config?.kind ?? d.kind ?? 'threshold_ladder', // 'binary' | 'threshold_ladder' (Phase 2)
    config: config ?? record.asset ?? {},
    resolution_status: statusOf(lifecycle.state),
    resolved_outcome: lifecycle.resolved_outcome ?? null,
    last_checked_at: nowISO,
    updated_at: nowISO,
  }, { onConflict: 'id' });
  if (up.error) throw new Error(`cache upsert market: ${up.error.message}`);

  const row = {
    market_id: marketId,
    fetched_at: record.snapshot.fetched_at,
    cached_at: nowISO,
    raw_sha256: record.snapshot.source.raw_sha256,
    schema_version: record.schema_version,
    methodology_version: record.methodology_version,
    assumptions_version: record.assumptions_version ?? null,
    lifecycle_state: lifecycle.state,
    is_final: isFinal,
    // Two-dimension confidence (0010). reliability = is the number trustworthy; liquidity = can
    // you transact. The legacy confidence_tier stays populated with the collapsed worst tier so any
    // unmigrated reader still works; the rail/detail read the two new columns.
    reliability_tier: d.confidence?.reliability?.tier ?? null,
    reliability_score: d.confidence?.reliability?.score ?? null,
    liquidity_tier: d.confidence?.liquidity?.tier ?? null,
    liquidity_score: d.confidence?.liquidity?.score ?? null,
    confidence_tier: collapseConfidenceTier(d.confidence),
    // OVERLOAD (Phase 2, no migration): for a binary market this column holds the YES
    // probability (0..1), not a median. The `kind` discriminator on `markets` tells the
    // rail/detail how to format it (probability % vs $median). See decisions: implied_median reuse.
    implied_median: d.implied_median ?? d.probability ?? null,
    stale_after: isFinal ? null : (d.freshness?.stale_after ?? null),
    record,
  };
  // Idempotent: a re-compute at the same fetched_at instant must not duplicate.
  // `replace: true` (seed/re-seed path, resolved-transition degraded freeze, CLOSED_PENDING freeze)
  // updates the existing row instead of ignoring the conflict — a frozen record's fetched_at never
  // changes, so without it a re-seed (or a resolution transition that had to degrade to a freeze)
  // is a silent no-op and the stored row keeps the stale shape/lifecycle forever.
  const ins = await c.from('market_snapshots')
    .upsert(row, { onConflict: 'market_id,fetched_at', ignoreDuplicates: !replace })
    .select('market_id,fetched_at');
  if (ins.error) throw new Error(`cache insert snapshot: ${ins.error.message}`);
  // A quiet drop must never share an exit path with success: with ignoreDuplicates (replace=false),
  // a conflicting row returns NO rows and no error — exactly the silent no-op that let
  // world-cup-winner / which-continent-will-win-the-world-cup stay OPEN in the cache forever after
  // resolving. Fail LOUD instead of returning as if the write landed.
  if (!replace && (!ins.data || ins.data.length === 0)) {
    throw new Error('cache insert snapshot: silent no-op — (market_id, fetched_at) already exists and replace was not declared');
  }
  return row;
}
