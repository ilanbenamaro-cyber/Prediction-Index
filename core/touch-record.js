// core/touch-record.js — build the canonical record for a DIRECTIONAL-TOUCH market.
//
// Peer to binary.js/snapshot.js's builders. A touch market has no settlement distribution
// (no CDF, no median); its derived block is { kind:'directional_touch', implied_range,
// high_series, low_series, confidence, narrative, freshness }. Provenance reuses the SAME
// hash recipe as every other kind (canonicalizeRawInputs over raw_inputs). Confidence is
// scored from spread + volume + fallback (no ladder concepts). Kept OUT of core/touch.js so
// fetch.js can import the pure parser/range without pulling snapshot.js (import-cycle safe).

import { buildFreshness } from './freshness.js';
import { SCHEMA_VERSION } from './snapshot.js';
import { nearSettlement, windowedVolumeSignal, bookDepthSignal, spreadToleranceMultiplier, expiryNote, worstTier } from './confidence.js';

/** Whole days from `fromIso` to a `YYYY-MM-DD` resolution date, or null if unknown. */
function daysUntil(resolves, fromIso) {
  if (!resolves) return null;
  const end = Date.parse(resolves), from = Date.parse(fromIso);
  if (!Number.isFinite(end) || !Number.isFinite(from)) return null;
  return (end - from) / 86_400_000;
}

const SPREAD_HIGH = 0.04; // mirror the ladder/binary spread thresholds (4pp / 8pp)
const SPREAD_MEDIUM = 0.08;
const VOL_HIGH = 100_000;
const VOL_MEDIUM = 10_000;
const TIER_SCORE = { high: 1, medium: 0.5, low: 0.15 };

/** Mean bid/ask spread across the priced touch legs, or null if no book data. */
function meanSpread(rawInputs) {
  const spreads = (rawInputs ?? [])
    .filter((r) => r.best_bid != null && r.best_ask != null)
    .map((r) => Number(r.best_ask) - Number(r.best_bid));
  return spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
}

/**
 * Score a touch snapshot into the two independent dimensions:
 *   RELIABILITY — spread (well-defined price; Bug 3 measured-value language), last-trade fallback.
 *   LIQUIDITY   — windowed (recent) volume, with all-time volume as the fallback.
 * Returns { reliability:{tier,score,reasons}, liquidity:{tier,score,reasons} }.
 */
export function scoreTouchConfidence({ rawInputs, totalVolume, midpointFallback = null, lifecycle = null, nearSettled = false, windowedVolume = null, daysToExpiry = null }) {
  const relTiers = [], relReasons = [];
  const liqTiers = [], liqReasons = [];
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';
  const spread = meanSpread(rawInputs);
  // Increment 3: spread tolerance widens near expiry.
  const spreadMult = spreadToleranceMultiplier(daysToExpiry);
  const note = expiryNote(daysToExpiry);

  // ════ RELIABILITY ════
  if (spread == null) {
    if (!settled) { relTiers.push('medium'); relReasons.push('no live book (price-only)'); }
  } else if (spread < SPREAD_HIGH * spreadMult) {
    relTiers.push('high');
  } else if (spread <= SPREAD_MEDIUM * spreadMult) {
    relTiers.push('medium');
    relReasons.push(`wide bid-ask spread (${(spread * 100).toFixed(1)}%) — ${spreadMult > 1 ? `expected near expiry${note}` : 'moderate liquidity'}`);
  } else {
    relTiers.push('low');
    relReasons.push(`wide bid-ask spread (${(spread * 100).toFixed(1)}%) — illiquid${note}`);
  }

  if (midpointFallback) {
    if (midpointFallback.lastTradeCount > 0) {
      // A leg off the live book is EXPECTED for a settled/near-settled market (winding down),
      // not a data-quality red flag — so say "settled", don't read as a defect.
      const expected = settled || nearSettled;
      relTiers.push('medium');
      relReasons.push(expected
        ? `${midpointFallback.lastTradeCount} settled leg(s) (priced from last trade)`
        : `${midpointFallback.lastTradeCount} leg(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) { relTiers.push('low'); relReasons.push(`${midpointFallback.skippedCount} leg(s) had no price`); }
  }

  // ════ LIQUIDITY ════
  // Windowed (recent) volume when present (Increment 1); all-time is the fallback.
  const winVol = windowedVolumeSignal(windowedVolume);
  if (winVol) {
    liqTiers.push(winVol.tier);
    if (winVol.reason) liqReasons.push(winVol.reason);
  } else if (totalVolume != null) {
    const v = `$${Math.round(totalVolume).toLocaleString('en-US')}`;
    if (totalVolume >= VOL_HIGH) liqTiers.push('high');
    else if (totalVolume >= VOL_MEDIUM) { liqTiers.push('medium'); liqReasons.push(`moderate volume (${v})`); }
    else { liqTiers.push('low'); liqReasons.push(`thin volume (${v})`); }
  }
  // Book depth (Increment C) — can you transact at SIZE, worst-of with volume. Null → no-op.
  const depth = bookDepthSignal(windowedVolume);
  if (depth) {
    liqTiers.push(depth.tier);
    if (depth.reason) liqReasons.push(depth.reason);
  }

  // ── reliability score ──
  let relScore = spread != null ? Math.max(0, Math.min(1, 1 - spread / 0.1)) : 0.6;
  relScore = Number(Math.max(0, Math.min(1, relScore)).toFixed(3));
  // ── liquidity score ──
  let liqScore = winVol ? TIER_SCORE[winVol.tier]
    : totalVolume != null ? Math.min(1, totalVolume / VOL_HIGH) : 0.6;
  if (depth) liqScore = Math.min(liqScore, TIER_SCORE[depth.tier]); // worst-of: a thin book caps it
  liqScore = Number(Math.max(0, Math.min(1, liqScore)).toFixed(3));

  if (relReasons.length === 0) relReasons.push('tight spreads');
  if (liqReasons.length === 0) liqReasons.push('deep books');

  return {
    reliability: { tier: worstTier(relTiers), score: relScore, reasons: relReasons },
    liquidity: { tier: worstTier(liqTiers), score: liqScore, reasons: liqReasons },
  };
}

/** Display string for a range bound, including the honest "outside the strike ladder" cases
 *  when the 50% crossover falls beyond the quoted levels (Bug 5 ethos — never a bare null). */
function boundLabel(value, series, kind, unit) {
  // TODO: boundLabel hardcodes '$' — fix when first %-unit touch market exists
  //       see .workflows/_knowledge/gotchas.md "touch-record boundLabel"
  if (value != null) return `$${value.toFixed(2)}${unit}`;
  if (!series.length) return 'n/a';
  const levels = series.map((s) => s.level);
  const min = Math.min(...levels), max = Math.max(...levels);
  const allAbove = series.every((s) => s.prob >= 0.5);
  // upper bound (HIGH series, decreasing): all≥0.5 → above the top strike; else → below the bottom
  if (kind === 'high') return allAbove ? `> $${max.toFixed(2)}${unit}` : `< $${min.toFixed(2)}${unit}`;
  // lower bound (LOW series, increasing): all≥0.5 → below the bottom strike; else → above the top
  return allAbove ? `< $${min.toFixed(2)}${unit}` : `> $${max.toFixed(2)}${unit}`;
}

function buildTouchNarrative(name, rangeLabelLow, rangeLabelHigh, confidence) {
  return `Touch market: the implied barrier range for "${name}" is ${rangeLabelLow} to ${rangeLabelHigh} before expiry. This prices the probability of touching price levels, not a settlement value. Reliability is ${confidence.reliability.tier}; liquidity is ${confidence.liquidity.tier}.`;
}

/** Build the full canonical directional-touch record from a fetchTouchSnapshot result. */
export function buildTouchRecord(live, methodologyVersion, config, lifecycle = null, freshnessThresholdHours = undefined) {
  if (!config) throw new Error('buildTouchRecord: a MarketConfig is required');
  const unit = live.unit ?? '';
  const daysToExpiry = daysUntil(config.resolves, live.fetched_at);
  const near_settlement = nearSettlement([...(live.high_series ?? []), ...(live.low_series ?? [])], daysToExpiry);
  const confidence = scoreTouchConfidence({
    rawInputs: live.raw_inputs, totalVolume: live.total_volume,
    midpointFallback: live.midpoint_fallback ?? null, lifecycle, nearSettled: near_settlement,
    windowedVolume: live.liquidity ?? null, // Increment 1
    daysToExpiry, // Increment 3 (already computed above for near_settlement)
  });

  const r = live.implied_range ?? { low: null, high: null, confidence: 0.5 };
  const low_label = boundLabel(r.low, live.low_series ?? [], 'low', unit);
  const high_label = boundLabel(r.high, live.high_series ?? [], 'high', unit);

  const derived = {
    kind: 'directional_touch',
    near_settlement,
    implied_range: { low: r.low ?? null, high: r.high ?? null, confidence: r.confidence ?? 0.5, low_label, high_label, unit },
    high_series: live.high_series ?? [],
    low_series: live.low_series ?? [],
    unit,
    total_volume: live.total_volume ?? 0,
    confidence,
    narrative: buildTouchNarrative(config.name, low_label, high_label, confidence),
    freshness: buildFreshness(live.fetched_at, null, freshnessThresholdHours, lifecycle),
  };
  if (live.liquidity) derived.liquidity = live.liquidity; // Increment 1: windowed volume, omit-when-absent

  const snapshot = {
    snapshot_id: live.fetched_at,
    fetched_at: live.fetched_at,
    source: { provider: 'Polymarket', endpoints: live.endpoints, raw_sha256: live.raw_sha256 },
    raw_inputs: live.raw_inputs,
    derived,
  };
  if (lifecycle) snapshot.lifecycle = lifecycle;

  return {
    schema_version: SCHEMA_VERSION,
    methodology_version: methodologyVersion,
    assumptions_version: null,
    asset: { id: config.id, name: config.name, platform: config.platform, market_url: config.market_url, resolves: config.resolves },
    snapshot,
  };
}
