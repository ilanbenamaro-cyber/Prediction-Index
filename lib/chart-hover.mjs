// lib/chart-hover.mjs — pure math for the shared chart hover/crosshair (ChartCrosshair.tsx).
//
// Why this exists (same reasoning as lib/touch-rangebar.mjs): the crosshair's correctness is all
// in a handful of numeric decisions — which anchor a cursor snaps to, which pair of points to
// interpolate between and by how much, how to space "every Nth" axis ticks, how to interpolate a
// probability at an arbitrary price level, and how to format a value. Isolating them here as pure
// functions lets them be unit-tested without rendering SVG or driving a browser (the interactive
// hover itself stays an operator/browser check); the .tsx consumes these verbatim. JSDoc types are
// the contract the TS callers compile against — keep @param/@returns in sync with the signatures.

/**
 * Format a number via a serializable spec: `${prefix}${(v*scale).toFixed(digits)}${suffix}`.
 * @param {number} v
 * @param {{ prefix?: string; suffix?: string; digits?: number; scale?: number }} [fmt]
 * @returns {string}
 */
export function fmtNum(v, fmt = {}) {
  const { prefix = '', suffix = '', digits = 0, scale = 1 } = fmt;
  return `${prefix}${(v * scale).toFixed(digits)}${suffix}`;
}

/**
 * Linear-interpolate a per-anchor value array at a bracket (integer index i, fraction t in [0,1]).
 * Clamps the upper index so t at the last anchor returns the last value.
 * @param {number[]} values @param {number} i @param {number} t @returns {number}
 */
export function lerpAt(values, i, t) {
  const a = values[i];
  const b = values[Math.min(i + 1, values.length - 1)];
  return a + (b - a) * t;
}

/**
 * Index of the anchor nearest a viewBox-x (snap mode). Ties resolve to the earlier anchor.
 * @param {number[]} anchorsX @param {number} x @returns {number}
 */
export function nearestAnchor(anchorsX, x) {
  let best = 0;
  for (let i = 1; i < anchorsX.length; i++) {
    if (Math.abs(anchorsX[i] - x) < Math.abs(anchorsX[best] - x)) best = i;
  }
  return best;
}

/**
 * The bracketing pair {i, t} for a cursor x over ASCENDING anchor x-positions (interpolate mode):
 * i is the lower anchor, t the fraction of the way to anchor i+1. Clamped to [0,1] so an x past
 * either end pins to that end. A single anchor → {i:0, t:0}.
 * @param {number[]} anchorsX @param {number} x @returns {{ i: number; t: number }}
 */
export function bracket(anchorsX, x) {
  if (anchorsX.length <= 1) return { i: 0, t: 0 };
  let i = 0;
  while (i < anchorsX.length - 2 && x > anchorsX[i + 1]) i++;
  const span = anchorsX[i + 1] - anchorsX[i] || 1;
  const t = Math.max(0, Math.min(1, (x - anchorsX[i]) / span));
  return { i, t };
}

/**
 * Pick ~maxTicks evenly-spaced items (always including the first and last) so a dense series' axis
 * labels don't overlap — the "label every Nth point" pattern. Never returns duplicate indices.
 * @template T @param {T[]} arr @param {number} maxTicks @returns {{ item: T; i: number }[]}
 */
export function pickTicks(arr, maxTicks) {
  const n = arr.length;
  if (n <= maxTicks) return arr.map((item, i) => ({ item, i }));
  const step = (n - 1) / (maxTicks - 1);
  const out = [];
  for (let k = 0; k < maxTicks; k++) { const i = Math.round(k * step); out.push({ item: arr[i], i }); }
  return out.filter((v, idx, a) => a.findIndex((z) => z.i === v.i) === idx);
}

/**
 * The Y domain for a probability axis FITTED TO THE VISIBLE DATA (Bug 1, 2026-07-06: a fixed
 * 0–100% axis made every sub-extreme series read as a flat line and never re-domained on the
 * 7D/30D/90D/ALL switch). Pads the data range, enforces a minimum span so day-to-day noise isn't
 * amplified into fake volatility (a trust product must not make a becalmed market look wild),
 * and clamps into [0,1] shifting to preserve the span at the edges. Empty input → full [0,1].
 * @param {number[]} values probabilities in 0..1 (the FILTERED window's points)
 * @param {{ minSpan?: number }} [opts] minimum axis span (default 0.10 = 10pp)
 * @returns {{ lo: number; hi: number }}
 */
export function probDomain(values, { minSpan = 0.10 } = {}) {
  const vs = (values ?? []).filter((v) => v != null && Number.isFinite(v));
  if (vs.length === 0) return { lo: 0, hi: 1 };
  const min = Math.min(...vs), max = Math.max(...vs);
  const pad = (max - min) * 0.15 || minSpan / 2;
  let lo = min - pad, hi = max + pad;
  if (hi - lo < minSpan) { const c = (lo + hi) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
  if (lo < 0) { hi = Math.min(1, hi - lo); lo = 0; }
  else if (hi > 1) { lo = Math.max(0, lo - (hi - 1)); hi = 1; }
  return { lo, hi };
}

/**
 * Probability at an arbitrary price `level` by linear interpolation of an ASCENDING {level,prob}
 * series, clamped to the series' ends (used for the touch bar's P(touch ≥/≤) hover). Empty → 0.
 * @param {{ level: number; prob: number }[]} pts @param {number} level @returns {number}
 */
export function interpSeriesAtLevel(pts, level) {
  if (pts.length === 0) return 0;
  if (level <= pts[0].level) return pts[0].prob;
  if (level >= pts[pts.length - 1].level) return pts[pts.length - 1].prob;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (level >= a.level && level <= b.level) {
      const t = (level - a.level) / ((b.level - a.level) || 1);
      return a.prob + (b.prob - a.prob) * t;
    }
  }
  return pts[pts.length - 1].prob;
}
