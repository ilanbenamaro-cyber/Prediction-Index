// core/categorical.js — build the canonical record for a CATEGORICAL market.
//
// Peer to binary.js / touch-record.js. A categorical event (e.g. "How many Fed rate cuts
// in 2026?") is N mutually-exclusive Yes/No legs whose YES midpoints form a PMF over named
// outcomes. Unlike a ladder there is no ordering/CDF/median — the signal is the probability
// distribution itself, plus which outcome leads and how concentrated the consensus is.
//
// DE-VIG ⟂ PROVENANCE: the leg midpoints carry the market-maker overround, so we NORMALIZE
// them to sum to 1 for DISPLAY. That normalization is a presentation transform — the RAW
// observed midpoints are what land in raw_inputs and the hash (constraint #2: the hash is
// over truth, not presentation). Same hash recipe as every other kind (canonicalizeRawInputs
// over raw_inputs; synthetic threshold = leg index for a stable canonical sort, mirroring
// binary's 1=YES/0=NO).

import { buildFreshness } from './freshness.js';
import { SCHEMA_VERSION } from './snapshot.js';
import { windowedVolumeSignal, bookDepthSignal, spreadToleranceMultiplier, expiryNote, daysUntil, worstTier } from './confidence.js';

const SPREAD_HIGH = 0.04; // mirror the ladder/binary/touch spread thresholds (4pp / 8pp)
const SPREAD_MEDIUM = 0.08;
const VOL_HIGH = 100_000;
const VOL_MEDIUM = 10_000;
const TIER_SCORE = { high: 1, medium: 0.5, low: 0.15 };
const CONSENSUS_HIGH = 0.7;
const CONSENSUS_MEDIUM = 0.4;
// Increment B: a strong consensus (low normalized entropy AND a clear leader) makes the HEADLINE
// number reliable even when long-tail legs have wider books — so it LIFTS a spread-driven 'medium'
// reliability to 'high'. Tuned to "clearly concentrated": entropy ≤ 0.40 with a ≥70% leader.
const CONSENSUS_RELIABILITY_ENTROPY = 0.40;
const CONSENSUS_RELIABILITY_LEADER = 0.70;

// Polymarket seeds categorical events with PLACEHOLDER / UNTRADED legs — generic "Candidate C"
// through "Candidate Z" (also "Choice X" / "Option X"), plus catch-all legs like "Other" — that
// carry $0 all-time volume and sit at the untraded listing-price midpoint (~0.5 each). They are
// market-structure artifacts, not real outcomes. CRITICAL (Bug Zero): they MUST be removed BEFORE
// the de-vig normalization — including 25+ legs at ~0.5 in the denominator collapses a real leader
// (Ryan Fazio's true 97% → ~7%; even one surviving "Other" at 0.5 drags him to ~65%).
//
// A leg is an artifact only when it has ZERO all-time volume AND EITHER a generic "<word> <letter>"
// label OR a midpoint still pinned at the ~0.5 listing default (never traded → no market signal).
// Any leg that has actually traded (volume > 0) is ALWAYS kept, however thin; and a zero-volume leg
// with a real divergent quote (not ~0.5) is kept too — so a genuine low-odds candidate survives.
const GENERIC_LEG_LABEL = /^(candidate|choice|option|name)\s+[a-z]$/i;
const UNTRADED_MIDPOINT = 0.5;     // Polymarket's no-information seed price for a fresh leg
const UNTRADED_EPS = 0.02;         // a leg within this of 0.5 with $0 volume has never traded

/** True when a leg is a zero-volume placeholder / untraded artifact (not a real, active outcome). */
export function isPlaceholderLeg(leg) {
  if (!leg) return false;
  const vol = leg.volume ?? 0;
  if (vol !== 0) return false; // any traded leg is real, regardless of label or price
  const label = String(leg.label ?? '').trim();
  if (GENERIC_LEG_LABEL.test(label)) return true;
  const raw = leg.prob;
  return raw != null && Number.isFinite(raw) && Math.abs(raw - UNTRADED_MIDPOINT) <= UNTRADED_EPS;
}

/** Drop placeholder legs, but never strip a market below its real outcomes: if filtering would
 *  leave nothing (a degenerate all-generic event), fall back to the original legs unchanged. */
export function realCategoricalLegs(legs) {
  const real = (legs ?? []).filter((l) => !isPlaceholderLeg(l));
  return real.length > 0 ? real : (legs ?? []);
}

// ── EXCLUSIVITY GUARD (5.6, operator-approved design 2026-07-13) ─────────────
// The de-vig below presumes MUTUALLY-EXCLUSIVE outcomes. 31% of live categorical
// boards are NESTED DEADLINES ("X by <date₁…ₙ>" — a CDF in time) and others are
// independent multi-binaries — normalizing those FABRICATES probabilities (live
// proof: fed-rate-cut-by-629 raw 20.5% displayed as 49%). The guard classifies
// each board and, when not exclusive, the record carries RAW probabilities only
// with every PMF derivation suppressed. Misclassification is asymmetric BY
// DESIGN: every wrong verdict degrades to raw-and-honest, never to fabricated.
const EXCLUSIVE_SUM_MIN = 0.8;   // placeholder-filtered raw sum band for a genuine
const EXCLUSIVE_SUM_MAX = 1.25;  // one-winner board (observed live: 0.96–1.05 + vig edge)
const NESTED_MIN_DATED_FRACTION = 0.8; // "by <date>" legs must dominate the board
const NESTED_MONOTONE_EPS = 0.025;     // tolerated per-step noise inversion (2.5pp)
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** Parse "by/before <date-ish>" from a leg question → { key: yyyymmdd, yearless } or null. */
export function parseByDeadline(question) {
  const m = String(question ?? '').toLowerCase().match(/\b(?:by|before)\b([^?]*)/);
  if (!m) return null;
  const s = m[1];
  const eo = s.match(/end of (\d{4})/);
  if (eo) return { key: Number(eo[1]) * 10000 + 1231, yearless: false };
  // day = 1-2 digits NOT followed by another digit — else "january 2026" greedily
  // reads day=20 out of the year (caught by the guard tests, 2026-07-13)
  const md = s.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s*(?:(\d{1,2})(?!\d))?(?:,?\s*(\d{4}))?/);
  if (md) {
    const year = md[3] ? Number(md[3]) : null;
    const monthDay = MONTHS[md[1]] * 100 + (md[2] ? Number(md[2]) : 28);
    return { key: (year ?? 0) * 10000 + monthDay, yearless: year == null, monthDay };
  }
  const y = s.match(/(\d{4})/);
  if (y) return { key: Number(y[1]) * 10000 + 1231, yearless: false };
  return null;
}

/** Non-decreasing within eps when ordered by `key` (ties keep input order). */
function monotoneByKey(items, eps = NESTED_MONOTONE_EPS) {
  const s = [...items].sort((a, b) => a.key - b.key);
  return s.every((it, i) => i === 0 || it.prob >= s[i - 1].prob - eps);
}

/**
 * Classify a categorical board's exclusivity from its REAL legs (placeholder-filtered).
 * legs: [{ label, prob (RAW YES midpoint), volume, question?, leg_end_date? }]
 * Returns { verdict, basis } — verdict ∈
 *   'exclusive'        → de-vig PMF is honest (today's path, unchanged)
 *   'nested_deadline'  → "by <date>" board, monotone in deadline (F1: raw cumulative)
 *   'non_exclusive'    → sum far from 1 and not nested (F2: raw list)
 *   'ambiguous'        → the two nested orderings DISAGREE (F3: conservative raw)
 * Detection is two-signal for nested (question-text dates + gamma leg endDates); a
 * disagreement lands on 'ambiguous', which renders exactly like 'non_exclusive' —
 * the conservative fallback is still honest raw, never a fabricated PMF.
 */
export function assessExclusivity(legs) {
  const real = realCategoricalLegs(legs);
  const priced = real.filter((l) => Number.isFinite(l.prob));
  const sum = priced.reduce((a, l) => a + l.prob, 0);
  const basis = { filtered_sum: Number(sum.toFixed(4)), real_legs: priced.length };
  if (priced.length < 2) return { verdict: 'exclusive', basis }; // degenerate: nothing to guard

  // ── nested test, signal 1: question-text "by/before <date>" ──
  const dated = priced
    .map((l) => ({ prob: l.prob, d: parseByDeadline(l.question), end: l.leg_end_date ? Date.parse(l.leg_end_date) : null }))
    .filter((l) => l.d);
  const datedFraction = dated.length / priced.length;
  basis.dated_fraction = Number(datedFraction.toFixed(2));
  let textMonotone = null, endMonotone = null;
  if (dated.length >= 2 && datedFraction >= NESTED_MIN_DATED_FRACTION) {
    // yearless legs: infer the base year from the earliest explicit year on the board
    // (else from leg end dates); mis-inference is caught by the endDate cross-check below.
    const years = dated.filter((l) => !l.d.yearless).map((l) => Math.floor(l.d.key / 10000)).filter((y) => y > 0);
    const endYears = dated.filter((l) => l.end != null).map((l) => new Date(l.end).getUTCFullYear());
    const baseYear = years.length ? Math.min(...years) : endYears.length ? Math.min(...endYears) : new Date().getUTCFullYear();
    const keyed = dated.map((l) => ({ prob: l.prob, key: l.d.yearless ? baseYear * 10000 + l.d.monthDay : l.d.key }));
    // A nested board needs ≥2 DISTINCT deadlines — 19 independent legs all "by end of 2026"
    // share one date, and tie-ordering must never let input order fake monotonicity.
    textMonotone = new Set(keyed.map((k) => k.key)).size >= 2 ? monotoneByKey(keyed) : null;
    // ── signal 2: gamma per-leg endDate ordering (metadata is occasionally stale/wrong,
    //    so it CROSS-CHECKS rather than replaces the text signal). Heavily-TIED endDates
    //    (fed-rate-cut: five legs share one stale date) make tie-order decide the answer —
    //    the signal is only trustworthy when endDates are MOSTLY DISTINCT. ──
    const ended = dated.filter((l) => l.end != null);
    const distinctEnds = new Set(ended.map((l) => l.end)).size;
    if (ended.length >= 2 && ended.length / dated.length >= NESTED_MIN_DATED_FRACTION
        && distinctEnds / ended.length >= NESTED_MIN_DATED_FRACTION) {
      endMonotone = monotoneByKey(ended.map((l) => ({ prob: l.prob, key: l.end })));
    }
    basis.text_monotone = textMonotone;
    if (endMonotone != null) basis.end_date_monotone = endMonotone;
    if (textMonotone && endMonotone !== false) return { verdict: 'nested_deadline', basis };
    if (textMonotone && endMonotone === false) return { verdict: 'ambiguous', basis };
  }

  if (sum >= EXCLUSIVE_SUM_MIN && sum <= EXCLUSIVE_SUM_MAX) return { verdict: 'exclusive', basis };
  return { verdict: 'non_exclusive', basis };
}

/** De-vig: scale a raw PMF to sum to 1, preserving ratios. All-zero ⇒ zeros (no div by 0). */
export function normalizeProbabilities(rawProbs) {
  const sum = (rawProbs ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (sum <= 0) return (rawProbs ?? []).map(() => 0);
  return rawProbs.map((p) => (Number.isFinite(p) ? p / sum : 0));
}

/** Shannon entropy normalized to [0,1] (0 = certain, 1 = maximally uncertain over N
 *  outcomes). Probabilities are normalized first; a single outcome is 0 by definition. */
export function shannonEntropy(probs) {
  const p = normalizeProbabilities(probs);
  const n = p.length;
  if (n <= 1) return 0;
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log(x);
  return h / Math.log(n);
}

/** Consensus tier from the leading outcome's probability. */
export function consensusStrength(dominantProb) {
  if (dominantProb > CONSENSUS_HIGH) return 'HIGH';
  if (dominantProb > CONSENSUS_MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/** legs [{label, prob (RAW YES midpoint), volume, midpoint_source}] → outcome distribution,
 *  normalized + sorted descending. Each outcome keeps BOTH the normalized `probability` and
 *  the `raw_probability` so the de-vig is transparent. */
export function parseCategoricalOutcomes(legs) {
  // Bug Zero: filter placeholder legs BEFORE de-vig so the normalization denominator is built
  // from real candidates only (else a real leader collapses, e.g. Ryan Fazio 97% → 7%).
  const real = realCategoricalLegs(legs);
  const raw = real.map((l) => (Number.isFinite(l.prob) ? l.prob : 0));
  const norm = normalizeProbabilities(raw);
  return real
    .map((l, i) => ({
      label: l.label,
      probability: norm[i],
      raw_probability: l.prob ?? null,
      volume: l.volume ?? null,
      midpoint_source: l.midpoint_source ?? null,
    }))
    .sort((a, b) => b.probability - a.probability);
}

/** Mean bid/ask spread across the priced legs, or null if no book data. */
function meanSpread(rawInputs) {
  const spreads = (rawInputs ?? [])
    .filter((r) => r.best_bid != null && r.best_ask != null)
    .map((r) => Number(r.best_ask) - Number(r.best_bid));
  return spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
}

/**
 * Score a categorical snapshot into the two independent dimensions:
 *   RELIABILITY — spread (well-defined leg prices), last-trade fallback, missing outcomes, AND
 *                 (Increment B) strong consensus: low entropy + a clear leader LIFTS a spread-driven
 *                 'medium' to 'high' (the headline is decisive even when tail legs have wider books).
 *   LIQUIDITY   — windowed (recent) volume, with all-time volume as the fallback.
 * Returns { reliability:{tier,score,reasons}, liquidity:{tier,score,reasons} }.
 */
export function scoreCategoricalConfidence({ rawInputs, totalVolume, midpointFallback = null, lifecycle = null, windowedVolume = null, daysToExpiry = null, entropy = null, dominantProb = null }) {
  const relTiers = [], relReasons = [];
  const liqTiers = [], liqReasons = [];
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';
  const spread = meanSpread(rawInputs);
  // Increment 3: spread tolerance widens near expiry.
  const spreadMult = spreadToleranceMultiplier(daysToExpiry);
  const note = expiryNote(daysToExpiry);
  // Increment B: a strongly-concentrated distribution (low entropy + a clear leader) — the headline
  // outcome is a well-formed agreement, reliable even if long-tail legs are thin/wide.
  const strongConsensus = entropy != null && entropy <= CONSENSUS_RELIABILITY_ENTROPY
    && dominantProb != null && dominantProb >= CONSENSUS_RELIABILITY_LEADER;

  // ════ RELIABILITY ════
  // Spread → (tier, reason), as a local so Increment B's consensus lift can upgrade it.
  let spreadTier = null, spreadReason = null;
  if (spread == null) {
    if (!settled) { spreadTier = 'medium'; spreadReason = 'no live book (price-only)'; }
  } else if (spread < SPREAD_HIGH * spreadMult) {
    spreadTier = 'high';
  } else if (spread <= SPREAD_MEDIUM * spreadMult) {
    spreadTier = 'medium';
    spreadReason = `wide bid-ask spread (${(spread * 100).toFixed(1)}%) — ${spreadMult > 1 ? `expected near expiry${note}` : 'moderate liquidity'}`;
  } else {
    spreadTier = 'low';
    spreadReason = `wide bid-ask spread (${(spread * 100).toFixed(1)}%) — illiquid${note}`;
  }
  // Strong consensus LIFTS a spread-driven 'medium' to 'high' (the leader is decisive; wide tail-leg
  // books don't make the headline unreliable). It never lifts 'low' (a genuinely illiquid >8% book) or
  // price-only (no book at all), and a missing/last-trade outcome still caps reliability separately.
  const consensusLifted = strongConsensus && spreadTier === 'medium' && spread != null;
  if (consensusLifted) {
    spreadTier = 'high';
    spreadReason = `strong consensus (entropy ${entropy.toFixed(2)}, leader ${Math.round(dominantProb * 100)}%) — headline well-determined despite wider tail books`;
  }
  if (spreadTier) { relTiers.push(spreadTier); if (spreadReason) relReasons.push(spreadReason); }

  if (midpointFallback) {
    if (midpointFallback.lastTradeCount > 0) {
      relTiers.push('medium');
      relReasons.push(`${midpointFallback.lastTradeCount} outcome(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) {
      relTiers.push('low');
      relReasons.push(`${midpointFallback.skippedCount} outcome(s) had no price`);
    }
  }

  // ════ LIQUIDITY ════
  // Windowed (recent) volume when present (Increment 1); all-time is the fallback.
  const winVol = windowedVolumeSignal(windowedVolume);
  if (winVol) {
    liqTiers.push(winVol.tier);
    if (winVol.reason) liqReasons.push(winVol.reason);
  } else if (totalVolume != null) {
    const v = `$${Math.round(totalVolume).toLocaleString('en-US')}`;
    if (totalVolume >= VOL_HIGH) liqTiers.push('high');
    else if (totalVolume >= VOL_MEDIUM) { liqTiers.push('medium'); liqReasons.push(`moderate volume (${v})`); }
    else { liqTiers.push('low'); liqReasons.push(`thin volume (${v})`); }
  }
  // Book depth (Increment C) — can you transact at SIZE, worst-of with volume. Null → no-op.
  const depth = bookDepthSignal(windowedVolume);
  if (depth) {
    liqTiers.push(depth.tier);
    if (depth.reason) liqReasons.push(depth.reason);
  }

  // ── reliability score ──
  let relScore = spread != null ? Math.max(0, Math.min(1, 1 - spread / 0.1)) : 0.6;
  // Strong consensus lifted the tier — keep the score consistent with a HIGH read (the wide tail-leg
  // book that depressed the spread-based score is not what the headline rests on).
  if (consensusLifted) relScore = Math.max(relScore, 0.85);
  if (midpointFallback) {
    relScore -= 0.05 * Math.min(2, midpointFallback.lastTradeCount ?? 0);
    relScore -= 0.1 * Math.min(2, midpointFallback.skippedCount ?? 0);
  }
  relScore = Number(Math.max(0, Math.min(1, relScore)).toFixed(3));
  // ── liquidity score ──
  let liqScore = winVol ? TIER_SCORE[winVol.tier]
    : totalVolume != null ? Math.min(1, totalVolume / VOL_HIGH) : 0.6;
  if (depth) liqScore = Math.min(liqScore, TIER_SCORE[depth.tier]); // worst-of: a thin book caps it
  liqScore = Number(Math.max(0, Math.min(1, liqScore)).toFixed(3));

  if (relReasons.length === 0) relReasons.push('tight spreads');
  if (liqReasons.length === 0) liqReasons.push('deep books');

  return {
    reliability: { tier: worstTier(relTiers), score: relScore, reasons: relReasons },
    liquidity: { tier: worstTier(liqTiers), score: liqScore, reasons: liqReasons },
  };
}

/** Deterministic one-liner — only claims backed by the computed distribution. */
function buildCategoricalNarrative(dominant, entropy, confidence) {
  const pct = dominant ? `${Math.round(dominant.probability * 100)}%` : 'an unknown';
  const label = dominant?.label ?? 'the leading outcome';
  const conc = entropy < 0.5 ? 'a concentrated consensus' : entropy < 0.78 ? 'a moderately contested field' : 'a wide-open field';
  return `The market assigns ${pct} probability to "${label}" — ${conc} (entropy ${entropy.toFixed(2)}). Reliability is ${confidence.reliability.tier}; liquidity is ${confidence.liquidity.tier}.`;
}

/** Guard-mode narrative: only claims the RAW per-leg prices support — no PMF language. */
function buildGuardedNarrative(verdict, headline, sum, confidence) {
  const tail = `Reliability is ${confidence.reliability.tier}; liquidity is ${confidence.liquidity.tier}.`;
  if (verdict === 'nested_deadline' && headline) {
    return `Cumulative deadlines: the market prices "${headline.label}" at ${Math.round(headline.raw_probability * 100)}% (raw). `
      + `Outcomes are nested, not mutually exclusive — probabilities do not sum to 1 and no single-winner distribution exists. ${tail}`;
  }
  const amb = verdict === 'ambiguous' ? ' (board structure ambiguous — treated conservatively)' : '';
  return `Outcomes shown at raw market prices${amb} — they are not mutually exclusive and do not sum to 1 `
    + `(raw sum ≈ ${sum.toFixed(2)}). No single-winner distribution exists. ${tail}`;
}

/**
 * Build the full canonical categorical record from a fetchCategoricalSnapshot result.
 *   live: { fetched_at, endpoints, raw_inputs, raw_sha256, outcomes[{label,prob,volume,
 *           midpoint_source}], total_volume, title, end_date, status, midpoint_fallback }
 */
export function buildCategoricalRecord(live, methodologyVersion, config, lifecycle = null, freshnessThresholdHours = undefined) {
  if (!config) throw new Error('buildCategoricalRecord: a MarketConfig is required');

  // ── 5.6 EXCLUSIVITY GUARD: classify BEFORE any normalization ──
  const exclusivity = assessExclusivity(live.outcomes ?? []);
  const guarded = exclusivity.verdict !== 'exclusive';

  let derived;
  if (!guarded) {
    // ── exclusive board: today's de-vig PMF path, byte-identical ──
    const outcomes = parseCategoricalOutcomes(live.outcomes ?? []);
    const dominant = outcomes[0] ?? null;
    const entropy = shannonEntropy(outcomes.map((o) => o.probability));
    const dominantProb = dominant?.probability ?? 0;
    const confidence = scoreCategoricalConfidence({
      rawInputs: live.raw_inputs, totalVolume: live.total_volume,
      midpointFallback: live.midpoint_fallback ?? null, lifecycle,
      windowedVolume: live.liquidity ?? null, // Increment 1
      daysToExpiry: daysUntil(config.resolves, live.fetched_at), // Increment 3
      entropy, dominantProb, // Increment B: strong consensus → reliability
    });
    derived = {
      kind: 'categorical',
      outcomes,
      dominant_outcome: dominant?.label ?? null,
      dominant_prob: dominantProb,
      entropy,
      consensus_strength: consensusStrength(dominantProb),
      implied_winner: dominantProb > 0.5 ? (dominant?.label ?? null) : 'no consensus',
      total_volume: live.total_volume ?? 0,
      confidence,
      narrative: buildCategoricalNarrative(dominant, entropy, confidence),
      freshness: buildFreshness(live.fetched_at, null, freshnessThresholdHours, lifecycle),
    };
  } else {
    // ── guarded board: RAW probabilities only; every PMF derivation SUPPRESSED
    //    (entropy, dominant_*, consensus_strength, implied_winner all OMITTED —
    //    normalizing a non-exclusive board fabricates numbers). Increment B is
    //    disarmed by passing entropy/dominantProb = null (its own null path). ──
    const real = realCategoricalLegs(live.outcomes ?? []);
    const items = real.map((l) => ({
      label: l.label,
      raw_probability: Number.isFinite(l.prob) ? l.prob : null,
      volume: l.volume ?? null,
      midpoint_source: l.midpoint_source ?? null,
      ...(l.leg_end_date ? { leg_end_date: l.leg_end_date } : {}),
      ...(l.question ? { deadline: parseByDeadline(l.question)?.key ?? null } : {}),
    }));
    const nested = exclusivity.verdict === 'nested_deadline';
    const outcomes = nested
      ? [...items].sort((a, b) => (a.deadline ?? a.leg_end_date ?? 0) > (b.deadline ?? b.leg_end_date ?? 0) ? 1 : -1)
      : [...items].sort((a, b) => (b.raw_probability ?? 0) - (a.raw_probability ?? 0));
    // F1's honest headline: the LONGEST-horizon cumulative probability (rail + history)
    const headline = nested && outcomes.length
      ? { label: outcomes[outcomes.length - 1].label, raw_probability: outcomes[outcomes.length - 1].raw_probability }
      : null;
    const confidence = scoreCategoricalConfidence({
      rawInputs: live.raw_inputs, totalVolume: live.total_volume,
      midpointFallback: live.midpoint_fallback ?? null, lifecycle,
      windowedVolume: live.liquidity ?? null,
      daysToExpiry: daysUntil(config.resolves, live.fetched_at),
      entropy: null, dominantProb: null, // Increment B must not fire on a fabricated PMF
    });
    derived = {
      kind: 'categorical',
      outcomes,
      exclusivity: { verdict: exclusivity.verdict, basis: exclusivity.basis, ...(headline ? { headline } : {}) },
      total_volume: live.total_volume ?? 0,
      confidence,
      narrative: buildGuardedNarrative(exclusivity.verdict, headline, exclusivity.basis.filtered_sum, confidence),
      freshness: buildFreshness(live.fetched_at, null, freshnessThresholdHours, lifecycle),
    };
  }
  if (live.liquidity) derived.liquidity = live.liquidity; // Increment 1: windowed volume, omit-when-absent

  const snapshot = {
    snapshot_id: live.fetched_at,
    fetched_at: live.fetched_at,
    source: { provider: 'Polymarket', endpoints: live.endpoints, raw_sha256: live.raw_sha256 },
    raw_inputs: live.raw_inputs,
    derived,
  };
  if (lifecycle) snapshot.lifecycle = lifecycle;

  return {
    schema_version: SCHEMA_VERSION,
    methodology_version: methodologyVersion,
    assumptions_version: null, // categorical carries no Tier-2 scenarios
    asset: { id: config.id, name: config.name, platform: config.platform, market_url: config.market_url, resolves: config.resolves },
    snapshot,
  };
}
