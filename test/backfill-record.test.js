// test/backfill-record.test.js — the historical record assembler (backfill I2).
//
// Each market shape, given one day's per-leg historical prices, must produce a VALIDATED
// record via the SAME core builders the live path uses — with backfill provenance: prices
// from CLOB price-history (midpoint_source='clob_price_history', no book → best_bid/ask null,
// no per-day volume), confidence capped at MEDIUM with a historical-backfill reason, and a
// re-verifiable raw_sha256 (same recipe). The frozen SpaceX hash is never touched (a separate
// gate); this only proves the backfill records are well-formed + honestly provenanced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildBackfillRecord, BACKFILL_MIDPOINT_SOURCE } from '../lib/backfill-record.mjs';
import { canonicalizeRawInputs } from '../core/fetch.js';
import { defaultConfigForLadder } from '../core/market-config.js';

const rehash = (rawInputs) => createHash('sha256').update(canonicalizeRawInputs(rawInputs)).digest('hex');
const minimalConfig = (id, name, kind) => ({ id, event_slug: id, name, kind, platform: 'polymarket', market_url: `https://polymarket.com/event/${id}`, resolves: '2027-12-31' });

/** Every backfill record must carry honest, re-verifiable provenance. */
function assertBackfillProvenance(rec) {
  const s = rec.snapshot;
  assert.equal(s.source.backfilled, true);
  assert.equal(s.source.method, BACKFILL_MIDPOINT_SOURCE);
  for (const ri of s.raw_inputs) {
    assert.equal(ri.midpoint_source, BACKFILL_MIDPOINT_SOURCE);
    assert.equal(ri.best_bid, null);
    assert.equal(ri.best_ask, null);
    assert.equal(ri.volume, null);
  }
  // the stored hash is reproducible from the stored raw_inputs (same recipe)
  assert.equal(s.source.raw_sha256, rehash(s.raw_inputs));
  // BOTH confidence dimensions capped at MEDIUM (never HIGH) with the historical-backfill reason —
  // a reconstructed day has no live book/spread (reliability) AND no windowed volume (liquidity).
  const c = s.derived.confidence;
  for (const dim of ['reliability', 'liquidity']) {
    assert.ok(c[dim].tier === 'medium' || c[dim].tier === 'low', `${dim} tier ${c[dim].tier} should be ≤ medium`);
    assert.ok(c[dim].reasons.some((r) => /historical backfill/i.test(r)), `${dim} has a historical-backfill reason`);
  }
}

// ── survival ladder ─────────────────────────────────────────────────────────────
test('survival: builds a full ladder record with derived markets/iqr/median + provenance', () => {
  const config = defaultConfigForLadder([1, 1.5, 2], { id: 'lad', event_slug: 'lad', name: 'Ladder', unit_prefix: '$', unit_suffix: 'T' });
  const meta = { kind: 'survival', config, legs: [
    { token_id: 'tA', threshold: 1, label: '>$1T' },
    { token_id: 'tB', threshold: 1.5, label: '>$1.5T' },
    { token_id: 'tC', threshold: 2, label: '>$2T' },
  ] };
  const rec = buildBackfillRecord({ meta, prices: { tA: 0.9, tB: 0.6, tC: 0.3 }, date: '2026-03-01' });
  const d = rec.snapshot.derived;
  assert.equal(d.markets.length, 3);
  assert.deepEqual(d.markets.map((m) => m.threshold), [1, 1.5, 2]);
  assert.equal(d.markets.find((m) => m.threshold === 1).prob, 0.9); // monotone → unadjusted
  assert.ok(d.implied_median != null && d.iqr != null);
  assert.equal(rec.snapshot.fetched_at.slice(0, 10), '2026-03-01');
  assertBackfillProvenance(rec);
});

test('survival: a day missing some legs still builds from the rest; all-missing → null', () => {
  const config = defaultConfigForLadder([1, 1.5, 2], { id: 'lad', event_slug: 'lad', name: 'Ladder', unit_prefix: '$', unit_suffix: 'T' });
  const legs = [
    { token_id: 'tA', threshold: 1, label: '>$1T' },
    { token_id: 'tB', threshold: 1.5, label: '>$1.5T' },
  ];
  const partial = buildBackfillRecord({ meta: { kind: 'survival', config, legs }, prices: { tA: 0.8 }, date: '2026-03-02' });
  assert.equal(partial.snapshot.raw_inputs.length, 1);
  const none = buildBackfillRecord({ meta: { kind: 'survival', config, legs }, prices: {}, date: '2026-03-03' });
  assert.equal(none, null);
});

// ── binary ─────────────────────────────────────────────────────────────────────
test('binary: probability = the YES price; NO complements when absent; provenance holds', () => {
  const meta = { kind: 'binary', config: minimalConfig('bin', 'Will X?', 'binary'), yes_token: 'Y', no_token: 'N' };
  const rec = buildBackfillRecord({ meta, prices: { Y: 0.62 }, date: '2026-03-01' });
  assert.equal(rec.snapshot.derived.kind, 'binary');
  assert.equal(rec.snapshot.derived.probability, 0.62);
  assert.ok(Math.abs(rec.snapshot.derived.probability_no - 0.38) < 1e-6); // complement of YES
  assertBackfillProvenance(rec);
});

// ── directional touch ────────────────────────────────────────────────────────────
test('touch: implied range from the 50% crossovers; kind + provenance', () => {
  const meta = { kind: 'directional_touch', config: minimalConfig('wti', 'WTI hit', 'directional_touch'), unit: '',
    legs: [
      { token_id: 'h70', side: 'HIGH', level: 70 }, { token_id: 'h90', side: 'HIGH', level: 90 },
      { token_id: 'l70', side: 'LOW', level: 70 }, { token_id: 'l50', side: 'LOW', level: 50 },
    ] };
  const rec = buildBackfillRecord({ meta, prices: { h70: 0.8, h90: 0.3, l70: 0.7, l50: 0.2 }, date: '2026-03-01' });
  assert.equal(rec.snapshot.derived.kind, 'directional_touch');
  assert.ok(rec.snapshot.derived.implied_range != null);
  assertBackfillProvenance(rec);
});

// ── categorical ──────────────────────────────────────────────────────────────────
test('categorical: de-vigged dominant outcome + provenance', () => {
  const meta = { kind: 'categorical', config: minimalConfig('fed', 'Fed cuts', 'categorical'),
    legs: [{ token_id: 'o0', label: '0 cuts' }, { token_id: 'o1', label: '1 cut' }, { token_id: 'o2', label: '2 cuts' }] };
  const rec = buildBackfillRecord({ meta, prices: { o0: 0.6, o1: 0.3, o2: 0.1 }, date: '2026-03-01' });
  assert.equal(rec.snapshot.derived.kind, 'categorical');
  assert.equal(rec.snapshot.derived.dominant_outcome, '0 cuts');
  assert.ok(Math.abs(rec.snapshot.derived.dominant_prob - 0.6) < 1e-6); // 0.6/(0.6+0.3+0.1)=0.6
  assertBackfillProvenance(rec);
});

// ── bucket PMF ───────────────────────────────────────────────────────────────────
test('bucket_pmf: de-vig → derived survival ladder + PMF mean + market_shape', () => {
  const config = defaultConfigForLadder([60, 62, 64], { id: 'btc', event_slug: 'btc', name: 'BTC', unit_prefix: '$', unit_suffix: 'K' });
  const meta = { kind: 'bucket_pmf', config, unit: 'K', legs: [
    { token_id: 'b0', lo: 0, hi: 60 }, { token_id: 'b1', lo: 60, hi: 62 },
    { token_id: 'b2', lo: 62, hi: 64 }, { token_id: 'b3', lo: 64, hi: Infinity },
  ] };
  const rec = buildBackfillRecord({ meta, prices: { b0: 0.1, b1: 0.3, b2: 0.4, b3: 0.2 }, date: '2026-03-01' });
  const d = rec.snapshot.derived;
  assert.equal(d.market_shape, 'bucket_pmf');
  assert.ok(Array.isArray(d.markets) && d.markets.length >= 2); // derived survival rungs
  assert.ok(d.implied_mean != null);
  assertBackfillProvenance(rec);
});

test('unsupported kind throws', () => {
  assert.throws(() => buildBackfillRecord({ meta: { kind: 'nope', config: minimalConfig('x', 'X', 'nope') }, prices: {}, date: '2026-03-01' }), /unsupported/i);
});

test('bucket_pmf PERCENT: finite thresholds in raw_inputs + %-labels without a "$" prefix', () => {
  // Legs as bucketBackfillMeta now produces them: the open-bottom "below 0%" leg already carries
  // its synthetic finite floor (-1). Every raw_inputs.threshold must be finite (hashable) and the
  // derived rung labels must read ">0%" style — never ">$0%".
  const config = defaultConfigForLadder([0, 1, 2], { id: 'gdp', event_slug: 'gdp', name: 'UK GDP', unit_prefix: '', unit_suffix: '%' });
  const meta = { kind: 'bucket_pmf', config, unit: '%', legs: [
    { token_id: 'p0', lo: -1, hi: 0 }, { token_id: 'p1', lo: 0, hi: 1 },
    { token_id: 'p2', lo: 1, hi: 2 }, { token_id: 'p3', lo: 2, hi: Infinity },
  ] };
  const rec = buildBackfillRecord({ meta, prices: { p0: 0.1, p1: 0.5, p2: 0.3, p3: 0.1 }, date: '2026-03-01' });
  const d = rec.snapshot.derived;
  assert.ok(rec.snapshot.raw_inputs.every((r) => Number.isFinite(r.threshold)), 'every hashed threshold is finite');
  assert.ok(d.markets.length >= 2);
  for (const m of d.markets) {
    assert.ok(!m.label.includes('$'), `percent label carries no $: ${m.label}`);
    assert.ok(m.label.endsWith('%'), `percent label ends with %: ${m.label}`);
  }
  assert.ok(Number.isFinite(d.implied_mean));
  assertBackfillProvenance(rec);
});
