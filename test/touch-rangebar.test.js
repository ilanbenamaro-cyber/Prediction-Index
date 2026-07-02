// test/touch-rangebar.test.js — the directional-touch range-bar label placement (Phase 4 Bug B).
// A narrow band must stack the lo/hi labels (above/below) instead of overlapping them over the bar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeBarLayout, RANGEBAR_W, NARROW_FRAC, niceTicks, buildAxisSamples, resolveBound } from '../lib/touch-rangebar.mjs';
import { bracket, lerpAt } from '../lib/chart-hover.mjs';

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

test('resolveBound: DIRECTION-AWARE null handling (both bounds, both cases)', () => {
  // finite → passthrough
  assert.deepEqual(resolveBound(1.7, [], 'high'), { value: 1.7, extend: false, unresolved: false });

  // LOW, all probs < 0.5 ("> $max") — the Anthropic case: floor ABOVE the top low strike → ANCHOR, no extend
  const lowUnres = resolveBound(null, [{ level: 0.6, prob: 0.045 }, { level: 0.7, prob: 0.075 }, { level: 0.8, prob: 0.10 }], 'low');
  assert.deepEqual(lowUnres, { value: 0.8, extend: false, unresolved: true }, 'anchors at the ladder top ($0.8), does not extend');

  // LOW, all probs ≥ 0.5 ("< $min") — NOT exercised by any live market → fixture proof: floor BELOW → EXTEND left
  const lowExt = resolveBound(null, [{ level: 0.6, prob: 0.9 }, { level: 0.7, prob: 0.95 }, { level: 0.8, prob: 0.99 }], 'low');
  assert.deepEqual(lowExt, { value: null, extend: true, unresolved: false }, 'extends to the left edge (as today)');

  // HIGH, all probs ≥ 0.5 ("> $max") → cap above the top → EXTEND right
  const highExt = resolveBound(null, [{ level: 2, prob: 0.9 }, { level: 3, prob: 0.8 }, { level: 5, prob: 0.6 }], 'high');
  assert.deepEqual(highExt, { value: null, extend: true, unresolved: false }, 'extends to the right edge');

  // HIGH, all probs < 0.5 ("< $min") → cap below the bottom high strike → ANCHOR at ladder bottom
  const highUnres = resolveBound(null, [{ level: 2, prob: 0.3 }, { level: 3, prob: 0.1 }, { level: 5, prob: 0.02 }], 'high');
  assert.deepEqual(highUnres, { value: 2, extend: false, unresolved: true }, 'anchors at the ladder bottom ($2), does not extend');

  // no series → extend (nothing to anchor to)
  assert.deepEqual(resolveBound(null, [], 'low'), { value: null, extend: true, unresolved: false });
});

test('resolveBound → rangeBarLayout: anchored bound sits INSIDE the plot, extend fills to the edge', () => {
  const levels = [0.6, 0.7, 0.8, 1, 1.5, 2];
  const geom = { x0: 16, W: 448 };
  // Anthropic-shaped: low ">$max" anchors at 0.8 (inside), high finite 1.7
  const lo = resolveBound(null, [{ level: 0.6, prob: 0.045 }, { level: 0.7, prob: 0.075 }, { level: 0.8, prob: 0.10 }], 'low');
  const A = rangeBarLayout(lo.extend ? null : lo.value, 1.7, levels, { ...geom, domain: [0.43, 2.17] });
  assert.ok(A.bandL > 16 + 1, 'anchored low edge is INSIDE the plot, not flush at x0=16');
  // vs the extend case: band flush to the left edge
  const B = rangeBarLayout(null, 1.7, levels, { ...geom, domain: [0.43, 2.17] });
  assert.equal(B.bandL, 16, 'extend low → band flush at the plot left edge');
});

test('crosshair-to-axis ALIGNMENT: cursor at a tick pixel reports that tick value (not a clamped level)', () => {
  // Anthropic-shaped domain: axis scoped to 0.43..2.17T (ticks 0.5/1/1.5/2), while the LOWEST quoted
  // level is 0.6 — the bug was the crosshair snapping to the 0.6 level anchor in the [0.43,0.6] margin.
  const dMin = 0.43, dMax = 2.17, plotL = 16, plotW = 448;
  const { xs, prices } = buildAxisSamples(dMin, dMax, plotL, plotW, 96);
  const xOf = (v) => plotL + ((v - dMin) / (dMax - dMin)) * plotW; // the SAME map the axis ticks use
  const valueAt = (vbX) => { const { i, t } = bracket(xs, vbX); return lerpAt(prices, i, t); };

  for (const tick of niceTicks(dMin, dMax, 6)) { // [0.5, 1, 1.5, 2]
    const got = valueAt(xOf(tick));
    assert.ok(Math.abs(got - tick) < 0.02, `cursor on the $${tick}T tick → ${got.toFixed(3)} (must ≈ ${tick})`);
  }
  // The exact regression: at the $0.5T tick the crosshair must read ~0.5, NOT the old clamped 0.6.
  const at05 = valueAt(xOf(0.5));
  assert.ok(Math.abs(at05 - 0.5) < 0.02 && at05 < 0.55, `at $0.5T must read ~0.50, not the old 0.60 (got ${at05.toFixed(3)})`);
  // and the value is monotonic left→right across the plot (linear axis)
  assert.ok(valueAt(plotL) < valueAt(plotL + plotW / 2) && valueAt(plotL + plotW / 2) < valueAt(plotL + plotW));
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
