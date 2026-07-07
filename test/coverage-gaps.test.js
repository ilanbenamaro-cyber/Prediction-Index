// test/coverage-gaps.test.js — direct coverage for critical-path functions that previously had
// none (2026-07-02 audit, Layer 5). Priority order: functions that can produce a WRONG NUMBER
// silently (quantile/mean/shape routing), then failure-path plumbing (freeze, statusFor), then
// display branch logic (jump narrative, score trends). All pure / offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quantileValuation, computeImpliedMean } from '../core/metrics.js';
import { marketShapeFromMarkets, kindFromMarkets } from '../core/fetch.js';
import { scoreTouchConfidence, buildTouchRecord } from '../core/touch-record.js';
import { statusFor } from '../lib/serve-market.mjs';
import { freezePriorRecord } from '../lib/compute.mjs';
import { jumpNarrative } from '../lib/format-detail.mjs';
import { deriveReliabilityTrend, deriveLiquidityTrend } from '../lib/market-history.mjs';
import { buildBackfillRecord } from '../lib/backfill-record.mjs';
import { defaultConfigForLadder } from '../core/market-config.js';
import { buildPmfLadder } from '../core/bucket.js';

// ── quantileValuation / computeImpliedMean (THE median/mean primitives) ────────────────────────
test('quantileValuation: interpolates the crossing; null when S is never crossed', () => {
  const snap = [
    { threshold: 1, prob: 0.9 },
    { threshold: 2, prob: 0.5 },
    { threshold: 3, prob: 0.1 },
  ];
  assert.equal(quantileValuation(snap, 0.5), 2); // exact node crossing (0.5 ≥ S, next < S)
  assert.equal(quantileValuation(snap, 0.7), 1.5); // linear between 0.9 and 0.5
  assert.equal(quantileValuation(snap, 0.95), null); // above every prob → never crossed
  assert.equal(quantileValuation([{ threshold: 1, prob: 0.9 }], 0.5), null); // single point: no pair
  assert.equal(quantileValuation([], 0.5), null);
});

test('computeImpliedMean: tail offsets + bucket midpoints; null on empty', () => {
  assert.equal(computeImpliedMean([]), null);
  const snap = [
    { threshold: 1, prob: 0.8 },
    { threshold: 2, prob: 0.2 },
  ];
  // below-tail (1−0.15)·(1−0.8) + middle 1.5·(0.8−0.2) + above-tail (2+0.4)·0.2
  const expected = 0.85 * 0.2 + 1.5 * 0.6 + 2.4 * 0.2;
  assert.ok(Math.abs(computeImpliedMean(snap) - expected) < 1e-12);
  // custom offsets flow through (the sensitivity grid's contract)
  const custom = computeImpliedMean(snap, { belowOffset: 0.1, aboveOffset: 0.3 });
  assert.ok(Math.abs(custom - (0.9 * 0.2 + 1.5 * 0.6 + 2.3 * 0.2)) < 1e-12);
});

// ── marketShapeFromMarkets (the 5-shape compute router; a mis-route = plausible wrong numbers) ──
test('marketShapeFromMarkets: binary (single leg) before any multi-leg shape test', () => {
  assert.equal(marketShapeFromMarkets([{ question: 'Will X happen?' }]), 'binary');
  // multi-leg delegates to ladderShapeFromMarkets (its branches are covered in market-shape.test.js)
  assert.equal(marketShapeFromMarkets([
    { question: 'SpaceX cap above $1.5T?' }, { question: 'SpaceX cap above $2T?' },
  ]), 'survival');
  assert.throws(() => marketShapeFromMarkets([]), /no markets/i);
});

test('kindFromMarkets: coarse contract (binary | ladder | categorical) unchanged', () => {
  assert.equal(kindFromMarkets([{ question: 'Will X?' }]), 'binary');
  assert.equal(kindFromMarkets([{ question: 'above $2T?' }, { question: 'above $3T?' }]), 'ladder');
  assert.equal(kindFromMarkets([{ question: 'Alice wins?' }, { question: 'Bob wins?' }]), 'categorical');
});

// ── statusFor (error → HTTP status; the serve path's whole failure vocabulary) ──────────────────
test('statusFor: compute codes pass through; validation → 422; upstream → 502; else 500', () => {
  const codeErr = (code) => Object.assign(new Error('x'), { code });
  assert.equal(statusFor(codeErr(404)), 404);
  assert.equal(statusFor(codeErr(409)), 409);
  assert.equal(statusFor(new Error('Record invalid:\n  - schema x')), 422);
  assert.equal(statusFor(new Error('https://gamma… → 500 Internal Server Error')), 502);
  assert.equal(statusFor(new Error('CLOB midpoints: nope')), 502);
  assert.equal(statusFor(new Error('anything else')), 500);
});

// unknown/delisted market (no gamma event for the slug) is "not found", not an upstream failure —
// a typo'd or delisted slug must 404, while a genuine upstream error (429/503/network) stays 502.
test('statusFor: "Gamma API returned no events" → 404 (not 502); other upstream failures stay 502', () => {
  assert.equal(statusFor(new Error('Gamma API returned no events')), 404);
  assert.equal(statusFor(new Error('https://gamma-api.polymarket.com/events?slug=x → 403 Forbidden')), 502);
});

// ── freezePriorRecord (the resolution-transition path; C4's failure mode characterized) ────────
const ladderPrior = () => {
  const config = defaultConfigForLadder([1, 1.5, 2], { id: 'lad', event_slug: 'lad', name: 'Ladder', unit_prefix: '$', unit_suffix: 'T' });
  const meta = { kind: 'survival', config, legs: [
    { token_id: 'A', threshold: 1, label: '>$1T' },
    { token_id: 'B', threshold: 1.5, label: '>$1.5T' },
    { token_id: 'C', threshold: 2, label: '>$2T' },
  ] };
  return buildBackfillRecord({ meta, prices: { A: 0.9, B: 0.6, C: 0.3 }, date: '2026-03-01' });
};

test('freezePriorRecord: a CURRENT-shape prior freezes cleanly (validated, final freshness)', () => {
  const prior = ladderPrior();
  const lifecycle = { state: 'RESOLVED', resolved_outcome: [{ threshold: 1, outcome: 'Yes' }], as_of: '2026-06-01T00:00:00Z' };
  const frozen = freezePriorRecord(prior, lifecycle);
  assert.equal(frozen.snapshot.lifecycle.state, 'RESOLVED');
  assert.equal(frozen.snapshot.derived.freshness.final, true);
  assert.notEqual(frozen, prior); // clone, not a mutation
  assert.equal(prior.snapshot.lifecycle.state, 'OPEN'); // prior untouched
});

test('freezePriorRecord: a PRE-RESHAPE prior (single-tier confidence) fails validation loudly', () => {
  // Characterizes the verify-phase2a C4 failure: a record cached before the confidence split
  // cannot pass the CURRENT schema when it resolves — the serve surfaces 422, never a silent
  // wrong record. (The operational fix is re-seeding stored finals after a breaking reshape.)
  const prior = ladderPrior();
  const d = prior.snapshot.derived;
  d.confidence = { tier: 'high', score: 0.9, reasons: ['old single-tier shape'] }; // pre-0010
  const lifecycle = { state: 'RESOLVED', resolved_outcome: [{ threshold: 1, outcome: 'Yes' }], as_of: '2026-06-01T00:00:00Z' };
  assert.throws(() => freezePriorRecord(prior, lifecycle), /Record invalid/);
});

// ── scoreTouchConfidence (the touch scorer had no direct tests) ─────────────────────────────────
test('scoreTouchConfidence: tight spread → HIGH reliability; wide spread → LOW with reason', () => {
  const tight = scoreTouchConfidence({ rawInputs: [{ best_bid: '0.48', best_ask: '0.50' }], totalVolume: 200_000 });
  assert.equal(tight.reliability.tier, 'high');
  assert.equal(tight.liquidity.tier, 'high'); // all-time fallback ≥ $100K
  const wide = scoreTouchConfidence({ rawInputs: [{ best_bid: '0.30', best_ask: '0.45' }], totalVolume: 200_000 });
  assert.equal(wide.reliability.tier, 'low');
  assert.ok(wide.reliability.reasons.some((r) => /spread/.test(r)));
});

test('scoreTouchConfidence: last-trade legs read "settled" near settlement, a defect otherwise', () => {
  const base = { rawInputs: [{ best_bid: '0.48', best_ask: '0.50' }], totalVolume: 200_000, midpointFallback: { lastTradeCount: 3, skippedCount: 0 } };
  const normal = scoreTouchConfidence(base);
  assert.equal(normal.reliability.tier, 'medium');
  assert.ok(normal.reliability.reasons.some((r) => /no live book/.test(r)));
  const near = scoreTouchConfidence({ ...base, nearSettled: true });
  assert.ok(near.reliability.reasons.some((r) => /settled/.test(r)));
});

test('scoreTouchConfidence: windowed volume replaces the all-time fallback (worst-of with depth)', () => {
  const r = scoreTouchConfidence({
    rawInputs: [{ best_bid: '0.48', best_ask: '0.50' }], totalVolume: 5_000_000, // all-time would be HIGH
    windowedVolume: { volume_24hr: 100, volume_1wk: 500, book_depth: 2_000 },   // recent flow dead + thin book
  });
  assert.equal(r.liquidity.tier, 'low');
  assert.ok(r.liquidity.reasons.some((x) => /thin/.test(x)));
});

// ── jumpNarrative (display branches) ───────────────────────────────────────────────────────────
test('jumpNarrative: empty without a recent jump; pp for prob kinds; $unit for value kinds', () => {
  assert.equal(jumpNarrative(null, 'binary'), '');
  assert.equal(jumpNarrative({ hasRecentJump: false, jumpMagnitude: 0.2 }, 'binary'), '');
  const prob = jumpNarrative({ hasRecentJump: true, jumpMagnitude: -0.12, jumpDate: '2026-06-03', stable: true }, 'binary');
  assert.ok(prob.includes('−12.0pp') && prob.includes('2026-06-03') && prob.includes('stabilized'), prob);
  const val = jumpNarrative({ hasRecentJump: true, jumpMagnitude: 0.4, jumpDate: '2026-06-03', stable: false }, 'survival', 'T');
  assert.ok(val.includes('+$0.40T') && val.includes('continued moving'), val);
});

// ── reliability / liquidity score trends (split-confidence trend cards) ────────────────────────
test('deriveReliabilityTrend / deriveLiquidityTrend: rising, falling, steady, null on legacy rows', () => {
  const rows = (col, vals) => vals.map((v, i) => ({ snapshot_date: `2026-06-0${i + 1}`, snapshot_hour: 0, [col]: v }));
  assert.equal(deriveReliabilityTrend(rows('reliability_score', [0.5, 0.6, 0.9])), 'rising');
  assert.equal(deriveReliabilityTrend(rows('reliability_score', [0.9, 0.7, 0.5])), 'falling');
  assert.equal(deriveReliabilityTrend(rows('reliability_score', [0.8, 0.81])), 'steady'); // <0.05 net
  assert.equal(deriveReliabilityTrend(rows('reliability_score', [null, null])), null); // pre-0010 rows
  assert.equal(deriveLiquidityTrend(rows('liquidity_score', [0.2, 0.5])), 'rising');
  assert.equal(deriveLiquidityTrend([]), null);
});

// ── buildPmfLadder open-bottom heuristic (Hard Stop 2, 2026-07-02) ─────────────────────────────
// The old `l.lo <= 0` gate treated ANY leg with lo<=0 as "the open floor bucket" (mid = hi -
// offset), which is right for a TRULY open (-Infinity) rung but WRONG for a bounded finite rung
// that merely happens to sit at/below 0 (a real percent leg like [-2%, 0%)) — that leg has a
// well-defined width and should use its own (lo+hi)/2 midpoint like any other bucket. Fixed to
// gate strictly on `!Number.isFinite(l.lo)`.

test('buildPmfLadder: a TRULY open-bottom leg (lo=-Infinity) still gets the floor-offset midpoint', () => {
  const legs = [
    { lo: -Infinity, hi: -1, prob: 0.2 },
    { lo: -1, hi: 1, prob: 0.5 },
    { lo: 1, hi: Infinity, prob: 0.3 },
  ];
  const { mean } = buildPmfLadder(legs);
  assert.ok(Number.isFinite(mean), `mean must be finite, got ${mean}`);
  // offset = half the [-1,1) middle-bucket width (2) = 1.
  // open-bottom mid = hi(-1) - offset(1) = -2; middle mid = (-1+1)/2 = 0; top mid = 1 + 1 = 2.
  // mean = .2*(-2) + .5*0 + .3*2 = -0.4 + 0 + 0.6 = 0.2
  assert.ok(Math.abs(mean - 0.2) < 1e-9, `mean=${mean}`);
});

test('buildPmfLadder: a BOUNDED negative leg (lo=-2, finite) uses its own midpoint — minimal isolation', () => {
  // A single bounded leg [-2,0): with no other legs, offset falls back to the boundary span (0
  // here, since there's only one boundary) — so the OLD floor formula gave mid = hi - 0 = 0, while
  // the leg's real midpoint is (-2+0)/2 = -1. This isolates the fix with zero ambiguity from offset.
  const { mean } = buildPmfLadder([{ lo: -2, hi: 0, prob: 1.0 }]);
  assert.equal(mean, -1); // was 0 under the old lo<=0 heuristic
});

test('buildPmfLadder: a BOUNDED negative rung in a realistic multi-bucket percent ladder', () => {
  const legs = [
    { lo: -2, hi: 0, prob: 0.2 },   // bounded negative — must use its own midpoint, not the floor
    { lo: 0, hi: 10, prob: 0.2 },
    { lo: 10, hi: 20, prob: 0.3 },  // the only lo>0 leg → drives the offset (width 10 → offset 5)
    { lo: 20, hi: Infinity, prob: 0.3 },
  ];
  const { mean } = buildPmfLadder(legs);
  // offset = 5 (median of the single lo>0 width, 10, halved).
  // leg1 (-2,0): mid = (-2+0)/2 = -1   [was hi-offset = 0-5 = -5 under the old heuristic]
  // leg2 (0,10): mid = (0+10)/2 = 5    [unaffected here — coincides with hi-offset=10-5=5]
  // leg3 (10,20): mid = 15 (unaffected, lo>0 both before and after)
  // leg4 (20,∞): mid = 20+5 = 25 (unaffected, top bucket)
  // mean = .2*(-1) + .2*5 + .3*15 + .3*25 = -0.2 + 1 + 4.5 + 7.5 = 12.8
  assert.ok(Math.abs(mean - 12.8) < 1e-9, `mean=${mean}`); // was 12.0 under the old heuristic
});

test('buildPmfLadder: dollar-ladder legs with POSITIVE lo are byte-identical (untouched by the fix)', () => {
  // Every leg here has lo > 0, so neither the old `lo<=0` gate nor the new `!isFinite(lo)` gate
  // ever fires for them — both formulas fall through to the same middle/top-bucket branches.
  const legs = [
    { lo: 60_000, hi: 62_000, prob: 0.5 },
    { lo: 62_000, hi: 64_000, prob: 0.3 },
    { lo: 64_000, hi: Infinity, prob: 0.2 },
  ];
  const { mean } = buildPmfLadder(legs);
  // offset: widths pool = [{60000,62000}=2000, {62000,64000}=2000] → median=2000 → offset=1000.
  // mid1=(60000+62000)/2=61000; mid2=(62000+64000)/2=63000; mid3(top)=64000+1000=65000.
  const expected = 0.5 * 61_000 + 0.3 * 63_000 + 0.2 * 65_000;
  assert.ok(Math.abs(mean - expected) < 1e-6, `mean=${mean} expected=${expected}`);
});

// NOTE (disclosed consequence, not covered by the "positive lo unchanged" guarantee above): a
// dollar ladder's OWN "less than $X" leg parses to `{lo: 0, hi: X}` — lo is finite and EXACTLY
// zero, not negative and not -Infinity. Under the literal `!Number.isFinite(l.lo)` fix this leg
// ALSO reroutes out of the floor-offset branch into the plain (lo+hi)/2 midpoint — changing the
// PMF mean contribution of every dollar bucket_pmf market's LOWEST bucket (not just percent
// negative rungs, which is all the background text discussed). See the updated assertion in
// test/bucket.test.js "derived median + PMF mean are correct" for the concrete before/after
// values (61200 -> 55400 on that fixture) and core/bucket.js's inline comment for the rationale
// (a bounded lo=0 has a well-defined width just like any other bucket boundary).

// ── buildTouchRecord stored narrative wording (Hard Stop 3, 2026-07-02) ────────────────────────
test('buildTouchRecord: stored narrative says "implied barrier range", never "trading range"', () => {
  const live = {
    fetched_at: '2026-03-01T00:00:00.000Z', endpoints: [], raw_inputs: [], raw_sha256: 'x',
    high_series: [{ level: 80, prob: 0.9 }, { level: 90, prob: 0.1 }],
    low_series: [{ level: 60, prob: 0.1 }, { level: 70, prob: 0.9 }],
    implied_range: { low: 68, high: 81, confidence: 0.5 },
    unit: '', total_volume: 100_000,
  };
  const config = { id: 'wti', name: 'WTI', platform: 'polymarket', market_url: 'x', resolves: '2026-08-01' };
  const rec = buildTouchRecord(live, '1.7.1', config, { state: 'OPEN' });
  const narrative = rec.snapshot.derived.narrative;
  assert.match(narrative, /implied barrier range/);
  assert.doesNotMatch(narrative, /trading range/);
});
