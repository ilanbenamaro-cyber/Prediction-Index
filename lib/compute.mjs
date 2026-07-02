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
  classifyMarketShape, fetchBinaryStatus, fetchBinarySnapshot,
  fetchBucketStatus, fetchBucketPmfSnapshot,
  fetchTouchStatus, fetchTouchSnapshot,
  fetchCategoricalStatus, fetchCategoricalSnapshot,
} from '../core/fetch.js';
import { buildTouchRecord } from '../core/touch-record.js';
import { buildCategoricalRecord } from '../core/categorical.js';
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

  const { status, lifecycle } = await probeLifecycle(id);
  if (!status || status.length < 2) {
    const e = new Error(`"${id}" is not a usable threshold-ladder event`);
    e.code = 404;
    throw e;
  }

  // Non-OPEN: there are no live midpoints to pull — freeze the prior record.
  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
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
    platform: 'polymarket', market_url: `https://polymarket.com/event/${id}`,
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
  const config = { id: a.id ?? id, name: a.name ?? id, kind: 'binary', platform: a.platform ?? 'polymarket', market_url: a.market_url, resolves: a.resolves };
  return { record: frozen, lifecycle, config };
}

/** Compute (or freeze) a BINARY market record. Lifecycle is classified from gamma meta
 *  (no threshold parse); non-OPEN freezes the prior, OPEN runs fetchBinarySnapshot. */
async function computeBinaryRecord({ id, prior = null }) {
  const status = await fetchBinaryStatus({ event_slug: id });
  const lifecycle = classifyLifecycle(status, new Date().toISOString());

  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
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
      id, event_slug: id, name: live.title || id, platform: 'polymarket',
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
    platform: 'polymarket', market_url: `https://polymarket.com/event/${id}`,
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
  const config = { id: a.id ?? id, name: a.name ?? id, kind: 'directional_touch', platform: a.platform ?? 'polymarket', market_url: a.market_url, resolves: a.resolves };
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
    platform: 'polymarket', market_url: `https://polymarket.com/event/${id}`,
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
  const config = { id: a.id ?? id, name: a.name ?? id, kind: 'categorical', platform: a.platform ?? 'polymarket', market_url: a.market_url, resolves: a.resolves };
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
