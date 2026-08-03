// test/last-trade-witness.test.js — the last-trade witness guard (operator-approved
// 2026-08-03). THE RULE: a last-trade response is an observation ONLY if its `side` is
// 'buy' or 'sell' (case-insensitive); price is NEVER the discriminator — CLOB fabricates
// {"price":"0.5","side":""} for never-traded tokens with no order book, and 8 genuine
// trades land at exactly 0.5 too, so side alone must decide. See gotchas.md "CLOB
// /last-trade-price FABRICATES" and decisions.md "A CLOB scalar is an observation only
// when its structural witness is present". If a change makes this read price instead of
// (or in addition to) side, the change is wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchLastTradePrice } from '../core/fetch.js';

/** Run `fn` with global.fetch stubbed to return `payload` as the last-trade JSON body. */
async function withLastTradeResponse(payload, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

/** Run `fn` with global.fetch stubbed to reject, simulating a network/fetch error. */
async function withFetchError(fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network unreachable'); };
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

/** Capture console.warn calls made during `fn`, restoring after. */
async function captureWarn(fn) {
  const orig = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try { const result = await fn(); return { result, calls }; } finally { console.warn = orig; }
}

test('verbatim fabrication fixture: {"price":"0.5","side":""} → null, warns once', async () => {
  const { result, calls } = await captureWarn(() =>
    withLastTradeResponse({ price: '0.5', side: '' }, () => fetchLastTradePrice('tok-fabricated')),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 1, 'exactly one warn for a fabricated (price-present, witness-failed) response');
  assert.match(calls[0][0], /^\[last-trade\] fabricated \(side:""\)/);
  const payload = JSON.parse(calls[0][1]);
  assert.deepEqual(payload, { token: 'tok-fabricated', price: '0.5', side: '' });
});

test('the 8-real-0.5 FP lock: {"price":"0.5","side":"buy"} → "0.5" survives — price is never the signal', async () => {
  const { result, calls } = await captureWarn(() =>
    withLastTradeResponse({ price: '0.5', side: 'buy' }, () => fetchLastTradePrice('tok-real-0.5')),
  );
  assert.equal(result, '0.5');
  assert.equal(calls.length, 0, 'a genuine trade must not warn');
});

test('{"price":"0.62","side":"sell"} → "0.62"; uppercase BUY/SELL accepted case-insensitively', async () => {
  assert.equal(
    await withLastTradeResponse({ price: '0.62', side: 'sell' }, () => fetchLastTradePrice('tok-sell')),
    '0.62',
  );
  assert.equal(
    await withLastTradeResponse({ price: '0.71', side: 'BUY' }, () => fetchLastTradePrice('tok-upper-buy')),
    '0.71',
  );
  assert.equal(
    await withLastTradeResponse({ price: '0.33', side: 'SELL' }, () => fetchLastTradePrice('tok-upper-sell')),
    '0.33',
  );
});

test('missing side field entirely → null, warns (price was present, witness absent)', async () => {
  const { result, calls } = await captureWarn(() =>
    withLastTradeResponse({ price: '0.44' }, () => fetchLastTradePrice('tok-no-side-field')),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0][1]);
  assert.deepEqual(payload, { token: 'tok-no-side-field', price: '0.44', side: '' });
});

test('unknown side value (e.g. "unknown") → null, warns', async () => {
  const { result, calls } = await captureWarn(() =>
    withLastTradeResponse({ price: '0.18', side: 'unknown' }, () => fetchLastTradePrice('tok-unknown-side')),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0][1]);
  assert.deepEqual(payload, { token: 'tok-unknown-side', price: '0.18', side: 'unknown' });
});

test('fetch error → null, no warn (existing silent-null path is unchanged)', async () => {
  const { result, calls } = await captureWarn(() =>
    withFetchError(() => fetchLastTradePrice('tok-error')),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0, 'a fetch error must stay silent, not warn');
});

test('null/absent body → null, no warn (no price was ever present)', async () => {
  const { result, calls } = await captureWarn(() =>
    withLastTradeResponse(null, () => fetchLastTradePrice('tok-null-body')),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0, 'no price present means nothing was fabricated to warn about');
});
