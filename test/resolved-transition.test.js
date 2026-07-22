// test/resolved-transition.test.js — permanent regression coverage for
// fix/resolved-transition-settled-truth (Part 3).
//
// Covers what the other test files don't already:
//   1. writeRecord's loud no-op detection (lib/cache.mjs) — a silent (market_id, fetched_at)
//      conflict under replace:false must throw, never look like success.
//   2. computeMarketRecord's resolved-transition persistence + the degraded-freeze fallback
//      (lib/compute.mjs's resolveTransition, exercised end-to-end via the survival shape, which
//      DOES throw the "no parseable settled prices" 409 buildMinimalBinary never does).
//   3. serveMarket's writeTransitionHistory wiring — called exactly once on a genuine RESOLVED
//      transition, never on a SERVE_FINAL cache hit or a no-prior first-ever browse, and the
//      writeReplace flag threads correctly into writeRecord's `replace` option.
//
// (REFINEMENT 1's "resolution row must not narrate as a jump" coverage lives in
// test/market-history.test.js, alongside the rest of that module's derive-function tests.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeRecord } from '../lib/cache.mjs';
import { computeMarketRecord } from '../lib/compute.mjs';
import { serveMarket } from '../lib/serve-market.mjs';
import { CACHE_TTL_MS } from '../lib/decide-cache-action.mjs';
import { buildSnapshotRecord, attachAnalytics, attachNarrative } from '../core/snapshot.js';
import { defaultConfigForLadder } from '../core/market-config.js';

// ── 1. writeRecord: loud no-op detection ────────────────────────────────────────────────────────

const MIN_RECORD = {
  schema_version: '2.1.0',
  methodology_version: '1.10.0',
  assumptions_version: null,
  asset: { name: 'X' },
  snapshot: {
    fetched_at: '2026-07-01T00:00:00.000Z',
    source: { raw_sha256: 'a'.repeat(64) },
    derived: { confidence: null, implied_median: null, probability: null },
  },
};
const OPEN_LIFECYCLE = { state: 'OPEN', resolved_outcome: null };
const CONFIG = { name: 'X', kind: 'binary' };

/** A minimal stub of the Supabase query-builder chain writeRecord touches:
 *  .from('markets').upsert() and .from('market_snapshots').upsert().select(). */
function fakeSupabase(snapshotSelectResult) {
  return {
    from(table) {
      if (table === 'markets') return { upsert: async () => ({ error: null }) };
      if (table === 'market_snapshots') {
        return { upsert: () => ({ select: async () => snapshotSelectResult }) };
      }
      throw new Error(`fakeSupabase: unexpected table "${table}"`);
    },
  };
}

test('writeRecord: replace:false + an upsert that silently conflicted (empty rows, no error) THROWS loud', async () => {
  const client = fakeSupabase({ data: [], error: null });
  await assert.rejects(
    () => writeRecord('m', MIN_RECORD, OPEN_LIFECYCLE, CONFIG, { client }),
    /silent no-op/,
  );
});

test('writeRecord: replace:true + the SAME empty-rows response does NOT throw (replace was declared)', async () => {
  const client = fakeSupabase({ data: [], error: null });
  await assert.doesNotReject(
    () => writeRecord('m', MIN_RECORD, OPEN_LIFECYCLE, CONFIG, { replace: true, client }),
  );
});

test('writeRecord: a normal non-conflicting write (rows returned) never throws, replace or not', async () => {
  const client = fakeSupabase({ data: [{ market_id: 'm', fetched_at: MIN_RECORD.snapshot.fetched_at }], error: null });
  await assert.doesNotReject(() => writeRecord('m', MIN_RECORD, OPEN_LIFECYCLE, CONFIG, { client }));
  await assert.doesNotReject(() => writeRecord('m', MIN_RECORD, OPEN_LIFECYCLE, CONFIG, { replace: true, client }));
});

test('writeRecord: a real Postgres error from the snapshot upsert still throws its OWN message (unaffected by the no-op check)', async () => {
  const client = fakeSupabase({ data: null, error: { message: 'connection reset' } });
  await assert.rejects(
    () => writeRecord('m', MIN_RECORD, OPEN_LIFECYCLE, CONFIG, { client }),
    /connection reset/,
  );
});

// ── 2. computeMarketRecord: resolved-transition persistence + degraded freeze ───────────────────

/** Run `fn` with global.fetch stubbed to return the gamma `events` payload, restoring after
 *  (the same pattern as test/resolved-no-prior.test.js / test/resolved-no-prior-shapes.test.js). */
async function withGamma(events, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => events });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

function ladderPrior(thresholds, id) {
  const config = defaultConfigForLadder(thresholds, { id, event_slug: id, name: 'X' });
  const prior = buildSnapshotRecord({
    fetched_at: '2026-01-01T00:00:00Z', endpoints: ['g'],
    raw_inputs: thresholds.map((t) => ({ token_id: `tok-${t}`, threshold: t, midpoint: '0.55', best_bid: null, best_ask: null, volume: 100 })),
    raw_sha256: 'a'.repeat(64),
    markets: thresholds.map((t) => ({ label: `>$${t}`, threshold: t, prob: 0.55, volume: 100 })),
  }, '1.0.0', { stale: false, closedCount: 0, liquidityDrop: null }, config, null);
  attachAnalytics(prior, { priors: {}, config });
  prior.assumptions_version = null;
  attachNarrative(prior, { config });
  return prior;
}

function ladderEvent(slug, legs) {
  return {
    title: 'Ladder test', slug, closed: true, active: true, endDate: '2026-07-05T00:00:00Z',
    markets: legs.map((l) => ({
      question: `Will X reach above $${l.threshold}?`, closed: true, active: true, acceptingOrders: false,
      umaResolutionStatus: 'resolved', outcomes: l.outcomes, outcomePrices: l.outcome_prices,
      clobTokenIds: [l.token_id, `${l.token_id}-no`], volume: l.volume,
    })),
  };
}

test('computeMarketRecord(survival): RESOLVED transition, prior + PARSEABLE settled prices → settled truth, new fetched_at, legs at 0/1, writeReplace:false', async () => {
  const thresholds = [40, 45];
  const prior = ladderPrior(thresholds, 'ladder-settle');
  const legs = thresholds.map((threshold, i) => ({
    threshold, token_id: `tok-${threshold}`, volume: 100,
    outcomes: ['Yes', 'No'], outcome_prices: i === 0 ? ['1', '0'] : ['0', '1'], // 40 settled Yes, 45 settled No
  }));
  const event = ladderEvent('ladder-settle', legs);

  const { record, lifecycle, writeReplace } = await withGamma([event],
    () => computeMarketRecord({ id: 'ladder-settle', prior }));

  assert.equal(lifecycle.state, 'RESOLVED');
  assert.equal(writeReplace, false);
  assert.notEqual(record.snapshot.fetched_at, prior.snapshot.fetched_at, 'a genuine new fetched_at, not the same-key no-op');
  const byThreshold = Object.fromEntries(record.snapshot.derived.markets.map((m) => [m.threshold, m.raw_prob]));
  assert.equal(byThreshold[40], 1);
  assert.equal(byThreshold[45], 0);
});

test('computeMarketRecord(survival): RESOLVED transition, prior + ALL rungs UNPARSEABLE settled prices → DEGRADES to freezing the prior (writeReplace:true), logged loud', async () => {
  const thresholds = [40, 45];
  const prior = ladderPrior(thresholds, 'ladder-degrade');
  const legs = thresholds.map((threshold) => ({
    threshold, token_id: `tok-${threshold}`, volume: 100, outcomes: null, outcome_prices: null, // unparseable — every rung
  }));
  const event = ladderEvent('ladder-degrade', legs);

  const warnCalls = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  let out;
  try {
    out = await withGamma([event], () => computeMarketRecord({ id: 'ladder-degrade', prior }));
  } finally {
    console.warn = origWarn;
  }

  assert.equal(out.lifecycle.state, 'RESOLVED');
  assert.equal(out.writeReplace, true, 'a degraded freeze MUST declare replace, or its write silently no-ops');
  assert.equal(out.record.snapshot.fetched_at, prior.snapshot.fetched_at, 'freeze keeps the prior fetched_at');
  assert.ok(
    warnCalls.some((args) => String(args[0]).includes('[resolved-transition] DEGRADED')),
    'the degrade must be logged loud, never a silent fallback',
  );
});

test('computeMarketRecord(survival): RESOLVED, ALL rungs unparseable, NO prior → still a clean 409 (nothing to degrade to)', async () => {
  const thresholds = [40, 45];
  const legs = thresholds.map((threshold) => ({
    threshold, token_id: `tok-${threshold}`, volume: 100, outcomes: null, outcome_prices: null,
  }));
  const event = ladderEvent('ladder-noprior-degrade', legs);
  await assert.rejects(
    () => withGamma([event], () => computeMarketRecord({ id: 'ladder-noprior-degrade', prior: null })),
    (e) => e.code === 409,
  );
});

// ── 3. serveMarket: writeTransitionHistory wiring ────────────────────────────────────────────────

const NOW = Date.UTC(2026, 5, 17, 12, 0, 0);
const now = () => NOW;
const iso = (ms) => new Date(ms).toISOString();
const recordAt = (fetchedAtMs) => ({
  snapshot: { fetched_at: iso(fetchedAtMs), source: { raw_sha256: 'abc' }, derived: {} },
});

test('serveMarket: a genuine RESOLVED transition (prior existed, RECOMPUTE path) calls writeTransitionHistory exactly once', async () => {
  const calls = { writeTransitionHistory: 0, writeRecord: 0 };
  const snapshot = { lifecycle_state: 'OPEN', cached_at: iso(NOW - CACHE_TTL_MS - 1), record: recordAt(NOW - CACHE_TTL_MS - 1) };
  const deps = {
    readCache: async () => ({ snapshot, market: null }),
    probeLifecycle: async () => ({ lifecycle: { state: 'OPEN', resolved_outcome: null } }),
    computeMarketRecord: async ({ prior }) => {
      assert.ok(prior, 'a prior must be threaded through to computeMarketRecord');
      return { record: recordAt(NOW), lifecycle: { state: 'RESOLVED', resolved_outcome: null }, config: {}, writeReplace: false };
    },
    writeRecord: async () => { calls.writeRecord++; },
    touchProbe: async () => {},
    writeTransitionHistory: async () => { calls.writeTransitionHistory++; },
  };
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.status, 200);
  assert.equal(calls.writeRecord, 1);
  assert.equal(calls.writeTransitionHistory, 1);
});

test('serveMarket: SERVE_FINAL (RESOLVED cache hit) never calls writeTransitionHistory, computeMarketRecord, or writeRecord', async () => {
  const calls = { writeTransitionHistory: 0 };
  const snapshot = { lifecycle_state: 'RESOLVED', cached_at: iso(NOW - 100 * 864e5), record: recordAt(NOW - 100 * 864e5) };
  const deps = {
    readCache: async () => ({ snapshot, market: null }),
    probeLifecycle: async () => { throw new Error('must not be called on SERVE_FINAL'); },
    computeMarketRecord: async () => { throw new Error('must not be called on SERVE_FINAL'); },
    writeRecord: async () => { throw new Error('must not be called on SERVE_FINAL'); },
    touchProbe: async () => {},
    writeTransitionHistory: async () => { calls.writeTransitionHistory++; },
  };
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, true);
  assert.equal(calls.writeTransitionHistory, 0);
});

test('serveMarket: a no-prior RESOLVED compute (first-ever browse) never calls writeTransitionHistory (nothing to append to)', async () => {
  const calls = { writeTransitionHistory: 0 };
  const deps = {
    readCache: async () => ({ snapshot: null, market: null }),
    computeMarketRecord: async ({ prior }) => {
      assert.equal(prior, null);
      return { record: recordAt(NOW), lifecycle: { state: 'RESOLVED', resolved_outcome: null }, config: {}, writeReplace: false };
    },
    writeRecord: async () => {},
    probeLifecycle: async () => {}, touchProbe: async () => {},
    writeTransitionHistory: async () => { calls.writeTransitionHistory++; },
  };
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.status, 200);
  assert.equal(calls.writeTransitionHistory, 0);
});

test('serveMarket: writeTransitionHistory absent from deps → treated as a no-op, never throws', async () => {
  const snapshot = { lifecycle_state: 'OPEN', cached_at: iso(NOW - CACHE_TTL_MS - 1), record: recordAt(NOW - CACHE_TTL_MS - 1) };
  const deps = {
    readCache: async () => ({ snapshot, market: null }),
    computeMarketRecord: async () => ({ record: recordAt(NOW), lifecycle: { state: 'RESOLVED', resolved_outcome: null }, config: {}, writeReplace: false }),
    writeRecord: async () => {},
    probeLifecycle: async () => {}, touchProbe: async () => {},
    // no writeTransitionHistory key at all
  };
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.status, 200);
});

test('serveMarket: threads computeMarketRecord\'s writeReplace into writeRecord({ replace })', async () => {
  let capturedReplace = 'unset';
  const deps = {
    readCache: async () => ({ snapshot: null, market: null }),
    computeMarketRecord: async () => ({ record: recordAt(NOW), lifecycle: { state: 'RESOLVED', resolved_outcome: null }, config: {}, writeReplace: true }),
    writeRecord: async (_id, _record, _lifecycle, _config, opts) => { capturedReplace = opts?.replace; },
    probeLifecycle: async () => {}, touchProbe: async () => {},
  };
  await serveMarket({ id: 'm', deps, now });
  assert.equal(capturedReplace, true);
});

test('serveMarket: writeReplace:false threads through as replace:false (the normal compute path)', async () => {
  let capturedReplace = 'unset';
  const deps = {
    readCache: async () => ({ snapshot: null, market: null }),
    computeMarketRecord: async () => ({ record: recordAt(NOW), lifecycle: { state: 'OPEN', resolved_outcome: null }, config: {}, writeReplace: false }),
    writeRecord: async (_id, _record, _lifecycle, _config, opts) => { capturedReplace = opts?.replace; },
    probeLifecycle: async () => {}, touchProbe: async () => {},
  };
  await serveMarket({ id: 'm', deps, now });
  assert.equal(capturedReplace, false);
});
