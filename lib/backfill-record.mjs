// lib/backfill-record.mjs — the historical record assembler (backfill I2).
//
// Given ONE day's per-leg historical prices (from core/price-history reconstruction) plus the
// market's leg structure (`meta`, fetched once from gamma in I3), build the SAME validated
// canonical record the live path produces — reusing every core builder (buildSnapshotRecord /
// buildBinaryRecord / buildTouchRecord / buildCategoricalRecord / buildPmfLadder). The only
// differences are provenance, all HONEST and HONESTLY MARKED:
//   • the price comes from CLOB prices-history, not a live book → midpoint_source =
//     'clob_price_history', best_bid/best_ask = null, per-day volume = null;
//   • confidence is CAPPED at MEDIUM with a historical-backfill reason (no live book/spread to
//     assess), per the approved decision;
//   • snapshot.source.{backfilled,method} mark the row as reconstructed (schema is open; these
//     stay OUT of canonicalizeRawInputs, so the hash recipe — and the frozen SpaceX hash — are
//     untouched). The raw_sha256 is still real + re-verifiable (hash over the stored raw_inputs).
//
// Mirrors lib/compute.mjs's per-shape routing, but with the live CLOB fetch replaced by the
// supplied daily prices. Pure of network/DB — fetch + write live in I3 (lib/backfill.mjs).

import METHODOLOGY from '../core/methodology.json' with { type: 'json' };
import ASSUMPTIONS from '../core/assumptions.json' with { type: 'json' };
import { hashRawInputs } from '../core/fetch.js';
import { buildSnapshotRecord, attachAnalytics, attachScenarios, attachNarrative } from '../core/snapshot.js';
import { buildBinaryRecord } from '../core/binary.js';
import { buildTouchRecord } from '../core/touch-record.js';
import { buildCategoricalRecord } from '../core/categorical.js';
import { buildPmfLadder } from '../core/bucket.js';
import { impliedRange } from '../core/touch.js';
import { validateRecord } from '../core/validate.js';

export const BACKFILL_MIDPOINT_SOURCE = 'clob_price_history';
export const BACKFILL_REASON = 'reconstructed from CLOB daily price history (historical backfill)';
const HISTORY_ENDPOINT = 'https://clob.polymarket.com/prices-history';
const OPEN = { state: 'OPEN' }; // a historical day was, by construction, an OPEN day
const TIER_RANK = { low: 0, medium: 1, high: 2 };
const NO_FALLBACK = (skipped = []) => ({ lastTradeCount: 0, lastTradeThresholds: [], skippedCount: skipped.length, skippedThresholds: skipped });

/** A backfill raw_inputs row: the historical price as the midpoint, no book, no per-day volume. */
function backfillRawInput(token_id, threshold, price) {
  return { token_id, threshold, midpoint: String(price), best_bid: null, best_ask: null, volume: null, midpoint_source: BACKFILL_MIDPOINT_SOURCE };
}

/** Cap a single confidence dimension {tier,score,reasons} at MEDIUM + add the historical-backfill
 *  reason. A reconstructed day has no live book/spread AND no windowed volume, so BOTH reliability
 *  and liquidity are capped — neither can be assessed from daily prices alone. */
function capDimension(dim) {
  if (!dim) return dim;
  const tier = TIER_RANK[dim.tier] > TIER_RANK.medium ? 'medium' : dim.tier;
  const reasons = [...(dim.reasons ?? [])];
  if (!reasons.some((r) => /historical backfill/i.test(r))) reasons.push(BACKFILL_REASON);
  return { ...dim, tier, reasons };
}

/** Cap confidence (both dimensions) at MEDIUM + add the historical-backfill reason, and mark the
 *  snapshot source as reconstructed. Mutates and returns the record. */
function markBackfill(record) {
  const d = record.snapshot.derived;
  const c = d.confidence;
  if (c) {
    d.confidence = { ...c, reliability: capDimension(c.reliability), liquidity: capDimension(c.liquidity) };
  }
  record.snapshot.source.backfilled = true;
  record.snapshot.source.method = BACKFILL_MIDPOINT_SOURCE;
  return record;
}

function finalize(record) {
  markBackfill(record);
  validateRecord(record); // schema + invariants + firewall — never store an unvalidated backfill row
  return record;
}

// ── per-shape assemblers (each returns a validated record, or null when the day has too few
//    usable legs to compute) ────────────────────────────────────────────────────────────────

function survivalRecord(meta, prices, fetchedAt) {
  const { config } = meta;
  const raw_inputs = [], markets = [], skipped = [];
  for (const leg of meta.legs) {
    const p = prices[leg.token_id];
    if (p == null) { skipped.push(leg.threshold); continue; }
    raw_inputs.push(backfillRawInput(leg.token_id, leg.threshold, p));
    markets.push({ label: leg.label, threshold: leg.threshold, prob: p, volume: null });
  }
  if (raw_inputs.length === 0) return null;
  const live = { fetched_at: fetchedAt, endpoints: [HISTORY_ENDPOINT], raw_inputs, raw_sha256: hashRawInputs(raw_inputs), markets, midpoint_fallback: NO_FALLBACK(skipped) };
  const anomalies = { stale: false, closedCount: 0, liquidityDrop: null };
  const record = buildSnapshotRecord(live, METHODOLOGY.version, anomalies, config, OPEN);
  attachAnalytics(record, { priors: {}, config });
  if (config.scenarios) attachScenarios(record, ASSUMPTIONS); else record.assumptions_version = null;
  attachNarrative(record, { config });
  return finalize(record);
}

function bucketRecord(meta, prices, fetchedAt) {
  const { config } = meta; const unit = meta.unit ?? '';
  const raw_inputs = [], priced = [], skipped = [];
  for (const leg of meta.legs) {
    const p = prices[leg.token_id];
    if (p == null) { skipped.push(leg.lo); continue; }
    raw_inputs.push(backfillRawInput(leg.token_id, leg.lo, p)); // threshold = lower bound (mantissa), mirrors fetchBucketPmfSnapshot
    priced.push({ lo: leg.lo, hi: leg.hi, prob: p });
  }
  if (priced.length < 2) return null;
  const probSum = priced.reduce((s, p) => s + p.prob, 0);
  const norm = probSum > 0 ? probSum : 1;
  const pmfLegs = priced.map((p) => ({ lo: p.lo, hi: Number.isFinite(p.hi) ? p.hi : Infinity, prob: p.prob / norm }));
  const { markets: rungs, mean: pmfMean } = buildPmfLadder(pmfLegs);
  // Percent buckets label ">2%" (no '$'), dollar buckets ">$1.8T" — mirrors fetchBucketPmfSnapshot.
  const prefix = unit === '%' ? '' : '$';
  const markets = rungs.map((m) => ({ label: `>${prefix}${m.threshold}${unit}`, threshold: m.threshold, prob: m.prob, volume: null }));
  const live = { fetched_at: fetchedAt, endpoints: [HISTORY_ENDPOINT], raw_inputs, raw_sha256: hashRawInputs(raw_inputs), markets, midpoint_fallback: NO_FALLBACK(skipped) };
  const anomalies = { stale: false, closedCount: 0, liquidityDrop: null };
  const record = buildSnapshotRecord(live, METHODOLOGY.version, anomalies, config, OPEN);
  attachAnalytics(record, { priors: {}, config });
  record.assumptions_version = null; // bucket markets carry no Tier-2 scenarios
  attachNarrative(record, { config });
  const d = record.snapshot.derived;
  d.implied_mean = pmfMean;   // PMF expectation, not the survival-tail mean (mirrors compute.mjs)
  d.total_volume = 0;
  d.market_shape = 'bucket_pmf';
  return finalize(record);
}

function binaryRecord(meta, prices, fetchedAt) {
  const { config } = meta;
  const pYes = prices[meta.yes_token];
  if (pYes == null) return null; // YES price is the headline — no YES, no row
  const pNo = prices[meta.no_token];
  const raw_inputs = [backfillRawInput(meta.yes_token, 1, pYes)];
  if (pNo != null) raw_inputs.push(backfillRawInput(meta.no_token, 0, pNo));
  const live = {
    fetched_at: fetchedAt, endpoints: [HISTORY_ENDPOINT], raw_inputs, raw_sha256: hashRawInputs(raw_inputs),
    probability: pYes,
    probability_no: pNo != null ? pNo : Number((1 - pYes).toFixed(4)), // complement when NO has no history that day
    total_volume: null, yes_best_bid: null, yes_best_ask: null, midpoint_fallback: NO_FALLBACK(),
  };
  return finalize(buildBinaryRecord(live, METHODOLOGY.version, config, OPEN));
}

function touchRecord(meta, prices, fetchedAt) {
  const { config } = meta; const unit = meta.unit ?? '';
  const raw_inputs = [], high = [], low = [], skipped = [];
  for (const leg of meta.legs) {
    const p = prices[leg.token_id];
    const signed = (leg.side === 'HIGH' ? 1 : -1) * leg.level; // unique signed key (mantissa), mirrors fetchTouchSnapshot
    if (p == null) { skipped.push(signed); continue; }
    raw_inputs.push(backfillRawInput(leg.token_id, signed, p));
    (leg.side === 'HIGH' ? high : low).push({ level: leg.level, prob: p, volume: null });
  }
  if (high.length + low.length < 2) return null;
  high.sort((a, b) => a.level - b.level);
  low.sort((a, b) => a.level - b.level);
  const live = {
    fetched_at: fetchedAt, endpoints: [HISTORY_ENDPOINT], raw_inputs, raw_sha256: hashRawInputs(raw_inputs),
    high_series: high, low_series: low, implied_range: impliedRange(high, low), unit, total_volume: null, midpoint_fallback: NO_FALLBACK(skipped),
  };
  return finalize(buildTouchRecord(live, METHODOLOGY.version, config, OPEN));
}

function categoricalRecord(meta, prices, fetchedAt) {
  const { config } = meta;
  const raw_inputs = [], outcomes = [], skipped = [];
  meta.legs.forEach((leg, i) => {
    const p = prices[leg.token_id];
    if (p == null) { skipped.push(i); return; }
    raw_inputs.push(backfillRawInput(leg.token_id, i, p));
    outcomes.push({ label: leg.label, prob: p, volume: null, midpoint_source: BACKFILL_MIDPOINT_SOURCE });
  });
  if (outcomes.length < 2) return null;
  const live = { fetched_at: fetchedAt, endpoints: [HISTORY_ENDPOINT], raw_inputs, raw_sha256: hashRawInputs(raw_inputs), outcomes, total_volume: null, midpoint_fallback: NO_FALLBACK(skipped) };
  return finalize(buildCategoricalRecord(live, METHODOLOGY.version, config, OPEN));
}

const ASSEMBLERS = {
  survival: survivalRecord,
  bucket_pmf: bucketRecord,
  binary: binaryRecord,
  directional_touch: touchRecord,
  categorical: categoricalRecord,
};

/**
 * Build ONE day's validated backfill record from the market's leg structure + that day's prices.
 *   meta:   { kind, config, ...per-kind leg structure } (see the per-shape assemblers)
 *   prices: { token_id: number(0..1) } for that UTC date (forward-filled upstream)
 *   date:   'YYYY-MM-DD' — becomes the snapshot's fetched_at (00:00 UTC of that day)
 * Returns the record, or null when the day has too few usable legs to compute.
 */
export function buildBackfillRecord({ meta, prices, date }) {
  const assemble = ASSEMBLERS[meta?.kind];
  if (!assemble) throw new Error(`backfill: unsupported kind ${meta?.kind}`);
  const fetchedAt = `${date}T00:00:00.000Z`;
  return assemble(meta, prices ?? {}, fetchedAt);
}
