// Locks the bucket-PMF core: parseBucketLeg against REAL gamma questions (Bitcoin,
// Anthropic IPO) and buildPmfLadder against a controlled PMF whose median/mean are
// hand-computable. A bucket market is a disjoint-interval PMF; the survival curve P(>X)
// is DERIVED from it (so the existing median/IQR/density math applies), and the mean is
// computed directly from the PMF (no astronomical-outlier blowup — Bug 2). See
// MARKET-TYPES-PLAN.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBucketLeg, buildPmfLadder } from '../core/bucket.js';
import { computeImpliedMedian } from '../core/metrics.js';

test('parseBucketLeg: "less than $X" → [0, X]', () => {
  assert.deepEqual(parseBucketLeg('Will the price of Bitcoin be less than $56,000 on June 24?'), { lo: 0, hi: 56000, unit: '$' });
});

test('parseBucketLeg: "between $X and $Y" → [X, Y]', () => {
  assert.deepEqual(parseBucketLeg('Will the price of Bitcoin be between $62,000 and $64,000 on June 24?'), { lo: 62000, hi: 64000, unit: '$' });
});

test('parseBucketLeg: "greater than $Y" → [Y, Infinity)', () => {
  assert.deepEqual(parseBucketLeg('Will the price of Bitcoin be greater than $74,000 on June 24?'), { lo: 74000, hi: Infinity, unit: '$' });
});

test('parseBucketLeg: trillion-unit brackets (Anthropic IPO)', () => {
  assert.deepEqual(parseBucketLeg("Will Anthropic's market cap be less than $1.25T at market close on IPO day?"), { lo: 0, hi: 1.25e12, unit: '$' });
  assert.deepEqual(parseBucketLeg("Will Anthropic's market cap be between $1.5T and $1.75T at market close on IPO day?"), { lo: 1.5e12, hi: 1.75e12, unit: '$' });
  assert.deepEqual(parseBucketLeg("Will Anthropic's market cap be $3.0T or greater at market close on IPO day?"), { lo: 3.0e12, hi: Infinity, unit: '$' });
});

test('parseBucketLeg: categorical leg with no $ → null (excluded from the PMF)', () => {
  assert.equal(parseBucketLeg('Will Anthropic not IPO by December 31, 2027?'), null);
});

// ── percentage-denominated buckets (UK GDP growth) — verbatim gamma phrasings ──
test('parseBucketLeg: "between A% and B%" → [A, B] unit % (positive-only range)', () => {
  assert.deepEqual(parseBucketLeg('Will UK annual GDP growth in 2026 be between 0% and 1%?'), { lo: 0, hi: 1, unit: '%' });
  assert.deepEqual(parseBucketLeg('Will UK annual GDP growth in 2026 be between 4% and 5%?'), { lo: 4, hi: 5, unit: '%' });
});

test('parseBucketLeg: "below 0%" → (-Infinity, 0] unit % (negative-open bottom, no 0 floor)', () => {
  assert.deepEqual(parseBucketLeg('Will UK annual GDP growth in 2026 be below 0%?'), { lo: -Infinity, hi: 0, unit: '%' });
});

test('parseBucketLeg: "X% or higher" → [X, Infinity) unit % (open top)', () => {
  assert.deepEqual(parseBucketLeg('Will UK annual GDP growth in 2026 be 5% or higher?'), { lo: 5, hi: Infinity, unit: '%' });
});

test('parseBucketLeg: negative-to-positive and negative-only percent ranges', () => {
  // negative-to-positive (crosses zero)
  assert.deepEqual(parseBucketLeg('Will growth be between -1% and 1%?'), { lo: -1, hi: 1, unit: '%' });
  // negative-only closed range
  assert.deepEqual(parseBucketLeg('Will growth be between -2% and -1%?'), { lo: -2, hi: -1, unit: '%' });
  // "less than -1%" open bottom below a negative
  assert.deepEqual(parseBucketLeg('Will growth be less than -1%?'), { lo: -Infinity, hi: -1, unit: '%' });
});

test('buildPmfLadder: percent PMF with a below-0 bucket keeps the 0 rung + a zero-crossing median/mean', () => {
  // 5 buckets: (-∞,0)=.10, [0,1)=.30, [1,2)=.40, [2,3)=.15, [3,∞)=.05  (synthetic floor -1 for the open bottom)
  const legs = [
    { lo: -1, hi: 0, prob: 0.10 },  // "below 0%" with the finite synthetic floor
    { lo: 0, hi: 1, prob: 0.30 },
    { lo: 1, hi: 2, prob: 0.40 },
    { lo: 2, hi: 3, prob: 0.15 },
    { lo: 3, hi: Infinity, prob: 0.05 },
  ];
  const { markets, mean } = buildPmfLadder(legs);
  // 0 IS a rung (P(>0) informative); -1 (the floor) is NOT.
  assert.deepEqual(markets.map((m) => m.threshold), [0, 1, 2, 3]);
  assert.deepEqual(markets.map((m) => Math.round(m.prob * 100) / 100), [0.90, 0.60, 0.20, 0.05]); // P(>b) = Σ prob(lo>=b)
  // median: CDF crosses 0.5 between (1,0.60) and (2,0.20) → ~1.25%
  assert.equal(Math.round(computeImpliedMedian(markets) * 100) / 100, 1.25);
  // mean = .10·(-0.5) + .30·0.5 + .40·1.5 + .15·2.5 + .05·(3+offset). offset = half median width (1) = .5
  // = -0.05 + 0.15 + 0.60 + 0.375 + 0.05·3.5 = 1.25
  assert.equal(Math.round(mean * 100) / 100, 1.25);
});

test('buildPmfLadder: derives the survival curve P(>boundary) from the PMF', () => {
  const legs = [
    { lo: 0, hi: 60000, prob: 0.2 },
    { lo: 60000, hi: 62000, prob: 0.5 },
    { lo: 62000, hi: Infinity, prob: 0.3 },
  ];
  const { markets } = buildPmfLadder(legs);
  assert.deepEqual(markets, [
    { threshold: 60000, prob: 0.8 }, // legs with lo >= 60000
    { threshold: 62000, prob: 0.3 }, // legs with lo >= 62000
  ]);
});

test('buildPmfLadder: derived median + PMF mean are correct (no outlier blowup)', () => {
  const legs = [
    { lo: 0, hi: 60000, prob: 0.2 },
    { lo: 60000, hi: 62000, prob: 0.5 },
    { lo: 62000, hi: Infinity, prob: 0.3 },
  ];
  const { markets, mean } = buildPmfLadder(legs);
  // median: CDF crosses 0.5 between (60000,0.8) and (62000,0.3) → 61200 (unaffected — depends only
  // on markets[], not the mean's midpoint formula below)
  assert.equal(Math.round(computeImpliedMedian(markets)), 61200);
  // Hard Stop 2 (2026-07-02): the leg's lo=0 leg previously took the open-bottom-floor formula
  // (hi - offset = 60000 - 1000 = 59000) under the old `lo <= 0` gate. That gate now requires a
  // TRULY open (non-finite) lo — a bounded lo of exactly 0 is a well-defined domain floor with its
  // own [0,hi) midpoint like any other bucket, so it takes (lo+hi)/2 = 30000 instead. See
  // core/bucket.js's inline comment + test/coverage-gaps.test.js for the fix's rationale (fixing a
  // real bias on bounded-negative percent rungs) and its disclosed side effect on this dollar case.
  // mean = 0.2·30000 + 0.5·61000 + 0.3·63000 = 55400 (tail offset unchanged: half the 2000 width)
  assert.equal(Math.round(mean), 55400);
});
