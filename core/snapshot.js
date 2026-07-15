// core/snapshot.js — assemble the one canonical snapshot record.
//
// Why this exists: this is the single point where raw inputs become derived
// numbers. Every metric is computed from the arbitrage-consistent (isotonic-
// adjusted) curve; raw is preserved alongside. The API serves this record, the
// dashboard renders it, the note narrates it — none recompute. Pure (no I/O).

import {
  computeImpliedMedian,
  computeIqr,
  computeImpliedMean,
  computeDensity,
} from './metrics.js';
import { adjustSnapshot, medianBand, meanSensitivity } from './stats.js';
import { scoreConfidence, nearSettlement } from './confidence.js';
import { buildNarrative } from './narrative.js';
import { buildAnalytics } from './analytics.js';
import { buildScenarios } from './scenarios.js';
import { buildFreshness } from './freshness.js';
import { ASSET } from './fetch.js';
import { labelLt, labelBetween, labelGt } from './market-config.js';

export const SCHEMA_VERSION = '2.1.0';

// Config → derived-metric option slices. A null config means "legacy SpaceX
// defaults" (the function-level defaults), keeping existing callers and the
// SpaceX record byte-identical; a real config supplies the per-market values.
function floorOpts(config) {
  return config ? { liquidityFloor: config.liquidity_floor } : undefined;
}
function meanOpts(config) {
  return config
    ? { belowOffset: config.mean.below_offset, aboveOffset: config.mean.above_offset }
    : undefined;
}
function sensitivityOpts(config) {
  return config
    ? {
        below: config.mean.below_offset,
        above: config.mean.above_offset,
        gridBelow: config.mean.grid_below,
        gridAbove: config.mean.grid_above,
      }
    : undefined;
}
function confidenceOpts(config) {
  return config
    ? {
        countHigh: config.confidence.count_high,
        countMedium: config.confidence.count_medium,
        ladderSize: config.confidence.ladder_size,
      }
    : {};
}
function densityLabels(config) {
  return config
    ? { lt: (t) => labelLt(config, t), between: (a, b) => labelBetween(config, a, b), gt: (t) => labelGt(config, t) }
    : undefined;
}

function totalVolume(markets) {
  return markets.reduce((sum, m) => sum + (m.volume ?? 0), 0);
}
/** Whole-ish days from `fromIso` to a 'YYYY-MM-DD' resolution date, or null if unknown.
 *  Drives near-settlement detection (Bug 3) for the ladder path. */
function daysUntil(resolves, fromIso) {
  if (!resolves || !fromIso) return null;
  const end = Date.parse(resolves), from = Date.parse(fromIso);
  if (!Number.isFinite(end) || !Number.isFinite(from)) return null;
  return (end - from) / 86_400_000;
}
function probAt(markets, threshold) {
  const row = markets.find((m) => m.threshold === threshold);
  return row ? row.prob : null;
}

/**
 * Core derived block shared by latest and history entries: isotonic adjustment +
 * all metrics from the adjusted curve + confidence. `context` carries optional
 * anomaly inputs for confidence.
 */
function buildDerivedCore({ markets, rawInputs = null, anomalies = null, config = null, lifecycle = null, midpointFallback = null, daysToExpiry = null, liquidity = null }) {
  const adj = adjustSnapshot(markets, floorOpts(config)); // markets carry raw_prob + adjusted_prob + bucket_prob>=0
  const adjusted = adj.markets;
  // SHAPE TRIPWIRE (INC 7 red-team, log-only — the record is untouched): a genuine survival
  // ladder is near-monotone by construction, so when the MAJORITY of adjacent rungs invert,
  // or rungs share one threshold, the board is structurally NOT a P(>X) curve — the signature
  // of a misrouted competing/touch/bare-hit board (the classifier families with no live
  // instance yet). Instrument forward, never guess: this converts "silent wrong number
  // someday" into "logged the day it happens". One structured line, same convention as
  // [touch-meta] / [backfill-trigger].
  const twPairs = Math.max(0, (markets?.length ?? 0) - 1);
  const twDup = new Set((markets ?? []).map((m) => m.threshold)).size < (markets?.length ?? 0);
  if (twPairs >= 2 && (twDup || adj.monotonicity_violations > twPairs * 0.5)) {
    console.warn('[shape-tripwire]', JSON.stringify({
      id: config?.id ?? null,
      violations: adj.monotonicity_violations,
      pairs: twPairs,
      duplicate_thresholds: twDup,
    }));
  }
  const impliedMedian = computeImpliedMedian(adjusted);
  const impliedMean = computeImpliedMean(adjusted, meanOpts(config)); // central / base case
  // Bug 3: near-settlement is computed from the ADJUSTED curve + days-to-expiry. The history
  // path passes no daysToExpiry → null → false → confidence + derived byte-identical (Gate 3).
  const nearSettled = nearSettlement(adjusted, daysToExpiry);
  const confidence = scoreConfidence({
    markets: adjusted,
    rawInputs,
    rawViolations: adj.monotonicity_violations,
    maxAdjustment: adj.max_adjustment,
    liquidity: adj.liquidity,
    anomalies,
    lifecycle,
    midpointFallback,
    nearSettled,
    windowedVolume: liquidity, // Increment 1; null on frozen replay → byte-identical
    daysToExpiry, // Increment 3: widens spread tolerance near expiry (SpaceX ~550d → ×1.0 → identical)
    ...confidenceOpts(config),
  });
  return {
    implied_median: impliedMedian,
    implied_mean: impliedMean,
    iqr: computeIqr(adjusted),
    total_volume: totalVolume(adjusted),
    adjustment: {
      monotonicity_violations: adj.monotonicity_violations,
      max_adjustment: adj.max_adjustment,
    },
    confidence,
    markets: adjusted,
    _adj: adj, // internal: not serialized at call sites that omit it
    _nearSettled: nearSettled, // internal: surfaced as derived.near_settlement only when true
    _liquidity: liquidity, // internal: surfaced as derived.liquidity only when windowed data exists
  };
}

/** Full "current" derived block: core + spread-implied median band + mean sensitivity. */
export function buildDerived({ markets, rawInputs = null, anomalies = null, config = null, lifecycle = null, midpointFallback = null, daysToExpiry = null, liquidity = null }) {
  const core = buildDerivedCore({ markets, rawInputs, anomalies, config, lifecycle, midpointFallback, daysToExpiry, liquidity });
  const median = medianBand(rawInputs, core.implied_median);
  const mean = meanSensitivity(core.markets, sensitivityOpts(config));
  const { _adj, _nearSettled, _liquidity, ...clean } = core;
  const derived = { ...clean, median, mean };
  // OMIT when false/absent so a normal ladder's derived block is byte-identical (SpaceX parity Gate 2).
  if (_nearSettled) derived.near_settlement = true;
  if (_liquidity) derived.liquidity = _liquidity; // Increment 1: windowed volume, omit-when-absent
  return derived;
}

/**
 * Build the full canonical record from a core/fetch.js live result.
 *   live: { fetched_at, endpoints, raw_inputs, raw_sha256, markets }
 *   anomalies: { stale, closedCount, liquidityDrop } (from orchestration)
 */
export function buildSnapshotRecord(live, methodologyVersion, anomalies = null, config = null, lifecycle = null, freshnessThresholdHours = undefined) {
  if (!config) throw new Error('buildSnapshotRecord: a MarketConfig is required (no silent SpaceX defaults)');
  const derived = buildDerived({
    markets: live.markets,
    rawInputs: live.raw_inputs,
    anomalies,
    config,
    lifecycle,
    midpointFallback: live.midpoint_fallback ?? null, // absent on history/frozen paths → no-op (SpaceX byte-identical)
    daysToExpiry: daysUntil(config.resolves, live.fetched_at), // Bug 3 near-settlement (SpaceX ~18mo out → false)
    liquidity: live.liquidity ?? null, // Increment 1 windowed volume; absent on frozen replay → omitted
  });
  // Tier-1 freshness: pure function of this snapshot's own as-of timestamp + a
  // threshold. BOTH the cron path and the on-demand serverless path now pass nothing
  // → the schedule-derived 17h default (SpaceX byte-identical). The on-demand path
  // formerly passed the 15-min cache TTL here, which made the rail read STALE ~15min
  // after any cron/view — the cache-recompute horizon is NOT the trust-staleness
  // horizon (see core/freshness.js). A non-OPEN market is FINAL, not stale —
  // freshness records that so consumers don't show STALE.
  derived.freshness = buildFreshness(live.fetched_at, null, freshnessThresholdHours, lifecycle);
  const asset = config
    ? { id: config.id, name: config.name, platform: config.platform, market_url: config.market_url, resolves: config.resolves }
    : { ...ASSET };
  const snapshot = {
    snapshot_id: live.fetched_at,
    fetched_at: live.fetched_at,
    source: {
      provider: 'Polymarket',
      endpoints: live.endpoints,
      raw_sha256: live.raw_sha256,
    },
    raw_inputs: live.raw_inputs,
    derived,
  };
  // lifecycle lives OUTSIDE derived (additive) so the derived block stays
  // byte-identical for an OPEN market like SpaceX.
  if (lifecycle) snapshot.lifecycle = lifecycle;
  return {
    schema_version: SCHEMA_VERSION,
    methodology_version: methodologyVersion,
    asset,
    snapshot,
  };
}

/**
 * Attach Tier-1 analytics (derived.market.analytics). Needs history priors, so it
 * runs in orchestration like the narrative. priors = { median_1d, median_7d,
 * median_30d, iqr_width_7d, iqr_width_30d }.
 */
export function attachAnalytics(record, { priors = {}, config = null } = {}) {
  if (!config) throw new Error('attachAnalytics: a MarketConfig is required (no silent SpaceX defaults)');
  const d = record.snapshot.derived;
  const analytics = buildAnalytics({
    markets: d.markets,
    iqr: d.iqr,
    median: d.implied_median,
    priors,
    asOf: record.snapshot.fetched_at.slice(0, 10),
    config,
  });
  d.market = { ...(d.market || {}), analytics };
  return record;
}

/**
 * Attach Tier-2 scenarios (derived.scenarios) + the top-level assumptions_version.
 * registry = parsed core/assumptions.json. Firewall: scenarios are the only place
 * assumption-based numbers live; each leaf carries its sourced assumptions.
 */
export function attachScenarios(record, registry) {
  const d = record.snapshot.derived;
  d.scenarios = buildScenarios({ median: d.implied_median, markets: d.markets, registry });
  record.assumptions_version = registry?.version ?? null;
  return record;
}

/**
 * Attach the deterministic narrative. Uses the already-attached analytics (velocity
 * deltas + shape descriptor), so call AFTER attachAnalytics. Mutates and returns.
 */
export function attachNarrative(record, { prior7d = null, prior30d = null, config = null } = {}) {
  if (!config) throw new Error('attachNarrative: a MarketConfig is required (no silent SpaceX defaults)');
  const d = record.snapshot.derived;
  const density = computeDensity(d.markets, densityLabels(config)).map((b) => ({ label: b.label, prob: b.prob }));
  const { narrative, narrative_components } = buildNarrative({
    derived: d,
    analytics: d.market?.analytics ?? null,
    prior7d,
    prior30d,
    density,
    config,
  });
  d.narrative = narrative;
  d.narrative_components = narrative_components;
  return record;
}

/**
 * Build a single history-day entry (backfill + daily append). Leaner than the
 * current record: scalars + adjusted markets + adjustment + confidence, no band /
 * sensitivity / narrative (those are "current" features).
 */
export function buildHistoryEntry(date, markets, rawInputs = null, config = null) {
  if (!config) throw new Error('buildHistoryEntry: a MarketConfig is required (no silent SpaceX defaults)');
  const core = buildDerivedCore({ markets, rawInputs, config });
  const entry = {
    date,
    implied_median: core.implied_median,
    implied_mean: core.implied_mean,
    iqr: core.iqr,
  };
  // Tracked-threshold probabilities, keyed per the market config (default = the
  // legacy SpaceX rungs prob_1_8t/2_0t/2_4t so existing history is byte-identical).
  const tracked = config?.tracked_thresholds ?? [
    { key: 'prob_1_8t', threshold: 1.8 },
    { key: 'prob_2_0t', threshold: 2.0 },
    { key: 'prob_2_4t', threshold: 2.4 },
  ];
  for (const { key, threshold } of tracked) entry[key] = probAt(core.markets, threshold);
  entry.adjustment = core.adjustment;
  entry.confidence = core.confidence;
  entry.markets = core.markets;
  return entry;
}
