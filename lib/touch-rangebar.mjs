// lib/touch-rangebar.mjs — pure geometry for the directional-touch implied-range bar.
//
// Why this exists: the lo/hi bound labels are anchored at the band's two edges. When the
// implied band is NARROW relative to the strike axis those edges nearly coincide, so the two
// labels (lo anchored start, hi anchored end) overlap and stack illegibly (Phase 4 Bug B).
// Below a width threshold we instead place the labels ABOVE and BELOW the bar at the band
// centre, so they never collide. Isolated here as a pure function so the threshold + placement
// are unit-tested without rendering SVG (TouchDetailView.tsx consumes the result verbatim).
//
// The geometry is PARAMETERIZED (Item 4 redesign): callers pass the plot's left edge `x0`, width
// `W`, and the label baselines so the bar lives in a padded 480×150 viewBox (real axis ticks,
// nothing clipped). The defaults reproduce the original 0..1000 / y16-72 layout EXACTLY, so the
// existing pure-geometry tests stay byte-identical.

export const RANGEBAR_W = 1000;        // default viewBox width units
export const NARROW_FRAC = 0.20;       // band < 20% of the axis → stack labels (Bug B)
const Y_ABOVE = 16, Y_BELOW = 72;      // default baselines above / below the bar

/**
 * Layout for the implied-range bar from the bound values and the strike levels.
 *   low/high: bound values in the axis unit, or null when the 50% crossover is outside the
 *             quoted ladder (the band extends to that edge — a full-width, never-narrow band).
 *   levels:   every quoted strike level (sets the axis min/max).
 *   geom:     { x0, W, yAbove, yBelow, narrowFrac } — plot placement (defaults = legacy 0..1000).
 * Returns null for an empty axis; otherwise { min, max, W, bandL, bandR, narrow, lo, hi } where
 * lo/hi are { x, y, anchor } placements (x in ABSOLUTE viewBox coords, i.e. already offset by x0).
 * When narrow, hi sits ABOVE and lo BELOW the bar (both centred on the band); otherwise both sit
 * above, lo anchored to the left edge, hi to the right.
 */
export function rangeBarLayout(low, high, levels, geom = {}) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const { x0 = 0, W = RANGEBAR_W, yAbove = Y_ABOVE, yBelow = Y_BELOW, narrowFrac = NARROW_FRAC } = geom;
  const min = Math.min(...levels), max = Math.max(...levels);
  const span = (max - min) || 1;
  const x = (lvl) => x0 + ((lvl - min) / span) * W;
  const bandL = low != null ? x(low) : x0;
  const bandR = high != null ? x(high) : x0 + W;
  const narrow = (bandR - bandL) / W < narrowFrac;
  const cx = (bandL + bandR) / 2;
  // Keep a centred label inside the viewport: hug the near edge when the band sits at an extreme.
  const anchorFor = (px) => (px < x0 + W * 0.15 ? 'start' : px > x0 + W * 0.85 ? 'end' : 'middle');
  const lo = narrow
    ? { x: cx, y: yBelow, anchor: anchorFor(cx) }
    : { x: Math.max(x0, bandL), y: yAbove, anchor: 'start' };
  const hi = narrow
    ? { x: cx, y: yAbove, anchor: anchorFor(cx) }
    : { x: Math.min(x0 + W, bandR), y: yAbove, anchor: 'end' };
  return { min, max, W, bandL, bandR, narrow, lo, hi };
}

/**
 * "Nice" round axis ticks within [min, max] — round numbers at a 1/2/5×10ⁿ step, ~count of them
 * (Item 4: the barrier axis shows readable ticks at sensible intervals, not just the min/max ends).
 * Returns [min] for a degenerate range. Endpoints aren't forced (the band/markers show the actual
 * bounds); ticks are the legible round values in between.
 */
export function niceTicks(min, max, count = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return [min];
  const rawStep = (max - min) / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step - 1e-9) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks.length ? ticks : [min, max];
}
