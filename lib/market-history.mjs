// lib/market-history.mjs — the Phase 1 per-market history layer (SERVER-ONLY for I/O).
//
// Why this exists: the multi-market product computes on demand and caches ONE snapshot,
// so every trend/velocity/dispersion card was empty (the v1 SpaceX tracker showed all of
// them from a stored daily series). This module is the foundational unlock: a daily cron
// (app/api/snapshot) writes one row per watched market per UTC day into market_history;
// the detail view reads the series back and derives the analytics the cards display.
//
// Two halves:
//   • PURE derive functions (linregSlope, headlineValue, deriveVelocity/Dispersion/
//     Deltas/BiggestMoves) — no DB, unit-tested in test/market-history.test.js.
//   • SERVER-ONLY I/O (db, allWatchedMarketIds, writeHistory, readHistory) — uses the
//     SERVICE-ROLE key exactly like lib/cache.mjs / lib/market-scan.mjs and must NEVER be
//     imported into client code. market_history is RLS deny-all (migration 0006, mirroring
//     market_snapshots): the service role is the only reader, so readHistory is bounded to a
//     single caller-supplied market_id — the same per-market trust level as /api/market.
//
// THE RULE the UI relies on: a series shorter than the minimum returns an explicit
// { status:'collecting', days_have, days_needed } — never dashes, never a fabricated number.

import { createClient } from '@supabase/supabase-js';
import { collapseConfidenceTier } from '../core/confidence.js';

export const MIN_VELOCITY_DAYS = 7;
export const MIN_DISPERSION_DAYS = 30;
const DAY_MS = 86_400_000;
const TREND_DEADBAND = 0.01; // <1% net move over the window reads as "steady" (1pp for binary)
const DISPERSION_DEADBAND = 0.01; // <1% IQR-width change reads as "stable"

// ── pure helpers ──────────────────────────────────────────────────────────────

/** Integer UTC day index for a 'YYYY-MM-DD' snapshot_date (stable, timezone-free). */
function dayIndex(snapshotDate) {
  return Math.round(Date.parse(`${snapshotDate}T00:00:00Z`) / DAY_MS);
}

/** Ordinary least-squares slope of y over x. null if <2 points or no horizontal span. */
export function linregSlope(points) {
  const pts = points ?? [];
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y } of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null; // all x identical
  return (n * sxy - sx * sy) / denom;
}

/** The headline scalar a market's velocity tracks, by kind:
 *  survival/bucket_pmf → implied_median; binary → YES probability;
 *  directional_touch → the implied-range midpoint (null if a bound is missing). */
export function headlineValue(row) {
  if (!row) return null;
  if (row.kind === 'binary') return row.probability ?? null;
  if (row.kind === 'categorical') return row.dominant_prob ?? null;
  if (row.kind === 'directional_touch') {
    // Both bounds → the range midpoint. A ONE-SIDED market (HIGH-only "hit $X" → no LOW crossover,
    // or LOW-only → no HIGH) has one bound null by construction; track the single available
    // crossover so its trend still charts (else velocity/chart stay empty forever, even with full
    // history — the gap the Anthropic backfill exposed). Neither bound → null (truly no signal).
    const lo = row.touch_range_lo, hi = row.touch_range_hi;
    if (lo != null && hi != null) return (lo + hi) / 2;
    return hi ?? lo ?? null;
  }
  return row.implied_median ?? null; // survival | bucket_pmf
}

/** P(>threshold) at a stored ladder snapshot (the adjusted survival prob). null if absent. */
function ladderProbAt(record, threshold) {
  const ms = record?.snapshot?.derived?.markets ?? [];
  const m = ms.find((x) => x.threshold === threshold);
  return m && m.prob != null ? m.prob : null;
}

/** IQR width (p75 − p25) at a stored ladder snapshot. null if absent. */
function iqrWidth(record) {
  const iqr = record?.snapshot?.derived?.iqr;
  if (iqr == null) return null;
  if (typeof iqr === 'number') return iqr;
  if (iqr.p25 != null && iqr.p75 != null) return iqr.p75 - iqr.p25;
  return null;
}

// Increment 2: two daily crons (02:00 + 18:00 UTC) can write TWO rows per market per day. The
// US-hours capture (18:00 UTC ≈ 1–2pm ET) is the higher-liquidity, better datapoint, so when a day
// has both we PREFER the one nearest US peak. snapshot_hour: 18 = US cron, 2 = off-peak cron, 0 =
// backfill / legacy single-daily rows. Frozen history carries no snapshot_hour (→ 0), so a
// one-row-per-day series collapses to itself — SpaceX Gate 3 stays byte-identical.
const US_PEAK_HOUR = 18;

// fix/resolved-transition-settled-truth: a resolution's final row (source='transition') must win
// its day over EITHER a cron capture or a backfill reconstruction — it's the settled truth, not an
// estimate, and it's the last thing that will ever be recorded for this market. Ranked ABOVE the
// hour-distance tiebreak (checked first), so a same-day transition can never lose to a nearer-peak
// cron row. Legacy rows predating the `source` column carry no value → default to 'cron' rank.
const SOURCE_RANK = { transition: 2, cron: 1, backfill: 0 };
const sourceRank = (source) => SOURCE_RANK[source] ?? SOURCE_RANK.cron;

/** Is capture `a` a better datapoint than `b`? Precedence: source (transition > cron > backfill),
 *  then nearest-US-peak hour, then (tie) the later hour. */
function prefersCapture(a, b) {
  const ra = sourceRank(a.source), rb = sourceRank(b.source);
  if (ra !== rb) return ra > rb;
  const da = Math.abs((a.snapshot_hour ?? 0) - US_PEAK_HOUR);
  const db = Math.abs((b.snapshot_hour ?? 0) - US_PEAK_HOUR);
  if (da !== db) return da < db;
  return (a.snapshot_hour ?? 0) > (b.snapshot_hour ?? 0);
}

/** PURE: collapse history rows to ONE row per UTC date (a same-day resolution 'transition' row wins
 *  first; otherwise the nearest-US-peak capture wins — so a cron capture at hour 15/19 beats an
 *  hour-0 backfill reconstruction of the same day), ascending by date. Since migration 0009 the
 *  unique key is (market_id, snapshot_date, snapshot_hour), so a date can legitimately carry a
 *  backfill row PLUS cron rows; every consumer wants one point per day. Exported for the dedup
 *  tests and reused by ordered(). */
export function collapseDaily(history) {
  const byDate = new Map();
  for (const r of (history ?? [])) {
    const prev = byDate.get(r.snapshot_date);
    if (!prev || prefersCapture(r, prev)) byDate.set(r.snapshot_date, r);
  }
  return [...byDate.values()].sort((a, b) => dayIndex(a.snapshot_date) - dayIndex(b.snapshot_date));
}

/** Rows ascending by day, COLLAPSED to one row per UTC date (the nearest-US-peak capture wins),
 *  with a precomputed integer day index attached. */
function ordered(history) {
  return collapseDaily(history).map((r) => ({ ...r, _x: dayIndex(r.snapshot_date) }));
}

/** A categorical row's exclusivity MODE (5.6 guard): 'exclusive' (de-vig PMF era) vs the
 *  guarded verdicts. Non-categorical rows are mode-constant by construction. */
function exclusivityMode(row) {
  return row?.record?.snapshot?.derived?.exclusivity?.verdict ?? 'exclusive';
}

/** MODE SEGMENTATION (5.6 guard): trim ordered categorical rows to the LATEST run of a
 *  constant exclusivity mode. A guard transition changes the SEMANTICS of the tracked
 *  values (fabricated de-vig → honest raw) — deriving across it would render our own
 *  bug as a market move, and detectJumps would narrate it ("post-jump velocity") — a
 *  fabrication with a story attached. Same reason band-edge flapping (a board
 *  oscillating around the exclusive-sum band across snapshots) must never read as
 *  volatility. Non-categorical histories pass through untouched. */
function latestModeSegment(rows) {
  if (rows.length === 0 || rows[rows.length - 1].kind !== 'categorical') return rows;
  const mode = exclusivityMode(rows[rows.length - 1]);
  let start = rows.length - 1;
  while (start > 0 && exclusivityMode(rows[start - 1]) === mode) start--;
  return rows.slice(start);
}

/** The capture window of the most recent datapoint, for the "Using US-hours snapshot" display note.
 *  'us-hours' (afternoon UTC capture), 'off-peak' (early-UTC capture), or null (backfill/legacy). */
export function latestSnapshotWindow(history) {
  const rows = ordered(history);
  if (rows.length === 0) return null;
  const h = rows[rows.length - 1].snapshot_hour ?? 0;
  if (h >= 12) return 'us-hours';
  if (h >= 1) return 'off-peak';
  return null;
}

// Increment 4: jump detection. Prediction markets move in JUMPS (news breaks) then plateau, so a
// linear regression reads a 3-week-old jump as "rising fast" when the market has actually converged.
// We find the latest single-day jump and, when it's recent, compute velocity on POST-JUMP data only.
const JUMP_THRESHOLD = 0.08;       // 8pp for prob-kinds (binary/categorical); 8% of value for the rest
const JUMP_RECENT_DAYS = 21;       // a jump within 3 weeks is still analytically relevant (operator)
const JUMP_STABLE_FRACTION = 0.5;  // post-jump σ < ½·|jump| → the market has converged (stable since)

// REFINEMENT 1 (fix/resolved-transition-settled-truth): a resolution's final row (source='transition')
// jumps the headline straight to the settled 0/1 (e.g. dominant 0.589 → 1.0) — a real, honest step,
// but NOT a market move; nobody traded it there, it's the outcome. Left unfiltered, detectJumps/
// deriveVelocity/headlineChange/deriveBiggestMoves would narrate a ~41pt "move" that never happened
// as trading. Mirrors the 5.6 `latestModeSegment` precedent (a guard transition isn't a market move
// either) — this is a NARRATION-only filter: the CHART series (deriveChartSeries et al.) still plots
// the row; the step should render, it just must never be counted/labeled as price action.

/** PURE: drop rows whose source is 'transition' (the resolution stamp) — for derivations that
 *  NARRATE movement (jumps, velocity, headline deltas, biggest-movers). Never applied to chart
 *  series, which must still render the settlement step. Legacy rows with no `source` column pass
 *  through unfiltered (source undefined ≠ 'transition'). */
export function stripResolutionRows(rows) {
  return (rows ?? []).filter((r) => r.source !== 'transition');
}

/** Population standard deviation (0 for <2 points). */
function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
}

// ── derive functions (pure) ─────────────────────────────────────────────────

/**
 * Detect the most recent single-day JUMP in the headline series. A jump exceeds JUMP_THRESHOLD:
 * 8pp absolute for prob-kinds (binary/categorical), 8% of the prior value for value-kinds. Returns
 * { hasRecentJump } and, when a jump exists, { jumpDate, jumpMagnitude, daysSinceJump, postJumpStdDev,
 * stable } — `stable` is post-jump σ < ½·|jump| (the market converged after the move). `hasRecentJump`
 * gates on the jump being within `recentDays`. Pure; no jump (or <2 points) → { hasRecentJump:false }.
 */
export function detectJumps(history, { threshold = JUMP_THRESHOLD, recentDays = JUMP_RECENT_DAYS } = {}) {
  // 5.6: a guard transition is not a jump; REFINEMENT 1: neither is the final resolution row.
  const rows = stripResolutionRows(latestModeSegment(ordered(history)));
  const kind = rows.length ? rows[rows.length - 1].kind : null;
  const isProb = kind === 'binary' || kind === 'categorical';
  const pts = rows.map((r) => ({ x: r._x, y: headlineValue(r), date: r.snapshot_date })).filter((p) => p.y != null);
  if (pts.length < 2) return { hasRecentJump: false };
  let last = null;
  for (let i = 1; i < pts.length; i++) {
    const delta = pts[i].y - pts[i - 1].y;
    const bound = isProb ? threshold : threshold * Math.max(Math.abs(pts[i - 1].y), 1e-9);
    if (Math.abs(delta) > bound) last = { x: pts[i].x, date: pts[i].date, magnitude: delta };
  }
  if (!last) return { hasRecentJump: false };
  const maxX = pts[pts.length - 1].x;
  const daysSinceJump = maxX - last.x;
  const postJumpStdDev = stdDev(pts.filter((p) => p.x >= last.x).map((p) => p.y));
  return {
    hasRecentJump: daysSinceJump <= recentDays,
    jumpDate: last.date,
    jumpMagnitude: last.magnitude,
    daysSinceJump,
    postJumpStdDev,
    stable: postJumpStdDev < JUMP_STABLE_FRACTION * Math.abs(last.magnitude),
  };
}

/**
 * Velocity of the headline value. JUMP-AWARE (Increment 4): with NO recent jump it's the linear
 * regression over the most recent MIN_VELOCITY_DAYS-day window (gradual drift). With a recent jump it
 * computes the slope on POST-JUMP data only and reports 'converged' (post-jump σ small → stable since)
 * or 'volatile' (still moving) — carrying a `jump` descriptor for the card + narrative. Returns
 * { status:'collecting', … } below the minimum.
 */
export function deriveVelocity(history) {
  // 5.6: never derive across a guard transition; REFINEMENT 1: nor across the resolution row.
  const rows = stripResolutionRows(latestModeSegment(ordered(history)));
  const kind = rows.length ? rows[rows.length - 1].kind : null;
  const pts = rows.map((r) => ({ x: r._x, y: headlineValue(r) })).filter((p) => p.y != null);
  if (pts.length < MIN_VELOCITY_DAYS) {
    return { status: 'collecting', days_have: pts.length, days_needed: MIN_VELOCITY_DAYS };
  }
  const jump = detectJumps(history);
  if (jump.hasRecentJump) {
    // Drift on POST-JUMP data only, CLIPPED to the last MIN_VELOCITY_DAYS (the labeled "7d" period):
    // the window never spans the jump (start ≥ jump day) and never exceeds the labeled period (start
    // ≥ maxX − 6), so a jump up to 21d old can't silently regress over a much-wider-than-7d window
    // while the card still reads "7d".
    const jx = dayIndex(jump.jumpDate);
    const maxX = pts[pts.length - 1].x;
    const post = pts.filter((p) => p.x >= Math.max(jx, maxX - (MIN_VELOCITY_DAYS - 1)));
    const slope = linregSlope(post);
    const change = post.length >= 2 ? post[post.length - 1].y - post[0].y : 0;
    const trend = jump.stable ? 'converged' : 'volatile';
    return { status: 'ok', kind, slope, trend, period: `${MIN_VELOCITY_DAYS}d`, change, days_have: pts.length, jump };
  }
  const maxX = pts[pts.length - 1].x;
  const win = pts.filter((p) => p.x >= maxX - (MIN_VELOCITY_DAYS - 1));
  const slope = linregSlope(win);
  const yFirst = win[0].y, yLast = win[win.length - 1].y;
  const change = yLast - yFirst;
  const denom = kind === 'binary' ? 1 : Math.max(Math.abs(yFirst), 1e-9);
  const rel = change / denom;
  const trend = Math.abs(rel) < TREND_DEADBAND ? 'steady' : rel > 0 ? 'rising' : 'falling';
  return { status: 'ok', kind, slope, trend, period: `${MIN_VELOCITY_DAYS}d`, change, days_have: pts.length };
}

/** The direction of a stored 0..1 score series (`column` on each ordered row) — 'rising' /
 *  'falling' / 'steady', or null below 2 finite points. A <0.05 net move reads as steady. Legacy
 *  history rows (pre-0010) have null reliability_score/liquidity_score → those dimensions return
 *  null ("collecting") until the split columns accrue, never a fabricated trend. */
function scoreTrend(history, column) {
  const rows = ordered(history);
  const pts = rows.map((r) => r[column]).filter((s) => s != null && Number.isFinite(s));
  if (pts.length < 2) return null;
  const net = pts[pts.length - 1] - pts[0];
  if (Math.abs(net) < 0.05) return 'steady';
  return net > 0 ? 'rising' : 'falling';
}

/** Increment 5 / confidence split: the RELIABILITY-score trend over the stored series. Feeds the
 *  narrative cross-signal synthesis (e.g. "rising median but FALLING reliability") — the trend claim
 *  is about whether the NUMBER is trustworthy, so it keys off reliability, not liquidity. */
export function deriveReliabilityTrend(history) {
  return scoreTrend(history, 'reliability_score');
}

/** The LIQUIDITY-score trend over the stored series (can-you-transact direction). */
export function deriveLiquidityTrend(history) {
  return scoreTrend(history, 'liquidity_score');
}

/** Legacy single-confidence trend (collapsed worst score). Kept for back-compat with pre-0010 rows
 *  whose only confidence column is confidence_score. New surfaces use the reliability/liquidity
 *  trends above. */
export function deriveConfidenceTrend(history) {
  return scoreTrend(history, 'confidence_score');
}

/**
 * v1 ITEM 1: the net change in the HEADLINE value over the last `days` (today vs the row nearest
 * `days` ago) — drives the narrative's "down/up $X over the past month / this week". Null when
 * there are <2 usable points or today's headline is null. The caller gates by days_have so a
 * too-short window isn't mislabelled "past month".
 */
export function headlineChange(history, days) {
  const rows = stripResolutionRows(ordered(history)); // REFINEMENT 1: never narrate the resolution as a move
  const pts = rows.map((r) => ({ x: r._x, y: headlineValue(r) })).filter((p) => p.y != null);
  if (pts.length < 2) return null;
  const today = pts[pts.length - 1];
  const targetX = today.x - days;
  const prior = pts.slice(0, -1).reduce((best, p) =>
    (best == null || Math.abs(p.x - targetX) < Math.abs(best.x - targetX)) ? p : best, null);
  return prior ? today.y - prior.y : null;
}

/**
 * Dispersion = how the 50% band (IQR width) has moved over ~30 days. Only meaningful for
 * survival/bucket_pmf (binary/touch have no settlement distribution → not_applicable).
 * Returns collecting below the minimum; otherwise { status:'ok', direction:'converging'
 * |'diverging'|'stable', current_width, width_30d_ago, change_pct, days_have }.
 */
export function deriveDispersion(history) {
  const rows = ordered(history);
  const kind = rows.length ? rows[rows.length - 1].kind : null;
  // Binary/touch/categorical have no settlement distribution → no IQR-based dispersion.
  if (kind === 'binary' || kind === 'directional_touch' || kind === 'categorical') return { status: 'not_applicable', kind };
  const pts = rows.map((r) => ({ x: r._x, w: iqrWidth(r.record) })).filter((p) => p.w != null);
  if (pts.length < MIN_DISPERSION_DAYS) {
    return { status: 'collecting', days_have: pts.length, days_needed: MIN_DISPERSION_DAYS };
  }
  const last = pts[pts.length - 1];
  const targetX = last.x - MIN_DISPERSION_DAYS;
  const baseline = pts.reduce((best, p) =>
    Math.abs(p.x - targetX) < Math.abs(best.x - targetX) ? p : best, pts[0]);
  const change_pct = baseline.w !== 0 ? (last.w - baseline.w) / baseline.w : 0;
  const direction = change_pct < -DISPERSION_DEADBAND ? 'converging'
    : change_pct > DISPERSION_DEADBAND ? 'diverging' : 'stable';
  return { status: 'ok', direction, current_width: last.w, width_30d_ago: baseline.w, change_pct, days_have: pts.length };
}

/**
 * Per-threshold P(>X) change at the 1d / 7d / 30d horizons (today vs the row exactly that
 * many days earlier). A horizon with no matching day is null — never fabricated. Returns
 * [{ threshold, d1, d7, d30 }] for the requested thresholds (ladder/bucket markets only).
 */
export function deriveDeltas(history, thresholds) {
  const rows = ordered(history);
  if (rows.length === 0) return (thresholds ?? []).map((t) => ({ threshold: t, d1: null, d7: null, d30: null }));
  const byDay = new Map(rows.map((r) => [r._x, r]));
  const today = rows[rows.length - 1];
  const todayX = today._x;
  const at = (row, t) => (row ? ladderProbAt(row.record, t) : null);
  const delta = (t, h) => {
    const now = at(today, t), then = at(byDay.get(todayX - h), t);
    return now != null && then != null ? now - then : null;
  };
  return (thresholds ?? []).map((t) => ({ threshold: t, d1: delta(t, 1), d7: delta(t, 7), d30: delta(t, 30) }));
}

/**
 * The biggest probability moves over the last `days`. For survival/bucket markets: the top-3
 * thresholds by |ΔP(>X)| → { kind:'ladder', movers:[{threshold,start,end,change,direction}] }.
 * For binary: the net YES-probability swing → { kind:'binary', start, end, change, direction }.
 * For touch: the range-midpoint shift. Categorical is filled in Phase 1b.
 */
export function deriveBiggestMoves(history, days = 30) {
  const rows = stripResolutionRows(ordered(history)); // REFINEMENT 1: never narrate the resolution as a move
  if (rows.length < 2) return { kind: rows[0]?.kind ?? null, movers: [], period: `${days}d` };
  const today = rows[rows.length - 1];
  const targetX = today._x - days;
  const start = rows.reduce((best, r) =>
    Math.abs(r._x - targetX) < Math.abs(best._x - targetX) ? r : best, rows[0]);
  const dir = (c) => (c > 0 ? 'up' : c < 0 ? 'down' : 'flat');

  if (today.kind === 'binary') {
    const s = start.probability ?? null, e = today.probability ?? null;
    const change = s != null && e != null ? e - s : null;
    return { kind: 'binary', start: s, end: e, change, direction: change == null ? 'flat' : dir(change), period: `${days}d` };
  }
  if (today.kind === 'directional_touch') {
    const s = headlineValue(start), e = headlineValue(today);
    const change = s != null && e != null ? e - s : null;
    return { kind: 'directional_touch', start: s, end: e, change, direction: change == null ? 'flat' : dir(change), period: `${days}d` };
  }

  const thresholds = (today.record?.snapshot?.derived?.markets ?? []).map((m) => m.threshold);
  const movers = thresholds.map((t) => {
    const s = ladderProbAt(start.record, t), e = ladderProbAt(today.record, t);
    const change = s != null && e != null ? e - s : null;
    return { threshold: t, start: s, end: e, change, direction: change == null ? 'flat' : dir(change) };
  }).filter((m) => m.change != null)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 3);
  return { kind: 'ladder', movers, period: `${days}d` };
}

/** The representative thresholds for the multi-line chart: the rungs nearest P=0.75 / 0.5 / 0.25
 *  in the latest snapshot — they bracket the distribution (low / at-the-money / high tail) without
 *  the 0%/100% noise rungs. Deduped, ordered high→low threshold (v1's three-line hierarchy). */
function pickChartThresholds(markets) {
  if (!Array.isArray(markets) || markets.length === 0) return [];
  const chosen = [];
  for (const target of [0.75, 0.5, 0.25]) {
    const m = markets.reduce((best, x) =>
      (x.prob != null && Math.abs(x.prob - target) < Math.abs((best?.prob ?? Infinity) - target)) ? x : best, null);
    if (m && !chosen.includes(m.threshold)) chosen.push(m.threshold);
  }
  return chosen.sort((a, b) => b - a);
}

/**
 * v1 ITEM 7: the multi-line dual-axis chart series for a SURVIVAL/BUCKET ladder — per-threshold
 * P(>X) lines on the probability axis (0–100%) plus the implied median (+ faint mean) on the value
 * axis, exactly the v1 trend chart. Returns null for binary/touch/categorical (single-line: the
 * caller falls back to the lean headline series) and below 2 points. Lean {date,value}[] per line —
 * the heavy record JSONB is read here on the server and never shipped; only the scalars cross.
 * `lowDays` carries the dates whose confidence was 'low' so the client can dash those segments.
 */
export function deriveChartSeries(history) {
  const rows = ordered(history);
  if (rows.length < 2) return null;
  const kind = rows[rows.length - 1].kind;
  const isLadder = kind === 'survival' || kind === 'bucket_pmf' || kind === 'threshold_ladder';
  if (!isLadder) return null;
  const latestMarkets = rows[rows.length - 1].record?.snapshot?.derived?.markets ?? [];
  const thresholds = pickChartThresholds(latestMarkets);
  const probLines = thresholds.map((t) => ({
    key: `p-${t}`,
    threshold: t,
    points: rows.map((r) => ({ date: r.snapshot_date, value: ladderProbAt(r.record, t) })).filter((p) => p.value != null),
  })).filter((l) => l.points.length >= 1);
  const medianPts = rows.map((r) => ({ date: r.snapshot_date, value: r.implied_median ?? null })).filter((p) => p.value != null);
  const meanPts = rows.map((r) => ({ date: r.snapshot_date, value: r.implied_mean ?? null })).filter((p) => p.value != null);
  const valueLines = [];
  if (medianPts.length >= 1) valueLines.push({ key: 'median', label: 'Implied median', points: medianPts });
  if (meanPts.length >= 1) valueLines.push({ key: 'mean', label: 'Implied mean', points: meanPts, faint: true, dashed: true });
  if (probLines.length === 0 && valueLines.length === 0) return null;
  const lowDays = rows.filter((r) => r.confidence_tier === 'low').map((r) => r.snapshot_date);
  // P25–P75 IQR band behind the median (multi-series pass, 2026-07-06): the dispersion of the
  // settlement distribution over time, read off the value axis. Only from an OBJECT iqr (p25+p75);
  // a legacy numeric iqr is width-only → no band. Requires ≥2 days like every plotted series.
  const band = [];
  for (const r of rows) {
    const iqr = r.record?.snapshot?.derived?.iqr;
    if (iqr != null && typeof iqr === 'object' && iqr.p25 != null && iqr.p75 != null) {
      band.push({ date: r.snapshot_date, lo: iqr.p25, hi: iqr.p75 });
    }
  }
  return { dual: true, probLines, valueLines, lowDays, band: band.length >= 2 ? band : null };
}

/**
 * The per-outcome chart series for a CATEGORICAL market (multi-series pass, 2026-07-06): the top
 * 4 outcomes by CURRENT de-vigged probability, each tracked by LABEL across days (a day missing
 * that outcome skips the point — never fabricated). One % axis; the legend names each outcome.
 * Lean {date,value}[] only. Returns null for non-categorical rows, <2 days, or no outcomes.
 * @param {Array<object>} history readHistoryLean rows (shape 'categorical')
 * @returns {{ dual: false, probLines: Array<{key: string, label: string, points: Array<{date: string, value: number}>}>, valueLines: [], lowDays: string[] } | null}
 */
export function deriveCategoricalSeries(history) {
  const rows = latestModeSegment(ordered(history)); // 5.6: one mode per chart — no spliced semantics
  if (rows.length < 2) return null;
  if (rows[rows.length - 1].kind !== 'categorical') return null;
  // Guarded rows (5.6) carry raw_probability with `probability` suppressed — the chart plots
  // whichever the segment's mode provides (the segment is mode-homogeneous by construction).
  const val = (o) => (o?.probability ?? o?.raw_probability ?? null);
  const latest = rows[rows.length - 1].record?.snapshot?.derived?.outcomes ?? [];
  const top = latest.filter((o) => o?.label && val(o) != null)
    .sort((a, b) => val(b) - val(a))
    .slice(0, 4);
  if (top.length === 0) return null;
  const probLines = top.map((o) => ({
    key: `o-${o.label}`,
    label: o.label,
    points: rows.map((r) => {
      const hit = (r.record?.snapshot?.derived?.outcomes ?? []).find((x) => x?.label === o.label);
      return hit && val(hit) != null ? { date: r.snapshot_date, value: val(hit) } : null;
    }).filter(Boolean),
  })).filter((l) => l.points.length >= 1);
  if (probLines.length === 0) return null;
  const lowDays = rows.filter((r) => r.confidence_tier === 'low').map((r) => r.snapshot_date);
  return { dual: false, probLines, valueLines: [], lowDays };
}

/** The representative barrier level of a touch side: the level whose CURRENT P(touch) is nearest
 *  50% — the informative strike (deep-ITM ~1 and deep-OTM ~0 levels carry no trend signal). The
 *  same "bracket the action" idea as pickChartThresholds. null on an empty/missing side. */
function pickTouchLevel(series) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const best = series.reduce((acc, p) =>
    (p?.prob != null && Math.abs(p.prob - 0.5) < Math.abs((acc?.prob ?? Infinity) - 0.5)) ? p : acc, null);
  return best?.level ?? null;
}

/**
 * The P(touch) chart series for a DIRECTIONAL-TOUCH market (Bug 3, 2026-07-06): the barrier PRICE
 * midpoint is a dollar value and charting it put "$6.02K"-style labels on the Y axis — the chart
 * now plots the touch PROBABILITIES themselves. One line per quoted side — P(touch ≥ L_hi) from
 * high_series and P(touch ≤ L_lo) from low_series, each tracked at the representative level picked
 * from the LATEST snapshot (nearest-50% strike) across all days; a one-sided market (HIGH-only /
 * LOW-only) gets its single line, clearly labelled. Lean {date,value}[] only — serializable.
 * Returns null for non-touch rows, <2 days, or when neither side has a pickable level.
 * @param {Array<object>} history readHistoryLean rows (shape 'directional_touch')
 * @param {{ unit?: string }} [opts] the market's ladder unit for the line labels ('' | 'K' | 'T' | '%')
 * @returns {{ dual: false, probLines: Array<{key: string, label: string, threshold: number, points: Array<{date: string, value: number}>}>, valueLines: [], lowDays: string[] } | null}
 */
export function deriveTouchSeries(history, { unit = '' } = {}) {
  const rows = ordered(history);
  if (rows.length < 2) return null;
  if (rows[rows.length - 1].kind !== 'directional_touch') return null;
  const latest = rows[rows.length - 1].record?.snapshot?.derived ?? {};
  const pfx = unit === '%' ? '' : '$';
  const mkLine = (side, seriesKey) => {
    const level = pickTouchLevel(latest[seriesKey]);
    if (level == null) return null;
    const points = rows.map((r) => {
      const hit = (r.record?.snapshot?.derived?.[seriesKey] ?? []).find((p) => p?.level === level);
      return hit && hit.prob != null ? { date: r.snapshot_date, value: hit.prob } : null;
    }).filter(Boolean);
    if (points.length === 0) return null;
    const label = side === 'high' ? `P(touch ≥ ${pfx}${level}${unit})` : `P(touch ≤ ${pfx}${level}${unit})`;
    return { key: side, label, threshold: level, points };
  };
  const probLines = [mkLine('high', 'high_series'), mkLine('low', 'low_series')].filter(Boolean);
  if (probLines.length === 0) return null;
  const lowDays = rows.filter((r) => r.confidence_tier === 'low').map((r) => r.snapshot_date);
  return { dual: false, probLines, valueLines: [], lowDays };
}

// ── server-only I/O ─────────────────────────────────────────────────────────

let _client = null;
function db() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // read/write; server-only
  if (!url || !key) throw new Error('market-history: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

/** The fine market shape stored on a history row, derived from the record's derived block.
 *  (markets.kind collapses survival+bucket to 'threshold_ladder'; history keeps them apart.) */
function fineKind(record) {
  const d = record?.snapshot?.derived ?? {};
  if (d.kind === 'binary') return 'binary';
  if (d.kind === 'categorical') return 'categorical';
  if (d.kind === 'directional_touch') return 'directional_touch';
  return d.market_shape ?? 'survival';
}

/** Every market_id on ANY user's watchlist (personal ∪ org), deduped. Service-role read
 *  of the base tables — this is the set the daily snapshot job covers. */
export async function allWatchedMarketIds() {
  const [pw, ow] = await Promise.all([
    db().from('personal_watchlist').select('market_id'),
    db().from('org_watchlist').select('market_id'),
  ]);
  if (pw.error) throw new Error(`market-history watched (personal): ${pw.error.message}`);
  if (ow.error) throw new Error(`market-history watched (org): ${ow.error.message}`);
  const ids = new Set([...(pw.data ?? []), ...(ow.data ?? [])].map((r) => r.market_id));
  return [...ids];
}

/** The stored history-row columns from a validated record, for a given UTC date + hour + provenance
 *  (`source` is 'cron' for the daily live capture, 'backfill' for a reconstructed row). `snapshotHour`
 *  is the UTC hour of the cron run (Increment 2: 18 = US peak, 2 = off-peak); 0 for a backfilled day. */
function buildHistoryRow(marketId, record, snapshotDate, source, snapshotHour = 0) {
  const d = record?.snapshot?.derived ?? {};
  return {
    market_id: marketId,
    snapshot_date: snapshotDate,
    snapshot_hour: snapshotHour,
    source,
    kind: fineKind(record),
    implied_median: d.implied_median ?? null,
    implied_mean: d.implied_mean ?? null,
    // Two-dimension confidence (0010): reliability (trustworthy number) + liquidity (can transact),
    // each with its own tier+score. The legacy confidence_* columns stay populated with the collapsed
    // worst tier/score for back-compat; the split-trend cards read the new columns.
    reliability_tier: d.confidence?.reliability?.tier ?? null,
    reliability_score: d.confidence?.reliability?.score ?? null,
    liquidity_tier: d.confidence?.liquidity?.tier ?? null,
    liquidity_score: d.confidence?.liquidity?.score ?? null,
    confidence_tier: collapseConfidenceTier(d.confidence),
    confidence_score: d.confidence
      ? Math.min(d.confidence.reliability?.score ?? 1, d.confidence.liquidity?.score ?? 1)
      : null,
    probability: d.probability ?? null,
    touch_range_lo: d.implied_range?.low ?? null,
    touch_range_hi: d.implied_range?.high ?? null,
    // Guarded categorical records (5.6 exclusivity guard) suppress dominant_* — for a
    // NESTED board the honest headline series is the longest-horizon RAW probability
    // (exclusivity.headline); F2/F3 boards have no headline number at all.
    dominant_outcome: d.dominant_outcome ?? d.exclusivity?.headline?.label ?? null,
    dominant_prob: d.dominant_prob ?? d.exclusivity?.headline?.raw_probability ?? null,
    record,
    raw_sha256: record?.snapshot?.source?.raw_sha256 ?? null,
  };
}

/** Upsert today's (UTC) history row for a market from a validated record. Idempotent on
 *  (market_id, snapshot_date, snapshot_hour) — a same-hour retry overwrites, but the 02:00 and
 *  18:00 cron runs (Increment 2) coexist as two rows for the day. `snapshotHour` defaults to the
 *  current UTC hour; the cron passes its run hour so date+hour are consistent. source='cron'.
 *  @param {string} marketId
 *  @param {object} record
 *  @param {number|null} [snapshotHour]
 */
export async function writeHistory(marketId, record, snapshotHour = null) {
  const now = new Date();
  const hour = snapshotHour != null ? snapshotHour : now.getUTCHours();
  const row = buildHistoryRow(marketId, record, now.toISOString().slice(0, 10), 'cron', hour);
  const { error } = await db().from('market_history')
    .upsert(row, { onConflict: 'market_id,snapshot_date,snapshot_hour' });
  if (error) throw new Error(`market-history write: ${error.message}`);
  return row;
}

/** Upsert the ONE final history row for a resolved-transition (fix/resolved-transition-settled-truth):
 *  a resolved market used to just vanish from the cache write path (the silent no-op bug) and NEVER
 *  got a final history point either — the series' last row stayed whatever the last live/cron
 *  capture happened to be. Called by serveMarket exactly once, right after a RESOLVED-with-prior
 *  compute persists. Thin wrapper over the same upsert writeHistory uses, source='transition' (see
 *  collapseDaily's precedence — transition beats cron/backfill for the day) at the CURRENT UTC hour
 *  (a resolution can land at any time, not just cron hours).
 *  @param {string} marketId
 *  @param {object} record the just-persisted settled (or degraded-frozen) record
 *  @param {number|null} [snapshotHour] defaults to the current UTC hour */
export async function writeTransitionHistory(marketId, record, snapshotHour = null) {
  const now = new Date();
  const hour = snapshotHour != null ? snapshotHour : now.getUTCHours();
  const row = buildHistoryRow(marketId, record, now.toISOString().slice(0, 10), 'transition', hour);
  const { error } = await db().from('market_history')
    .upsert(row, { onConflict: 'market_id,snapshot_date,snapshot_hour' });
  if (error) throw new Error(`market-history transition write: ${error.message}`);
  return row;
}

/** Insert ONE backfilled history row for a past UTC date at snapshot_hour 0 (a reconstructed day has
 *  no intraday time). PRECEDENCE: a plain INSERT whose unique-key conflict is a no-op (returns false)
 *  — so a prior backfill of the same day isn't duplicated; and since a real cron row lands at hour
 *  2/18 (≠ 0), a backfilled hour-0 row coexists with it, and the read-time collapse (ordered) prefers
 *  the nearer-US-peak cron capture. Returns true when the row was newly inserted. */
export async function writeBackfillRow(marketId, snapshotDate, record) {
  const row = buildHistoryRow(marketId, record, snapshotDate, 'backfill', 0);
  const { error } = await db().from('market_history').insert(row);
  if (error) {
    if (error.code === '23505') return false; // (market_id, snapshot_date, 0) exists → prior backfill wins
    throw new Error(`market-history backfill write: ${error.message}`);
  }
  return true;
}

/** Record a market's backfill progress (status pending|done|failed; `through` = the earliest
 *  UTC date a row was written, for the cron retry + the UI "backfilling history" signal). */
export async function setBackfillStatus(marketId, status, through = null) {
  const patch = { backfill_status: status, updated_at: new Date().toISOString() };
  if (through != null) patch.backfilled_through = through;
  const { error } = await db().from('markets').update(patch).eq('id', marketId);
  if (error) throw new Error(`market-history backfill status: ${error.message}`);
}

/** Read one market's backfill status ('pending'|'done'|'failed'|null). Drives the detail-view
 *  "Backfilling history…" signal — a freshly-added market (null/'pending') shows that instead of
 *  the bare "Collecting" state until the reconstruction completes. Returns null if the row is
 *  missing (never throws for a not-found — the caller degrades to the neutral collecting state). */
export async function readBackfillStatus(marketId) {
  const { data, error } = await db().from('markets')
    .select('backfill_status').eq('id', marketId).maybeSingle();
  if (error) throw new Error(`market-history read-backfill-status: ${error.message}`);
  return data?.backfill_status ?? null;
}

/** A market's backfill is INCOMPLETE when its status is null (never triggered — e.g. added
 *  before CRON_SECRET was set, or a trigger that never reached the route) or 'failed'. The daily
 *  cron retries these so a missed add-time backfill self-heals. ('done'/'pending' are left alone.) */
export function needsBackfill(status) {
  return status == null || status === 'failed';
}

/** Of `ids`, the market_ids whose backfill is incomplete (needsBackfill) — the cron's retry set. */
export async function marketsNeedingBackfill(ids) {
  if (!ids || ids.length === 0) return [];
  const { data, error } = await db().from('markets')
    .select('id, backfill_status').in('id', ids);
  if (error) throw new Error(`market-history needing-backfill: ${error.message}`);
  return (data ?? []).filter((m) => needsBackfill(m.backfill_status)).map((m) => m.id);
}

/** Insert ONE row into the cron_runs ledger (migration 0015, Part 2 of
 *  fix/resolved-transition-settled-truth): a permanent, queryable audit trail of every snapshot cron
 *  invocation — Vercel deployment logs roll off, this table doesn't. Insert-only; RLS deny-all,
 *  same posture as market_history. Throws loud on failure — the CALLER (app/api/snapshot) decides
 *  how to handle a ledger-write failure; this function never silently swallows one.
 *  @param {{started_at:string, run_date:string, snapshot_hour:number, total:number,
 *    skipped_already:number, skipped_resolved:number, success:number, failed:number,
 *    failures:Array, backfill_retried:Array}} row */
export async function writeCronRun(row) {
  const { error } = await db().from('cron_runs').insert(row);
  if (error) throw new Error(`market-history cron_runs write: ${error.message}`);
}

/** Of `ids`, the market_ids that ALREADY have a history row on `date` ('YYYY-MM-DD') at `hour`.
 *  The cron's dedup guard: skip markets already snapshotted in THIS hour-slot — so the 18:00 run
 *  does NOT skip what the 02:00 run wrote (Increment 2), but an idempotent re-run of the same slot does. */
export async function marketsSnapshottedOn(date, hour, ids) {
  if (!ids || ids.length === 0) return new Set();
  const { data, error } = await db().from('market_history')
    .select('market_id').eq('snapshot_date', date).eq('snapshot_hour', hour).in('market_id', ids);
  if (error) throw new Error(`market-history dedup: ${error.message}`);
  return new Set((data ?? []).map((r) => r.market_id));
}

/** PURE: reshape a lean projection row (record sub-paths pulled out of the JSONB server-side)
 *  back into the readHistory row shape, so every derive fn (ladderProbAt/iqrWidth/deriveChartSeries)
 *  consumes it unchanged. `markets`/`iqr` always reconstruct (the ladder defaults every derive fn
 *  expects); the shape-specific paths (`outcomes`, `high_series`, `low_series`) attach only when
 *  the projection carried them. Exported for the full≡lean equivalence tests.
 *  @param {object} raw one PostgREST row: scalar columns + optional {markets,iqr,outcomes,high_series,low_series}
 *  @returns {object} the readHistory-shaped row */
export function leanHistoryRow(raw) {
  const { markets, iqr, outcomes, high_series, low_series, ...cols } = raw ?? {};
  const derived = { markets: markets ?? [], iqr: iqr ?? null };
  if (outcomes != null) derived.outcomes = outcomes;
  if (high_series != null) derived.high_series = high_series;
  if (low_series != null) derived.low_series = low_series;
  return { ...cols, record: { snapshot: { derived } } };
}

// The scalar columns every lean read projects, and the per-shape record sub-paths layered on top.
// Each shape gets ONLY the JSONB paths its chart/derivations consume — never the full `record`
// (that's the 1.6MB-per-365-rows problem this read exists to avoid).
// `source` ('cron'|'backfill'|'transition') is a scalar column every derivation needs to project —
// collapseDaily's precedence reads it, and stripResolutionRows (REFINEMENT 1) filters narration
// derivations on it. Without it here, every lean-read consumer would see `source: undefined` and
// silently treat a resolution row as a normal capture.
const LEAN_BASE_COLS = 'snapshot_date, snapshot_hour, source, kind, implied_median, implied_mean, confidence_tier, confidence_score, reliability_tier, reliability_score, liquidity_tier, liquidity_score, probability, touch_range_lo, touch_range_hi, dominant_outcome, dominant_prob, raw_sha256';
const LEAN_SHAPE_PATHS = {
  ladder: 'markets:record->snapshot->derived->markets, iqr:record->snapshot->derived->iqr', // Δ/movers/chart lines + dispersion
  directional_touch: 'high_series:record->snapshot->derived->high_series, low_series:record->snapshot->derived->low_series', // P(touch) chart lines
  categorical: 'outcomes:record->snapshot->derived->outcomes', // per-outcome chart lines
  binary: null, // the probability scalar column is the whole series
};

/**
 * Read the last `days` of history for ONE market as a LEAN projection: the promoted scalar
 * columns plus ONLY the record sub-paths that market SHAPE's display derivations consume —
 * ladder: derived.markets (Δ / movers / chart lines) + derived.iqr (dispersion/band);
 * directional_touch: derived.high_series/low_series (P(touch) chart lines);
 * categorical: derived.outcomes (per-outcome chart lines); binary: scalar columns only.
 * The projection happens SERVER-SIDE in Postgres (PostgREST `record->…` selection), so the
 * raw_inputs/narrative/analytics bulk of up to 365 record JSONBs (~80% of the payload; measured
 * 1.6MB → 323KB, p50 287ms → 75ms on a 180-day ladder) never crosses the wire. EFFICIENCY ≠ DATA
 * REDUCTION: every field any surface displays still flows — this only stops fetching what nothing
 * reads. readHistory (below) keeps the FULL record contract — verify-history re-hashes stored
 * raw_inputs from it (provenance), so its shape is load-bearing; use THIS one for display reads.
 * Rows come back COLLAPSED to one per UTC date (collapseDaily — Bug 2).
 * @param {string} marketId
 * @param {number} [days]
 * @param {'ladder'|'binary'|'categorical'|'directional_touch'} [shape] the served record's chart kind
 */
export async function readHistoryLean(marketId, days = 90, shape = 'ladder') {
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const paths = LEAN_SHAPE_PATHS[shape] ?? LEAN_SHAPE_PATHS.ladder;
  const { data, error } = await db().from('market_history')
    .select(paths ? `${LEAN_BASE_COLS}, ${paths}` : LEAN_BASE_COLS)
    .eq('market_id', marketId)
    .gte('snapshot_date', cutoff)
    .order('snapshot_date', { ascending: true })
    .order('snapshot_hour', { ascending: true });
  if (error) throw new Error(`market-history lean read: ${error.message}`);
  // ONE row per UTC date (Bug 2): a date can carry an hour-0 backfill row plus cron rows; without
  // this collapse the chart rendered duplicate dots at the same x. The derive fns collapse
  // internally already (ordered), so this is idempotent for them — it fixes the direct consumers
  // (hist.points in MarketDetailView). readHistory (provenance contract) stays uncollapsed.
  return collapseDaily((data ?? []).map(leanHistoryRow));
}

/** Read the last `days` of history for ONE market, ascending by snapshot_date. Bounded to a
 *  single caller-supplied id (same per-market trust as /api/market; RLS is deny-all).
 *  FULL record contract — the provenance gate (verify-history) re-hashes raw_inputs from these
 *  rows. Display reads should use readHistoryLean above. */
export async function readHistory(marketId, days = 90) {
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await db().from('market_history')
    .select('snapshot_date, snapshot_hour, source, kind, implied_median, implied_mean, confidence_tier, confidence_score, reliability_tier, reliability_score, liquidity_tier, liquidity_score, probability, touch_range_lo, touch_range_hi, dominant_outcome, dominant_prob, record, raw_sha256')
    .eq('market_id', marketId)
    .gte('snapshot_date', cutoff)
    .order('snapshot_date', { ascending: true })
    .order('snapshot_hour', { ascending: true });
  if (error) throw new Error(`market-history read: ${error.message}`);
  return data ?? [];
}
