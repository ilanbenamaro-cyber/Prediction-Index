// test/trigger-backfill.test.js — the shared fire-and-forget backfill kick (browse-history, 2026-07-03).
//
// triggerBackfill is used by BOTH addMarket (add path) and DetailData (browse path), so its
// fail-closed + fire behavior is load-bearing for the whole "any viewed market loads its history"
// contract. Pure of a request context (host/proto are passed in) → unit-testable here with a mocked
// fetch + captured console + a controlled CRON_SECRET.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerBackfill } from '../lib/trigger-backfill.mjs';

/** Run `fn` with a stubbed console (capturing [backfill-trigger] lines) + fetch + CRON_SECRET,
 *  restoring everything after. Returns { events, fetchCalls }. */
async function withStubs({ secret, fetchImpl }, fn) {
  const origSecret = process.env.CRON_SECRET;
  const origLog = console.log, origWarn = console.warn, origFetch = globalThis.fetch;
  const events = [];       // parsed [backfill-trigger] payloads
  const fetchCalls = [];   // { url, init }
  const cap = (...a) => { if (a[0] === '[backfill-trigger]') events.push(JSON.parse(a[1])); };
  console.log = cap; console.warn = cap;
  globalThis.fetch = async (url, init) => { fetchCalls.push({ url, init }); return fetchImpl(url, init); };
  if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
  try { await fn(); return { events, fetchCalls }; }
  finally {
    console.log = origLog; console.warn = origWarn; globalThis.fetch = origFetch;
    if (origSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = origSecret;
  }
}

test('triggerBackfill: fails CLOSED when CRON_SECRET is unset — no fetch, logs skipped', async () => {
  const { events, fetchCalls } = await withStubs(
    { secret: undefined, fetchImpl: async () => ({ ok: true, status: 202 }) },
    () => triggerBackfill('mkt', 'localhost:3000', 'http'),
  );
  assert.equal(fetchCalls.length, 0, 'must NOT hit the route without a secret');
  assert.deepEqual(events.map((e) => e.event), ['attempt', 'skipped']);
  assert.equal(events[1].reason, 'CRON_SECRET unset');
});

test('triggerBackfill: skips when host is null — no fetch, logs skipped', async () => {
  const { events, fetchCalls } = await withStubs(
    { secret: 's3cret', fetchImpl: async () => ({ ok: true, status: 202 }) },
    () => triggerBackfill('mkt', null, 'https'),
  );
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(events.map((e) => e.event), ['attempt', 'skipped']);
  assert.equal(events[1].reason, 'no host header');
});

test('triggerBackfill: fires a bearer POST to /api/backfill and logs success', async () => {
  const { events, fetchCalls } = await withStubs(
    { secret: 's3cret', fetchImpl: async () => ({ ok: true, status: 202 }) },
    () => triggerBackfill('my-market', 'example.com', 'https'),
  );
  assert.equal(fetchCalls.length, 1);
  const { url, init } = fetchCalls[0];
  assert.equal(url, 'https://example.com/api/backfill?id=my-market');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer s3cret');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual(events.map((e) => e.event), ['attempt', 'success']);
  assert.equal(events[1].route_status, 202);
});

test('triggerBackfill: url-encodes the id in the route query', async () => {
  const { fetchCalls } = await withStubs(
    { secret: 's', fetchImpl: async () => ({ ok: true, status: 202 }) },
    () => triggerBackfill('a b/c&d', 'h', 'http'),
  );
  assert.equal(fetchCalls[0].url, 'http://h/api/backfill?id=a%20b%2Fc%26d');
});

test('triggerBackfill: a non-ok route response logs failure (never throws)', async () => {
  const { events } = await withStubs(
    { secret: 's', fetchImpl: async () => ({ ok: false, status: 401 }) },
    () => triggerBackfill('mkt', 'h', 'http'),
  );
  assert.deepEqual(events.map((e) => e.event), ['attempt', 'failure']);
  assert.equal(events[1].route_status, 401);
});

test('triggerBackfill: a thrown fetch is swallowed + logged (fire-and-forget never affects caller)', async () => {
  const { events } = await withStubs(
    { secret: 's', fetchImpl: async () => { throw new Error('network down'); } },
    () => triggerBackfill('mkt', 'h', 'http'),
  );
  assert.deepEqual(events.map((e) => e.event), ['attempt', 'failure']);
  assert.equal(events[1].error, 'network down');
});
