// test/hardening.test.js — proves each statistical / anomaly / provenance claim
// with a synthetic case. Run: node --test
//
// Covers: PAVA monotonicity + volume weighting, non-negative buckets, median band
// ordering, mean sensitivity ordering, every confidence anomaly reason, validation
// failing loudly on impossible values, and hash match vs mismatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pava, adjustSnapshot, medianBand, meanSensitivity } from '../core/stats.js';
import { computeImpliedMedian } from '../core/metrics.js';
import { scoreConfidence } from '../core/confidence.js';
import { scoreBinaryConfidence } from '../core/binary.js';
import { buildNarrative } from '../core/narrative.js';
import { validateRecord } from '../core/validate.js';
import { hashRawInputs, canonicalizeRawInputs, kindFromMarkets } from '../core/fetch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LATEST = JSON.parse(readFileSync(join(__dirname, '../docs/api/v1/latest.json'), 'utf8'));

test('PAVA enforces non-increasing and pools violators', () => {
  const out = pava([0.9, 0.95, 0.8], [1, 1, 1]); // 0.9<0.95 violates non-increasing
  for (let i = 0; i < out.length - 1; i++) assert.ok(out[i] >= out[i + 1] - 1e-12);
  assert.ok(Math.abs(out[0] - 0.925) < 1e-9 && Math.abs(out[1] - 0.925) < 1e-9); // pooled mean
});

test('PAVA volume weighting pulls toward the more liquid quote', () => {
  // 0.90 (vol 1000) then 0.96 (vol 1) violate; pooled mean ~ 0.90006, near the liquid one
  const out = pava([0.9, 0.96], [1000, 1]);
  assert.ok(out[0] === out[1]); // pooled into one block
  assert.ok(out[0] < 0.905, `pooled ${out[0]} should sit near the high-volume 0.90`);
});

test('adjustSnapshot: non-negative buckets, monotone, sum=1, raw preserved', () => {
  const markets = [
    { label: '>$1T', threshold: 1, prob: 0.9, volume: 1000 },
    { label: '>$1.2T', threshold: 1.2, prob: 0.95, volume: 10 }, // violation
    { label: '>$1.4T', threshold: 1.4, prob: 0.6, volume: 500 },
  ];
  const a = adjustSnapshot(markets);
  assert.equal(a.monotonicity_violations, 1);
  assert.ok(a.max_adjustment > 0);
  for (const m of a.markets) assert.ok(m.bucket_prob >= -1e-9, `bucket ${m.bucket_prob} >= 0`);
  for (let i = 0; i < a.markets.length - 1; i++)
    assert.ok(a.markets[i].adjusted_prob >= a.markets[i + 1].adjusted_prob - 1e-12);
  const sum = 1 - a.markets[0].adjusted_prob + a.markets.reduce((s, m) => s + m.bucket_prob, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(a.markets[1].raw_prob, 0.95); // raw preserved
});

test('medianBand: low <= central <= high', () => {
  const raw = [
    { threshold: 1.8, midpoint: '0.7', best_bid: '0.68', best_ask: '0.72', volume: 100 },
    { threshold: 2.0, midpoint: '0.45', best_bid: '0.43', best_ask: '0.47', volume: 100 },
  ];
  const central = computeImpliedMedian([
    { threshold: 1.8, prob: 0.7 },
    { threshold: 2.0, prob: 0.45 },
  ]);
  const band = medianBand(raw, central);
  assert.ok(band && band.low <= band.central + 1e-9 && band.central <= band.high + 1e-9);
  assert.equal(medianBand(null, central), null); // price-only => null
});

test('meanSensitivity: low <= central <= high', () => {
  const adj = [
    { threshold: 1.8, prob: 0.7 },
    { threshold: 2.0, prob: 0.45 },
    { threshold: 2.4, prob: 0.2 },
  ];
  const m = meanSensitivity(adj);
  assert.ok(m.low <= m.central + 1e-9 && m.central <= m.high + 1e-9);
});

test('confidence surfaces each anomaly reason', () => {
  const markets = Array.from({ length: 16 }, (_, i) => ({ threshold: 1 + i * 0.2, prob: 0.9 - i * 0.05 }));
  const rawInputs = markets.map((m) => ({ best_bid: '0.5', best_ask: '0.51' }));
  const liquidity = { thinCount: 0, total: 16, thinShare: 0 };

  // stale feed is a RELIABILITY signal (the number may be stale).
  const stale = scoreConfidence({ markets, rawInputs, liquidity, anomalies: { stale: true, closedCount: 0, liquidityDrop: null } });
  assert.ok(stale.reliability.reasons.some((r) => /identical to prior snapshot/.test(r)));

  // closed/not-accepting and liquidity-drop are LIQUIDITY signals (you can't transact).
  const closed = scoreConfidence({ markets, rawInputs, liquidity, anomalies: { stale: false, closedCount: 3, liquidityDrop: null } });
  assert.ok(closed.liquidity.reasons.some((r) => /closed \/ not accepting/.test(r)) && closed.liquidity.tier === 'low');

  const drop = scoreConfidence({ markets, rawInputs, liquidity, anomalies: { stale: false, closedCount: 0, liquidityDrop: { triggered: true, pct: 0.55 } } });
  assert.ok(drop.liquidity.reasons.some((r) => /below 7-day median/.test(r)));

  const thin = scoreConfidence({ markets, rawInputs, liquidity: { thinCount: 9, total: 16, thinShare: 9 / 16 } });
  assert.ok(thin.liquidity.reasons.some((r) => /thin liquidity on 9 of 16/.test(r)));
});

test('confidence surfaces midpoint-fallback reasons + degrades; null is a no-op (SpaceX-safety)', () => {
  const markets = Array.from({ length: 16 }, (_, i) => ({ threshold: 1 + i * 0.2, prob: 0.9 - i * 0.05 }));
  const rawInputs = markets.map(() => ({ best_bid: '0.5', best_ask: '0.51' }));
  const liquidity = { thinCount: 0, total: 16, thinShare: 0 };

  // null / absent fallback → identical to no fallback at all (the frozen-record invariant)
  const base = scoreConfidence({ markets, rawInputs, liquidity });
  const nullFb = scoreConfidence({ markets, rawInputs, liquidity, midpointFallback: null });
  assert.deepEqual(nullFb, base, 'null midpointFallback must not change tier/score/reasons');
  const zeroFb = scoreConfidence({ markets, rawInputs, liquidity, midpointFallback: { lastTradeCount: 0, skippedCount: 0, skippedThresholds: [] } });
  assert.deepEqual(zeroFb, base, 'zero-count fallback is also a no-op');

  // last-trade rungs (RELIABILITY: stale-trade provenance) → reason + degraded reliability (was high)
  const lt = scoreConfidence({ markets, rawInputs, liquidity, midpointFallback: { lastTradeCount: 2, lastTradeThresholds: [1.8, 2.0], skippedCount: 0, skippedThresholds: [] } });
  assert.ok(lt.reliability.reasons.some((r) => /2 rung\(s\) priced from last trade \(no live book\)/.test(r)));
  assert.ok(lt.reliability.tier !== 'high' && lt.reliability.score < base.reliability.score);

  // skipped rungs (RELIABILITY: a hole in the CDF) → reason naming the thresholds + low reliability
  const sk = scoreConfidence({ markets, rawInputs, liquidity, midpointFallback: { lastTradeCount: 0, skippedCount: 1, skippedThresholds: [2.4] } });
  assert.ok(sk.reliability.reasons.some((r) => /1 rung\(s\) excluded \(no price\): 2\.4/.test(r)) && sk.reliability.tier === 'low');
});

test('kindFromMarkets: binary / ladder / categorical from event shape (no parser throw)', () => {
  assert.equal(kindFromMarkets([{ question: 'US recession by end of 2026?' }]), 'binary');
  assert.equal(kindFromMarkets([{ question: 'Will WTI hit $75 this week?' }, { question: 'Will WTI hit $80 this week?' }]), 'ladder');
  // multi-leg, non-numeric outcomes → categorical (NOT a thrown "Cannot parse threshold")
  assert.equal(kindFromMarkets([{ question: 'Will Ed Miliband be the next Chancellor?' }, { question: 'Will Rachel Reeves be the next Chancellor?' }]), 'categorical');
  assert.equal(kindFromMarkets([{ question: 'Fed rate cut by June 2026 meeting?' }, { question: 'Fed rate cut by July 2026 meeting?' }]), 'categorical');
  assert.throws(() => kindFromMarkets([]), /no markets/);
});

test('binary confidence (split): liquid → high/high; illiquid+thin → spread drags reliability, volume drags liquidity', () => {
  const liquid = scoreBinaryConfidence({ probability: 0.105, bestBid: '0.10', bestAsk: '0.11', totalVolume: 1_600_000 });
  assert.equal(liquid.reliability.tier, 'high'); // tight spread
  assert.equal(liquid.liquidity.tier, 'high');   // deep volume

  const illiquid = scoreBinaryConfidence({ probability: 0.145, bestBid: '0.08', bestAsk: '0.21', totalVolume: 2978 });
  assert.equal(illiquid.reliability.tier, 'low'); // wide spread
  assert.equal(illiquid.liquidity.tier, 'low');   // thin volume
  assert.ok(illiquid.reliability.reasons.some((r) => /spread .*pp \(illiquid\)/.test(r)));
  assert.ok(illiquid.liquidity.reasons.some((r) => /thin volume/.test(r)));
  assert.ok(illiquid.reliability.reasons.some((r) => /% of the implied probability/.test(r)));

  // Phase-1 last-trade fallback is a RELIABILITY signal here too.
  const lt = scoreBinaryConfidence({ probability: 0.5, bestBid: '0.49', bestAsk: '0.51', totalVolume: 500000, midpointFallback: { lastTradeCount: 1, skippedCount: 0 } });
  assert.ok(lt.reliability.reasons.some((r) => /priced from last trade/.test(r)) && lt.reliability.tier !== 'high');
});

test('validateRecord throws on a negative/inconsistent bucket', () => {
  const tampered = JSON.parse(JSON.stringify(LATEST));
  tampered.snapshot.derived.markets[3].adjusted_prob = 0.999; // breaks monotonicity + bucket
  assert.throws(() => validateRecord(tampered), /invalid/i);
});

test('validateRecord passes on the real published record', () => {
  assert.equal(validateRecord(LATEST), true);
});

test('hash: MATCH on real inputs, MISMATCH on a mutated copy', () => {
  const ri = LATEST.snapshot.raw_inputs;
  assert.equal(hashRawInputs(ri), LATEST.snapshot.source.raw_sha256); // match
  const mutated = JSON.parse(JSON.stringify(ri));
  mutated[0].midpoint = (Number(mutated[0].midpoint) + 0.01).toFixed(4);
  assert.notEqual(hashRawInputs(mutated), LATEST.snapshot.source.raw_sha256); // mismatch
  // canonicalization is stable / order-independent
  assert.equal(canonicalizeRawInputs(ri), canonicalizeRawInputs([...ri].reverse()));
});

test('narrative asserts nothing absent from narrative_components', () => {
  const derived = {
    implied_median: 2.1,
    confidence: {
      reliability: { tier: 'medium', score: 0.6, reasons: ['price-only history (no bid/ask spread)'] },
      liquidity: { tier: 'high', score: 1, reasons: ['deep books'] },
    },
  };
  const density = [{ label: '$2–2.2T', prob: 0.3 }, { label: '$1.8–2T', prob: 0.2 }];
  const { narrative, narrative_components } = buildNarrative({ derived, prior7d: 2.0, prior30d: 2.05, density });
  assert.ok(narrative_components.dominant_bucket.label === '$2–2.2T');
  assert.ok(/\$2–2.2T/.test(narrative)); // dominant bucket claim backed
  assert.ok(/Confidence is medium/.test(narrative)); // caveat backed by tier
  assert.ok(narrative_components.change_7d && narrative_components.change_30d);
});

// ── H1: monoScore honors the SAME immateriality carve-out the TIER already does ──
// R2's tier logic treats a sub-0.5% max isotonic adjustment as immaterial noise (tier stays
// 'high' regardless of rawViolations count) — but monoScore computed the SAME adjustment's
// magnitude/count penalty unconditionally, so a tier=high market could carry a depressed,
// unexplained reliability score (e.g. ~0.6) with no reason string accounting for the gap.
// monoScore must now ALSO short-circuit to 1 (full, pre-adjustment) whenever the adjustment is
// immaterial — mirroring R2's own branch, not a new threshold.
function monoTestLadder() {
  const markets = Array.from({ length: 16 }, (_, i) => ({ threshold: i, prob: 0.5, adjusted_prob: 0.5 }));
  return { markets, rawInputs: markets.map(() => ({ best_bid: '0.49', best_ask: '0.51' })) };
}

test('scoreConfidence: an IMMATERIAL adjustment (<0.5%) keeps monoScore at the pre-adjustment 1, not a violations-penalized value', () => {
  const base = monoTestLadder();
  // rawViolations=1, maxAdjustment=0.2% (< MATERIAL_ADJUSTMENT=0.5%) — R2's own "negligible" branch.
  const c = scoreConfidence({ ...base, rawViolations: 1, maxAdjustment: 0.002 });
  assert.equal(c.reliability.tier, 'high'); // regression: R2's existing immateriality tier carve-out
  // countScore=1 (16/16), spreadScore=0.8 (spread 0.02 → 1-0.02/0.1), monoScore=1 (the fix) →
  // relScore = (1 + 1 + 0.8) / 3 = 0.933. Pre-fix this would have been (1+0.485+0.8)/3 ≈ 0.762 —
  // asserting the exact value locks the fix, not just "some higher number".
  assert.equal(c.reliability.score, 0.933);
});

test('scoreConfidence: a MATERIAL adjustment (≥0.5%) still penalizes monoScore by count + magnitude (unchanged)', () => {
  const base = monoTestLadder();
  // rawViolations=1, maxAdjustment=2% (≥ MATERIAL_ADJUSTMENT) — R2's "medium" branch (rawViolations<=2).
  const c = scoreConfidence({ ...base, rawViolations: 1, maxAdjustment: 0.02 });
  assert.equal(c.reliability.tier, 'medium'); // regression: existing tier behavior, untouched
  // monoScore = (1 - 1/4) * (1 - 0.02/0.1) = 0.75 * 0.8 = 0.6 (same formula as before the fix —
  // the guard only bypasses the formula when the adjustment is immaterial).
  // relScore = (1 + 0.6 + 0.8) / 3 = 0.8.
  assert.equal(c.reliability.score, 0.8);
});
