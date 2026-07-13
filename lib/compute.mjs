// lib/compute.mjs — run the verified core/ pipeline for one market, on demand.
//
// Why this exists: the serverless function must produce a record the SAME way the
// cron does (ARCHITECTURE governing principle) — isotonic → firewall → validate →
// hash, in core/ — just invoked per-request with a per-market config and written
// to the Supabase cache instead of the filesystem. No metric is computed here; this
// only orchestrates core/. Pure of any DB/HTTP-response concern (the handler owns those).

// Data is IMPORTED (bundled into the JS), not read from disk at runtime — so the
// serverless function never ENOENTs on an un-traced file (see core/markets/manifest.mjs).
import METHODOLOGY from '../core/methodology.json' with { type: 'json' };
import ASSUMPTIONS from '../core/assumptions.json' with { type: 'json' };

import {
  fetchLiveSnapshot, fetchEventStatus, countClosed,
  classifyMarketShape, fetchMarketMeta,
  fetchBinaryStatus, fetchBinaryMeta, fetchBinarySnapshot,
  fetchBucketStatus, fetchBucketMeta, fetchBucketPmfSnapshot,
  fetchTouchStatus, fetchTouchMeta, fetchTouchSnapshot,
  fetchCategoricalStatus, fetchCategoricalMeta, fetchCategoricalSnapshot,
  hashRawInputs,
} from '../core/fetch.js';
import { buildTouchRecord } from '../core/touch-record.js';
import { impliedRange } from '../core/touch.js';
import { buildCategoricalRecord } from '../core/categorical.js';
import { buildPmfLadder } from '../core/bucket.js';
import { defaultConfigForLadder } from '../core/market-config.js';
import { classifyLifecycle, LIFECYCLE } from '../core/lifecycle.js';
import {
  buildSnapshotRecord, attachAnalytics, attachScenarios, attachNarrative,
} from '../core/snapshot.js';
import { buildBinaryRecord } from '../core/binary.js';
import { validateRecord } from '../core/validate.js';
import { buildFreshness } from '../core/freshness.js';
import { PINNED_CONFIGS } from '../core/markets/manifest.mjs';
// NOTE (freshness decoupling): the on-demand record builders below deliberately do NOT pass a
// freshness threshold, so they use core/freshness.js's default (17h). CACHE_TTL_HOURS (15min) is the
// SERVER cache-recompute horizon (decide-cache-action.mjs) — a different quantity from the user-facing
// staleness/trust threshold. Passing the 15min TTL as stale_after made every rail market read STALE
// ~15min after any cron/view (the rail reads cached stale_after without recomputing). See gotchas
// "price-match window ≠ liveness window" + decisions "Staleness threshold is a DERIVED function…".

/** A pinned MarketConfig whose event_slug matches, or null (→ generic defaults).
 *  structuredClone hands out a fresh mutable copy per call (preserving the old
 *  JSON.parse(readFileSync) semantics) so a caller can't mutate the shared manifest. */
export function pinnedConfigFor(eventSlug) {
  const match = PINNED_CONFIGS.find((c) => c.event_slug === eventSlug);
  return match ? structuredClone(match) : null;
}

/** The survival-ladder bootstrap config (the `$X` threshold parser) for fetchEventStatus. */
function survivalBootstrap(eventSlug) {
  return {
    event_slug: eventSlug,
    threshold: { parse_pattern: '\\$(\\d+\\.?\\d*)', unit_prefix: '$', unit_suffix: '' },
    narrative: { unit_prefix: '$', unit_suffix: '' },
  };
}

/** Default probe deps: classify the shape, then the per-shape lifecycle-status fetcher. Only the
 *  survival fetcher parses `$X` thresholds; the others read lifecycle signals without parsing,
 *  so a non-survival market never hits the survival parser (audit F1). Injected in tests. */
const REAL_PROBE_DEPS = {
  classifyShape: classifyMarketShape,
  statusFetchers: {
    binary: (slug) => fetchBinaryStatus({ event_slug: slug }),
    bucket_pmf: (slug) => fetchBucketStatus({ event_slug: slug }),
    directional_touch: (slug) => fetchTouchStatus({ event_slug: slug }),
    categorical: (slug) => fetchCategoricalStatus({ event_slug: slug }),
    survival: (slug) => fetchEventStatus(survivalBootstrap(slug)),
  },
};

/**
 * Lifecycle (gamma-meta only, no CLOB) for a market — safe on resolved markets and on EVERY
 * market shape. We CLASSIFY the shape first (one gamma GET, no threshold parse) and then call the
 * shape's lifecycle-status fetcher. Before audit F1 this assumed a survival ladder and ran the
 * `$X` parser, which threw "Cannot parse threshold" on binary/categorical/touch/bucket markets —
 * 500ing the detail serve whenever a non-survival OPEN market took the PROBE path (within the
 * 15-min cache TTL but >60s since the last probe). Mirrors computeMarketRecord's classify-then-route.
 */
export async function probeLifecycle(eventSlug, deps = REAL_PROBE_DEPS) {
  const shape = await deps.classifyShape(eventSlug);
  const fetchStatus = deps.statusFetchers[shape] ?? deps.statusFetchers.survival;
  const status = await fetchStatus(eventSlug);
  return { status, lifecycle: classifyLifecycle(status, new Date().toISOString()) };
}

/**
 * Freeze a prior record under a non-OPEN lifecycle (no live pull) — mirrors
 * scripts/snapshot.js:freezeRecord. Used when a market has resolved/closed.
 */
export function freezePriorRecord(prior, lifecycle) {
  const frozen = structuredClone(prior);
  frozen.methodology_version = METHODOLOGY.version;
  frozen.snapshot.lifecycle = lifecycle;
  frozen.snapshot.derived.freshness = buildFreshness(frozen.snapshot.fetched_at, null, undefined, lifecycle);
  validateRecord(frozen);
  return frozen;
}

/**
 * Compute (or freeze) the verified canonical record for a market on demand.
 *   { id, prior }  — prior = the last cached record (for the freeze path), or null.
 * Returns { record, lifecycle, config }. Throws { code } on a 404/409-class issue.
 * Never returns an unvalidated record (validateRecord runs before return).
 */
export async function computeMarketRecord({ id, prior = null }) {
  // Detect the FINE shape BEFORE any threshold parsing — fetchMarketMeta throws on a leg
  // whose question has no $threshold (binary, categorical, OR a bucket market's "not IPO"
  // leg), and a bucket/touch market is NOT a survival ladder, so each must route to its own
  // pipeline before probeLifecycle's strict parser runs.
  const shape = await classifyMarketShape(id);
  if (shape === 'binary') return computeBinaryRecord({ id, prior });
  if (shape === 'bucket_pmf') return computeBucketPmfRecord({ id, prior });
  if (shape === 'categorical') return computeCategoricalRecord({ id, prior });
  if (shape === 'directional_touch') return computeTouchRecord({ id, prior });
  if (shape === 'unsupported') {
    // 5.5: a MIXED board (some legs $-threshold, some not) fits no honest model — survival
    // would throw on the unparseable leg, categorical would de-vig non-exclusive outcomes
    // into a fabricated PMF. Fail EARLY with a friendly typed error: no compute, NO
    // market-row write (writes only happen after a successful compute).
    const e = new Error(`UNSUPPORTED_SHAPE: "${id}" mixes $-threshold and non-threshold legs — no honest model exists for this structure yet (shown as unsupported rather than shown wrong)`);
    e.code = 422;
    throw e;
  }

  const { status, lifecycle } = await probeLifecycle(id);
  if (!status || status.length < 2) {
    const e = new Error(`"${id}" is not a usable threshold-ladder event`);
    e.code = 404;
    throw e;
  }

  // Non-OPEN: there are no live midpoints to pull — freeze the prior record.
  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
      // RESOLVED with no cached prior: build a minimal, valid frozen record from the settled
      // per-threshold outcomes (see buildMinimalSurvival). CLOSED_PENDING still 409s.
      if (lifecycle.state === LIFECYCLE.RESOLVED) {
        const legs = await fetchMarketMeta(survivalBootstrap(id));
        return buildMinimalResolvedRecord('survival', legs, id, lifecycle);
      }
      const e = new Error(`"${id}" is ${lifecycle.state} with no prior record to freeze`);
      e.code = 409;
      throw e;
    }
    return { record: freezePriorRecord(prior, lifecycle), lifecycle, config: prior.snapshot?.lifecycleConfig ?? null };
  }

  // OPEN: full live pipeline.
  const config = pinnedConfigFor(id) ?? defaultConfigForLadder(
    status.map((s) => s.threshold),
    { id, event_slug: id, name: id, unit_prefix: '$', unit_suffix: '' }
  );
  const live = await fetchLiveSnapshot(config);
  const anomalies = { stale: false, closedCount: countClosed(live.status), liquidityDrop: null };
  const record = buildSnapshotRecord(live, METHODOLOGY.version, anomalies, config, lifecycle);
  attachAnalytics(record, { priors: {}, config }); // no history priors on-demand (2a)
  if (config.scenarios) attachScenarios(record, ASSUMPTIONS);
  else record.assumptions_version = null;
  attachNarrative(record, { config });
  validateRecord(record); // schema + invariants + firewall + lifecycle — never cache unvalidated
  return { record, lifecycle, config };
}

/** A MarketConfig for a binary market — name/resolves come from gamma; kind drives
 *  the cache (markets.kind='binary') and the rail/detail rendering branch. */
function defaultBinaryConfig(id, title = null, endDate = null) {
  return {
    id, event_slug: id, name: title || id, kind: 'binary',
    platform: 'prediction index', market_url: `https://polymarket.com/event/${id}`,
    resolves: endDate ? endDate.slice(0, 10) : null,
  };
}

/** Freeze a prior BINARY record under a non-OPEN lifecycle (no live pull), mirroring
 *  freezePriorRecord. Reconstructs a kind:'binary' config from the prior's asset. */
function freezeBinaryPriorRecord(prior, lifecycle, id) {
  const frozen = structuredClone(prior);
  frozen.methodology_version = METHODOLOGY.version;
  frozen.snapshot.lifecycle = lifecycle;
  frozen.snapshot.derived.freshness = buildFreshness(frozen.snapshot.fetched_at, null, undefined, lifecycle);
  validateRecord(frozen);
  const a = prior.asset ?? {};
  const config = { id: a.id ?? id, name: a.name ?? id, kind: 'binary', platform: a.platform ?? 'prediction index', market_url: a.market_url, resolves: a.resolves };
  return { record: frozen, lifecycle, config };
}

// ── minimal resolved-record construction (RESOLVED + no cached prior) ──────────────────────────
// Browsing a RESOLVED market the product never captured while OPEN used to 409 ("no prior record
// to freeze") for every shape. Gamma DOES still serve resolved markets (closed:true +
// umaResolutionStatus:"resolved" + settled outcomePrices), so instead of 409ing we build a valid
// record from those SETTLED prices — real, observed data, not an estimate. The design, extended
// here from the binary-only fix to all 5 shapes: construct a `live`-shaped object (the same shape
// each shape's own fetchXSnapshot produces) from the settled outcomePrices, then feed it through
// the SAME builder (buildBinaryRecord/buildSnapshotRecord/buildTouchRecord/buildCategoricalRecord)
// the OPEN path already uses — mirroring the backfill pattern (lib/backfill-record.mjs builds a
// `live`-shaped object from CLOB price HISTORY, not live quotes, and feeds it through the same core
// builders). This reuses every existing formula (isotonic adjustment, quantile crossings, de-vig,
// entropy) instead of re-deriving bucket/CDF math by hand — "one source of truth" (decisions.md).

/** Parse a gamma array field that may arrive as a JSON string OR an already-parsed array
 *  (mirrors core/lifecycle.js's parser, which isn't exported). */
function parseGammaArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; }
  }
  return null;
}

/** null-guard FIRST: Number(null) is 0 (not NaN), so a missing price must short-circuit to null
 *  rather than fabricate a 0%/false probability (the trap from the binary fix — see gotchas.md). */
function num(s) {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The settled YES-outcome price for one gamma leg's outcomes/outcomePrices, as a string (for
 *  raw_inputs) — aligned by label ('Yes') when present, else positional [0]. null when unparseable.
 *  Shared across every shape: each leg's "did this outcome settle true" is the same lookup. */
function settledYesStr(outcomesRaw, pricesRaw) {
  const outcomes = parseGammaArr(outcomesRaw) ?? [];
  const prices = parseGammaArr(pricesRaw) ?? [];
  const idx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  const raw = idx >= 0 ? prices[idx] : prices[0];
  return raw != null ? String(raw) : null;
}

/** The settled YES-outcome price as a NUMBER (0 or 1), or null when unparseable — never a
 *  fabricated 0 for missing data (see `num`). */
function settledYesNum(outcomesRaw, pricesRaw) {
  return num(settledYesStr(outcomesRaw, pricesRaw));
}

/** The winning-outcome label(s) from a RESOLVED lifecycle's resolved_outcome, or 'settled'. Reads
 *  fine for a SHORT resolved_outcome (binary's single rung); the ladder shapes use their own
 *  `ladderSettlementLabel` instead (joining every one of a dozen+ rungs here would be unreadable). */
function resolvedOutcomeLabel(lifecycle) {
  const ro = lifecycle?.resolved_outcome;
  if (!Array.isArray(ro) || ro.length === 0) return 'settled';
  const labels = ro.map((r) => r.outcome).filter(Boolean);
  return labels.length ? labels.join(', ') : 'settled';
}

/** A settlement-zone label for a LADDER (survival/bucket_pmf) shape's resolved_outcome — the same
 *  lastYes/firstNo heuristic the detail view (MarketDetailView.resolvedBand) already uses for a
 *  clean single-direction ladder. NOTE: some gamma events classify as 'survival' via the generic
 *  $-threshold regex while actually being a two-sided "reach $X / dip to $X" structure (a
 *  pre-existing shape-classifier limitation — see the fineKind gotcha entry for the sibling case in
 *  market-history.mjs) — for THOSE the settled per-rung outcomes are genuinely non-monotonic, so
 *  this label may span a wide or unintuitive range. That's a classifier limitation, not something
 *  this function can (or should) paper over by inventing a narrower "cleaner" range. */
function ladderSettlementLabel(lifecycle, prefix = '$', suffix = '') {
  const ro = lifecycle?.resolved_outcome;
  if (!Array.isArray(ro) || ro.length === 0) return 'settled';
  const yesT = ro.filter((r) => r.outcome === 'Yes').map((r) => r.threshold);
  const noT = ro.filter((r) => r.outcome === 'No').map((r) => r.threshold);
  const lastYes = yesT.length ? Math.max(...yesT) : null;
  const firstNo = noT.length ? Math.min(...noT) : null;
  if (lastYes != null && firstNo != null) {
    // A CLEAN one-directional ladder always has lastYes < firstNo (Yes at the low thresholds, No at
    // the high ones — SpaceX-style "above $X"). lastYes >= firstNo means the settled outcomes are NOT
    // a simple survival step — the event is a two-sided structure the shape classifier missed (see
    // the caveat on this function above). Asserting a specific "$X–$Y" range there would read
    // backwards/confusing and be a plausible-but-WRONG claim, so fall back to an honest non-specific
    // statement instead of inventing a misleading range.
    if (lastYes < firstNo) return `settled in ${prefix}${lastYes}${suffix}–${prefix}${firstNo}${suffix}`;
    return 'settled (see per-threshold outcomes for the exact settlement pattern)';
  }
  if (lastYes != null) return `settled above ${prefix}${lastYes}${suffix}`;
  if (firstNo != null) return `settled below ${prefix}${firstNo}${suffix}`;
  return 'settled';
}

/** A settlement label for a TOUCH shape: which HIGH/LOW level(s) actually touched (settled prob
 *  ≥ 0.5), or 'neither level was touched' when none did. */
function touchSettlementLabel(high, low, unit = '') {
  const pfx = unit === '%' ? '' : '$'; // percent levels carry no '$' prefix (lib/market-history.mjs deriveTouchSeries)
  const hit = [
    ...high.filter((p) => p.prob >= 0.5).map((p) => `HIGH ${pfx}${p.level}${unit}`),
    ...low.filter((p) => p.prob >= 0.5).map((p) => `LOW ${pfx}${p.level}${unit}`),
  ];
  return hit.length ? `touched ${hit.join(', ')}` : 'neither level was touched';
}

/** Confidence for ANY minimal resolved record: settled-honest, VALID enum tiers (never the literal
 *  'RESOLVED' — the schema locks tier to high|medium|low; see gotchas.md). Reliability HIGH (the
 *  outcome is final, not an estimate); liquidity LOW (you can no longer transact). Set explicitly
 *  rather than via each shape's live scorer, which would report a misleading "tight spread"/"deep
 *  book" default on a market that has no live book at all. Shared across all 5 shapes. */
function resolvedConfidence() {
  return {
    reliability: { tier: 'high', score: 1, reasons: ['market resolved — outcome is final'] },
    liquidity: { tier: 'low', score: 0, reasons: ['market resolved — no longer trading'] },
  };
}

/** The per-leg lifecycle status rows every shape's minimal builder needs to classify (or receive)
 *  the RESOLVED lifecycle, from a legs-with-{closed,active,accepting_orders,outcomes,outcome_prices}
 *  array. Mirrors each fetchXStatus function's own mapping (indexed by position, not threshold). */
function statusFromLegs(legs) {
  return legs.map((l, i) => ({
    threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
    umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
  }));
}

/** A clean 409 for the rare case where NO leg of a resolved market has a parseable settled price —
 *  the schema requires real markets/series data for the ladder/touch shapes, so there is genuinely
 *  nothing valid to build (never fabricate a threshold/probability that was never observed). */
function noParseableSettlementError(id) {
  const e = new Error(`"${id}" is RESOLVED with no parseable settled prices — cannot build a record`);
  e.code = 409;
  return e;
}

/**
 * Build a MINIMAL but fully-VALID frozen record for a RESOLVED market of any shape that was NEVER
 * cached (no prior to freeze). Dispatches to a per-shape builder; each constructs a `live`-shaped
 * object from the settled outcomePrices and feeds it through the SAME builder the OPEN path uses.
 * Never throws for a malformed-but-partially-parseable gamma shape (per-leg null-safe fallbacks);
 * DOES throw a clean 409 when a shape's schema branch requires real data we genuinely don't have
 * (see `noParseableSettlementError`) — that is the honest failure, not a bug.
 *
 * @param {'binary'|'survival'|'bucket_pmf'|'directional_touch'|'categorical'} shape
 * @param {object} meta shape-specific gamma meta: fetchBinaryMeta (binary) / fetchMarketMeta legs
 *                 array (survival) / fetchBucketMeta (bucket_pmf) / fetchTouchMeta (directional_touch)
 *                 / fetchCategoricalMeta (categorical) result
 * @param {string} id the event slug
 * @param {object|null} [lifecycle] a precomputed RESOLVED lifecycle; recomputed from `meta` when omitted
 * @returns {{ record: object, lifecycle: object, config: object }}
 */
export function buildMinimalResolvedRecord(shape, meta, id, lifecycle = null) {
  if (shape === 'binary') return buildMinimalBinary(meta, id, lifecycle);
  if (shape === 'survival') return buildMinimalSurvival(meta, id, lifecycle);
  if (shape === 'bucket_pmf') return buildMinimalBucketPmf(meta, id, lifecycle);
  if (shape === 'directional_touch') return buildMinimalTouch(meta, id, lifecycle);
  if (shape === 'categorical') return buildMinimalCategorical(meta, id, lifecycle);
  // An unrecognized shape: nothing we can build safely — never fabricate a record for a schema
  // branch we don't understand.
  const e = new Error(`"${id}" is RESOLVED with no prior record and an unrecognized shape "${shape}"`);
  e.code = 409;
  throw e;
}

/** BINARY: a valid kind:'binary' record from the settled YES/NO prices (unchanged behavior from
 *  the original binary-only fix — see [[decisions]] "Resolved markets with NO prior…"). */
function buildMinimalBinary(meta, id, lifecycle) {
  const asOf = new Date().toISOString();
  const lc = lifecycle ?? classifyLifecycle(statusFromLegs([{
    closed: meta.closed, active: meta.active, accepting_orders: meta.accepting_orders,
    uma_resolution_status: meta.uma_resolution_status, outcomes: meta.outcomes, outcome_prices: meta.outcome_prices,
  }]), asOf);

  // Align YES/NO to their outcome labels; fall back to positional [0]=YES, [1]=NO.
  const outcomes = parseGammaArr(meta.outcomes) ?? [];
  const prices = parseGammaArr(meta.outcome_prices) ?? [];
  const idxYes = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  const idxNo = outcomes.findIndex((o) => String(o).toLowerCase() === 'no');
  const priceStr = (i, posFallback) =>
    (i >= 0 && prices[i] != null ? String(prices[i]) : (prices[posFallback] != null ? String(prices[posFallback]) : null));
  const yesStr = priceStr(idxYes, 0);
  const noStr = priceStr(idxNo, 1);

  // raw_inputs over the SETTLED prices (threshold 1 = YES, 0 = NO — the same synthetic-key trick the
  // live binary fetcher uses), hashed by canonicalizeRawInputs UNCHANGED. `midpoint_source` is NOT in
  // the canonicalizer, so the frozen hash recipe stays byte-stable.
  const raw_inputs = [
    { token_id: meta.yes_token ?? null, threshold: 1, midpoint: yesStr ?? '0', best_bid: null, best_ask: null, volume: meta.volume ?? null, midpoint_source: 'resolved_settlement' },
    { token_id: meta.no_token ?? null, threshold: 0, midpoint: noStr ?? '0', best_bid: null, best_ask: null, volume: meta.volume ?? null, midpoint_source: 'resolved_settlement' },
  ];

  const live = {
    fetched_at: asOf,
    endpoints: [`https://gamma-api.polymarket.com/events?slug=${id}`],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    probability: num(yesStr),
    probability_no: num(noStr),
    total_volume: meta.volume ?? 0,
    yes_best_bid: null, yes_best_ask: null,
    midpoint_fallback: null, liquidity: null,
    title: meta.title, end_date: meta.end_date,
  };
  const config = defaultBinaryConfig(id, meta.title, meta.end_date);
  const record = buildBinaryRecord(live, METHODOLOGY.version, config, lc);
  record.snapshot.derived.confidence = resolvedConfidence();
  record.snapshot.derived.narrative = `This market resolved ${resolvedOutcomeLabel(lc)}. No further updates.`;

  validateRecord(record);
  return { record, lifecycle: lc, config };
}

/** SURVIVAL (a plain threshold ladder — SpaceX-shaped): a valid ladder record whose markets[] rows
 *  are the settled 0/1 per-threshold outcomes, run through the SAME buildSnapshotRecord + isotonic
 *  adjustment the OPEN path uses. The isotonic step (adjustSnapshot, inside buildDerived) is what
 *  makes this safe even for a genuinely non-monotonic settled ladder (see the comment on
 *  `ladderSettlementLabel` — some 'survival'-classified events are actually two-sided) — it's the
 *  SAME correction mechanism already trusted for noisy LIVE quotes, not new/invented math, and
 *  `adjustment.monotonicity_violations`/`max_adjustment` honestly record how much it had to correct.
 *  @param {Array<object>} legs a fetchMarketMeta result (threshold/label/token_id/volume/…) */
function buildMinimalSurvival(legs, id, lifecycle) {
  const asOf = new Date().toISOString();
  const statusArr = legs.map((m) => ({
    threshold: m.threshold, closed: m.closed, active: m.active, accepting_orders: m.accepting_orders,
    umaResolutionStatus: m.uma_resolution_status, outcomes: m.outcomes, outcomePrices: m.outcome_prices,
  }));
  const lc = lifecycle ?? classifyLifecycle(statusArr, asOf);

  const raw_inputs = [];
  const marketsIn = [];
  for (const m of legs) {
    const settled = settledYesNum(m.outcomes, m.outcome_prices);
    if (settled == null) continue; // drop an unparseable rung — never fabricate its price
    raw_inputs.push({ token_id: m.token_id ?? null, threshold: m.threshold, midpoint: String(settled), best_bid: null, best_ask: null, volume: m.volume ?? null, midpoint_source: 'resolved_settlement' });
    marketsIn.push({ label: m.label, threshold: m.threshold, prob: settled, volume: m.volume ?? null });
  }
  if (marketsIn.length === 0) throw noParseableSettlementError(id);

  const live = {
    fetched_at: asOf,
    endpoints: [`https://gamma-api.polymarket.com/events?slug=${id}`],
    raw_inputs, raw_sha256: hashRawInputs(raw_inputs),
    markets: marketsIn,
  };
  const config = defaultConfigForLadder(marketsIn.map((m) => m.threshold), {
    id, event_slug: id, name: id, unit_prefix: '$', unit_suffix: '',
  });
  const anomalies = { stale: false, closedCount: countClosed(statusArr), liquidityDrop: null };
  const record = buildSnapshotRecord(live, METHODOLOGY.version, anomalies, config, lc);
  attachAnalytics(record, { priors: {}, config });
  record.assumptions_version = null; // no Tier-2 scenarios for a minimal resolved record
  attachNarrative(record, { config });

  record.snapshot.derived.confidence = resolvedConfidence();
  record.snapshot.derived.narrative = `This market has resolved — ${ladderSettlementLabel(lc, '$', '')}. No further updates.`;

  validateRecord(record);
  return { record, lifecycle: lc, config };
}

/** BUCKET_PMF (Bitcoin/Anthropic-style disjoint intervals): settled 0/1 per bucket fed through the
 *  SAME buildPmfLadder the OPEN path uses to derive the survival curve + PMF mean — the "which
 *  bucket won" settlement is a degenerate (single-step) PMF, so no de-vig is needed (exactly one
 *  leg is 1, the rest 0, already summing to 1). Mirrors computeBucketPmfRecord's construction.
 *  @param {object} bucketMeta a fetchBucketMeta result ({title,end_date,unitInfo,legs}) */
function buildMinimalBucketPmf(bucketMeta, id, lifecycle) {
  const asOf = new Date().toISOString();
  const { divisor, unit } = bucketMeta.unitInfo;
  const prefix = unit === '%' ? '' : '$';
  const statusArr = statusFromLegs(bucketMeta.legs);
  const lc = lifecycle ?? classifyLifecycle(statusArr, asOf);

  // Same synthetic-floor trick fetchBucketPmfSnapshot uses for an open-bottom bucket (lo=-Infinity).
  const finiteLos = bucketMeta.legs.map((l) => l.lo).filter(Number.isFinite);
  const minFiniteLo = finiteLos.length ? Math.min(...finiteLos) : 0;
  const finiteWidths = bucketMeta.legs.filter((l) => Number.isFinite(l.lo) && Number.isFinite(l.hi)).map((l) => l.hi - l.lo).sort((a, b) => a - b);
  const medianWidth = finiteWidths.length ? finiteWidths[Math.floor(finiteWidths.length / 2)] : 1;
  const syntheticFloor = minFiniteLo - medianWidth;
  const loKey = (lo) => (Number.isFinite(lo) ? lo : syntheticFloor) / divisor;

  const raw_inputs = [];
  const pmfLegs = [];
  const volByLo = new Map();
  for (const l of bucketMeta.legs) {
    const settled = settledYesNum(l.outcomes, l.outcome_prices);
    if (settled == null) continue;
    const key = loKey(l.lo);
    raw_inputs.push({ token_id: l.token_id ?? null, threshold: key, midpoint: String(settled), best_bid: null, best_ask: null, volume: l.volume ?? null, midpoint_source: 'resolved_settlement' });
    pmfLegs.push({ lo: key, hi: Number.isFinite(l.hi) ? l.hi / divisor : Infinity, prob: settled });
    volByLo.set(key, l.volume ?? 0);
  }
  if (pmfLegs.length === 0) throw noParseableSettlementError(id);

  const { markets: survival, mean: pmfMean } = buildPmfLadder(pmfLegs);
  const markets = survival.map((m) => ({ label: `>${prefix}${m.threshold}${unit}`, threshold: m.threshold, prob: m.prob, volume: volByLo.get(m.threshold) ?? 0 }));

  const live = {
    fetched_at: asOf, endpoints: [`https://gamma-api.polymarket.com/events?slug=${id}`],
    raw_inputs, raw_sha256: hashRawInputs(raw_inputs), markets,
  };
  const config = defaultConfigForLadder(markets.map((m) => m.threshold), {
    id, event_slug: id, name: bucketMeta.title || id, platform: 'prediction index',
    market_url: `https://polymarket.com/event/${id}`,
    resolves: bucketMeta.end_date ? bucketMeta.end_date.slice(0, 10) : null,
    unit_prefix: prefix, unit_suffix: unit,
  });
  const anomalies = { stale: false, closedCount: countClosed(statusArr), liquidityDrop: null };
  const record = buildSnapshotRecord(live, METHODOLOGY.version, anomalies, config, lc);
  attachAnalytics(record, { priors: {}, config });
  record.assumptions_version = null;
  attachNarrative(record, { config });

  const d = record.snapshot.derived;
  d.implied_mean = pmfMean;
  d.total_volume = [...volByLo.values()].reduce((s, v) => s + v, 0);
  d.market_shape = 'bucket_pmf';

  record.snapshot.derived.confidence = resolvedConfidence();
  record.snapshot.derived.narrative = `This market has resolved — ${ladderSettlementLabel(lc, prefix, unit)}. No further updates.`;

  validateRecord(record);
  return { record, lifecycle: lc, config };
}

/** DIRECTIONAL_TOUCH: settled 0/1 per HIGH/LOW leg fed through the SAME impliedRange crossing math
 *  the OPEN path uses (finds the settled touch/no-touch boundary), then buildTouchRecord. A touch
 *  record tolerates empty/one-sided series (implied_range null bounds are an already-handled UI
 *  state — "n/a"), so only a TRULY empty leg set is a hard failure.
 *  @param {object} touchMeta a fetchTouchMeta result ({title,end_date,unitInfo,legs}) */
function buildMinimalTouch(touchMeta, id, lifecycle) {
  const asOf = new Date().toISOString();
  const { divisor, unit } = touchMeta.unitInfo;
  const statusArr = statusFromLegs(touchMeta.legs);
  const lc = lifecycle ?? classifyLifecycle(statusArr, asOf);

  const raw_inputs = [];
  const high = [], low = [];
  for (const l of touchMeta.legs) {
    const settled = settledYesNum(l.outcomes, l.outcome_prices);
    if (settled == null) continue;
    const lvl = l.level / divisor;
    const signed = (l.side === 'HIGH' ? 1 : -1) * lvl;
    raw_inputs.push({ token_id: l.token_id ?? null, threshold: signed, midpoint: String(settled), best_bid: null, best_ask: null, volume: l.volume ?? null, midpoint_source: 'resolved_settlement' });
    (l.side === 'HIGH' ? high : low).push({ level: lvl, prob: settled, volume: l.volume ?? 0 });
  }
  if (high.length + low.length === 0) throw noParseableSettlementError(id);
  high.sort((a, b) => a.level - b.level);
  low.sort((a, b) => a.level - b.level);

  const live = {
    fetched_at: asOf, endpoints: [`https://gamma-api.polymarket.com/events?slug=${id}`],
    raw_inputs, raw_sha256: hashRawInputs(raw_inputs),
    high_series: high, low_series: low, implied_range: impliedRange(high, low),
    unit, total_volume: touchMeta.legs.reduce((s, l) => s + (l.volume ?? 0), 0),
    title: touchMeta.title, end_date: touchMeta.end_date,
  };
  const config = defaultTouchConfig(id, touchMeta.title, touchMeta.end_date);
  const record = buildTouchRecord(live, METHODOLOGY.version, config, lc);

  record.snapshot.derived.confidence = resolvedConfidence();
  record.snapshot.derived.narrative = `This market has resolved — ${touchSettlementLabel(high, low, unit)}. No further updates.`;

  validateRecord(record);
  return { record, lifecycle: lc, config };
}

/** CATEGORICAL: settled 0/1 per outcome fed through the SAME buildCategoricalRecord the OPEN path
 *  uses (de-vig is a no-op on an already-degenerate 0/1 distribution). Its `outcomes` field itself
 *  has no minItems (parseCategoricalOutcomes/shannonEntropy degrade gracefully to an empty
 *  distribution), but `raw_inputs` has a SCHEMA-WIDE minItems:1 (every shape's snapshot requires
 *  at least one raw input row) — so an all-unparseable leg set still needs the same honest 409 as
 *  ladder/touch, it just can't be skipped via a degenerate `outcomes` value.
 *  @param {object} catMeta a fetchCategoricalMeta result ({title,end_date,legs}) */
function buildMinimalCategorical(catMeta, id, lifecycle) {
  const asOf = new Date().toISOString();
  const statusArr = statusFromLegs(catMeta.legs);
  const lc = lifecycle ?? classifyLifecycle(statusArr, asOf);

  const raw_inputs = [];
  const outcomes = [];
  catMeta.legs.forEach((l, i) => {
    const settled = settledYesNum(l.outcomes, l.outcome_prices);
    if (settled == null) return; // skip by original index — mirrors fetchCategoricalSnapshot
    raw_inputs.push({ token_id: l.token_id ?? null, threshold: i, midpoint: String(settled), best_bid: null, best_ask: null, volume: l.volume ?? null, midpoint_source: 'resolved_settlement' });
    outcomes.push({ label: l.label, prob: settled, volume: l.volume ?? null, midpoint_source: 'resolved_settlement' });
  });
  if (raw_inputs.length === 0) throw noParseableSettlementError(id);

  const live = {
    fetched_at: asOf, endpoints: [`https://gamma-api.polymarket.com/events?slug=${id}`],
    raw_inputs, raw_sha256: hashRawInputs(raw_inputs),
    outcomes, total_volume: catMeta.legs.reduce((s, l) => s + (l.volume ?? 0), 0),
    title: catMeta.title, end_date: catMeta.end_date,
  };
  const config = defaultCategoricalConfig(id, catMeta.title, catMeta.end_date);
  const record = buildCategoricalRecord(live, METHODOLOGY.version, config, lc);

  const winner = record.snapshot.derived.dominant_outcome;
  record.snapshot.derived.confidence = resolvedConfidence();
  record.snapshot.derived.narrative = `This market has resolved${winner ? ` — winning outcome: ${winner}` : ''}. No further updates.`;

  validateRecord(record);
  return { record, lifecycle: lc, config };
}

/** Compute (or freeze) a BINARY market record. Lifecycle is classified from gamma meta
 *  (no threshold parse); non-OPEN freezes the prior, OPEN runs fetchBinarySnapshot. */
async function computeBinaryRecord({ id, prior = null }) {
  const status = await fetchBinaryStatus({ event_slug: id });
  const lifecycle = classifyLifecycle(status, new Date().toISOString());

  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
      // RESOLVED with no cached prior: build a minimal, valid frozen record from the settled gamma
      // outcomePrices instead of 409ing — so a resolved binary market browses cleanly the first time
      // it's seen (it then caches → future browses SERVE_FINAL). CLOSED_PENDING (trading ended, UMA
      // unconfirmed → no settled outcome and no live prices) genuinely can't be built → still 409.
      if (lifecycle.state === LIFECYCLE.RESOLVED) {
        const meta = await fetchBinaryMeta({ event_slug: id });
        return buildMinimalResolvedRecord('binary', meta, id, lifecycle);
      }
      const e = new Error(`"${id}" is ${lifecycle.state} with no prior record to freeze`);
      e.code = 409;
      throw e;
    }
    return freezeBinaryPriorRecord(prior, lifecycle, id);
  }

  const live = await fetchBinarySnapshot({ event_slug: id });
  const config = defaultBinaryConfig(id, live.title, live.end_date);
  const record = buildBinaryRecord(live, METHODOLOGY.version, config, lifecycle);
  validateRecord(record); // schema (binary branch) + lifecycle — never cache unvalidated
  return { record, lifecycle, config };
}

/**
 * Compute (or freeze) a BUCKET-PMF market record (Bitcoin, Anthropic IPO). The market is a
 * disjoint-interval PMF; fetchBucketPmfSnapshot de-vigs it and derives a survival ladder, so
 * the record is ladder-SHAPED (stored kind 'threshold_ladder', rendered by the ladder detail
 * view) — reusing buildSnapshotRecord/attachAnalytics/attachNarrative. Two overrides: the
 * headline mean is the PMF expectation (bounded — fixes the survival-tail blowup, Bug 2), and
 * total_volume is the true Σ of all bucket volumes. Units are the ladder's own (Bug 1).
 */
async function computeBucketPmfRecord({ id, prior = null }) {
  const status = await fetchBucketStatus({ event_slug: id });
  const lifecycle = classifyLifecycle(status, new Date().toISOString());

  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
      // RESOLVED with no cached prior: build a minimal, valid frozen record from the settled per-
      // bucket outcomePrices (see buildMinimalBucketPmf). CLOSED_PENDING (no settled outcome) still 409s.
      if (lifecycle.state === LIFECYCLE.RESOLVED) {
        const meta = await fetchBucketMeta({ event_slug: id });
        return buildMinimalResolvedRecord('bucket_pmf', meta, id, lifecycle);
      }
      const e = new Error(`"${id}" is ${lifecycle.state} with no prior record to freeze`);
      e.code = 409;
      throw e;
    }
    return { record: freezePriorRecord(prior, lifecycle), lifecycle, config: prior.snapshot?.lifecycleConfig ?? null };
  }

  const live = await fetchBucketPmfSnapshot({ event_slug: id });
  const config = defaultConfigForLadder(
    live.markets.map((m) => m.threshold),
    {
      id, event_slug: id, name: live.title || id, platform: 'prediction index',
      market_url: `https://polymarket.com/event/${id}`,
      resolves: live.end_date ? live.end_date.slice(0, 10) : null,
      // Percentage-denominated buckets read "2%" (no '$' prefix); dollar buckets read "$1.8T".
      unit_prefix: live.unit === '%' ? '' : '$', unit_suffix: live.unit,
    }
  );
  const anomalies = { stale: false, closedCount: countClosed(live.status), liquidityDrop: null };
  const record = buildSnapshotRecord(live, METHODOLOGY.version, anomalies, config, lifecycle);
  attachAnalytics(record, { priors: {}, config }); // no history priors on-demand
  record.assumptions_version = null; // bucket markets carry no Tier-2 scenarios
  attachNarrative(record, { config });

  const d = record.snapshot.derived;
  d.implied_mean = live.pmf_mean; // PMF expectation, not the survival-tail mean
  d.total_volume = live.total_volume; // true Σ bucket volume (the per-boundary value is a liquidity proxy)
  d.market_shape = 'bucket_pmf'; // provenance marker (additive; kind stays 'threshold_ladder')
  validateRecord(record); // schema + invariants + firewall + lifecycle — never cache unvalidated
  return { record, lifecycle, config };
}

/** A MarketConfig for a directional-touch market (kind drives the cache + the touch view). */
function defaultTouchConfig(id, title = null, endDate = null) {
  return {
    id, event_slug: id, name: title || id, kind: 'directional_touch',
    platform: 'prediction index', market_url: `https://polymarket.com/event/${id}`,
    resolves: endDate ? endDate.slice(0, 10) : null,
  };
}

/** Freeze a prior TOUCH record under a non-OPEN lifecycle (no live pull), mirroring the
 *  binary freeze: reconstruct a kind:'directional_touch' config from the prior's asset. */
function freezeTouchPriorRecord(prior, lifecycle, id) {
  const frozen = structuredClone(prior);
  frozen.methodology_version = METHODOLOGY.version;
  frozen.snapshot.lifecycle = lifecycle;
  frozen.snapshot.derived.freshness = buildFreshness(frozen.snapshot.fetched_at, null, undefined, lifecycle);
  validateRecord(frozen);
  const a = prior.asset ?? {};
  const config = { id: a.id ?? id, name: a.name ?? id, kind: 'directional_touch', platform: a.platform ?? 'prediction index', market_url: a.market_url, resolves: a.resolves };
  return { record: frozen, lifecycle, config };
}

/**
 * Compute (or freeze) a DIRECTIONAL-TOUCH market record (WTI/Silver "(LOW)/(HIGH) hit $X").
 * Not a survival ladder — buildTouchRecord produces { kind:'directional_touch', implied_range,
 * high_series, low_series, … } rendered by the dedicated touch view. Lifecycle from gamma meta.
 */
async function computeTouchRecord({ id, prior = null }) {
  const status = await fetchTouchStatus({ event_slug: id });
  const lifecycle = classifyLifecycle(status, new Date().toISOString());

  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
      // RESOLVED with no cached prior: build a minimal, valid frozen record from the settled
      // HIGH/LOW touch outcomes (see buildMinimalTouch). CLOSED_PENDING still 409s.
      if (lifecycle.state === LIFECYCLE.RESOLVED) {
        const meta = await fetchTouchMeta({ event_slug: id });
        return buildMinimalResolvedRecord('directional_touch', meta, id, lifecycle);
      }
      const e = new Error(`"${id}" is ${lifecycle.state} with no prior record to freeze`);
      e.code = 409;
      throw e;
    }
    return freezeTouchPriorRecord(prior, lifecycle, id);
  }

  const live = await fetchTouchSnapshot({ event_slug: id });
  const config = defaultTouchConfig(id, live.title, live.end_date);
  const record = buildTouchRecord(live, METHODOLOGY.version, config, lifecycle);
  validateRecord(record); // schema (touch branch) + lifecycle — never cache unvalidated
  return { record, lifecycle, config };
}

/** A MarketConfig for a categorical market (kind drives the cache + the categorical view). */
function defaultCategoricalConfig(id, title = null, endDate = null) {
  return {
    id, event_slug: id, name: title || id, kind: 'categorical',
    platform: 'prediction index', market_url: `https://polymarket.com/event/${id}`,
    resolves: endDate ? endDate.slice(0, 10) : null,
  };
}

/** Freeze a prior CATEGORICAL record under a non-OPEN lifecycle (no live pull). */
function freezeCategoricalPriorRecord(prior, lifecycle, id) {
  const frozen = structuredClone(prior);
  frozen.methodology_version = METHODOLOGY.version;
  frozen.snapshot.lifecycle = lifecycle;
  frozen.snapshot.derived.freshness = buildFreshness(frozen.snapshot.fetched_at, null, undefined, lifecycle);
  validateRecord(frozen);
  const a = prior.asset ?? {};
  const config = { id: a.id ?? id, name: a.name ?? id, kind: 'categorical', platform: a.platform ?? 'prediction index', market_url: a.market_url, resolves: a.resolves };
  return { record: frozen, lifecycle, config };
}

/**
 * Compute (or freeze) a CATEGORICAL market record (named mutually-exclusive outcomes, e.g.
 * "How many Fed rate cuts in 2026?"). Not a survival ladder — buildCategoricalRecord de-vigs
 * the YES-midpoint PMF into { kind:'categorical', outcomes, dominant_outcome, entropy, … }
 * rendered by the dedicated categorical view. Lifecycle from gamma meta (no threshold parse).
 */
async function computeCategoricalRecord({ id, prior = null }) {
  const status = await fetchCategoricalStatus({ event_slug: id });
  const lifecycle = classifyLifecycle(status, new Date().toISOString());

  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
      // RESOLVED with no cached prior: build a minimal, valid frozen record from the settled
      // per-outcome prices (see buildMinimalCategorical). CLOSED_PENDING still 409s.
      if (lifecycle.state === LIFECYCLE.RESOLVED) {
        const meta = await fetchCategoricalMeta({ event_slug: id });
        return buildMinimalResolvedRecord('categorical', meta, id, lifecycle);
      }
      const e = new Error(`"${id}" is ${lifecycle.state} with no prior record to freeze`);
      e.code = 409;
      throw e;
    }
    return freezeCategoricalPriorRecord(prior, lifecycle, id);
  }

  const live = await fetchCategoricalSnapshot({ event_slug: id });
  const config = defaultCategoricalConfig(id, live.title, live.end_date);
  const record = buildCategoricalRecord(live, METHODOLOGY.version, config, lifecycle);
  validateRecord(record); // schema (categorical branch) + lifecycle — never cache unvalidated
  return { record, lifecycle, config };
}
