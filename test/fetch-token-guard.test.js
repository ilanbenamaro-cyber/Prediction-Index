// test/fetch-token-guard.test.js — a gamma leg with no clobTokenIds must not crash the fetcher.
//
// Bug (2026-07-03): searching `what-will-gold-gc-hit-by-end-of-december` 500'd with "Cannot read
// properties of undefined (reading '0')". Root cause: a valid directional_touch market whose "(HIGH)
// $5,000" leg is an untraded placeholder — gamma sends it with NO clobTokenIds — so the old inline
// `JSON.parse(...) : m.clobTokenIds` left `ids` undefined and `ids[0]` threw a bare TypeError → 500.
// Fix: parseClobTokenIds() returns null for an absent/empty/malformed token list, and every meta
// parser SKIPS such a leg (it has no order book, so it can't be priced) — the market loads from its
// tradeable legs. The single-leg binary can't skip → it throws a clean coded-404 instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClobTokenIds, fetchTouchMeta, fetchBinaryMeta } from '../core/fetch.js';

/** Run `fn` with global.fetch stubbed to return `payload` as the gamma JSON, restoring after. */
async function withGammaResponse(payload, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

// ── parseClobTokenIds (the pure guard) ─────────────────────────────────────────────────────────
test('parseClobTokenIds: JSON-string, array, and absent/empty/malformed cases', () => {
  assert.deepEqual(parseClobTokenIds({ clobTokenIds: '["a","b"]' }), ['a', 'b']); // JSON string
  assert.deepEqual(parseClobTokenIds({ clobTokenIds: ['a', 'b'] }), ['a', 'b']);  // already an array
  assert.equal(parseClobTokenIds({ clobTokenIds: null }), null);   // the gold bug: null token list
  assert.equal(parseClobTokenIds({ clobTokenIds: undefined }), null);
  assert.equal(parseClobTokenIds({}), null);                        // field absent
  assert.equal(parseClobTokenIds({ clobTokenIds: '[]' }), null);    // empty array → null (no token to price)
  assert.equal(parseClobTokenIds({ clobTokenIds: 'not json' }), null); // malformed → null, NEVER throws
  assert.equal(parseClobTokenIds(null), null);                      // no leg at all
});

// ── fetchTouchMeta skips the untradeable leg (the gold scenario, offline) ──────────────────────
test('fetchTouchMeta: a leg with no clobTokenIds is SKIPPED, not a crash — the market still parses', async () => {
  const goldEvent = {
    title: 'What will Gold (GC) hit by end of December?', endDate: '2026-12-31T00:00:00Z',
    markets: [
      { question: 'Will Gold (GC) hit (HIGH) $5,000 by end of December?', clobTokenIds: null },        // untraded → skip
      { question: 'Will Gold (GC) hit (HIGH) $10,000 by end of December?', clobTokenIds: '["a","b"]' }, // tradeable
      { question: 'Will Gold (GC) hit (HIGH) $12,000 by end of December?', clobTokenIds: '["c","d"]' }, // tradeable
    ],
  };
  const meta = await withGammaResponse([goldEvent], () => fetchTouchMeta({ event_slug: 'gold' }));
  assert.equal(meta.legs.length, 2, 'the untradeable $5,000 leg is dropped, leaving 2 tradeable legs');
  assert.ok(!meta.legs.some((l) => l.level === 5000), 'the $5,000 leg is absent');
  assert.deepEqual(meta.legs.map((l) => l.level).sort((a, b) => a - b), [10000, 12000]);
  assert.equal(meta.legs[0].token_id != null && meta.legs[1].token_id != null, true, 'surviving legs carry real tokens');
});

// ── fetchBinaryMeta: a single leg can't be skipped → a CLEAN coded 404, never a TypeError ──────
test('fetchBinaryMeta: a single leg with no order book throws a clean coded-404 (not a TypeError)', async () => {
  const noTokenBinary = { title: 'X', endDate: null, markets: [{ question: 'Will X happen?', clobTokenIds: null }] };
  await withGammaResponse([noTokenBinary], async () => {
    await assert.rejects(
      () => fetchBinaryMeta({ event_slug: 'x' }),
      (e) => {
        assert.equal(e.code, 404, 'integer code → statusFor maps to 404, not 500');
        assert.ok(!(e instanceof TypeError), 'a clean Error, not the raw undefined[0] TypeError');
        assert.match(e.message, /no tradeable order book/);
        return true;
      },
    );
  });
});

test('fetchBinaryMeta: a normal binary with tokens still parses (fix is additive)', async () => {
  const okBinary = { title: 'Recession?', endDate: '2026-12-31T00:00:00Z', markets: [{ question: 'Recession by 2026?', clobTokenIds: '["yes","no"]', volume: 1000 }] };
  const meta = await withGammaResponse([okBinary], () => fetchBinaryMeta({ event_slug: 'rec' }));
  assert.equal(meta.yes_token, 'yes');
  assert.equal(meta.no_token, 'no');
});
