// core/market-config.js — per-market configuration as DATA, not code branches.
//
// Why this exists: the verified pipeline was tuned to one market (SpaceX). To
// process ANY threshold-ladder event without `if (market === 'spacex')` anywhere,
// every market-specific value (tail offsets, liquidity floor, confidence ladder
// size, label units, tracked thresholds, narrative wording, scenario assumptions)
// lives in a MarketConfig object. SpaceX is one pinned instance whose values equal
// the historical constants exactly (so its output is byte-identical); a generic
// market gets scale-free defaults derived from its own ladder.
//
// A MarketConfig is the single source of truth for those values; core/ functions
// receive the relevant slice and never hold a second copy.

// Pinned configs are IMPORTED (bundled into the JS) via the manifest, not read from
// disk at runtime — so the serverless function never ENOENTs (see markets/manifest.mjs).
import { PINNED_BY_NAME } from './markets/manifest.mjs';

/** Load a pinned market config by name (filename stem). structuredClone returns a
 *  fresh mutable object per call, preserving the old JSON.parse(readFileSync) contract. */
export function loadMarketConfig(name) {
  const src = PINNED_BY_NAME[name];
  if (!src) throw new Error(`No pinned market config '${name}' in core/markets/manifest.mjs`);
  const cfg = structuredClone(src);
  validateMarketConfig(cfg);
  return cfg;
}

/** Compile the threshold parser for a config (RegExp from the stored pattern). */
export function thresholdRegExp(config) {
  return new RegExp(config.threshold.parse_pattern);
}

/** Parse the numeric threshold out of a market question. Throws (fail loud) on no match. */
export function parseThreshold(config, question) {
  const m = question.match(thresholdRegExp(config));
  if (!m) throw new Error(`Cannot parse threshold from "${question}" with ${config.threshold.parse_pattern}`);
  return parseFloat(m[1]);
}

// ── label builders (reproduce the historical "$…T" forms exactly) ──
const P = (c) => c.threshold?.unit_prefix ?? c.narrative?.unit_prefix ?? '$';
const S = (c) => c.threshold?.unit_suffix ?? c.narrative?.unit_suffix ?? '';
/** ">$1.8T" — used for a market's own "above $X" label and the top density bucket. */
export const labelGt = (config, t) => `>${P(config)}${t}${S(config)}`;
/** "<$1T" — the "below lowest" density bucket. */
export const labelLt = (config, t) => `<${P(config)}${t}${S(config)}`;
/** "$1–1.2T" — a middle density bucket. */
export const labelBetween = (config, a, b) => `${P(config)}${a}–${b}${S(config)}`;

/** Money/unit formatter for narrative + value prose: "$2.10T". */
export const fmtValue = (config, x) => `${P(config)}${x}${S(config)}`;

/**
 * Scale-free default config for any threshold-ladder market. Derives the
 * historically-tuned ratios from the ladder's median inter-threshold gap, so a
 * market on a different scale gets sensible offsets/grids without hand-tuning.
 * (For SpaceX's uniform 0.2 gap these reproduce 0.15/0.40 etc., but SpaceX uses
 * its pinned config for zero risk — this is for markets we have not pinned.)
 *   thresholds: ascending numeric ladder
 *   meta: { id, name, platform, market_url, resolves, event_slug, unit_prefix, unit_suffix }
 */
export function defaultConfigForLadder(thresholds, meta = {}) {
  const sorted = [...thresholds].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1; // median gap; 1 if single rung
  const n = sorted.length;

  // tracked thresholds: the rungs nearest the 25/50/75 percentile of the ladder.
  const pick = (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  const trackedVals = [...new Set([pick(0.25), pick(0.5), pick(0.75)])];
  const tracked_thresholds = trackedVals.map((t) => ({
    key: `prob_${String(t).replace('.', '_')}`,
    threshold: t,
  }));

  const prefix = meta.unit_prefix ?? '$';
  const suffix = meta.unit_suffix ?? '';

  return {
    id: meta.id ?? meta.event_slug ?? 'market',
    name: meta.name ?? meta.id ?? 'market',
    platform: meta.platform ?? 'prediction index',
    market_url: meta.market_url ?? null,
    resolves: meta.resolves ?? null,
    event_slug: meta.event_slug ?? null,
    threshold: { parse_pattern: meta.parse_pattern ?? '\\$(\\d+\\.?\\d*)', unit_prefix: prefix, unit_suffix: suffix },
    mean: {
      below_offset: 0.75 * gap,
      above_offset: 2.0 * gap,
      grid_below: [0.5 * gap, 0.75 * gap, 1.0 * gap],
      grid_above: [1.5 * gap, 2.0 * gap, 3.0 * gap],
    },
    // No absolute-dollar anchor for an unknown market: scale the thin-book floor
    // to a fraction of the ladder's own typical rung volume at call time instead.
    // null here => stats falls back to its relative floor (see adjustSnapshot).
    liquidity_floor: null,
    confidence: { count_high: Math.ceil(0.75 * n), count_medium: Math.ceil(0.5 * n), ladder_size: n },
    analytics: { dispersion_eps: 0.15 * gap, accel_eps: 0.01 * gap },
    tracked_thresholds,
    narrative: { subject: meta.name ?? 'the market', unit_prefix: prefix, unit_suffix: suffix },
    calibration: { resolves: meta.resolves ?? null },
    scenarios: null, // generic markets carry no Tier-2 (Part B)
  };
}

/** Minimal structural validation — fail loud on a malformed config. */
export function validateMarketConfig(cfg) {
  const need = ['id', 'threshold', 'mean', 'confidence', 'tracked_thresholds', 'narrative'];
  for (const k of need) {
    if (cfg[k] == null) throw new Error(`MarketConfig missing required key: ${k}`);
  }
  if (!Array.isArray(cfg.mean.grid_below) || !Array.isArray(cfg.mean.grid_above)) {
    throw new Error('MarketConfig.mean.grid_below/grid_above must be arrays');
  }
  if (!Array.isArray(cfg.tracked_thresholds)) {
    throw new Error('MarketConfig.tracked_thresholds must be an array');
  }
  return cfg;
}
