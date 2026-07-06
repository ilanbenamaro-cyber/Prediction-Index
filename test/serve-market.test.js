// test/serve-market.test.js — the request orchestration, every branch, with
// injected fakes (no DB, no network). Proves the WIRING that the pure
// decideCacheAction can't: a cache hit serves WITHOUT computing; a market that
// resolved after caching is NEVER served stale-live; a miss computes + writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveMarket } from '../lib/serve-market.mjs';
import { CACHE_TTL_MS, PROBE_TTL_MS } from '../lib/decide-cache-action.mjs';

const NOW = Date.UTC(2026, 5, 17, 12, 0, 0);
const now = () => NOW;
const iso = (ms) => new Date(ms).toISOString();
const recordAt = (fetchedAtMs, extra = {}) => ({
  snapshot: { fetched_at: iso(fetchedAtMs), source: { raw_sha256: 'abc' }, derived: {} },
  ...extra,
});

// A fake deps builder with call counters.
function fakeDeps({ snapshot = null, market = null, probeState = 'OPEN', computeLifecycle = 'OPEN' } = {}) {
  const calls = { readCache: 0, probe: 0, compute: 0, write: 0, touch: 0 };
  return {
    calls,
    deps: {
      readCache: async () => { calls.readCache++; return { snapshot, market }; },
      probeLifecycle: async () => { calls.probe++; return { lifecycle: { state: probeState, resolved_outcome: probeState === 'RESOLVED' ? [{ threshold: 1, outcome: 'Yes' }] : null } }; },
      computeMarketRecord: async ({ prior }) => { calls.compute++; return { record: recordAt(NOW, { _from: prior ? 'prior' : 'fresh' }), lifecycle: { state: computeLifecycle, resolved_outcome: null }, config: { id: 'x' } }; },
      writeRecord: async () => { calls.write++; },
      touchProbe: async () => { calls.touch++; },
    },
  };
}

test('missing id → 400', async () => {
  const { deps } = fakeDeps();
  const r = await serveMarket({ id: '  ', deps, now });
  assert.equal(r.status, 400);
});

test('cache MISS → computes + writes, cached:false', async () => {
  const { deps, calls } = fakeDeps({ snapshot: null });
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, false);
  assert.equal(calls.compute, 1);
  assert.equal(calls.write, 1);
});

test('RESOLVED cache → served from cache, NO compute, NO probe', async () => {
  const snapshot = { lifecycle_state: 'RESOLVED', cached_at: iso(NOW - 100 * 864e5), record: recordAt(NOW - 100 * 864e5) };
  const { deps, calls } = fakeDeps({ snapshot });
  const r = await serveMarket({ id: 'spacex', deps, now });
  assert.equal(r.body.cached, true);
  assert.equal(r.body.lifecycle_state, 'RESOLVED');
  assert.equal(calls.compute, 0);
  assert.equal(calls.probe, 0);
});

test('OPEN within TTL, probed recently → served from cache, NO compute, NO probe', async () => {
  const snapshot = { lifecycle_state: 'OPEN', cached_at: iso(NOW - 60_000), record: recordAt(NOW - 60_000) };
  const market = { last_checked_at: iso(NOW - (PROBE_TTL_MS - 1)) };
  const { deps, calls } = fakeDeps({ snapshot, market });
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.body.cached, true);
  assert.equal(calls.probe, 0);
  assert.equal(calls.compute, 0);
});

test('OPEN within TTL, probe due, STILL open → probe then serve cached (no compute)', async () => {
  const snapshot = { lifecycle_state: 'OPEN', cached_at: iso(NOW - 60_000), record: recordAt(NOW - 60_000) };
  const market = { last_checked_at: iso(NOW - (PROBE_TTL_MS + 1)) };
  const { deps, calls } = fakeDeps({ snapshot, market, probeState: 'OPEN' });
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.body.cached, true);
  assert.equal(calls.probe, 1);
  assert.equal(calls.touch, 1);
  assert.equal(calls.compute, 0);
});

test('THE TRAP: OPEN cache within TTL, but probe finds it RESOLVED → recompute, NOT stale-served', async () => {
  const snapshot = { lifecycle_state: 'OPEN', cached_at: iso(NOW - 60_000), record: recordAt(NOW - 60_000) };
  const market = { last_checked_at: iso(NOW - (PROBE_TTL_MS + 1)) };
  // probe says RESOLVED; compute freezes to RESOLVED.
  const { deps, calls } = fakeDeps({ snapshot, market, probeState: 'RESOLVED', computeLifecycle: 'RESOLVED' });
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(calls.probe, 1);
  assert.equal(calls.compute, 1, 'must recompute, not serve the stale OPEN cache');
  assert.equal(r.body.cached, false);
  assert.equal(r.body.lifecycle_state, 'RESOLVED');
});

test('OPEN past TTL → recompute (no probe needed; recompute re-classifies)', async () => {
  const snapshot = { lifecycle_state: 'OPEN', cached_at: iso(NOW - (CACHE_TTL_MS + 1)), record: recordAt(NOW - (CACHE_TTL_MS + 1)) };
  const { deps, calls } = fakeDeps({ snapshot, market: { last_checked_at: iso(NOW) } });
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(calls.probe, 0);
  assert.equal(calls.compute, 1);
  assert.equal(r.body.cached, false);
});

test('compute 409 (resolved, no prior) → surfaced as 409', async () => {
  const deps = {
    readCache: async () => ({ snapshot: null, market: null }),
    computeMarketRecord: async () => { const e = new Error('resolved no prior'); e.code = 409; throw e; },
    writeRecord: async () => {}, probeLifecycle: async () => {}, touchProbe: async () => {},
  };
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.status, 409);
});

test('compute validation failure → 422, never written to cache', async () => {
  let wrote = false;
  const deps = {
    readCache: async () => ({ snapshot: null, market: null }),
    computeMarketRecord: async () => { throw new Error('Record invalid:\n  - schema'); },
    writeRecord: async () => { wrote = true; }, probeLifecycle: async () => {}, touchProbe: async () => {},
  };
  const r = await serveMarket({ id: 'm', deps, now });
  assert.equal(r.status, 422);
  assert.equal(wrote, false, 'an invalid record must never reach the cache');
});

// ── market-id allow-list (rejects path traversal / query-injection before any I/O) ──────────────
test('serveMarket: a path-traversal id → 400, no injected dep called', async () => {
  const { deps, calls } = fakeDeps();
  const r = await serveMarket({ id: '../../../etc/passwd', deps, now });
  assert.equal(r.status, 400);
  assert.equal(calls.readCache, 0, 'readCache must never run on an invalid id');
  assert.equal(calls.probe + calls.compute + calls.write + calls.touch, 0);
});

test('serveMarket: a query-injection id (& query string) → 400, no injected dep called', async () => {
  const { deps, calls } = fakeDeps();
  const r = await serveMarket({ id: 'foo&limit=9', deps, now });
  assert.equal(r.status, 400);
  assert.equal(calls.readCache, 0, 'readCache must never run on an invalid id');
  assert.equal(calls.probe + calls.compute + calls.write + calls.touch, 0);
});

test('serveMarket: a real-shaped gamma slug passes the id allow-list (deps ARE called)', async () => {
  const { deps, calls } = fakeDeps({ snapshot: null });
  const r = await serveMarket({ id: 'net-quarterly-earnings-nongaap-eps-02-11-2026-0pt27', deps, now });
  assert.equal(r.status, 200);
  assert.equal(calls.compute, 1, 'a valid slug must reach computeMarketRecord, not be rejected at validation');
});
