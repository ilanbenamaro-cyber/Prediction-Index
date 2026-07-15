// test/shape-tripwire.test.js — the INC 7 shape tripwire: a survival build over data that is
// structurally NOT a P(>X) curve must emit ONE loud [shape-tripwire] line (log-only; the
// record itself is untouched — asserted here so the tripwire can never mutate behavior).
// The families it instruments (classifier P2s, no live instance yet): misrouted touch /
// competing all-$ boards (majority-inverted "curve") and the strc bare-hit family
// (duplicate thresholds). A genuine near-monotone ladder stays silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDerived } from '../core/snapshot.js';

const leg = (threshold, prob) => ({ label: `> $${threshold}`, threshold, prob, volume: 1000 });

function captureWarns(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return warns.filter((w) => w.includes('[shape-tripwire]'));
}

test('tripwire fires on a majority-inverted "curve" (misrouted competing/touch board)', () => {
  // a PMF-like competing board misrouted as survival: probs rise with threshold
  const warns = captureWarns(() => buildDerived({ markets: [leg(1, 0.1), leg(2, 0.3), leg(5, 0.6)] }));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /"violations":2/);
});

test('tripwire fires on duplicate thresholds (strc bare-hit family: identical rungs)', () => {
  const warns = captureWarns(() => buildDerived({ markets: [leg(100, 0.6), leg(100, 0.4), leg(100, 0.2)] }));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /"duplicate_thresholds":true/);
});

test('tripwire stays SILENT on a genuine near-monotone ladder (one noisy inversion)', () => {
  const warns = captureWarns(() =>
    buildDerived({ markets: [leg(1, 0.9), leg(2, 0.7), leg(3, 0.72), leg(4, 0.4), leg(5, 0.2)] }));
  assert.equal(warns.length, 0);
});

test('tripwire is log-only: the derived record is identical with the warn suppressed', () => {
  const mk = () => [leg(1, 0.1), leg(2, 0.3), leg(5, 0.6)];
  const a = captureWarns(() => {}); // noop — just proving captureWarns restores console.warn
  assert.equal(a.length, 0);
  let rec1, rec2;
  captureWarns(() => { rec1 = buildDerived({ markets: mk() }); });
  captureWarns(() => { rec2 = buildDerived({ markets: mk() }); });
  assert.deepEqual(JSON.parse(JSON.stringify(rec1)), JSON.parse(JSON.stringify(rec2)));
});
