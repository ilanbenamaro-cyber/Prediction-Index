// test/market-history.test.js — unit coverage for the Phase 1 history analytics.
//
// These exercise the PURE derive functions of lib/market-history.mjs (no DB), the
// same pattern as market-scan.test.js covering assembleScanRows. The DB I/O paths
// (readHistory/writeHistory/allWatchedMarketIds) are exercised by the live gate
// (scripts/verify-history.mjs), not here. The contract under test: velocity needs
// ≥7 days, dispersion needs ≥30, both return an explicit "collecting" state (never
// dashes), and deltas/biggest-moves read per-threshold survival probs from the
// stored record JSONB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linregSlope, headlineValue,
  deriveVelocity, deriveDispersion, deriveDeltas, deriveBiggestMoves,
  deriveChartSeries, headlineChange, latestSnapshotWindow, detectJumps, deriveConfidenceTrend,
  needsBackfill, stripResolutionRows,
  MIN_VELOCITY_DAYS, MIN_DISPERSION_DAYS,
} from '../lib/market-history.mjs';

// ── needsBackfill (the cron-retry rule) ───────────────────────────────────────
test('needsBackfill: null (never triggered) and "failed" retry; "done"/"pending" do not', () => {
  assert.equal(needsBackfill(null), true);
  assert.equal(needsBackfill(undefined), true);
  assert.equal(needsBackfill('failed'), true);
  assert.equal(needsBackfill('done'), false);
  assert.equal(needsBackfill('pending'), false);
});

// ── fixture helpers ──────────────────────────────────────────────────────────
const dayMs = 86_400_000;
const dateAt = (i) => new Date(i * dayMs).toISOString().slice(0, 10); // day-index → YYYY-MM-DD

/** One history row. `markets` = [{threshold,prob}] and `iqr` go into the record JSONB. */
function mkRow(dayIdx, { kind = 'survival', median = null, probability = null,
  touchLo = null, touchHi = null, markets = null, iqr = null } = {}) {
  const derived = {};
  if (markets) derived.markets = markets;
  if (iqr) derived.iqr = iqr;
  return {
    snapshot_date: dateAt(dayIdx),
    kind,
    implied_median: median,
    probability,
    touch_range_lo: touchLo,
    touch_range_hi: touchHi,
    record: { snapshot: { derived } },
  };
}

// ── linregSlope ──────────────────────────────────────────────────────────────
test('linregSlope: slope of a straight line y = 2x + 1', () => {
  assert.equal(linregSlope([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]), 2);
});

test('linregSlope: null when fewer than two points', () => {
  assert.equal(linregSlope([{ x: 0, y: 1 }]), null);
  assert.equal(linregSlope([]), null);
});

test('linregSlope: null when all x are identical (no horizontal span)', () => {
  assert.equal(linregSlope([{ x: 5, y: 1 }, { x: 5, y: 9 }]), null);
});

// ── headlineValue ────────────────────────────────────────────────────────────
test('headlineValue: survival/bucket use implied_median, binary uses probability, touch uses range midpoint', () => {
  assert.equal(headlineValue(mkRow(0, { kind: 'survival', median: 60 })), 60);
  assert.equal(headlineValue(mkRow(0, { kind: 'bucket_pmf', median: 61.1 })), 61.1);
  assert.equal(headlineValue(mkRow(0, { kind: 'binary', probability: 0.42 })), 0.42);
  assert.equal(headlineValue(mkRow(0, { kind: 'directional_touch', touchLo: 66, touchHi: 90 })), 78);
});

test('headlineValue: a one-sided touch market tracks its single available bound (not null)', () => {
  // HIGH-only "hit $X" market: no LOW crossover → track the high bound (the gap the Anthropic
  // backfill exposed — otherwise its trend never charts despite full history).
  assert.equal(headlineValue(mkRow(0, { kind: 'directional_touch', touchLo: null, touchHi: 1.84 })), 1.84);
  // LOW-only: track the low bound.
  assert.equal(headlineValue(mkRow(0, { kind: 'directional_touch', touchLo: 66, touchHi: null })), 66);
  // truly no signal → null.
  assert.equal(headlineValue(mkRow(0, { kind: 'directional_touch', touchLo: null, touchHi: null })), null);
});

// ── deriveVelocity ───────────────────────────────────────────────────────────
test('deriveVelocity: collecting state when fewer than 7 days', () => {
  const hist = [0, 1, 2, 3, 4].map((i) => mkRow(i, { median: 60 }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'collecting');
  assert.equal(v.days_needed, MIN_VELOCITY_DAYS);
  assert.equal(v.days_have, 5);
});

test('deriveVelocity: rising binary series → trend rising, positive slope', () => {
  // 0.30 → 0.50 over 7 days
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { kind: 'binary', probability: 0.30 + i * (0.20 / 6) }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'rising');
  assert.ok(v.slope > 0);
});

test('deriveVelocity: flat series → trend steady', () => {
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { median: 60 }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'steady');
});

test('deriveVelocity: falling median series → trend falling, negative slope', () => {
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { median: 66 - i }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'falling');
  assert.ok(v.slope < 0);
});

test('deriveVelocity: touch market drives velocity off the range midpoint', () => {
  // midpoint 70 → 80 (lo fixed, hi rising)
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { kind: 'directional_touch', touchLo: 60, touchHi: 80 + i * (20 / 6) }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'rising');
});

// ── deriveDispersion ─────────────────────────────────────────────────────────
test('deriveDispersion: collecting when fewer than 30 days', () => {
  const hist = [0, 1, 2].map((i) => mkRow(i, { median: 60, iqr: { p25: 50, p75: 70 } }));
  const d = deriveDispersion(hist);
  assert.equal(d.status, 'collecting');
  assert.equal(d.days_needed, MIN_DISPERSION_DAYS);
});

test('deriveDispersion: not applicable for binary / touch markets', () => {
  const hist = Array.from({ length: 31 }, (_, i) => mkRow(i, { kind: 'binary', probability: 0.5 }));
  assert.equal(deriveDispersion(hist).status, 'not_applicable');
});

test('deriveDispersion: narrowing IQR over ≥30 days → converging', () => {
  // width 40 → 10 over 31 days
  const hist = Array.from({ length: 31 }, (_, i) => {
    const half = (20 - i * (15 / 30)) / 1; // p75-p25 shrinks 40→10
    return mkRow(i, { median: 60, iqr: { p25: 60 - half, p75: 60 + half } });
  });
  const d = deriveDispersion(hist);
  assert.equal(d.status, 'ok');
  assert.equal(d.direction, 'converging');
  assert.ok(d.change_pct < 0);
});

test('deriveDispersion: widening IQR over ≥30 days → diverging', () => {
  const hist = Array.from({ length: 31 }, (_, i) => {
    const half = (5 + i * (15 / 30)); // width 10 → 40
    return mkRow(i, { median: 60, iqr: { p25: 60 - half, p75: 60 + half } });
  });
  const d = deriveDispersion(hist);
  assert.equal(d.status, 'ok');
  assert.equal(d.direction, 'diverging');
  assert.ok(d.change_pct > 0);
});

// ── deriveDeltas ─────────────────────────────────────────────────────────────
test('deriveDeltas: per-threshold P(>X) change at 1d / 7d / 30d horizons', () => {
  // prob at 1.8 climbs 0.50 + 0.01*idx over 31 days; today idx30 = 0.80
  const hist = Array.from({ length: 31 }, (_, i) =>
    mkRow(i, { median: 60, markets: [{ threshold: 1.8, prob: 0.50 + i * 0.01 }] }));
  const deltas = deriveDeltas(hist, [1.8]);
  const row = deltas.find((r) => r.threshold === 1.8);
  assert.ok(Math.abs(row.d1 - 0.01) < 1e-9); // 0.80 - 0.79
  assert.ok(Math.abs(row.d7 - 0.07) < 1e-9); // 0.80 - 0.73
  assert.ok(Math.abs(row.d30 - 0.30) < 1e-9); // 0.80 - 0.50
});

test('deriveDeltas: horizon with no matching day is null, not fabricated', () => {
  const hist = [0, 1, 2].map((i) => mkRow(i, { markets: [{ threshold: 2.0, prob: 0.4 + i * 0.01 }] }));
  const row = deriveDeltas(hist, [2.0]).find((r) => r.threshold === 2.0);
  assert.ok(Math.abs(row.d1 - 0.01) < 1e-9);
  assert.equal(row.d7, null);
  assert.equal(row.d30, null);
});

// ── deriveBiggestMoves ───────────────────────────────────────────────────────
test('deriveBiggestMoves: top movers ranked by absolute change (survival ladder)', () => {
  const hist = Array.from({ length: 31 }, (_, i) => mkRow(i, {
    markets: [
      { threshold: 1.8, prob: 0.50 + i * (0.30 / 30) }, // +0.30
      { threshold: 2.0, prob: 0.40 + i * (0.05 / 30) }, // +0.05
      { threshold: 2.4, prob: 0.30 - i * (0.20 / 30) }, // -0.20
    ],
  }));
  const moves = deriveBiggestMoves(hist, 30);
  assert.equal(moves.kind, 'ladder');
  assert.equal(moves.movers.length, 3);
  assert.equal(moves.movers[0].threshold, 1.8);
  assert.equal(moves.movers[1].threshold, 2.4);
  assert.equal(moves.movers[2].threshold, 2.0);
  assert.equal(moves.movers[0].direction, 'up');
  assert.equal(moves.movers[1].direction, 'down');
});

test('deriveBiggestMoves: binary reports the max probability swing', () => {
  const hist = Array.from({ length: 31 }, (_, i) => mkRow(i, { kind: 'binary', probability: 0.20 + i * (0.40 / 30) }));
  const moves = deriveBiggestMoves(hist, 30);
  assert.equal(moves.kind, 'binary');
  assert.ok(Math.abs(moves.change - 0.40) < 1e-9);
  assert.equal(moves.direction, 'up');
});

// ── deriveChartSeries (v1 ITEM 7: multi-line dual-axis chart) ─────────────────
/** A ladder history row carrying per-threshold survival probs + median/mean + a confidence tier. */
function ladderRow(dayIdx, { markets, median, mean = null, tier = 'high', kind = 'survival' }) {
  return {
    snapshot_date: dateAt(dayIdx),
    kind,
    implied_median: median,
    implied_mean: mean,
    confidence_tier: tier,
    record: { snapshot: { derived: { markets } } },
  };
}

test('deriveChartSeries: survival ladder → dual axis with prob lines + median/mean value lines', () => {
  const mk = (i) => ladderRow(i, {
    markets: [{ threshold: 1.8, prob: 0.80 }, { threshold: 2.0, prob: 0.50 + i * 0.01 }, { threshold: 2.4, prob: 0.20 }],
    median: 2.0 + i * 0.01, mean: 2.1 + i * 0.01,
  });
  const series = deriveChartSeries([mk(0), mk(1), mk(2)]);
  assert.equal(series.dual, true);
  // three rungs bracket P=0.75/0.5/0.25 → all three distinct thresholds chosen, ordered high→low
  assert.deepEqual(series.probLines.map((l) => l.threshold), [2.4, 2.0, 1.8]);
  assert.equal(series.probLines[0].points.length, 3);
  // value lines: median (plain) + mean (faint, dashed)
  assert.deepEqual(series.valueLines.map((l) => l.key), ['median', 'mean']);
  assert.equal(series.valueLines.find((l) => l.key === 'mean').dashed, true);
  assert.equal(series.valueLines.find((l) => l.key === 'median').points.length, 3);
});

test('deriveChartSeries: dedups when one rung is nearest multiple targets', () => {
  // a single-rung ladder → P=0.75/0.5/0.25 all snap to the same threshold → one prob line
  const mk = (i) => ladderRow(i, { markets: [{ threshold: 2.0, prob: 0.5 }], median: 2.0 });
  const series = deriveChartSeries([mk(0), mk(1)]);
  assert.equal(series.probLines.length, 1);
  assert.equal(series.probLines[0].threshold, 2.0);
});

test('deriveChartSeries: low-confidence days are flagged for dashing', () => {
  const rows = [
    ladderRow(0, { markets: [{ threshold: 2.0, prob: 0.5 }], median: 2.0, tier: 'low' }),
    ladderRow(1, { markets: [{ threshold: 2.0, prob: 0.5 }], median: 2.0, tier: 'high' }),
  ];
  const series = deriveChartSeries(rows);
  assert.deepEqual(series.lowDays, [dateAt(0)]);
});

test('deriveChartSeries: null for binary/touch/categorical (single-line falls back)', () => {
  assert.equal(deriveChartSeries([0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { kind: 'binary', probability: 0.4 }))), null);
  assert.equal(deriveChartSeries([0, 1].map((i) => mkRow(i, { kind: 'directional_touch', touchLo: 60, touchHi: 80 }))), null);
});

test('deriveChartSeries: null below two points', () => {
  assert.equal(deriveChartSeries([ladderRow(0, { markets: [{ threshold: 2.0, prob: 0.5 }], median: 2.0 })]), null);
  assert.equal(deriveChartSeries([]), null);
});

// ── Increment 2: two daily captures collapse to one row/day, preferring US-hours ──────────────
/** A history row with an explicit snapshot_hour (the Increment 2 capture-time key). */
function hourRow(dayIdx, hour, { median = null, kind = 'survival' } = {}) {
  return { snapshot_date: dateAt(dayIdx), snapshot_hour: hour, kind, implied_median: median, record: { snapshot: { derived: {} } } };
}

test('ordered (via headlineChange): a day with both 02:00 and 18:00 rows prefers the US-hours capture', () => {
  // day 0 baseline (18:00, median 60); day 7 has BOTH a 02:00 (median 70) and an 18:00 (median 65).
  // Preferring 18:00 → change = 65 − 60 = 5. Preferring 02:00 would give 10.
  const rows = [
    hourRow(0, 18, { median: 60 }),
    hourRow(7, 2, { median: 70 }),
    hourRow(7, 18, { median: 65 }),
  ];
  assert.ok(Math.abs(headlineChange(rows, 7) - 5) < 1e-9);
});

test('deriveVelocity: two captures per day count as ONE day (no double-counting)', () => {
  // 7 distinct days, each with a 02:00 AND an 18:00 row → days_have must be 7, not 14.
  const rows = [];
  for (let i = 0; i < 7; i++) { rows.push(hourRow(i, 2, { median: 60 + i })); rows.push(hourRow(i, 18, { median: 60 + i })); }
  const v = deriveVelocity(rows);
  assert.equal(v.status, 'ok');
  assert.equal(v.days_have, 7);
});

test('latestSnapshotWindow: classifies the most recent capture', () => {
  assert.equal(latestSnapshotWindow([hourRow(0, 18, { median: 60 })]), 'us-hours');
  assert.equal(latestSnapshotWindow([hourRow(0, 2, { median: 60 })]), 'off-peak');
  assert.equal(latestSnapshotWindow([hourRow(0, 0, { median: 60 })]), null); // backfill/legacy
  assert.equal(latestSnapshotWindow([]), null);
  // when a day has both, the preferred (18:00) capture drives the note
  assert.equal(latestSnapshotWindow([hourRow(0, 2, { median: 60 }), hourRow(0, 18, { median: 61 })]), 'us-hours');
});

test('ordered: legacy rows with NO snapshot_hour are treated as hour 0 (one row/day → no collapse)', () => {
  // mkRow carries no snapshot_hour — the frozen/legacy shape. A 7-day series must still derive normally.
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { median: 60 + i }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.days_have, 7);
});

// ── Increment 4: velocity jump detection ─────────────────────────────────────
test('detectJumps: no jump on a gradual series (8pp threshold not crossed)', () => {
  const hist = [0,1,2,3,4,5,6].map((i) => mkRow(i, { kind: 'binary', probability: 0.30 + i * 0.02 })); // +2pp/day
  assert.equal(detectJumps(hist).hasRecentJump, false);
});

test('detectJumps: a recent jump + flat after → hasRecentJump, stable', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  rows.push(mkRow(10, { kind: 'binary', probability: 0.70 }));              // jump +0.40
  for (let i = 11; i < 21; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.70 + (i % 2 ? 0.005 : -0.005) }));
  const j = detectJumps(rows);
  assert.equal(j.hasRecentJump, true);
  assert.equal(j.jumpDate, dateAt(10));
  assert.ok(Math.abs(j.jumpMagnitude - 0.40) < 1e-9);
  assert.equal(j.daysSinceJump, 10);
  assert.equal(j.stable, true); // post-jump σ ≈ 0.005 ≪ 0.5·0.40
});

test('detectJumps: a jump older than recentDays (21) is NOT recent', () => {
  const rows = [mkRow(0, { kind: 'binary', probability: 0.30 }), mkRow(1, { kind: 'binary', probability: 0.55 })]; // jump
  for (let i = 2; i < 26; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.55 })); // 24 flat days after
  assert.equal(detectJumps(rows).hasRecentJump, false); // daysSinceJump = 24 > 21
});

test('detectJumps: value-kind uses an 8%-of-value threshold (median ladder)', () => {
  // +10% move (2.0 → 2.20) is a jump; a +5% move (2.0 → 2.10) is not.
  const jump = detectJumps([mkRow(0, { median: 2.0 }), mkRow(1, { median: 2.20 })]);
  assert.equal(jump.hasRecentJump, true);
  const noJump = detectJumps([mkRow(0, { median: 2.0 }), mkRow(1, { median: 2.10 })]);
  assert.equal(noJump.hasRecentJump, false);
});

test('deriveVelocity: recent jump + stable after → trend "converged" (not "rising")', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  rows.push(mkRow(10, { kind: 'binary', probability: 0.70 }));
  for (let i = 11; i < 21; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.70 }));
  const v = deriveVelocity(rows);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'converged');
  assert.equal(v.jump.stable, true);
});

test('deriveVelocity: recent jump + wide post-jump drift → trend "volatile"', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  rows.push(mkRow(10, { kind: 'binary', probability: 0.40 }));               // jump +0.10
  for (let i = 11; i < 21; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.40 + (i - 10) * 0.02 })); // wide drift, no new jumps
  const v = deriveVelocity(rows);
  assert.equal(v.trend, 'volatile'); // post-jump σ ≈ 0.063 > 0.5·0.10
  assert.equal(v.jump.stable, false);
});

test('deriveVelocity: gradual series with no jump keeps the linreg trend', () => {
  const hist = [0,1,2,3,4,5,6].map((i) => mkRow(i, { median: 66 - i }));
  const v = deriveVelocity(hist);
  assert.equal(v.trend, 'falling'); // unchanged linreg path
  assert.equal(v.jump, undefined);
});

// Window clip (the labeled "7d" period must bound the post-jump regression, never the jump itself):
// a jump 15 days ago must NOT regress over all 15 post-jump points — it must match the plain 7-day
// window a no-jump series with the same last-7-day values would produce.
test('deriveVelocity: jump 15d ago clips the post-jump slope to the last 7 days (matches a no-jump 7d series)', () => {
  const rows = [];
  for (let i = 0; i <= 14; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  rows.push(mkRow(15, { kind: 'binary', probability: 0.50 })); // jump +0.20
  for (let i = 16; i <= 29; i++) rows.push(mkRow(i, { kind: 'binary', probability: 0.50 + (i - 15) * 0.005 })); // steady +0.5pp/day drift
  const v = deriveVelocity(rows);
  assert.equal(v.status, 'ok');
  assert.equal(v.jump.hasRecentJump, true);

  // A no-jump series carrying the SAME last-7-day values (days 23–29 of the above): its plain
  // 7-day linreg window is the ground truth the clipped post-jump window must match.
  const noJump = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { kind: 'binary', probability: 0.50 + (23 + i - 15) * 0.005 }));
  const v2 = deriveVelocity(noJump);
  assert.equal(v2.jump, undefined);
  assert.ok(Math.abs(v.slope - v2.slope) < 1e-9, `clipped slope ${v.slope} must equal the last-7d-only slope ${v2.slope}`);
});

test('deriveVelocity: jump 3d ago uses only the post-jump points (shorter than 7d, no clipping needed)', () => {
  const rows = [0, 1, 2, 3, 4, 5].map((i) => mkRow(i, { kind: 'binary', probability: 0.30 }));
  rows.push(mkRow(6, { kind: 'binary', probability: 0.55 })); // jump +0.25
  rows.push(mkRow(7, { kind: 'binary', probability: 0.60 }));
  rows.push(mkRow(8, { kind: 'binary', probability: 0.65 }));
  rows.push(mkRow(9, { kind: 'binary', probability: 0.70 })); // maxX=9, jumpDate day 6 → daysSinceJump=3
  const v = deriveVelocity(rows);
  assert.equal(v.status, 'ok');
  assert.equal(v.jump.daysSinceJump, 3);
  // window start = max(jumpDay=6, maxX-6=3) = 6 → post-jump points are days 6..9 only (4 points).
  const expected = linregSlope([{ x: 6, y: 0.55 }, { x: 7, y: 0.60 }, { x: 8, y: 0.65 }, { x: 9, y: 0.70 }]);
  assert.ok(Math.abs(v.slope - expected) < 1e-9);
  assert.ok(v.jump);
  assert.ok(v.trend === 'converged' || v.trend === 'volatile');
});

// ── Increment 5: confidence trend (feeds the narrative synthesis) ─────────────
test('deriveConfidenceTrend: rising / falling / steady / null from the confidence_score series', () => {
  const row = (i, score) => ({ snapshot_date: dateAt(i), confidence_score: score, kind: 'survival', record: { snapshot: { derived: {} } } });
  assert.equal(deriveConfidenceTrend([row(0, 0.5), row(1, 0.6), row(2, 0.8)]), 'rising');
  assert.equal(deriveConfidenceTrend([row(0, 0.8), row(1, 0.6), row(2, 0.4)]), 'falling');
  assert.equal(deriveConfidenceTrend([row(0, 0.70), row(1, 0.72)]), 'steady'); // <0.05 net
  assert.equal(deriveConfidenceTrend([row(0, 0.5)]), null); // <2 points
  assert.equal(deriveConfidenceTrend([]), null);
});

// ── lean read equivalence (perf, 2026-07-02): leanHistoryRow must reconstruct exactly the row
//    shape every derive fn consumes, so full-read and lean-read derivations are IDENTICAL. ──────
import { leanHistoryRow, deriveChartSeries as _dcs, deriveDeltas as _dd, deriveDispersion as _ddisp, deriveBiggestMoves as _dbm } from '../lib/market-history.mjs';

test('leanHistoryRow: derive fns produce identical output on full-record vs lean-projected rows', () => {
  const mk = (date, probs, median, iqr) => ({
    snapshot_date: date, snapshot_hour: 0, kind: 'survival',
    implied_median: median, implied_mean: median + 0.05,
    confidence_tier: 'high', reliability_score: 0.9, liquidity_score: 0.8,
    probability: null, touch_range_lo: null, touch_range_hi: null,
    dominant_outcome: null, dominant_prob: null,
    record: { snapshot: { derived: {
      markets: probs.map(([t, p]) => ({ threshold: t, prob: p, label: `>$${t}T` })),
      iqr,
      raw_inputs: [{ noise: 'never read by derives' }], narrative: 'bulk the lean read drops',
    } } },
  });
  const fullRows = [
    mk('2026-06-01', [[1, 0.9], [2, 0.5], [3, 0.1]], 2.0, { p25: 1.5, p75: 2.5 }),
    mk('2026-06-08', [[1, 0.92], [2, 0.55], [3, 0.12]], 2.1, { p25: 1.6, p75: 2.4 }),
  ];
  // The lean PROJECTION as PostgREST returns it: scalar cols + markets/iqr pulled to the top level.
  const leanRaw = fullRows.map((r) => {
    const { record, ...cols } = r;
    return { ...cols, markets: record.snapshot.derived.markets, iqr: record.snapshot.derived.iqr };
  });
  const leanRows = leanRaw.map(leanHistoryRow);

  assert.deepEqual(_dcs(leanRows), _dcs(fullRows));
  assert.deepEqual(_dd(leanRows, [1, 2, 3]), _dd(fullRows, [1, 2, 3]));
  assert.deepEqual(_ddisp(leanRows), _ddisp(fullRows));
  assert.deepEqual(_dbm(leanRows, 30), _dbm(fullRows, 30));
  // null markets (a categorical lean row) degrades to [] — never a throw
  const cat = leanHistoryRow({ snapshot_date: '2026-06-01', kind: 'categorical', markets: null, iqr: null, dominant_prob: 0.6 });
  assert.deepEqual(cat.record.snapshot.derived.markets, []);
});

test('leanHistoryRow: shape-specific paths (outcomes, high/low series) reconstruct under derived', () => {
  // categorical projection carries `outcomes`; touch carries `high_series`/`low_series` —
  // each must land back at record.snapshot.derived.<path> exactly where the full read has it.
  const catRaw = {
    snapshot_date: '2026-07-01', kind: 'categorical', dominant_outcome: 'December Meeting', dominant_prob: 0.44,
    outcomes: [{ label: 'December Meeting', probability: 0.44, raw_probability: 0.19, volume: 215856 }],
  };
  const cat = leanHistoryRow(catRaw);
  assert.deepEqual(cat.record.snapshot.derived.outcomes, catRaw.outcomes);
  assert.deepEqual(cat.record.snapshot.derived.markets, []); // ladder defaults still present
  assert.equal(cat.record.snapshot.derived.iqr, null);
  assert.equal(cat.outcomes, undefined); // moved under record, not duplicated at the top level

  const touchRaw = {
    snapshot_date: '2026-07-01', kind: 'directional_touch', touch_range_lo: 62.01, touch_range_hi: 75.65,
    high_series: [{ level: 80, prob: 0.115, volume: null }],
    low_series: [{ level: 30, prob: 0.0035, volume: null }],
  };
  const touch = leanHistoryRow(touchRaw);
  assert.deepEqual(touch.record.snapshot.derived.high_series, touchRaw.high_series);
  assert.deepEqual(touch.record.snapshot.derived.low_series, touchRaw.low_series);
  assert.equal(touch.high_series, undefined);
  // a binary lean row (no paths at all) still reconstructs the derived skeleton
  const bin = leanHistoryRow({ snapshot_date: '2026-07-01', kind: 'binary', probability: 0.12 });
  assert.deepEqual(bin.record.snapshot.derived, { markets: [], iqr: null });
});

// ── collapseDaily (Bug 2, 2026-07-06): one row per UTC date — a date can carry an hour-0
//    backfill row PLUS cron rows (unique key is date+hour since 0009); the chart must never
//    render two dots at the same x. Nearest-US-peak wins → cron beats backfill. ────────────────
import { collapseDaily } from '../lib/market-history.mjs';

test('collapseDaily: cron row (h15/h19) beats the hour-0 backfill row for the same date', () => {
  const rows = [
    { snapshot_date: '2026-06-29', snapshot_hour: 0, source: 'backfill', probability: 0.10 },
    { snapshot_date: '2026-06-29', snapshot_hour: 19, source: 'cron', probability: 0.12 },
    { snapshot_date: '2026-06-30', snapshot_hour: 0, source: 'backfill', probability: 0.11 },
  ];
  const out = collapseDaily(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].snapshot_date, '2026-06-29');
  assert.equal(out[0].source, 'cron'); // the live capture wins over the reconstruction
  assert.equal(out[0].probability, 0.12);
  assert.equal(out[1].source, 'backfill'); // sole row for its date passes through
});

test('collapseDaily: two cron captures on one date → the nearer-US-peak (18:00) hour wins', () => {
  const rows = [
    { snapshot_date: '2026-07-01', snapshot_hour: 2, source: 'cron', probability: 0.20 },
    { snapshot_date: '2026-07-01', snapshot_hour: 18, source: 'cron', probability: 0.25 },
  ];
  const out = collapseDaily(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].snapshot_hour, 18);
});

// ── deriveCategoricalSeries (multi-series pass, 2026-07-06): top-4 outcome lines. ──────────────
import { deriveCategoricalSeries } from '../lib/market-history.mjs';

/** A categorical history row: per-outcome de-vigged probs live in the record JSONB. */
function catRow(dayIdx, outcomes, { confidenceTier = 'medium' } = {}) {
  return {
    snapshot_date: dateAt(dayIdx), kind: 'categorical', confidence_tier: confidenceTier,
    record: { snapshot: { derived: { outcomes } } },
  };
}

test('deriveCategoricalSeries: top-4 by CURRENT probability, tracked by label across days', () => {
  const day = (a, b, c, d, e) => [
    { label: '0 cuts', probability: a }, { label: '1 cut', probability: b },
    { label: '2 cuts', probability: c }, { label: '3 cuts', probability: d },
    { label: '4+ cuts', probability: e },
  ];
  const rows = [catRow(0, day(0.10, 0.30, 0.25, 0.20, 0.15)), catRow(1, day(0.05, 0.35, 0.30, 0.20, 0.10))];
  const s = deriveCategoricalSeries(rows);
  assert.equal(s.dual, false);
  assert.equal(s.probLines.length, 4);
  // ranked by the LATEST day's probabilities → '0 cuts' (0.05) is the one dropped
  assert.deepEqual(s.probLines.map((l) => l.label), ['1 cut', '2 cuts', '3 cuts', '4+ cuts']);
  assert.deepEqual(s.probLines[0].points.map((p) => p.value), [0.30, 0.35]); // tracked by label
  assert.deepEqual(s.valueLines, []);
});

test('deriveCategoricalSeries: fewer than 4 outcomes → that many lines; missing days skip points', () => {
  const rows = [
    catRow(0, [{ label: 'A', probability: 0.6 }, { label: 'B', probability: 0.4 }]),
    catRow(1, [{ label: 'A', probability: 0.7 }]), // B absent this day
    catRow(2, [{ label: 'A', probability: 0.65 }, { label: 'B', probability: 0.35 }], { confidenceTier: 'low' }),
  ];
  const s = deriveCategoricalSeries(rows);
  assert.equal(s.probLines.length, 2);
  const b = s.probLines.find((l) => l.label === 'B');
  assert.deepEqual(b.points.map((p) => p.date), [dateAt(0), dateAt(2)]);
  assert.deepEqual(s.lowDays, [dateAt(2)]);
});

test('deriveCategoricalSeries: null for non-categorical rows, <2 days, or no outcomes', () => {
  assert.equal(deriveCategoricalSeries([catRow(0, [{ label: 'A', probability: 0.6 }])]), null);
  assert.equal(deriveCategoricalSeries([mkRow(0, { kind: 'binary' }), mkRow(1, { kind: 'binary' })]), null);
  assert.equal(deriveCategoricalSeries([catRow(0, []), catRow(1, [])]), null);
});

// ── deriveChartSeries IQR band (multi-series pass, 2026-07-06) ─────────────────────────────────
test('deriveChartSeries: P25–P75 band from object iqr; absent for width-only/missing iqr', () => {
  const mk = (i, iqr) => ({
    snapshot_date: dateAt(i), kind: 'survival', implied_median: 2.0 + i * 0.01, implied_mean: null,
    confidence_tier: 'high',
    record: { snapshot: { derived: { markets: [{ threshold: 2.0, prob: 0.5 }], iqr } } },
  });
  const withBand = deriveChartSeries([mk(0, { p25: 1.9, p75: 2.4 }), mk(1, { p25: 1.95, p75: 2.35 })]);
  assert.deepEqual(withBand.band, [
    { date: dateAt(0), lo: 1.9, hi: 2.4 },
    { date: dateAt(1), lo: 1.95, hi: 2.35 },
  ]);
  // a legacy NUMERIC iqr (width only) or a missing one → no band, never a throw
  assert.equal(deriveChartSeries([mk(0, 0.5), mk(1, 0.4)]).band, null);
  assert.equal(deriveChartSeries([mk(0, null), mk(1, { p25: 1.9, p75: 2.4 })]).band, null); // 1 day < 2
});

// ── deriveTouchSeries (Bug 3, 2026-07-06): the touch chart plots P(touch), not the barrier
//    price. One line per quoted side at the representative (nearest-50%) level. ────────────────
import { deriveTouchSeries } from '../lib/market-history.mjs';

/** A touch history row: per-level P(touch) series live in the record JSONB. */
function touchRow(dayIdx, { high = null, low = null, confidenceTier = 'medium' } = {}) {
  const derived = {};
  if (high) derived.high_series = high;
  if (low) derived.low_series = low;
  return {
    snapshot_date: dateAt(dayIdx), kind: 'directional_touch', confidence_tier: confidenceTier,
    record: { snapshot: { derived } },
  };
}

test('deriveTouchSeries: two-sided — picks the nearest-50% level per side and tracks it', () => {
  const rows = [
    touchRow(0, { high: [{ level: 70, prob: 0.999 }, { level: 80, prob: 0.20 }], low: [{ level: 30, prob: 0.01 }, { level: 60, prob: 0.35 }] }),
    touchRow(1, { high: [{ level: 70, prob: 0.999 }, { level: 80, prob: 0.15 }], low: [{ level: 30, prob: 0.01 }, { level: 60, prob: 0.40 }] }),
  ];
  const s = deriveTouchSeries(rows, { unit: '' });
  assert.equal(s.dual, false);
  assert.equal(s.probLines.length, 2);
  const hi = s.probLines.find((l) => l.key === 'high');
  const lo = s.probLines.find((l) => l.key === 'low');
  assert.equal(hi.threshold, 80); // |0.15−0.5| < |0.999−0.5| in the LATEST row
  assert.equal(hi.label, 'P(touch ≥ $80)');
  assert.deepEqual(hi.points.map((p) => p.value), [0.20, 0.15]);
  assert.equal(lo.threshold, 60);
  assert.equal(lo.label, 'P(touch ≤ $60)');
  assert.deepEqual(lo.points.map((p) => p.value), [0.35, 0.40]);
  assert.deepEqual(s.valueLines, []);
});

test('deriveTouchSeries: HIGH-only market → one clearly-labelled line; unit threads', () => {
  const rows = [
    touchRow(0, { high: [{ level: 1.25, prob: 0.60 }] }),
    touchRow(1, { high: [{ level: 1.25, prob: 0.55 }] }),
  ];
  const s = deriveTouchSeries(rows, { unit: 'T' });
  assert.equal(s.probLines.length, 1);
  assert.equal(s.probLines[0].key, 'high');
  assert.equal(s.probLines[0].label, 'P(touch ≥ $1.25T)');
});

test('deriveTouchSeries: a day missing the tracked level skips that point; low-conf days flagged', () => {
  const rows = [
    touchRow(0, { high: [{ level: 80, prob: 0.30 }] }),
    touchRow(1, { high: [{ level: 85, prob: 0.25 }] }, /* level 80 absent this day */),
    touchRow(2, { high: [{ level: 80, prob: 0.45 }], low: null, confidenceTier: 'low' }),
  ];
  const s = deriveTouchSeries(rows);
  const hi = s.probLines[0];
  assert.equal(hi.threshold, 80); // picked from the LATEST row
  assert.deepEqual(hi.points.map((p) => p.date), [dateAt(0), dateAt(2)]); // day 1 skipped
  assert.deepEqual(s.lowDays, [dateAt(2)]);
});

test('deriveTouchSeries: null for non-touch rows, <2 days, or no pickable level', () => {
  assert.equal(deriveTouchSeries([touchRow(0, { high: [{ level: 80, prob: 0.3 }] })]), null); // 1 day
  assert.equal(deriveTouchSeries([mkRow(0, { kind: 'binary' }), mkRow(1, { kind: 'binary' })]), null);
  assert.equal(deriveTouchSeries([touchRow(0, {}), touchRow(1, {})]), null); // no sides at all
});

test('collapseDaily: already-unique dates pass through unchanged, ascending by date', () => {
  const rows = [
    { snapshot_date: '2026-07-02', snapshot_hour: 15, source: 'cron' },
    { snapshot_date: '2026-07-01', snapshot_hour: 0, source: 'backfill' },
  ];
  const out = collapseDaily(rows);
  assert.deepEqual(out.map((r) => r.snapshot_date), ['2026-07-01', '2026-07-02']);
  assert.deepEqual(collapseDaily([]), []);
  assert.deepEqual(collapseDaily(null), []);
});

// ── REFINEMENT 1 (fix/resolved-transition-settled-truth): a resolution's final row is a settlement,
// not a market move. stripResolutionRows filters source==='transition' out of every derivation that
// NARRATES movement; the CHART series (deriveChartSeries et al, covered above) is deliberately never
// filtered — the step must still render, it just must never be counted/labeled as price action. ────

test('stripResolutionRows: drops rows with source==="transition"; legacy rows without `source` pass through', () => {
  const rows = [
    { snapshot_date: dateAt(0), source: 'cron' },
    { snapshot_date: dateAt(1), source: 'transition' },
    { snapshot_date: dateAt(2) }, // legacy row, no `source` column at all
  ];
  const out = stripResolutionRows(rows);
  assert.deepEqual(out.map((r) => r.snapshot_date), [dateAt(0), dateAt(2)]);
  assert.deepEqual(stripResolutionRows([]), []);
  assert.deepEqual(stripResolutionRows(null), []);
});

test('detectJumps: a resolution row (source="transition") is NEVER read as a jump; the identical data WITHOUT the marker still detects it (proves the guard is the discriminator)', () => {
  const flat = [];
  for (let i = 0; i < 10; i++) flat.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  const settled = { ...mkRow(10, { kind: 'binary', probability: 1.0 }), source: 'transition' };

  assert.equal(detectJumps([...flat, settled]).hasRecentJump, false, 'the settlement step must not read as a jump');

  const unmarked = { ...mkRow(10, { kind: 'binary', probability: 1.0 }) }; // same data, no source marker
  assert.equal(detectJumps([...flat, unmarked]).hasRecentJump, true, 'the SAME data without the marker IS a real jump');
});

test('deriveVelocity: excludes the resolution row from both the point count and the trend', () => {
  const flat = [];
  for (let i = 0; i < 10; i++) flat.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  const settled = { ...mkRow(10, { kind: 'binary', probability: 1.0 }), source: 'transition' };
  const v = deriveVelocity([...flat, settled]);
  assert.equal(v.days_have, 10); // the transition row is excluded from the count
  assert.equal(v.trend, 'steady'); // the real 10 days are flat — no jump-driven "rising" from settlement
  assert.equal(v.jump, undefined);
});

test('headlineChange: the resolution row is never the "today" endpoint of a narrated delta', () => {
  const flat = [];
  for (let i = 0; i <= 7; i++) flat.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  const settled = { ...mkRow(8, { kind: 'binary', probability: 1.0 }), source: 'transition' };
  // "today" resolves to day 7 (0.30); 7 days back is day 0 (0.30) → no change, despite day 8 settling to 1.0.
  assert.equal(headlineChange([...flat, settled], 7), 0);
});

test('deriveBiggestMoves: the resolution row is never counted as a move', () => {
  const flat = [];
  for (let i = 0; i <= 5; i++) flat.push(mkRow(i, { kind: 'binary', probability: 0.30 }));
  const settled = { ...mkRow(6, { kind: 'binary', probability: 1.0 }), source: 'transition' };
  const moves = deriveBiggestMoves([...flat, settled], 30);
  assert.equal(moves.change, 0, 'flat across the real (non-transition) days');
});

test('collapseDaily: a same-day transition row wins over a cron row for that date (precedence: transition > cron > backfill)', () => {
  const rows = [
    { snapshot_date: '2026-07-10', snapshot_hour: 18, source: 'cron', probability: 0.30 },
    { snapshot_date: '2026-07-10', snapshot_hour: 20, source: 'transition', probability: 1.0 },
  ];
  const out = collapseDaily(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'transition');
  assert.equal(out[0].probability, 1.0);
});

test('deriveDeltas: the settlement step never appears in the Δ columns; the same data WITHOUT the marker does (review P2)', () => {
  // 8 flat traded days at P(>2)=0.6, then the settled 0/1 step.
  const flat = [];
  for (let i = 0; i <= 7; i++) flat.push(mkRow(i, { markets: [{ threshold: 2, prob: 0.6 }] }));
  const settledRow = { ...mkRow(8, { markets: [{ threshold: 2, prob: 1.0 }] }), source: 'transition' };

  const withMarker = deriveDeltas([...flat, settledRow], [2]);
  assert.equal(withMarker[0].d1, 0, 'the settlement step must not read as a 1-day Δ');

  const unmarked = { ...mkRow(8, { markets: [{ threshold: 2, prob: 1.0 }] }) }; // same data, no marker
  const control = deriveDeltas([...flat, unmarked], [2]);
  assert.ok(Math.abs(control[0].d1 - 0.4) < 1e-9, 'the SAME data without the marker IS a real Δ (the guard is the discriminator)');
});

test('deriveDispersion: the settled point-mass IQR never fabricates a "converging" narrative (review P2)', () => {
  // 31 traded days with a stable width-1 IQR, then the resolution's degenerate point-mass (width 0).
  const traded = [];
  for (let i = 0; i <= 30; i++) traded.push(mkRow(i, { iqr: { p25: 1, p75: 2 } }));
  const settledRow = { ...mkRow(31, { iqr: { p25: 1.5, p75: 1.5 } }), source: 'transition' };

  const d = deriveDispersion([...traded, settledRow]);
  assert.equal(d.status, 'ok');
  assert.equal(d.direction, 'stable', 'traded IQR was flat — the settled point-mass must not read as converging');
  assert.equal(d.current_width, 1, 'the current width is the last TRADED width, not the settled 0');

  const unmarked = { ...mkRow(31, { iqr: { p25: 1.5, p75: 1.5 } }) }; // same data, no marker
  const control = deriveDispersion([...traded, unmarked]);
  assert.equal(control.direction, 'converging', 'the SAME data without the marker DOES converge (the guard is the discriminator)');
});
