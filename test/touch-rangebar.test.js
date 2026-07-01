// test/touch-rangebar.test.js — the directional-touch range-bar label placement (Phase 4 Bug B).
// A narrow band must stack the lo/hi labels (above/below) instead of overlapping them over the bar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeBarLayout, RANGEBAR_W, NARROW_FRAC, niceTicks } from '../lib/touch-rangebar.mjs';

const LEVELS = [0, 50, 100, 150, 200]; // axis 0..200

test('empty axis → null (nothing to place)', () => {
  assert.equal(rangeBarLayout(95, 105, []), null);
});

test('wide band (≥20%): both labels above the bar, anchored to opposite edges', () => {
  const L = rangeBarLayout(40, 160, LEVELS); // band = 120/200 = 60% of axis
  assert.equal(L.narrow, false);
  assert.equal(L.lo.y, L.hi.y);          // same row
  assert.equal(L.lo.anchor, 'start');    // left edge
  assert.equal(L.hi.anchor, 'end');      // right edge
  assert.ok(L.lo.x < L.hi.x);            // lo left of hi
});

test('narrow band (<20%): labels stack — hi above, lo below — centred on the band', () => {
  const L = rangeBarLayout(99, 101, LEVELS); // band = 2/200 = 1% of axis
  assert.equal(L.narrow, true);
  assert.ok(L.hi.y < L.lo.y);            // hi above, lo below (distinct rows)
  assert.equal(L.lo.x, L.hi.x);          // both centred on the band → no horizontal overlap
  assert.equal(L.lo.anchor, 'middle');   // mid-axis band → centred anchor
  assert.equal(L.hi.anchor, 'middle');
});

test('the 20% threshold is the boundary (exactly 20% is NOT narrow)', () => {
  // band width = exactly NARROW_FRAC of the axis → strict "<" keeps it wide.
  const lo = 0, hi = (NARROW_FRAC * 200); // 40 → band 0..40 = 20% of 0..200
  const L = rangeBarLayout(lo, hi, LEVELS);
  assert.equal((L.bandR - L.bandL) / RANGEBAR_W, NARROW_FRAC);
  assert.equal(L.narrow, false);
  // a hair narrower flips it
  assert.equal(rangeBarLayout(lo, hi - 1, LEVELS).narrow, true);
});

test('null bound → band extends to that edge → full width, never narrow', () => {
  const L = rangeBarLayout(null, 120, LEVELS); // lower crossover outside ladder → bandL = 0
  assert.equal(L.bandL, 0);
  assert.equal(L.narrow, false);
});

test('narrow band at an extreme edge hugs that edge so the label stays in view', () => {
  const lo = rangeBarLayout(2, 4, LEVELS);   // band near the far left
  assert.equal(lo.narrow, true);
  assert.equal(lo.hi.anchor, 'start');       // < 15% → left-anchored, not centred off-screen
  const hi = rangeBarLayout(196, 198, LEVELS); // band near the far right
  assert.equal(hi.hi.anchor, 'end');         // > 85% → right-anchored
});

test('geom params offset x + set label baselines (defaults reproduce the legacy layout)', () => {
  // default (no geom) is byte-identical to the 3-arg legacy call
  const legacy = rangeBarLayout(40, 160, LEVELS);
  assert.equal(legacy.bandL, (40 / 200) * RANGEBAR_W); // x0=0, W=1000
  assert.equal(legacy.lo.y, 16);
  // padded 480×150 geometry: x offset by x0, width W, custom baselines
  const geom = { x0: 16, W: 448, yAbove: 40, yBelow: 96 };
  const L = rangeBarLayout(40, 160, LEVELS, geom);
  assert.equal(L.bandL, 16 + (40 / 200) * 448);
  assert.equal(L.bandR, 16 + (160 / 200) * 448);
  assert.equal(L.lo.y, 40);   // yAbove
  assert.ok(L.bandL >= 16 && L.bandR <= 16 + 448, 'band stays within the plot box');
});

test('niceTicks: round 1/2/5×10ⁿ ticks within range', () => {
  assert.deepEqual(niceTicks(0, 200, 6), [0, 50, 100, 150, 200]);
  assert.deepEqual(niceTicks(35, 250, 6), [50, 100, 150, 200, 250]); // endpoints not forced
  const t = niceTicks(1.1, 3.9, 5);
  assert.ok(t.every((v) => v >= 1.1 && v <= 3.9));
  assert.ok(t.length >= 2);
  assert.deepEqual(niceTicks(5, 5), [5]);   // degenerate range
  assert.deepEqual(niceTicks(NaN, 10), [NaN]);
});
