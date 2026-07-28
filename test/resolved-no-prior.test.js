// test/resolved-no-prior.test.js — a RESOLVED BINARY market with NO cached prior must build a
// valid minimal frozen record from gamma's settled outcomePrices, not throw a 409.
//
// Context: browsing a resolved market the product never captured while OPEN used to 409
// ("no prior record to freeze") from lib/compute.mjs. Gamma DOES serve resolved markets
// (closed:true + umaResolutionStatus:"resolved" + outcomePrices), so buildMinimalResolvedRecord
// (now a shape-dispatching function — call as `buildMinimalResolvedRecord(shape, meta, id,
// lifecycle?)`) reconstructs a valid record from those settled prices (the FINAL prices are real
// observed data), with a real re-verifiable raw_sha256 over the UNCHANGED canonicalizeRawInputs
// recipe. This file covers the BINARY shape only; the other 4 shapes (survival/bucket_pmf/
// directional_touch/categorical) are covered by test/resolved-no-prior-shapes.test.js. These lock:
// (1) the builder is valid + honest across YES/NO winners and a malformed shape; (2)
// computeMarketRecord returns 200 on RESOLVED + prior=null; (3) the RESOLVED + prior path is
// unchanged (still freezes the prior — the builder is not used).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMinimalResolvedRecord, computeMarketRecord } from '../lib/compute.mjs';
import { buildBinaryRecord } from '../core/binary.js';
import { validateRecord } from '../core/validate.js';

/** A fetchBinaryMeta-shaped object for a RESOLVED binary market. */
function resolvedMeta({ outcomes = ['Yes', 'No'], outcomePrices = ['1', '0'], uma = 'resolved' } = {}) {
  return {
    title: 'Will X beat earnings?',
    question: 'Will X beat earnings?',
    end_date: '2026-02-10T22:00:00Z',
    yes_token: 'token-yes', no_token: 'token-no',
    volume: 9784.27,
    closed: true, active: true, accepting_orders: false,
    uma_resolution_status: uma,
    outcomes, outcome_prices: outcomePrices,
  };
}

// ── buildMinimalResolvedRecord (pure) ─────────────────────────────────────────
test('buildMinimalResolvedRecord: outcomePrices ["1","0"] → valid RESOLVED record, YES won', () => {
  const { record, lifecycle, config } = buildMinimalResolvedRecord('binary', resolvedMeta(), 'x');
  validateRecord(record); // throws if invalid — the load-bearing assertion
  const d = record.snapshot.derived;
  assert.equal(record.snapshot.lifecycle.state, 'RESOLVED');
  assert.equal(lifecycle.state, 'RESOLVED');
  assert.ok(Array.isArray(record.snapshot.lifecycle.resolved_outcome) && record.snapshot.lifecycle.resolved_outcome.length > 0, 'resolved_outcome set');
  assert.equal(record.snapshot.lifecycle.resolved_outcome[0].outcome, 'Yes');
  assert.equal(d.kind, 'binary');
  assert.equal(d.probability, 1);
  assert.equal(d.probability_no, 0);
  assert.equal(typeof record.snapshot.source.raw_sha256, 'string');
  assert.ok(record.snapshot.source.raw_sha256.length > 0, 'raw_sha256 present');
  assert.equal(d.freshness.final, true);
  assert.match(d.narrative, /resolved Yes/i);
  // confidence uses valid enum tiers (not the invalid literal 'RESOLVED'), settled-honest
  assert.equal(d.confidence.reliability.tier, 'high');
  assert.equal(d.confidence.liquidity.tier, 'low');
  assert.equal(config.kind, 'binary');
});

test('buildMinimalResolvedRecord: outcomePrices ["0","1"] → NO won (second outcome)', () => {
  const { record } = buildMinimalResolvedRecord('binary', resolvedMeta({ outcomePrices: ['0', '1'] }), 'x');
  validateRecord(record);
  const d = record.snapshot.derived;
  assert.equal(d.probability, 0);
  assert.equal(d.probability_no, 1);
  assert.equal(record.snapshot.lifecycle.resolved_outcome[0].outcome, 'No');
  assert.match(d.narrative, /resolved No/i);
});

test('buildMinimalResolvedRecord: raw_sha256 differs by settled prices (real, content-dependent hash)', () => {
  const a = buildMinimalResolvedRecord('binary', resolvedMeta({ outcomePrices: ['1', '0'] }), 'x').record.snapshot.source.raw_sha256;
  const b = buildMinimalResolvedRecord('binary', resolvedMeta({ outcomePrices: ['0', '1'] }), 'x').record.snapshot.source.raw_sha256;
  assert.notEqual(a, b);
});

test('buildMinimalResolvedRecord: malformed gamma shape (missing outcomePrices) never throws, stays valid', () => {
  const meta = resolvedMeta({ outcomes: null, outcomePrices: null });
  const { record } = buildMinimalResolvedRecord('binary', meta, 'x'); // must not throw
  validateRecord(record); // still schema-valid
  assert.equal(record.snapshot.derived.kind, 'binary');
  assert.equal(record.snapshot.derived.probability, null); // no price → null (schema allows), never NaN
  assert.equal(record.snapshot.lifecycle.state, 'RESOLVED'); // uma 'resolved' still classifies
});

// ── computeMarketRecord wiring (gamma stubbed) ────────────────────────────────
/** Run `fn` with global.fetch stubbed to return the gamma `events` payload, restoring after. */
async function withGamma(events, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => events });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

const RESOLVED_BINARY_EVENT = {
  title: 'Will X beat earnings?', slug: 'x', closed: true, active: true, endDate: '2026-02-10T22:00:00Z',
  markets: [{
    question: 'Will X beat earnings?', closed: true, active: true, acceptingOrders: false,
    umaResolutionStatus: 'resolved', outcomes: ['Yes', 'No'], outcomePrices: ['1', '0'],
    clobTokenIds: ['token-yes', 'token-no'], volume: 9784.27,
  }],
};

test('computeMarketRecord: RESOLVED binary + prior=null → 200-able record (no 409 throw), valid', async () => {
  const { record, lifecycle } = await withGamma([RESOLVED_BINARY_EVENT],
    () => computeMarketRecord({ id: 'x', prior: null }));
  assert.equal(lifecycle.state, 'RESOLVED');
  assert.equal(record.snapshot.lifecycle.state, 'RESOLVED');
  assert.equal(record.snapshot.derived.kind, 'binary');
  assert.equal(record.snapshot.derived.probability, 1);
  validateRecord(record);
});

// fix/resolved-transition-settled-truth: this used to characterize the freeze-forever bug — a
// RESOLVED transition with a prior froze the PRIOR's stale live probability instead of the settled
// truth, and worse, kept the prior's fetched_at so the write silently no-opped (the market stayed
// OPEN in the cache forever). Now a RESOLVED transition ALWAYS tries settled truth first (a NEW
// fetched_at → a genuine write), and only degrades to a freeze when no leg has a parseable settled
// price (see the DEGRADED test below).
test('computeMarketRecord: RESOLVED binary + prior≠null → settled truth wins (builder IS used, new fetched_at)', async () => {
  // A prior with a DISTINCTIVE 0.42 probability the settled-truth builder (1/0) would never produce.
  const priorLive = {
    fetched_at: '2026-02-01T00:00:00Z', endpoints: ['g'],
    raw_inputs: [
      { token_id: 'y', threshold: 1, midpoint: '0.42', best_bid: null, best_ask: null, volume: 5000 },
      { token_id: 'n', threshold: 0, midpoint: '0.58', best_bid: null, best_ask: null, volume: 5000 },
    ],
    raw_sha256: 'a'.repeat(64), probability: 0.42, probability_no: 0.58, total_volume: 5000, // 64-hex placeholder (schema pattern)
    yes_best_bid: null, yes_best_ask: null, midpoint_fallback: null, liquidity: null,
    title: 'X', end_date: '2026-02-10T22:00:00Z',
  };
  const priorConfig = { id: 'x', name: 'X', kind: 'binary', platform: 'polymarket', market_url: 'https://polymarket.com/event/x', resolves: '2026-02-10' };
  const prior = buildBinaryRecord(priorLive, '1.0.0', priorConfig, null); // OPEN prior

  const { record, lifecycle, writeReplace } = await withGamma([RESOLVED_BINARY_EVENT],
    () => computeMarketRecord({ id: 'x', prior }));
  assert.equal(lifecycle.state, 'RESOLVED');
  // The SETTLED price (1) wins, not the frozen prior's stale 0.42 — proving buildMinimalResolvedRecord IS used.
  assert.equal(record.snapshot.derived.probability, 1);
  assert.notEqual(record.snapshot.fetched_at, priorLive.fetched_at, 'a genuine new fetched_at — never the same-key no-op');
  assert.equal(writeReplace, false, 'settled truth writes as a normal insert, never replace');
  validateRecord(record);
});

// NOTE: unlike the 4 ladder/touch/categorical shapes, buildMinimalBinary never throws the
// "no parseable settled prices" 409 (a missing price just renders `probability: null`, per its own
// contract in test/resolved-no-prior.test.js above) — so the DEGRADE branch of resolveTransition is
// structurally unreachable for the binary shape. That degrade path is covered by the ladder shapes
// (which DO 409 on an all-unparseable settlement) in test/resolved-transition.test.js.
