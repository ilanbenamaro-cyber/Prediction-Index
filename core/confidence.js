// core/confidence.js — score how trustworthy a single snapshot/day is.
//
// Why this exists: the product sells trust in the number, so every snapshot
// carries an explicit, explainable assessment instead of implying false
// precision. Confidence is the WORST of several signals (a single bad signal
// caps trust), each mapped to a human-readable reason the dashboard surfaces
// inline. Backfilled days have no order book → "price-only", capped at medium.

const MIN_THRESHOLDS_HIGH = 12;
const MIN_THRESHOLDS_MEDIUM = 8;
const SPREAD_HIGH = 0.04;
const SPREAD_MEDIUM = 0.08;
const THIN_SHARE_HIGH = 0.2; // < 20% thin books → fine
const THIN_SHARE_MEDIUM = 0.5; // 20–50% thin → medium
const MATERIAL_ADJUSTMENT = 0.005; // 0.5%: below this an isotonic tweak is immaterial
const TIER_RANK = { low: 0, medium: 1, high: 2 };
// Score a windowed/categorical tier contributes to a 0..1 dimension score.
const TIER_SCORE = { high: 1, medium: 0.5, low: 0.15 };

/** The worst (lowest) tier in a list; 'high' when the list is empty (no signal = no objection).
 *  Shared by every scorer to collapse a dimension's signals into one tier. */
export function worstTier(tiers) {
  return (tiers ?? []).reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), 'high');
}

/** Collapse a split confidence { reliability, liquidity } back to the LEGACY single worst tier.
 *  The old single confidence tier was the worst of all signals; splitting partitions those signals
 *  into two dimensions, so the old tier is recoverable as the worst of the two independent tiers.
 *  Used for the legacy DB column (back-compat) and the SpaceX parity faithfulness proof. */
export function collapseConfidenceTier(confidence) {
  if (!confidence) return null;
  const r = confidence.reliability?.tier, l = confidence.liquidity?.tier;
  return worstTier([r, l].filter(Boolean));
}

const NEAR_SETTLEMENT_DAYS = 7;
const EXTREME_LOW = 0.01;
const EXTREME_HIGH = 0.99;

// Increment 1 — windowed-volume liquidity tiers (operator-calibrated against live markets).
// Recent activity is a far better liquidity proxy than all-time cumulative (a dormant market shows
// a huge all-time total but ~0 recent volume). HIGH demands genuine recent flow; LOW catches the
// dormant-but-historically-traded case (US recession: $478/24h, $16K/7d behind a $1.6M all-time).
const VOL24_HIGH = 50_000;
const VOL1WK_HIGH = 200_000;
const VOL24_MEDIUM = 5_000;
const VOL1WK_MEDIUM = 25_000;
// F1 (red-team fix): the 7d-only HIGH path requires a minimum recent (24h) floor so a STALE 7d spike
// on a now-dormant market (24h ≈ dead) can't read HIGH on week-old activity. Absent v24 counts as 0.
const VOL24_HIGH_FLOOR = 2_000;

// Increment C — order-book DEPTH tiers (max per-leg gamma `liquidity`, $ of resting orders). Depth
// answers "can you transact at SIZE right now", complementing windowed volume ("was there recent
// flow"); they go worst-of in the LIQUIDITY dimension. Operator-calibrated against ~150 live markets
// (depth p50 ≈ $62K, p75 ≈ $352K): HIGH ≥ $100K (move real size), MED ≥ $10K (usable), LOW below
// (thin book, easy to push). Red-teamed 2026-06-30 (see decisions.md "Red-team of the confidence
// tuning constants") — boundary/manipulation/interaction cases + a 280-market live re-survey moved
// no threshold.
const DEPTH_HIGH = 100_000;
const DEPTH_MEDIUM = 10_000;

/**
 * Book-depth liquidity signal from a derived.liquidity object's `book_depth` (max per-leg resting
 * order $). Returns { tier, reason } (reason null for HIGH) or NULL when no depth is present, so the
 * caller leaves the tier unchanged — the null path keeps SpaceX's frozen replay byte-identical (a
 * resolved market carries no gamma liquidity field → book_depth omitted → null signal).
 */
export function bookDepthSignal(liquidity) {
  if (!liquidity || liquidity.book_depth == null) return null;
  const d = liquidity.book_depth;
  const usd = `$${Math.round(d).toLocaleString('en-US')}`;
  if (d >= DEPTH_HIGH) return { tier: 'high', reason: null };
  if (d >= DEPTH_MEDIUM) return { tier: 'medium', reason: `moderate order book (${usd} depth)` };
  return { tier: 'low', reason: `thin order book (${usd} depth)` };
}

/**
 * Windowed-volume liquidity signal from a derived.liquidity object {volume_24hr, volume_1wk}.
 *   HIGH   : 24h ≥ $50K  OR  (7d ≥ $200K AND 24h ≥ $2K)   ← the $2K floor blocks a stale 7d spike
 *   MEDIUM : 24h ≥ $5K   OR  7d ≥ $25K
 *   LOW    : below both
 * Returns { tier, reason } (reason null for HIGH — no caveat) or NULL when no windowed data is
 * present, so callers fall back to the all-time tier and leave the score/tier UNCHANGED. The null
 * path is what keeps SpaceX's frozen confidence byte-identical (its replay carries no windowed volume).
 */
export function windowedVolumeSignal(liquidity) {
  if (!liquidity) return null;
  const v24 = liquidity.volume_24hr, v7 = liquidity.volume_1wk;
  if (v24 == null && v7 == null) return null;
  const v24n = v24 ?? 0, v7n = v7 ?? 0;
  if (v24n >= VOL24_HIGH || (v7n >= VOL1WK_HIGH && v24n >= VOL24_HIGH_FLOOR)) return { tier: 'high', reason: null };
  if (v24n >= VOL24_MEDIUM || v7n >= VOL1WK_MEDIUM) {
    // Name whichever window ACTUALLY crossed the medium threshold — not just whichever field is
    // present. Prefer 24h when both crossed (mirrors the HIGH path's 24h-first precedence); fall
    // back to 7d only when 24h didn't qualify (else a below-threshold, possibly-zero 24h figure
    // could be reported as the reason for a tier the 7d window actually earned).
    const via24 = v24n >= VOL24_MEDIUM;
    const window = via24 ? '24h' : '7d';
    const usd = `$${Math.round(via24 ? v24n : v7n).toLocaleString('en-US')}`;
    return { tier: 'medium', reason: `moderate ${window} volume (${usd})` };
  }
  const window = v24 != null ? '24h' : '7d';
  const usd = `$${Math.round(v24 ?? v7 ?? 0).toLocaleString('en-US')}`;
  return { tier: 'low', reason: `thin ${window} volume (${usd})` };
}

/**
 * Increment 3 — time-to-expiry normalized spread tolerance. A wide bid/ask spread near expiry is
 * market-makers exiting (expected), not genuine illiquidity; the same spread 6 months out is real
 * illiquidity. So we WIDEN the spread thresholds as expiry approaches:
 *   > 90d (or unknown) → ×1.0 (standard) · 30–90d → ×1.5 · 7–30d → ×2.5 · < 7d → ×2.5
 * (< 7d's pinned-rung case is additionally handled by the near-settlement carve-out.) The multiplier
 * NEVER tightens, so a far-dated market (SpaceX, ~550d → ×1.0) is byte-identical.
 */
export function spreadToleranceMultiplier(daysToExpiry) {
  if (daysToExpiry == null || daysToExpiry > 90) return 1.0;
  if (daysToExpiry > 30) return 1.5;
  return 2.5;
}

/** " — 12d remaining" / "" — the time-to-expiry context appended to a spread reason. */
export function expiryNote(daysToExpiry) {
  return daysToExpiry == null ? '' : ` — ${Math.round(daysToExpiry)}d remaining`;
}

/** Fractional days from `fromIso` to a 'YYYY-MM-DD' resolution date, or null if unknown.
 *  (Mirrors the local copies in snapshot.js/touch-record.js; exported here for binary/categorical.) */
export function daysUntil(resolves, fromIso) {
  if (!resolves) return null;
  const end = Date.parse(resolves), from = Date.parse(fromIso);
  if (!Number.isFinite(end) || !Number.isFinite(from)) return null;
  return (end - from) / 86_400_000;
}

/**
 * "Near settlement" market state: expiring within 7 days AND a MAJORITY of rungs pinned to
 * ~0/~1 (adjusted_prob ≤0.01 or ≥0.99) — the outcome is essentially decided. Such a market's
 * large monotonicity adjustments and many closed/last-trade rungs are EXPECTED (the book is
 * winding down), not data-quality noise, so confidence must not penalize them as if the
 * market were a live, contested ladder, and the UI shows an amber NEAR SETTLEMENT badge
 * rather than OPEN. Pure; daysToExpiry null/unknown ⇒ false (never a false badge).
 */
export function nearSettlement(markets, daysToExpiry) {
  if (daysToExpiry == null || daysToExpiry > NEAR_SETTLEMENT_DAYS) return false;
  if (!Array.isArray(markets) || markets.length === 0) return false;
  const extreme = markets.filter((m) => {
    const p = m.adjusted_prob ?? m.prob;
    return p != null && (p <= EXTREME_LOW || p >= EXTREME_HIGH);
  }).length;
  return extreme / markets.length > 0.5;
}

/** Mean bid/ask spread across raw_inputs, or null if no book data present. */
function meanSpread(rawInputs) {
  if (!rawInputs) return null;
  const spreads = rawInputs
    .filter((r) => r.best_bid != null && r.best_ask != null)
    .map((r) => Number(r.best_ask) - Number(r.best_bid));
  if (spreads.length === 0) return null;
  return spreads.reduce((a, b) => a + b, 0) / spreads.length;
}

/**
 * Score a snapshot into TWO INDEPENDENT dimensions (the conceptual split):
 *   RELIABILITY — is the displayed number itself trustworthy? (threshold count, monotonicity,
 *                 spread, last-trade fallback, missing rungs, stale feed)
 *   LIQUIDITY   — can you actually transact at this price? (book-thin breadth, windowed volume,
 *                 closed/not-accepting-orders rungs, liquidity drop)
 * These are genuinely orthogonal: a market can be HIGH reliability + LOW liquidity (everyone
 * agrees, nobody trades) or the reverse. All inputs are facts already computed in core/ —
 * confidence never recomputes a metric, it only interprets:
 *   markets       : adjusted markets [{threshold,...}]
 *   rawInputs     : [{best_bid,best_ask,...}] | null (null => price-only)
 *   rawViolations : monotonicity violations on RAW (from stats.adjustSnapshot)
 *   maxAdjustment : largest |raw - adjusted| (fraction)
 *   liquidity     : { thinCount, total, thinShare } (from stats.volumeTiers)
 *   anomalies     : { stale, closedCount, liquidityDrop:{triggered,pct}|null }
 * Returns { reliability:{tier,score,reasons}, liquidity:{tier,score,reasons} }.
 */
export function scoreConfidence({
  markets,
  rawInputs = null,
  rawViolations = 0,
  maxAdjustment = 0,
  liquidity = null,
  anomalies = null,
  midpointFallback = null,
  countHigh = MIN_THRESHOLDS_HIGH,
  countMedium = MIN_THRESHOLDS_MEDIUM,
  ladderSize = 16,
  lifecycle = null,
  nearSettled = false,
  windowedVolume = null,
  daysToExpiry = null,
}) {
  const relTiers = [], relReasons = [];
  const liqTiers = [], liqReasons = [];
  const count = markets.length;
  const spread = meanSpread(rawInputs);
  const priceOnly = spread == null;
  // A non-OPEN market's "closed" rungs are its expected terminal condition, not a
  // data-quality anomaly — don't let them drag the tier (SpaceX is OPEN → no effect).
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';
  // Bug 3 recalibration (CONFINED to the near-settlement path): once the outcome is decided
  // (expiring ≤7d, rungs pinned to ~0/~1), the large monotonicity adjustments and last-trade-priced
  // legs are the EXPECTED signature of a winding-down book, not data-quality red flags — so they
  // must not drag RELIABILITY to LOW. (LIQUIDITY stays genuinely low near settlement — you can't
  // trade it — but that reads through the windowed-volume signal, not the carve-out.) `expected`
  // gates the reliability carve-outs; a normal market (incl. frozen SpaceX, ~18mo out → nearSettled
  // false) is byte-identical. A genuinely missing price (skippedCount) is still a real CDF hole.
  const expected = settled || nearSettled;

  // ════ RELIABILITY — is the number trustworthy? ════
  // R1) Threshold count — resolution of the CDF.
  if (count >= countHigh) relTiers.push('high');
  else if (count >= countMedium) {
    relTiers.push('medium');
    relReasons.push(`${count} active thresholds (coarser CDF)`);
  } else {
    relTiers.push('low');
    relReasons.push(`only ${count} active thresholds (sparse CDF)`);
  }

  // R2) Monotonicity — penalize by the MAGNITUDE of the isotonic adjustment, not
  //    the raw count: a violation pooled to a sub-0.5% tweak is immaterial noise and
  //    must not drop the tier (a quant would rightly call that over-penalizing).
  const adjPct = maxAdjustment * 100;
  const adjStr = adjPct < 0.05 ? '<0.05%' : `${adjPct.toFixed(1)}%`;
  if (rawViolations === 0) {
    relTiers.push('high');
  } else if (nearSettled) {
    // Near settlement, rungs pinning to 0/1 manufacture large apparent violations — structural,
    // not noisy quotes. Don't penalize (let an otherwise-clean converged ladder reach HIGH).
    relTiers.push('high');
    relReasons.push(`${rawViolations} monotonicity adjustment(s) (max ${adjStr}) — expected near settlement`);
  } else if (maxAdjustment < MATERIAL_ADJUSTMENT) {
    relTiers.push('high');
    relReasons.push(`${rawViolations} negligible monotonicity tweak(s) (max ${adjStr})`);
  } else if (rawViolations <= 2) {
    relTiers.push('medium');
    relReasons.push(`${rawViolations} monotonicity adjustment(s) today (max ${adjStr})`);
  } else {
    relTiers.push('low');
    relReasons.push(`${rawViolations} monotonicity adjustments (max ${adjStr}) — noisy quotes`);
  }

  // R3) Spread — how well-defined the displayed midpoint is. Tolerance WIDENS near expiry
  //    (Increment 3): a wide spread on a market expiring soon is MMs exiting, not a noisy price.
  //    SpaceX (~550d → ×1.0, tight spread → HIGH, no reason) is byte-identical.
  const spreadMult = spreadToleranceMultiplier(daysToExpiry);
  const sHigh = SPREAD_HIGH * spreadMult;
  const sMedium = SPREAD_MEDIUM * spreadMult;
  const note = expiryNote(daysToExpiry);
  if (priceOnly) {
    relTiers.push('medium');
    relReasons.push('price-only history (no bid/ask spread)');
  } else if (spread < sHigh) relTiers.push('high');
  else if (spread <= sMedium) {
    relTiers.push('medium');
    relReasons.push(`mean spread ${(spread * 100).toFixed(1)}% (${spreadMult > 1 ? `expected near expiry${note}` : 'moderate liquidity'})`);
  } else {
    relTiers.push('low');
    relReasons.push(`mean spread ${(spread * 100).toFixed(1)}% (illiquid${note})`);
  }

  // R4) Stale feed — inputs identical to the prior snapshot ⇒ the displayed number may be stale.
  if (anomalies && anomalies.stale) {
    relTiers.push('medium');
    relReasons.push('inputs identical to prior snapshot (possible stale feed)');
  }

  // R5) Midpoint fallback — rungs priced from the last trade (no live book) or excluded for want of
  //    any price. A price off a stale trade is a RELIABILITY detractor (the displayed number's
  //    provenance), not a liquidity one (the can't-trade aspect is covered by volume/spread). Null/
  //    zero on the normal path → no effect (SpaceX has none → frozen reliability unchanged).
  if (midpointFallback) {
    if (midpointFallback.lastTradeCount > 0) {
      // Expected near settlement (winding-down book) — say "settled", don't read as a defect.
      relTiers.push(expected ? 'high' : 'medium');
      relReasons.push(expected
        ? `${midpointFallback.lastTradeCount} settled rung(s) (priced from last trade)`
        : `${midpointFallback.lastTradeCount} rung(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) {
      // A genuinely missing price punches a hole in the CDF — a real defect even near settlement.
      relTiers.push('low');
      const ts = (midpointFallback.skippedThresholds ?? []).join(', ');
      relReasons.push(`${midpointFallback.skippedCount} rung(s) excluded (no price)${ts ? `: ${ts}` : ''}`);
    }
  }

  // ════ LIQUIDITY — can you transact at this price? ════
  // L1) Book-thin breadth — how many of the rungs' books are thin.
  if (liquidity && liquidity.total > 0) {
    if (liquidity.thinShare < THIN_SHARE_HIGH) liqTiers.push('high');
    else if (liquidity.thinShare <= THIN_SHARE_MEDIUM) {
      liqTiers.push('medium');
      liqReasons.push(`thin liquidity on ${liquidity.thinCount} of ${liquidity.total} markets`);
    } else {
      liqTiers.push('low');
      liqReasons.push(`thin liquidity on ${liquidity.thinCount} of ${liquidity.total} markets`);
    }
  }

  // L2) Closed / not-accepting-orders rungs — you literally cannot trade them (a LIQUIDITY fact;
  //    the stale-price aspect is covered separately by R5 last-trade fallback). Suppressed when the
  //    market is settled/near-settled — closed rungs are then the expected terminal condition.
  if (anomalies) {
    if (anomalies.closedCount > 0 && !expected) {
      liqTiers.push(anomalies.closedCount > 2 ? 'low' : 'medium');
      liqReasons.push(`${anomalies.closedCount} market(s) closed / not accepting orders`);
    }
    if (anomalies.liquidityDrop && anomalies.liquidityDrop.triggered) {
      liqTiers.push('medium');
      liqReasons.push(`total volume ${(anomalies.liquidityDrop.pct * 100).toFixed(0)}% below 7-day median`);
    }
  }

  // L3) Windowed volume (Increment 1) — recent flow is the primary "can you trade this" signal.
  //    Absent (frozen replay) it's a no-op → SpaceX byte-identical.
  const winVol = windowedVolumeSignal(windowedVolume);
  if (winVol) {
    liqTiers.push(winVol.tier);
    if (winVol.reason) liqReasons.push(winVol.reason);
  }
  // L4) Book depth (Increment C) — can you transact at SIZE right now, worst-of with windowed volume.
  //    Absent (frozen replay / resolved) → no-op → SpaceX byte-identical.
  const depth = bookDepthSignal(windowedVolume);
  if (depth) {
    liqTiers.push(depth.tier);
    if (depth.reason) liqReasons.push(depth.reason);
  }

  // ── reliability score (0..1) ──
  const countScore = Math.min(1, count / ladderSize);
  const monoScore = nearSettled ? 1 : Math.max(0, 1 - rawViolations / 4) * Math.max(0, 1 - maxAdjustment / 0.1);
  const spreadScore = priceOnly ? 0.6 : Math.max(0, Math.min(1, 1 - spread / 0.1));
  let relScore = (countScore + monoScore + spreadScore) / 3;
  if (anomalies && anomalies.stale) relScore -= 0.15;
  if (midpointFallback) {
    if (!expected) relScore -= 0.05 * Math.min(4, midpointFallback.lastTradeCount ?? 0);
    relScore -= 0.1 * Math.min(4, midpointFallback.skippedCount ?? 0);
  }
  relScore = Number(Math.max(0, Math.min(1, relScore)).toFixed(3));

  // ── liquidity score (0..1) ──
  const liqBreadthScore = liquidity ? Math.max(0, 1 - liquidity.thinShare) : 0.7;
  const liqTerms = [liqBreadthScore];
  if (winVol) liqTerms.push(TIER_SCORE[winVol.tier]);
  let liqScore = liqTerms.reduce((a, b) => a + b, 0) / liqTerms.length;
  if (depth) liqScore = Math.min(liqScore, TIER_SCORE[depth.tier]); // worst-of: a thin book caps the score
  if (anomalies) {
    if (anomalies.closedCount > 0 && !expected) liqScore -= 0.1 * Math.min(3, anomalies.closedCount);
    if (anomalies.liquidityDrop && anomalies.liquidityDrop.triggered) liqScore -= 0.1;
  }
  liqScore = Number(Math.max(0, Math.min(1, liqScore)).toFixed(3));

  if (relReasons.length === 0) relReasons.push('full threshold set, monotonic, tight spreads');
  if (liqReasons.length === 0) liqReasons.push('deep books');

  return {
    reliability: { tier: worstTier(relTiers), score: relScore, reasons: relReasons },
    liquidity: { tier: worstTier(liqTiers), score: liqScore, reasons: liqReasons },
  };
}
