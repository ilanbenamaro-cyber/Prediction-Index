// test/chart-hover.test.js — the pure math behind the shared chart hover/crosshair.
// The interactive overlay itself is a browser/operator check; these lock the numeric decisions
// (snap, interpolate bracket, tick spacing, level interpolation, formatting) that carry the risk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtNum, lerpAt, nearestAnchor, bracket, pickTicks, interpSeriesAtLevel } from '../lib/chart-hover.mjs';

test('fmtNum: scale, digits, prefix/suffix', () => {
  assert.equal(fmtNum(0.4213, { scale: 100, digits: 1, suffix: '%' }), '42.1%');
  assert.equal(fmtNum(1.8, { prefix: '$', suffix: 'T', digits: 2 }), '$1.80T');
  assert.equal(fmtNum(5, {}), '5');
  assert.equal(fmtNum(-0.5, { prefix: '$', digits: 2 }), '$-0.50'); // no special-casing of sign
});

test('lerpAt: interpolates between i and i+1; clamps at the last index', () => {
  const v = [10, 20, 40];
  assert.equal(lerpAt(v, 0, 0), 10);
  assert.equal(lerpAt(v, 0, 0.5), 15);
  assert.equal(lerpAt(v, 1, 0.25), 25);
  assert.equal(lerpAt(v, 2, 0.9), 40); // upper index clamps → returns values[2]
});

test('nearestAnchor: closest index, ties resolve to the earlier anchor', () => {
  const xs = [0, 10, 20, 30];
  assert.equal(nearestAnchor(xs, 12), 1);
  assert.equal(nearestAnchor(xs, 16), 2);
  assert.equal(nearestAnchor(xs, 5), 0);  // equidistant 0 vs 10 → earlier (0)
  assert.equal(nearestAnchor(xs, 100), 3); // past the end → last
});

test('bracket: finds the bracketing pair and fraction; clamps past either end', () => {
  const xs = [0, 100, 200];
  assert.deepEqual(bracket(xs, 50), { i: 0, t: 0.5 });
  assert.deepEqual(bracket(xs, 150), { i: 1, t: 0.5 });
  assert.deepEqual(bracket(xs, -20), { i: 0, t: 0 });   // before first → pin start
  assert.deepEqual(bracket(xs, 999), { i: 1, t: 1 });   // past last → pin end of last segment
  assert.deepEqual(bracket([42], 10), { i: 0, t: 0 });  // single anchor
});

test('bracket: exact hit on an interior anchor', () => {
  assert.deepEqual(bracket([0, 100, 200], 100), { i: 0, t: 1 });
});

test('pickTicks: returns all when short; ~evenly spaced incl. first+last; no dup indices', () => {
  const short = ['a', 'b', 'c'];
  assert.deepEqual(pickTicks(short, 6).map((x) => x.i), [0, 1, 2]);

  const long = Array.from({ length: 100 }, (_, i) => i);
  const ticks = pickTicks(long, 6);
  assert.equal(ticks[0].i, 0);
  assert.equal(ticks[ticks.length - 1].i, 99);
  assert.ok(ticks.length <= 6);
  const idxs = ticks.map((t) => t.i);
  assert.equal(new Set(idxs).size, idxs.length, 'no duplicate indices');
  // strictly increasing
  for (let k = 1; k < idxs.length; k++) assert.ok(idxs[k] > idxs[k - 1]);
});

test('interpSeriesAtLevel: linear interpolation clamped to the series ends', () => {
  const pts = [{ level: 50, prob: 0.9 }, { level: 60, prob: 0.5 }, { level: 70, prob: 0.1 }];
  assert.equal(interpSeriesAtLevel(pts, 40), 0.9);  // below range → first
  assert.equal(interpSeriesAtLevel(pts, 55), 0.7);  // midway 50→60
  assert.ok(Math.abs(interpSeriesAtLevel(pts, 65) - 0.3) < 1e-9); // midway 60→70
  assert.equal(interpSeriesAtLevel(pts, 80), 0.1);  // above range → last
  assert.equal(interpSeriesAtLevel([], 55), 0);     // empty → 0
});

// ── probDomain (Bug 1, 2026-07-06): probability axes fit the FILTERED window instead of a
//    fixed 0–100% that flattened every sub-extreme series and ignored the tab switch. ──────────
import { probDomain } from '../lib/chart-hover.mjs';

test('probDomain: fits the data with padding, inside [0,1]', () => {
  const { lo, hi } = probDomain([0.30, 0.40, 0.60]);
  assert.ok(lo < 0.30 && lo > 0); // padded below the min, not to 0
  assert.ok(hi > 0.60 && hi < 1); // padded above the max, not to 1
});

test('probDomain: min-span guard — near-flat data never collapses below 10pp', () => {
  const { lo, hi } = probDomain([0.500, 0.502, 0.501]);
  assert.ok(hi - lo >= 0.10 - 1e-12);
  assert.ok(lo < 0.5 && hi > 0.5); // centred on the data
});

test('probDomain: clamps at the edges preserving the span', () => {
  const nearZero = probDomain([0.01, 0.02]);
  assert.equal(nearZero.lo, 0); // shifted up, not cut
  assert.ok(nearZero.hi >= 0.10 - 1e-12);
  const nearOne = probDomain([0.98, 0.99]);
  assert.equal(nearOne.hi, 1);
  assert.ok(nearOne.lo <= 0.90 + 1e-12);
});

test('probDomain: empty/invalid input → the full 0–100% axis; custom minSpan honoured', () => {
  assert.deepEqual(probDomain([]), { lo: 0, hi: 1 });
  assert.deepEqual(probDomain(null), { lo: 0, hi: 1 });
  assert.deepEqual(probDomain([NaN, null]), { lo: 0, hi: 1 });
  const wide = probDomain([0.5], { minSpan: 0.3 });
  assert.ok(wide.hi - wide.lo >= 0.3 - 1e-12);
});
