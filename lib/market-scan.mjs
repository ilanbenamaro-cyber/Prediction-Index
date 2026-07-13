// lib/market-scan.mjs — the watchlist RAIL's scan-data reader (SERVER-ONLY).
//
// Why this exists: the rail (Zone 1) paints a dense glanceable row per watchlisted
// market — name, implied median, 24h delta, confidence tier, freshness. Those fields
// are ALREADY promoted to columns on market_snapshots (surfaced by the market_latest
// view) plus the delta inside the stored record JSONB, so the rail reads the CACHE
// ONLY — no per-call resolution probe, no recompute, no /api/market fan-out. The rail
// is a SCAN SUMMARY using the cost layer; the resolution-probed AUTHORITATIVE serve
// stays in Zone 2 (/api/market) for the single SELECTED market. (See decisions.md /
// gotchas.md: /api/market is never HTTP-cached precisely because IT is the correctness
// layer — the rail deliberately does not claim authoritative-live state.)
//
// SERVER-ONLY, same pattern as lib/cache.mjs: this module uses the SERVICE-ROLE key
// and must NEVER be imported into client code. The service-role requirement is itself
// the fence — db() throws without it, and the key is NEVER NEXT_PUBLIC_, so it cannot
// be inlined into a browser bundle. The light rows it returns carry NO raw record.
//
// ── THE FIREWALL (load-bearing) ───────────────────────────────────────────────
// The service-role read BYPASSES RLS, so it could read ANY market's scan data. The
// ONE thing that keeps it tenant-safe: the ids are derived ONLY from `visibleRows`,
// which the caller obtained from lib/watchlist.listVisible() — the RLS-scoped
// my_visible_watchlist union view. readScan takes NO id list (nothing to forge) and
// NEVER does an unfiltered read: every query is bounded `.in('…', ids)` where ids ⊆
// what the signed-in user may see. A market the user cannot see via listVisible can
// NOT appear in the rail even though service-role could physically read it. The 2c.2
// gate asserts exactly this cross-tenant property.

import { createClient } from '@supabase/supabase-js';
import { fmtT } from '../core/format.js';
import { unitFromLadder, fmtMoney, displayTitle, impliedMedianLabel } from './format-detail.mjs';

let _client = null;
function db() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // read-capable; server-only
  if (!url || !key) throw new Error('market-scan: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

/** Pull the stored 24h median delta {display, dir} out of a core record JSONB.
 *  Path: snapshot.derived.market.analytics.velocity.change_24h (null when no prior).
 *  Returns { display, dir } with safe fallbacks so a thin/early record never throws. */
function deltaFromRecord(record) {
  const ch = record?.snapshot?.derived?.market?.analytics?.velocity?.change_24h ?? null;
  if (!ch || ch.display == null) return { display: null, dir: 'flat' };
  return { display: ch.display, dir: ch.dir ?? 'flat' };
}

/** Total market volume from the record (drives the rail's volume tint, Enh 2). */
function volumeFromRecord(record) {
  const v = record?.snapshot?.derived?.total_volume;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 24h (recent) volume from derived.liquidity — the primary rail liquidity signal (Increment 1).
 *  null when the market was computed before windowed volume existed (falls back to all-time tint). */
function volume24hFromRecord(record) {
  const v = record?.snapshot?.derived?.liquidity?.volume_24hr;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * PURE: assemble the rail's light rows from the three reads. Exported for unit tests
 * (no DB). Dedups by market_id (the union view can return the same market under both
 * 'personal' and 'org' — merge into ONE row carrying BOTH scopes), formats the median
 * via the SAME core/format.fmtT the detail view uses (byte-identical strings), and
 * extracts the pre-formatted delta. Ordering: personal-first, then most-recently-added.
 *
 * @param visibleRows rows from listVisible: { scope, org_id, market_id, created_at }
 * @param marketRows  from `markets`:        { id, title }
 * @param latestRows  from `market_latest`:  { market_id, implied_median, confidence_tier,
 *                                             lifecycle_state, is_final, stale_after,
 *                                             fetched_at, record }
 */
/** Format the rail's headline by market kind, reading the stored record for the unit:
 *   binary           → YES probability as a percentage (stored in implied_median);
 *   directional_touch → the implied range labels (no median exists for a touch market);
 *   ladder / bucket   → the median in the market's OWN unit (derived from the record's
 *                       labels). The $T case still routes through fmtT so SpaceX's rail
 *                       string stays byte-identical (the 2c.2 rail gate); K/B/M/bare-$
 *                       markets (Bitcoin/WTI/...) no longer mis-render as $T. */
function headlineDisplay(kind, value, record) {
  if (kind === 'binary') return value == null ? '—' : `${Math.round(value * 100)}%`;
  if (kind === 'directional_touch') {
    const r = record?.snapshot?.derived?.implied_range;
    return r?.low_label && r?.high_label ? `${r.low_label}–${r.high_label}` : '—';
  }
  // Categorical has no median (it's not stored in implied_median) — headline the LEADING outcome's
  // probability, read from the record (audit F7: this was falling through to a bare "—").
  if (kind === 'categorical') {
    // Guarded boards (5.6): dominant_prob is suppressed; a NESTED board's honest headline is
    // the longest-horizon RAW probability; F2/F3 boards have no single headline number → '—'.
    const d = record?.snapshot?.derived;
    const p = d?.dominant_prob ?? d?.exclusivity?.headline?.raw_probability;
    return p == null ? '—' : `${Math.round(p * 100)}%`;
  }
  // ladder / bucket_pmf
  const markets = record?.snapshot?.derived?.markets;
  if (value == null) {
    // CDF never crosses 50% → the SAME honest "< $lo" / "> $hi" label the detail uses (Bug 5),
    // not a bare dash (audit F3: the rail showed "—" where the detail showed the bound label).
    return Array.isArray(markets) && markets.length ? impliedMedianLabel(markets, null, unitFromLadder(markets)) : '—';
  }
  if (!Array.isArray(markets) || markets.length === 0) return fmtT(value); // thin record, no labels → legacy
  const unit = unitFromLadder(markets);
  return unit === 'T' ? fmtT(value) : fmtMoney(value, unit);
}

export function assembleScanRows(visibleRows, marketRows, latestRows) {
  const titleById = new Map((marketRows ?? []).map((m) => [m.id, m.title]));
  const kindById = new Map((marketRows ?? []).map((m) => [m.id, m.kind ?? 'threshold_ladder']));
  const latestById = new Map((latestRows ?? []).map((s) => [s.market_id, s]));

  // Fold the union rows into one entry per market_id, accumulating scopes + earliest add.
  const byMarket = new Map();
  for (const v of visibleRows ?? []) {
    let e = byMarket.get(v.market_id);
    if (!e) { e = { market_id: v.market_id, scopes: new Set(), created_at: v.created_at ?? null, org_id: null, org_ids: new Set() }; byMarket.set(v.market_id, e); }
    e.scopes.add(v.scope);
    // capture the org this market is shared in (first one wins) — drives org-scoped remove
    if (v.scope === 'org' && v.org_id && !e.org_id) e.org_id = v.org_id;
    // ALL orgs this market is shared in (a market can be in several) — drives the rail's per-org filter
    if (v.scope === 'org' && v.org_id) e.org_ids.add(v.org_id);
    // keep the MOST RECENT add time across scopes (drives ordering)
    if (v.created_at && (!e.created_at || v.created_at > e.created_at)) e.created_at = v.created_at;
  }

  const rows = [...byMarket.values()].map((e) => {
    const s = latestById.get(e.market_id) ?? null;
    const median = s?.implied_median ?? null;
    const kind = kindById.get(e.market_id) ?? 'threshold_ladder';
    const { display: delta_display, dir: delta_dir } = deltaFromRecord(s?.record);
    return {
      market_id: e.market_id,
      title: displayTitle(titleById.get(e.market_id), e.market_id), // gamma name, else a cleaned slug (Bug 7)
      kind,
      scopes: [...e.scopes],
      personal: e.scopes.has('personal'),
      org_id: e.org_id, // the FIRST org this market is shared in (for org-scoped remove), or null
      org_ids: [...e.org_ids], // EVERY org this market is shared in (the rail's per-org toggle filter)
      implied_median: median,
      median_display: headlineDisplay(kind, median, s?.record),
      confidence_tier: s?.confidence_tier ?? null, // legacy collapsed (back-compat)
      // Two-dimension confidence (0010): the rail shows two dots (reliability, liquidity). A
      // pre-split row has these null → the rail renders that dot as a neutral "—".
      reliability_tier: s?.reliability_tier ?? null,
      liquidity_tier: s?.liquidity_tier ?? null,
      lifecycle_state: s?.lifecycle_state ?? null,
      is_final: s?.is_final ?? false,
      stale_after: s?.stale_after ?? null,
      fetched_at: s?.fetched_at ?? null,
      delta_display,
      delta_dir,
      volume: volumeFromRecord(s?.record), // Enh 2: rail volume tint
      volume_24hr: volume24hFromRecord(s?.record), // Increment 1: 24h primary liquidity signal
      near_settlement: s?.record?.snapshot?.derived?.near_settlement === true, // Enh 2: near-settlement clock
      has_scan: s != null,
      created_at: e.created_at,
    };
  });

  // personal-first, then most-recently-added, tiebreak market_id for determinism.
  rows.sort((a, b) => {
    if (a.personal !== b.personal) return a.personal ? -1 : 1;
    if (a.created_at && b.created_at && a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.market_id < b.market_id ? -1 : a.market_id > b.market_id ? 1 : 0;
  });
  return rows;
}

/**
 * Read scan data for EXACTLY the markets the caller may see. `visibleRows` MUST come
 * from lib/watchlist.listVisible(userClient) (RLS-scoped) — that is the firewall: the
 * ids are taken only from these rows, never a caller-supplied list, and every query is
 * bounded `.in(…, ids)`. Returns [] for an empty watchlist without touching the DB.
 */
export async function readScan(visibleRows) {
  const ids = [...new Set((visibleRows ?? []).map((r) => r.market_id))];
  if (ids.length === 0) return [];

  const [mkts, latest] = await Promise.all([
    db().from('markets').select('id, title, kind').in('id', ids),
    db().from('market_latest')
      .select('market_id, implied_median, confidence_tier, reliability_tier, liquidity_tier, lifecycle_state, is_final, stale_after, fetched_at, record')
      .in('market_id', ids),
  ]);
  if (mkts.error) throw new Error(`market-scan read (markets): ${mkts.error.message}`);
  if (latest.error) throw new Error(`market-scan read (market_latest): ${latest.error.message}`);

  return assembleScanRows(visibleRows, mkts.data ?? [], latest.data ?? []);
}
