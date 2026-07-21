// test/resolved-no-prior-shapes.test.js — extends the resolved-no-prior fix (binary; see
// test/resolved-no-prior.test.js) to the 4 remaining market shapes: survival, bucket_pmf,
// directional_touch, categorical.
//
// Each shape's minimal builder constructs a `live`-shaped object from gamma's SETTLED
// outcomePrices, then feeds it through the SAME builder (buildSnapshotRecord/buildTouchRecord/
// buildCategoricalRecord) the OPEN path already uses — mirroring the backfill pattern (a
// `live`-shaped object built from non-live data, run through the one true core/ builder), so no
// bucket/CDF/entropy math is reimplemented here.
//
// Per shape: (a) valid settled data → passes validateRecord, resolved_outcome set, raw_sha256
// present, freshness.final; (b) malformed/partial data → degrades gracefully, never crashes;
// (c) all-unparseable data → the ladder/touch/categorical schema branches all require real
// raw_inputs/markets/series data (raw_inputs has a SCHEMA-WIDE minItems:1), so — unlike binary,
// which always has exactly 2 rows — this is the one case where the honest response is a clean 409,
// never a fabricated threshold/probability; (d) a shape WITH a prior still freezes the prior
// (the minimal builder is never called) — the parity/regression proof.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMinimalResolvedRecord, computeMarketRecord } from '../lib/compute.mjs';
import { buildSnapshotRecord, attachAnalytics, attachNarrative } from '../core/snapshot.js';
import { defaultConfigForLadder } from '../core/market-config.js';
import { validateRecord } from '../core/validate.js';

/** Run `fn` with global.fetch stubbed to return the gamma `events` payload, restoring after
 *  (the same pattern as test/fetch-token-guard.test.js and test/resolved-no-prior.test.js). */
async function withGamma(events, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => events });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

// ── SURVIVAL (a plain "above $X" threshold ladder) ──────────────────────────────────────────────
/** A fetchMarketMeta-shaped legs array for a RESOLVED survival ladder. */
function survivalLegs(prices = ['0', '1', '1', '0']) {
  const thresholds = [40, 45, 50, 55];
  return thresholds.map((threshold, i) => ({
    threshold, label: `>$${threshold}`, token_id: `tok-${threshold}`, volume: 1000 + i * 10,
    closed: true, active: true, accepting_orders: false, uma_resolution_status: 'resolved',
    outcomes: ['Yes', 'No'], outcome_prices: [prices[i], prices[i] === '1' ? '0' : '1'],
  }));
}

test('buildMinimalResolvedRecord(survival): clean monotonic settlement → valid ladder record', () => {
  // Yes at 40,45 / No at 50,55 — a CLEAN one-directional ladder (Yes at low thresholds, No above).
  const legs = survivalLegs(['1', '1', '0', '0']);
  const { record, lifecycle, config } = buildMinimalResolvedRecord('survival', legs, 'bmk');
  validateRecord(record);
  const d = record.snapshot.derived;
  assert.equal(record.snapshot.lifecycle.state, 'RESOLVED');
  assert.equal(lifecycle.state, 'RESOLVED');
  assert.equal(record.snapshot.lifecycle.resolved_outcome.length, 4);
  assert.equal(d.markets.length, 4);
  assert.equal(typeof record.snapshot.source.raw_sha256, 'string');
  assert.ok(record.snapshot.source.raw_sha256.length > 0);
  assert.equal(d.freshness.final, true);
  assert.equal(d.confidence.reliability.tier, 'high');
  assert.equal(d.confidence.liquidity.tier, 'low');
  assert.match(d.narrative, /settled in \$45–\$50/); // lastYes=45 < firstNo=50 → the clean ascending label
  assert.equal(config.kind, undefined); // ladder configs carry no explicit kind (matches the OPEN path)
});

test('buildMinimalResolvedRecord(survival): non-monotonic settlement (mis-shaped market) → honest fallback label, still valid', () => {
  // Yes at 45 sandwiched between No at 40 and No at 50/55 — NOT a clean survival step (the real
  // Bitcoin "reach/dip" market this fix was built for hits exactly this pattern). Must not emit a
  // backwards-reading "$45–$40" range; must still validate via the isotonic adjustment.
  const legs = survivalLegs(['0', '1', '0', '0']);
  const { record } = buildMinimalResolvedRecord('survival', legs, 'bmk2');
  validateRecord(record);
  assert.match(record.snapshot.derived.narrative, /see per-threshold outcomes/);
  assert.ok(record.snapshot.derived.adjustment.monotonicity_violations >= 0); // isotonic step ran, no throw
});

test('buildMinimalResolvedRecord(survival): a rung with unparseable prices is DROPPED, not fabricated', () => {
  const legs = survivalLegs(['1', '1', '0', '0']);
  legs[2] = { ...legs[2], outcomes: null, outcome_prices: null }; // one malformed rung among 4
  const { record } = buildMinimalResolvedRecord('survival', legs, 'bmk3');
  validateRecord(record);
  assert.equal(record.snapshot.derived.markets.length, 3); // the malformed rung is excluded, not zeroed
});

test('buildMinimalResolvedRecord(survival): ALL rungs unparseable → clean 409, never a fabricated ladder', () => {
  const legs = survivalLegs().map((l) => ({ ...l, outcomes: null, outcome_prices: null }));
  assert.throws(() => buildMinimalResolvedRecord('survival', legs, 'bmk4'), (e) => e.code === 409);
});

test('computeMarketRecord(survival): RESOLVED + prior=null → 200-able record (no 409)', async () => {
  const event = {
    title: 'Ladder test', slug: 'ladder-x', closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: survivalLegs(['1', '1', '0', '0']).map((l) => ({
      question: `Will X reach ${l.label.replace('>', 'above ')}?`, closed: true, active: true, acceptingOrders: false,
      umaResolutionStatus: 'resolved', outcomes: l.outcomes, outcomePrices: l.outcome_prices,
      clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
  const { record, lifecycle } = await withGamma([event], () => computeMarketRecord({ id: 'ladder-x', prior: null }));
  assert.equal(lifecycle.state, 'RESOLVED');
  validateRecord(record);
});

// fix/resolved-transition-settled-truth: this used to characterize the freeze-forever bug (a
// RESOLVED transition froze the PRIOR's stale live probabilities, keeping the prior's fetched_at —
// the silent same-key no-op that left resolved markets stuck OPEN in the cache forever). Now a
// RESOLVED transition with a prior tries settled truth FIRST (new fetched_at → a real write); the
// degrade-to-freeze path (unparseable settlement) is covered in test/resolved-transition.test.js.
test('computeMarketRecord(survival): RESOLVED + prior≠null → settled truth wins (builder IS used, new fetched_at)', async () => {
  const legs = survivalLegs(['1', '1', '0', '0']);
  const marketsLive = legs.map((l) => ({ label: l.label, threshold: l.threshold, prob: 0.77, volume: l.volume })); // distinctive 0.77
  const config = defaultConfigForLadder(legs.map((l) => l.threshold), { id: 'ladder-x', event_slug: 'ladder-x', name: 'X' });
  const prior = buildSnapshotRecord({
    fetched_at: '2026-01-01T00:00:00Z', endpoints: ['g'],
    raw_inputs: legs.map((l) => ({ token_id: l.token_id, threshold: l.threshold, midpoint: '0.77', best_bid: null, best_ask: null, volume: l.volume })),
    raw_sha256: 'a'.repeat(64), markets: marketsLive,
  }, '1.0.0', { stale: false, closedCount: 0, liquidityDrop: null }, config, null);
  attachAnalytics(prior, { priors: {}, config });
  prior.assumptions_version = null;
  attachNarrative(prior, { config });

  const event = {
    title: 'Ladder test', slug: 'ladder-x', closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: legs.map((l) => ({
      question: `Will X reach ${l.label.replace('>', 'above ')}?`, closed: true, active: true, acceptingOrders: false,
      umaResolutionStatus: 'resolved', outcomes: l.outcomes, outcomePrices: l.outcome_prices,
      clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
  const { record, lifecycle, writeReplace } = await withGamma([event], () => computeMarketRecord({ id: 'ladder-x', prior }));
  assert.equal(lifecycle.state, 'RESOLVED');
  // The SETTLED (0/1-adjacent) probs win, not the frozen prior's distinctive 0.77 — the minimal
  // builder WAS used. (Yes at 40,45 / No at 50,55 per legs(['1','1','0','0']).)
  assert.ok(record.snapshot.derived.markets.every((m) => m.raw_prob !== 0.77));
  assert.notEqual(record.snapshot.fetched_at, prior.snapshot.fetched_at);
  assert.equal(writeReplace, false);
});

// ── BUCKET_PMF (disjoint-interval PMF, e.g. Bitcoin "between $X and $Y") ────────────────────────
function bucketMeta({ prices = ['0', '1', '0'] } = {}) {
  const legs = [
    { lo: 50000, hi: 60000, unit: '$', token_id: 'b1', volume: 1000 },
    { lo: 60000, hi: 70000, unit: '$', token_id: 'b2', volume: 2000 },
    { lo: 70000, hi: Infinity, unit: '$', token_id: 'b3', volume: 500 },
  ].map((l, i) => ({
    ...l, closed: true, active: true, accepting_orders: false, uma_resolution_status: 'resolved',
    outcomes: ['Yes', 'No'], outcome_prices: [prices[i], prices[i] === '1' ? '0' : '1'],
  }));
  return { title: 'Bucket test', end_date: '2026-07-05T00:00:00Z', unitInfo: { divisor: 1000, unit: 'K' }, excludedCount: 0, legs };
}

test('buildMinimalResolvedRecord(bucket_pmf): the winning bucket settles the ladder (de-vig is a no-op on 0/1)', () => {
  const meta = bucketMeta({ prices: ['0', '1', '0'] }); // the $60K-$70K bucket won
  const { record, lifecycle } = buildMinimalResolvedRecord('bucket_pmf', meta, 'btc-x');
  validateRecord(record);
  const d = record.snapshot.derived;
  assert.equal(lifecycle.state, 'RESOLVED');
  assert.equal(d.market_shape, 'bucket_pmf');
  assert.equal(typeof record.snapshot.source.raw_sha256, 'string');
  assert.ok(record.snapshot.source.raw_sha256.length > 0);
  assert.equal(d.confidence.reliability.tier, 'high');
  assert.equal(d.confidence.liquidity.tier, 'low');
  assert.equal(d.freshness.final, true);
});

test('buildMinimalResolvedRecord(bucket_pmf): a malformed leg is dropped; total_volume excludes it', () => {
  const meta = bucketMeta({ prices: ['0', '1', '0'] });
  meta.legs[2] = { ...meta.legs[2], outcomes: null, outcome_prices: null };
  const { record } = buildMinimalResolvedRecord('bucket_pmf', meta, 'btc-y');
  validateRecord(record);
  assert.equal(record.snapshot.derived.total_volume, 1000 + 2000); // leg 3's 500 excluded (unparseable)
});

test('buildMinimalResolvedRecord(bucket_pmf): ALL legs unparseable → clean 409', () => {
  const meta = bucketMeta();
  meta.legs = meta.legs.map((l) => ({ ...l, outcomes: null, outcome_prices: null }));
  assert.throws(() => buildMinimalResolvedRecord('bucket_pmf', meta, 'btc-z'), (e) => e.code === 409);
});

test('computeMarketRecord(bucket_pmf): RESOLVED + prior=null → 200-able record (no 409)', async () => {
  const meta = bucketMeta({ prices: ['0', '1', '0'] });
  const event = {
    title: 'Bucket test', slug: 'bucket-x', closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: meta.legs.map((l) => ({
      question: `Will X land between $${l.lo} and $${l.hi === Infinity ? '999999' : l.hi}?`,
      closed: true, active: true, acceptingOrders: false, umaResolutionStatus: 'resolved',
      outcomes: l.outcomes, outcomePrices: l.outcome_prices, clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
  const { record, lifecycle } = await withGamma([event], () => computeMarketRecord({ id: 'bucket-x', prior: null }));
  assert.equal(lifecycle.state, 'RESOLVED');
  validateRecord(record);
});

// fix/resolved-transition-settled-truth: was "freezes the prior (builder NOT used)" — see the
// survival test above for the full rationale.
test('computeMarketRecord(bucket_pmf): RESOLVED + prior≠null → settled truth wins (builder IS used, new fetched_at)', async () => {
  const meta = bucketMeta({ prices: ['0', '1', '0'] });
  const event = {
    title: 'Bucket test', slug: 'bucket-x', closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: meta.legs.map((l) => ({
      question: `Will X land between $${l.lo} and $${l.hi === Infinity ? '999999' : l.hi}?`,
      closed: true, active: true, acceptingOrders: false, umaResolutionStatus: 'resolved',
      outcomes: l.outcomes, outcomePrices: l.outcome_prices, clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
  const config = defaultConfigForLadder([50, 60, 70], { id: 'bucket-x', event_slug: 'bucket-x', name: 'X' });
  const prior = buildSnapshotRecord({
    fetched_at: '2026-01-01T00:00:00Z', endpoints: ['g'],
    raw_inputs: [{ token_id: 'p', threshold: 50, midpoint: '0.33', best_bid: null, best_ask: null, volume: 1 }],
    raw_sha256: 'a'.repeat(64),
    markets: [{ label: '>$50', threshold: 50, prob: 0.33, volume: 1 }, { label: '>$60', threshold: 60, prob: 0.11, volume: 1 }, { label: '>$70', threshold: 70, prob: 0.02, volume: 1 }],
  }, '1.0.0', { stale: false, closedCount: 0, liquidityDrop: null }, config, null);
  attachAnalytics(prior, { priors: {}, config });
  prior.assumptions_version = null;
  attachNarrative(prior, { config });
  const { record, lifecycle, writeReplace } = await withGamma([event], () => computeMarketRecord({ id: 'bucket-x', prior }));
  assert.equal(lifecycle.state, 'RESOLVED');
  // The frozen prior's distinctive 0.33/0.11/0.02 probs do NOT survive — settled truth was built.
  assert.ok(!record.snapshot.derived.markets.some((m) => m.raw_prob === 0.33));
  assert.notEqual(record.snapshot.fetched_at, prior.snapshot.fetched_at);
  assert.equal(writeReplace, false);
});

// ── DIRECTIONAL_TOUCH (WTI/Silver "(LOW)/(HIGH) hit $X") ─────────────────────────────────────────
function touchMeta({ highPrices = ['1', '0'], lowPrices = ['0'] } = {}) {
  const legs = [
    { side: 'HIGH', level: 80, token_id: 'h1', volume: 100 },
    { side: 'HIGH', level: 90, token_id: 'h2', volume: 100 },
    { side: 'LOW', level: 60, token_id: 'l1', volume: 100 },
  ].map((l, i) => {
    const price = l.side === 'HIGH' ? highPrices[i] : lowPrices[0];
    return { ...l, closed: true, active: true, accepting_orders: false, uma_resolution_status: 'resolved', outcomes: ['Yes', 'No'], outcome_prices: [price, price === '1' ? '0' : '1'] };
  });
  return { title: 'Touch test', end_date: '2026-07-05T00:00:00Z', unitInfo: { divisor: 1, unit: '' }, legs };
}

test('buildMinimalResolvedRecord(directional_touch): touched HIGH $80, not $90, not LOW $60 → valid range', () => {
  const meta = touchMeta({ highPrices: ['1', '0'], lowPrices: ['0'] });
  const { record, lifecycle } = buildMinimalResolvedRecord('directional_touch', meta, 'touch-x');
  validateRecord(record);
  const d = record.snapshot.derived;
  assert.equal(lifecycle.state, 'RESOLVED');
  assert.equal(d.kind, 'directional_touch');
  assert.equal(d.high_series.length, 2);
  assert.equal(d.low_series.length, 1);
  assert.match(d.narrative, /touched HIGH \$80/);
  assert.equal(d.confidence.reliability.tier, 'high');
  assert.equal(d.confidence.liquidity.tier, 'low');
});

test('buildMinimalResolvedRecord(directional_touch): one-sided (HIGH-only legs) still valid — implied_range tolerates a null bound', () => {
  const meta = touchMeta();
  meta.legs = meta.legs.filter((l) => l.side === 'HIGH'); // drop the LOW leg entirely
  const { record } = buildMinimalResolvedRecord('directional_touch', meta, 'touch-y');
  validateRecord(record);
  assert.equal(record.snapshot.derived.low_series.length, 0);
  assert.equal(record.snapshot.derived.implied_range.low, null); // no LOW data → null, never fabricated
});

test('buildMinimalResolvedRecord(directional_touch): %-unit level reads "HIGH 80%", never "HIGH $80%"', () => {
  const meta = touchMeta({ highPrices: ['1', '0'], lowPrices: ['0'] });
  meta.unitInfo = { divisor: 1, unit: '%' };
  const { record } = buildMinimalResolvedRecord('directional_touch', meta, 'touch-pct');
  validateRecord(record);
  const d = record.snapshot.derived;
  assert.match(d.narrative, /touched HIGH 80%/);
  assert.doesNotMatch(d.narrative, /\$/, 'a %-unit settlement label must carry no $ prefix');
});

test('buildMinimalResolvedRecord(directional_touch): a malformed leg is dropped, not fabricated', () => {
  const meta = touchMeta();
  meta.legs[1] = { ...meta.legs[1], outcomes: null, outcome_prices: null };
  const { record } = buildMinimalResolvedRecord('directional_touch', meta, 'touch-z');
  validateRecord(record);
  assert.equal(record.snapshot.derived.high_series.length, 1); // the malformed HIGH leg excluded
});

test('buildMinimalResolvedRecord(directional_touch): ALL legs unparseable → clean 409', () => {
  const meta = touchMeta();
  meta.legs = meta.legs.map((l) => ({ ...l, outcomes: null, outcome_prices: null }));
  assert.throws(() => buildMinimalResolvedRecord('directional_touch', meta, 'touch-w'), (e) => e.code === 409);
});

test('computeMarketRecord(directional_touch): RESOLVED + prior=null → 200-able record (no 409)', async () => {
  const meta = touchMeta();
  const event = {
    title: 'Touch test', slug: 'touch-e', closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: meta.legs.map((l) => ({
      question: `Will X (${l.side}) hit $${l.level}?`, closed: true, active: true, acceptingOrders: false,
      umaResolutionStatus: 'resolved', outcomes: l.outcomes, outcomePrices: l.outcome_prices,
      clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
  const { record, lifecycle } = await withGamma([event], () => computeMarketRecord({ id: 'touch-e', prior: null }));
  assert.equal(lifecycle.state, 'RESOLVED');
  validateRecord(record);
});

// ── CATEGORICAL (named mutually-exclusive outcomes) ─────────────────────────────────────────────
function categoricalMeta({ prices = ['0', '1', '0'] } = {}) {
  const legs = [
    { label: 'Option A', token_id: 'a', volume: 500 },
    { label: 'Option B', token_id: 'b', volume: 800 },
    { label: 'Option C', token_id: 'c', volume: 200 },
  ].map((l, i) => ({
    ...l, closed: true, active: true, accepting_orders: false, uma_resolution_status: 'resolved',
    outcomes: ['Yes', 'No'], outcome_prices: [prices[i], prices[i] === '1' ? '0' : '1'],
  }));
  return { title: 'Categorical test', end_date: '2026-07-05T00:00:00Z', legs };
}

test('buildMinimalResolvedRecord(categorical): the winning outcome dominates (de-vig is a no-op on 0/1)', () => {
  const meta = categoricalMeta({ prices: ['0', '1', '0'] });
  const { record, lifecycle } = buildMinimalResolvedRecord('categorical', meta, 'cat-x');
  validateRecord(record);
  const d = record.snapshot.derived;
  assert.equal(lifecycle.state, 'RESOLVED');
  assert.equal(d.dominant_outcome, 'Option B');
  assert.equal(d.dominant_prob, 1);
  assert.match(d.narrative, /winning outcome: Option B/);
  assert.equal(d.confidence.reliability.tier, 'high');
  assert.equal(d.confidence.liquidity.tier, 'low');
});

test('buildMinimalResolvedRecord(categorical): partial malformed legs degrade gracefully (kept legs still valid)', () => {
  const meta = categoricalMeta({ prices: ['0', '1', '0'] });
  meta.legs[2] = { ...meta.legs[2], outcomes: null, outcome_prices: null };
  const { record } = buildMinimalResolvedRecord('categorical', meta, 'cat-y');
  validateRecord(record);
  assert.equal(record.snapshot.derived.outcomes.length, 2); // Option C dropped, A+B kept
});

test('buildMinimalResolvedRecord(categorical): ALL legs unparseable → clean 409 (raw_inputs needs >=1, schema-wide)', () => {
  const meta = categoricalMeta();
  meta.legs = meta.legs.map((l) => ({ ...l, outcomes: null, outcome_prices: null }));
  assert.throws(() => buildMinimalResolvedRecord('categorical', meta, 'cat-z'), (e) => e.code === 409);
});

test('computeMarketRecord(categorical): RESOLVED + prior=null → 200-able record (no 409)', async () => {
  const meta = categoricalMeta({ prices: ['0', '1', '0'] });
  const event = {
    title: 'Categorical test', slug: 'cat-e', closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: meta.legs.map((l) => ({
      question: `Will the outcome be ${l.label}?`, groupItemTitle: l.label,
      closed: true, active: true, acceptingOrders: false, umaResolutionStatus: 'resolved',
      outcomes: l.outcomes, outcomePrices: l.outcome_prices, clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
  const { record, lifecycle } = await withGamma([event], () => computeMarketRecord({ id: 'cat-e', prior: null }));
  assert.equal(lifecycle.state, 'RESOLVED');
  validateRecord(record);
});

// fix/resolved-transition-settled-truth: was "freezes the prior (builder NOT used)" — see the
// survival test above for the full rationale.
test('computeMarketRecord(categorical): RESOLVED + prior≠null → settled truth wins (builder IS used, new fetched_at)', async () => {
  const meta = categoricalMeta({ prices: ['0', '1', '0'] });
  const event = {
    title: 'Categorical test', slug: 'cat-e2', closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: meta.legs.map((l) => ({
      question: `Will the outcome be ${l.label}?`, groupItemTitle: l.label,
      closed: true, active: true, acceptingOrders: false, umaResolutionStatus: 'resolved',
      outcomes: l.outcomes, outcomePrices: l.outcome_prices, clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
  const priorConfig = { id: 'cat-e2', name: 'X', kind: 'categorical', platform: 'polymarket', market_url: 'https://polymarket.com/event/cat-e2', resolves: '2026-07-05' };
  const { buildCategoricalRecord } = await import('../core/categorical.js');
  const prior = buildCategoricalRecord({
    fetched_at: '2026-01-01T00:00:00Z', endpoints: ['g'],
    raw_inputs: [{ token_id: 'x', threshold: 0, midpoint: '0.4', best_bid: null, best_ask: null, volume: 1 }],
    raw_sha256: 'a'.repeat(64),
    outcomes: [{ label: 'Option A', prob: 0.4, volume: 1 }, { label: 'Option B', prob: 0.35, volume: 1 }, { label: 'Option C', prob: 0.25, volume: 1 }],
    total_volume: 3,
  }, '1.0.0', priorConfig, null);
  const { record, lifecycle, writeReplace } = await withGamma([event], () => computeMarketRecord({ id: 'cat-e2', prior }));
  assert.equal(lifecycle.state, 'RESOLVED');
  // Settled truth wins: Option B settled to 1 (prices ['0','1','0']) — NOT the frozen prior's
  // distinctive 40%/35%/25% distribution (which would report Option A).
  assert.equal(record.snapshot.derived.dominant_outcome, 'Option B');
  assert.ok(Math.abs(record.snapshot.derived.dominant_prob - 1) < 1e-9);
  assert.notEqual(record.snapshot.fetched_at, prior.snapshot.fetched_at);
  assert.equal(writeReplace, false);
});
