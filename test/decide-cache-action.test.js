// test/decide-cache-action.test.js — every branch of the cache read-path decision.
// This is the deterministic proof that resolution stays authoritative over the
// cache (ARCHITECTURE §3.1); the live verification proves the wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideBeforeProbe, decideAfterProbe, CACHE_TTL_MS, PROBE_TTL_MS,
} from '../lib/decide-cache-action.mjs';

const NOW = Date.UTC(2026, 5, 17, 12, 0, 0);
const ago = (ms) => NOW - ms;

test('cache miss → COMPUTE', () => {
  assert.equal(decideBeforeProbe({ lifecycleState: null, cachedAtMs: null, nowMs: NOW }), 'COMPUTE');
});

test('RESOLVED → SERVE_FINAL regardless of age (monotonic, no probe)', () => {
  assert.equal(
    decideBeforeProbe({ lifecycleState: 'RESOLVED', cachedAtMs: ago(100 * 24 * 3600_000), nowMs: NOW }),
    'SERVE_FINAL'
  );
});

test('OPEN past TTL → RECOMPUTE (recompute re-classifies lifecycle)', () => {
  assert.equal(
    decideBeforeProbe({ lifecycleState: 'OPEN', cachedAtMs: ago(CACHE_TTL_MS + 1), lastCheckedAtMs: NOW, nowMs: NOW }),
    'RECOMPUTE'
  );
});

test('OPEN within TTL, probe due → PROBE (must confirm not-resolved before serving)', () => {
  assert.equal(
    decideBeforeProbe({
      lifecycleState: 'OPEN', cachedAtMs: ago(60_000),
      lastCheckedAtMs: ago(PROBE_TTL_MS + 1), nowMs: NOW,
    }),
    'PROBE'
  );
});

test('OPEN within TTL, probed recently → SERVE_FRESH (dedup the probe)', () => {
  assert.equal(
    decideBeforeProbe({
      lifecycleState: 'OPEN', cachedAtMs: ago(60_000),
      lastCheckedAtMs: ago(PROBE_TTL_MS - 1), nowMs: NOW,
    }),
    'SERVE_FRESH'
  );
});

test('OPEN within TTL, never probed → PROBE', () => {
  assert.equal(
    decideBeforeProbe({ lifecycleState: 'OPEN', cachedAtMs: ago(60_000), lastCheckedAtMs: null, nowMs: NOW }),
    'PROBE'
  );
});

test('CLOSED_PENDING within TTL, probe due → PROBE (not served blindly)', () => {
  assert.equal(
    decideBeforeProbe({ lifecycleState: 'CLOSED_PENDING', cachedAtMs: ago(60_000), lastCheckedAtMs: null, nowMs: NOW }),
    'PROBE'
  );
});

test('after probe: still OPEN → SERVE_FRESH', () => {
  assert.equal(decideAfterProbe('OPEN'), 'SERVE_FRESH');
});

test('after probe: RESOLVED → RECOMPUTE (the cache×resolution trap: do NOT serve stale OPEN)', () => {
  assert.equal(decideAfterProbe('RESOLVED'), 'RECOMPUTE');
});

test('after probe: CLOSED_PENDING → RECOMPUTE (left OPEN; re-freeze, do not serve OPEN)', () => {
  assert.equal(decideAfterProbe('CLOSED_PENDING'), 'RECOMPUTE');
});

