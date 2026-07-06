// lib/backfill.mjs — the history-backfill orchestrator (I3).
//
// When a user adds a market, rebuild market_history from Polymarket's CLOB prices-history:
// one gamma call for the leg structure, one prices-history call per leg, reconstruct a daily
// per-leg price table (core/price-history), assemble a validated record per day
// (lib/backfill-record), and write each as a backfill row — with the SAME hash recipe and the
// cron-precedence rule (insert ignoring duplicates so a real captured row is never clobbered).
//
// I/O is injected (the serve-market.mjs pattern) so the read→reconstruct→assemble→write loop is
// unit-tested deterministically; the real fetch/DB deps are wired in DEPS_BACKFILL (I4). One bad
// day never aborts the batch; a fatal error marks the market `failed` and never throws.

import { reconstructDailySeries } from '../core/price-history.js';
import { buildBackfillRecord } from './backfill-record.mjs';
import {
  classifyMarketShape, fetchMarketMeta, fetchBinaryMeta, fetchBucketMeta, fetchTouchMeta, fetchCategoricalMeta,
} from '../core/fetch.js';
import { defaultConfigForLadder } from '../core/market-config.js';
import { pinnedConfigFor } from './compute.mjs';
import { writeBackfillRow, setBackfillStatus } from './market-history.mjs';

const PRICES_HISTORY = 'https://clob.polymarket.com/prices-history';
// Daily fidelity is the ONLY one that returns full history depth — finer fidelities are
// retention-capped to ~the last 17 days (measured against the live API).
const DAILY_FIDELITY = 1440;

/** A minimal MarketConfig for the non-ladder kinds (the builders read only these fields). */
function simpleConfig(slug, name, kind, endDate) {
  return { id: slug, event_slug: slug, name: name || slug, kind, platform: 'prediction index',
    market_url: `https://polymarket.com/event/${slug}`, resolves: endDate ? endDate.slice(0, 10) : null };
}

/** The survival bootstrap config (default `$X` parser), mirroring compute.probeLifecycle. */
function bootstrapLadderConfig(slug) {
  return { event_slug: slug, threshold: { parse_pattern: '\\$(\\d+\\.?\\d*)', unit_prefix: '$', unit_suffix: '' },
    narrative: { unit_prefix: '$', unit_suffix: '' } };
}

/**
 * PURE: shape a fetched bucket meta into the backfill `meta`, MIRRORING the live path exactly
 * (core/fetch.fetchBucketPmfSnapshot + compute.computeBucketPmfRecord). Exported for unit tests.
 * Three rules the old inline version missed for PERCENT-denominated buckets (UK GDP):
 *   • an open-bottom leg (lo = -Infinity, "below 0%") gets the SAME synthetic finite floor the
 *     live path hashes (minFiniteLo − medianWidth, in absolute units, then ÷ divisor) — a raw
 *     -Infinity threshold JSON-serializes to null and breaks the canonical hash;
 *   • config boundaries use buildPmfLadder's unit-agnostic rung rule (a finite b is a rung iff
 *     ∃ leg hi ≤ b) — byte-identical for all-positive dollar ladders (0 has nothing below), but
 *     KEEPS percent ladders' 0/negative rungs (the old `v > 0` filter dropped them);
 *   • unit_prefix is '' for percent buckets ('$' only for dollar ladders), matching compute.mjs.
 */
export function bucketBackfillMeta(m, slug) {
  const { divisor, unit } = m.unitInfo;
  // Synthetic floor for an open-bottom bucket — same recipe as core/fetch.js (absolute units).
  const finiteLos = m.legs.map((l) => l.lo).filter(Number.isFinite);
  const minFiniteLo = finiteLos.length ? Math.min(...finiteLos) : 0;
  const finiteWidths = m.legs.filter((l) => Number.isFinite(l.lo) && Number.isFinite(l.hi)).map((l) => l.hi - l.lo).sort((a, b) => a - b);
  const medianWidth = finiteWidths.length ? finiteWidths[Math.floor(finiteWidths.length / 2)] : 1;
  const syntheticFloor = minFiniteLo - medianWidth;
  const loKey = (lo) => (Number.isFinite(lo) ? lo : syntheticFloor) / divisor;

  const legs = m.legs.map((l) => ({ token_id: l.token_id, lo: loKey(l.lo), hi: Number.isFinite(l.hi) ? l.hi / divisor : Infinity }));
  // buildPmfLadder's boundary rule: a finite edge is a rung iff some leg's finite hi ≤ it.
  const boundaries = [...new Set(legs.flatMap((l) => [l.lo, l.hi]).filter(Number.isFinite))]
    .filter((b) => legs.some((l) => Number.isFinite(l.hi) && l.hi <= b))
    .sort((a, b) => a - b);
  const prefix = unit === '%' ? '' : '$'; // percent labels read "2%"; dollar labels read "$1.8T"
  const config = defaultConfigForLadder(boundaries, { id: slug, event_slug: slug, name: m.title || slug, unit_prefix: prefix, unit_suffix: unit });
  return { kind: 'bucket_pmf', config, unit, legs, tokenIds: legs.map((l) => l.token_id) };
}

/**
 * Fetch the market's leg structure from gamma and shape it into the `meta` the assembler
 * consumes (kind, config, per-kind legs, tokenIds). REUSES the live meta parsers so the
 * token ids / thresholds / levels / intervals / outcome labels match the live path exactly.
 */
export async function fetchBackfillMeta(slug) {
  const shape = await classifyMarketShape(slug);
  const ev = { event_slug: slug };

  if (shape === 'binary') {
    const m = await fetchBinaryMeta(ev);
    return { kind: 'binary', config: simpleConfig(slug, m.title, 'binary', m.end_date),
      yes_token: m.yes_token, no_token: m.no_token, tokenIds: [m.yes_token, m.no_token].filter(Boolean) };
  }
  if (shape === 'bucket_pmf') {
    const m = await fetchBucketMeta(ev);
    return bucketBackfillMeta(m, slug); // pure shaping (synthetic floor + rung rule + unit prefix)
  }
  if (shape === 'directional_touch') {
    const m = await fetchTouchMeta(ev);
    const { divisor, unit } = m.unitInfo;
    const legs = m.legs.map((l) => ({ token_id: l.token_id, side: l.side, level: l.level / divisor }));
    return { kind: 'directional_touch', config: simpleConfig(slug, m.title, 'directional_touch', m.end_date), unit, legs, tokenIds: legs.map((l) => l.token_id) };
  }
  if (shape === 'categorical') {
    const m = await fetchCategoricalMeta(ev);
    const legs = m.legs.map((l) => ({ token_id: l.token_id, label: l.label }));
    return { kind: 'categorical', config: simpleConfig(slug, m.title, 'categorical', m.end_date), legs, tokenIds: legs.map((l) => l.token_id) };
  }

  // survival ladder (SpaceX-style): bootstrap-parse the legs, then use the pinned config if any.
  const legs0 = await fetchMarketMeta(bootstrapLadderConfig(slug));
  const thresholds = legs0.map((l) => l.threshold);
  const config = pinnedConfigFor(slug) ?? defaultConfigForLadder(thresholds, { id: slug, event_slug: slug, name: slug, unit_prefix: '$', unit_suffix: '' });
  const legs = legs0.map((l) => ({ token_id: l.token_id, threshold: l.threshold, label: l.label }));
  return { kind: 'survival', config, legs, tokenIds: legs.map((l) => l.token_id) };
}

/** Fetch one token's full daily price history. Returns [{t,p}] (empty on a non-200/parse miss
 *  — a single dead leg degrades that leg, it must not abort the market's whole backfill). */
export async function fetchTokenHistory(token, { fidelity = DAILY_FIDELITY } = {}) {
  const url = `${PRICES_HISTORY}?market=${token}&interval=max&fidelity=${fidelity}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-tracker-backfill/1.0' } });
  if (!res.ok) throw new Error(`prices-history ${token} → ${res.status}`);
  const j = await res.json();
  return Array.isArray(j?.history) ? j.history : [];
}

/**
 * PURE: turn the reconstructed daily rows into per-day records. Each row → a validated record
 * (or skipped when the day has too few usable legs); an assembler throw is captured as
 * { date, error } so the caller logs it without aborting. Rows are oldest-first.
 */
export function assembleBackfillRecords(meta, rows) {
  const out = [];
  for (const row of rows ?? []) {
    let record;
    try {
      record = buildBackfillRecord({ meta, prices: row.prices, date: row.date });
    } catch (e) {
      out.push({ date: row.date, error: e.message });
      continue;
    }
    if (record) out.push({ date: row.date, record });
  }
  return out;
}

/**
 * Backfill one market end-to-end with injected I/O deps:
 *   deps.fetchMeta(slug) → meta            (default: fetchBackfillMeta)
 *   deps.fetchHistory(token) → [{t,p}]     (default: fetchTokenHistory)
 *   deps.writeRow(slug, date, record) → bool (true = inserted, false = already present/cron)
 *   deps.setStatus(slug, status, through)  (status: pending|done|failed; through = earliest date)
 * Returns { written, failed, days, error? }. Never throws — a fatal error marks the market failed.
 */
export async function backfillMarket({ slug, deps, log = console }) {
  await safeStatus(deps, slug, 'pending', null, log);
  let meta;
  try {
    meta = await deps.fetchMeta(slug);
    const tokens = [];
    for (const token of meta.tokenIds) {
      try {
        tokens.push({ token_id: token, history: await deps.fetchHistory(token) });
      } catch (e) {
        log.warn?.(`backfill ${slug}: leg ${token} history failed (${e.message}) — degraded`);
        tokens.push({ token_id: token, history: [] });
      }
    }
    const { rows } = reconstructDailySeries(tokens);
    const assembled = assembleBackfillRecords(meta, rows);

    let written = 0, failed = 0, earliest = null;
    for (const a of assembled) {
      if (a.error) { failed++; log.warn?.(`backfill ${slug} ${a.date}: ${a.error}`); continue; }
      try {
        const inserted = await deps.writeRow(slug, a.date, a.record);
        if (inserted) { written++; if (earliest == null) earliest = a.date; }
      } catch (e) {
        failed++;
        log.warn?.(`backfill ${slug} ${a.date}: write failed (${e.message})`);
      }
    }
    // Wrote nothing AND something failed → failed; otherwise done (zero-write with no failures
    // is a legitimate "already fully backfilled" outcome).
    const status = written === 0 && failed > 0 ? 'failed' : 'done';
    await safeStatus(deps, slug, status, earliest, log);
    return { written, failed, days: assembled.length };
  } catch (e) {
    log.error?.(`backfill ${slug} failed: ${e.message}`);
    await safeStatus(deps, slug, 'failed', null, log);
    return { written: 0, failed: -1, error: e.message };
  }
}

/** A status write must never be the thing that throws out of the backfill. */
async function safeStatus(deps, slug, status, through, log) {
  try { await deps.setStatus?.(slug, status, through); }
  catch (e) { log.warn?.(`backfill ${slug}: status write failed (${e.message})`); }
}

/** The REAL I/O deps: gamma meta + CLOB prices-history fetches, service-role DB writes. The
 *  /api/backfill route injects this; tests inject mocks. SERVER-ONLY (pulls the service-role
 *  client via market-history.mjs). */
export const DEPS_BACKFILL = {
  fetchMeta: fetchBackfillMeta,
  fetchHistory: fetchTokenHistory,
  writeRow: writeBackfillRow,
  setStatus: setBackfillStatus,
};
