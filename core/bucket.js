// core/bucket.js — bucket-PMF market core (Bitcoin "between $X and $Y", Anthropic IPO).
//
// A bucket market is a set of DISJOINT price/value intervals whose YES prices form a PMF
// (probability mass function) — NOT a survival ladder. Modeling it as P(>X) (the old
// 'ladder' misclassification) collapsed comma/bracket numbers to duplicate thresholds
// (Bug 4) and produced nonsense means (Bug 2). Here we parse each leg to an interval,
// then DERIVE the survival curve P(>boundary) from the PMF (so core/metrics median/IQR/
// density still apply) and compute the mean DIRECTLY from the PMF (bounded, no outlier
// blowup). Pure; values are absolute dollars (core/money.parseMoney). See MARKET-TYPES-PLAN.md.

import { parseMoney } from './money.js';

const BETWEEN_RE = /between\s+(\$[\d.,]+[KMBT]?)\s+and\s+(\$[\d.,]+[KMBT]?)/i;
// Percentage-denominated buckets (e.g. UK GDP growth: "between 0% and 1%", "below 0%", "5% or higher").
// Values are SIGNED — growth can be negative — so the mantissa pattern allows a leading '-'.
const PCT_BETWEEN_RE = /between\s+(-?[\d.]+)\s*%\s+and\s+(-?[\d.]+)\s*%/i;
const PCT_VALUE_RE = /(-?\d+(?:\.\d+)?)\s*%/;
const LESS_RE = /less than|below|under|or less|or lower|or fewer/i;
const GREATER_RE = /greater|above|or more|or greater|at least|higher/i;

/** A bucket leg's question → { lo, hi, unit } interval, or null when the leg carries no parseable
 *  amount (a categorical leg such as "Will X not IPO …" — excluded from the PMF). `unit` is '$' for
 *  dollar-denominated buckets (Bitcoin, Anthropic) or '%' for percentage-denominated ones (UK GDP
 *  growth). Dollars have a natural 0 floor ("less than $X" → [0, X)); percentages do NOT — growth
 *  can be negative, so "below 0%" is the open interval (-∞, 0). The PMF math is unit-agnostic (it
 *  operates on the numeric lo/hi); only the display denomination differs. */
export function parseBucketLeg(question) {
  if (question == null) return null;
  const s = String(question);

  // ── dollar path (Bitcoin / Anthropic) — unchanged; tried first ──
  const between = s.match(BETWEEN_RE);
  if (between) {
    const a = parseMoney(between[1])?.value;
    const b = parseMoney(between[2])?.value;
    if (a == null || b == null) return null;
    return { lo: Math.min(a, b), hi: Math.max(a, b), unit: '$' };
  }
  const money = parseMoney(s);
  if (money) {
    if (LESS_RE.test(s)) return { lo: 0, hi: money.value, unit: '$' };
    if (GREATER_RE.test(s)) return { lo: money.value, hi: Infinity, unit: '$' };
    return { lo: money.value, hi: Infinity, unit: '$' }; // single-bound fallback → ">= value"
  }

  // ── percent path (no $ token) ──
  const pctBetween = s.match(PCT_BETWEEN_RE);
  if (pctBetween) {
    const a = parseFloat(pctBetween[1]), b = parseFloat(pctBetween[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { lo: Math.min(a, b), hi: Math.max(a, b), unit: '%' };
  }
  const pct = s.match(PCT_VALUE_RE);
  if (pct) {
    const v = parseFloat(pct[1]);
    if (!Number.isFinite(v)) return null;
    // NO 0 floor for percentages: "below 0%" is (-∞, 0), not [0, 0).
    if (LESS_RE.test(s)) return { lo: -Infinity, hi: v, unit: '%' };
    if (GREATER_RE.test(s)) return { lo: v, hi: Infinity, unit: '%' };
    return { lo: v, hi: Infinity, unit: '%' }; // single-bound fallback → ">= value"
  }

  return null; // categorical leg — no $ and no %
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Build the derived survival ladder + PMF mean from parsed bucket legs.
 *   legs: [{ lo, hi, prob }]  (prob = observed YES price = P(value ∈ bucket))
 * Returns { markets: [{threshold, prob:P(>threshold)}], mean, offset } where the markets
 * array plugs straight into computeImpliedMedian/computeIqr/computeDensity. The mean is the
 * PMF expectation Σ midpoint·prob; open tails use a half-width offset (same idea as the
 * survival mean's tail offsets), so a tiny-mass far bucket can't dominate.
 */
export function buildPmfLadder(legs) {
  const valid = (legs || []).filter((l) => l && Number.isFinite(l.prob));
  // Survival rungs: every FINITE boundary that has mass at/below it (∃ leg with finite hi ≤ b, so
  // P(>b) < 1). This is unit-agnostic — it drops a hard FLOOR like dollars' 0 (no bucket below it →
  // P(>0)=1, a trivial rung) while KEEPING a percentage market's 0 (and negative) boundaries when a
  // "below 0%" bucket sits underneath. Byte-identical to the old `> 0` filter for all-positive dollar
  // ladders (dollars' 0 has nothing below → excluded either way).
  const edges = new Set();
  for (const l of valid) {
    if (Number.isFinite(l.lo)) edges.add(l.lo);
    if (Number.isFinite(l.hi)) edges.add(l.hi);
  }
  const boundaries = [...edges]
    .filter((b) => valid.some((l) => Number.isFinite(l.hi) && l.hi <= b))
    .sort((a, b) => a - b);
  const markets = boundaries.map((b) => ({
    threshold: b,
    prob: valid.filter((l) => l.lo >= b).reduce((sum, l) => sum + l.prob, 0),
  }));

  // Tail offset = half the median MIDDLE-bucket width (fallback: half the boundary span).
  // Only buckets with a finite positive lower bound are "middle" buckets — the open bottom
  // bucket [0, hi) has an artificially huge width that would skew the median.
  const widths = valid.filter((l) => Number.isFinite(l.lo) && l.lo > 0 && Number.isFinite(l.hi)).map((l) => l.hi - l.lo);
  const span = boundaries.length >= 2 ? boundaries[boundaries.length - 1] - boundaries[0] : (boundaries[0] ?? 0);
  const offset = (widths.length ? median(widths) : span) / 2;

  let mean = 0;
  for (const l of valid) {
    let mid;
    // Open-bottom bucket: only a TRULY open (non-finite) lo gets the floor-offset midpoint. A
    // BOUNDED lo — even zero or negative, e.g. a percent rung [-2%, 0%) or dollar's [0, hi) — has
    // a well-defined width and uses its own [lo,hi) midpoint like any other bucket. `lo <= 0` was
    // too broad: it caught genuine bounded-negative percent rungs (a real leg, not an artificially
    // huge open floor) and biased their contribution to the mean. Hard Stop 2, 2026-07-02.
    if (!Number.isFinite(l.lo) && Number.isFinite(l.hi)) mid = l.hi - offset; // truly open bottom bucket
    else if (!Number.isFinite(l.hi)) mid = l.lo + offset; // top bucket [lo, ∞)
    else mid = (l.lo + l.hi) / 2; // middle bucket (incl. a bounded lo of 0 or negative)
    mean += mid * l.prob;
  }

  return { markets, mean, offset };
}
