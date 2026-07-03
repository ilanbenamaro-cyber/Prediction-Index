// core/fetch.js — the product's provenance-aware fetcher.
//
// Why this exists: the canonical record must carry exactly what Polymarket
// returned, so consumers can verify the derived numbers against unaltered
// inputs. This fetches three public, auth-free endpoints and distils them into
// `raw_inputs` (one row per threshold, values kept as the API's literal strings)
// plus a reproducible sha256 over the canonical serialization of those inputs.
//
// (api.js stays the lighter fetcher for the local CLI; this is the richer one
// that also pulls best bid/ask for the liquidity/confidence signal.)

import { createHash } from 'node:crypto';
import { thresholdRegExp, labelGt } from './market-config.js';
import { parseBucketLeg, buildPmfLadder } from './bucket.js';
import { parseTouchLeg, impliedRange } from './touch.js';
import { deriveUnit } from './money.js';

const EVENT_SLUG = 'spacex-ipo-closing-market-cap-above';
export const ENDPOINTS = {
  gamma: `https://gamma-api.polymarket.com/events?slug=${EVENT_SLUG}`,
  midpoints: 'https://clob.polymarket.com/midpoints',
  prices: 'https://clob.polymarket.com/prices',
  lastTrade: 'https://clob.polymarket.com/last-trade-price',
};
const lastTradeUrl = (token) => `${ENDPOINTS.lastTrade}?token_id=${token}`;
const THRESHOLD_RE = /\$(\d+\.?\d*)/;

export const ASSET = {
  id: 'spacex-ipo-market-cap',
  name: 'SpaceX IPO closing market cap',
  platform: 'polymarket',
  market_url: 'https://polymarket.com/event/spacex-ipo-closing-market-cap-above',
  resolves: '2027-12-31',
};

/**
 * Canonical JSON serialization of raw_inputs: fixed key order, ascending by
 * threshold. Both the build (node) and the dashboard (browser) reproduce this
 * exact string, so the sha256 verifies anywhere. Keep this in sync with the
 * browser-side verifier in docs/index.html.
 */
export function canonicalizeRawInputs(rawInputs) {
  const ordered = [...rawInputs]
    .sort((a, b) => a.threshold - b.threshold)
    .map((r) => ({
      token_id: r.token_id,
      threshold: r.threshold,
      midpoint: r.midpoint,
      best_bid: r.best_bid,
      best_ask: r.best_ask,
      volume: r.volume,
    }));
  return JSON.stringify(ordered);
}

export function hashRawInputs(rawInputs) {
  return createHash('sha256').update(canonicalizeRawInputs(rawInputs)).digest('hex');
}

// ── windowed volume (Increment 1) ────────────────────────────────────────────
// All-time cumulative volume is a poor liquidity proxy (a market dormant for months but heavily
// traded last year reads identical to an active one). Gamma also returns WINDOWED volume per leg
// (`volume24hr`, `volume1wk`). These are SUPPLEMENTARY: they go into a derived.liquidity object,
// NEVER into raw_inputs — canonicalizeRawInputs (and the frozen SpaceX hash) stay untouched. The
// numbers are still "what was observed", just recorded outside the canonical, same as midpoint_source.

const numOrNull = (x) => (x != null && Number.isFinite(Number(x)) ? Number(x) : null);

/**
 * Parse a gamma market leg's `clobTokenIds` (a JSON string OR an already-parsed array) into a
 * NON-EMPTY token-id array, or NULL when it's absent/empty/malformed. A leg with no clobTokenIds has
 * no order book — an untraded/placeholder rung Polymarket lists but that isn't tradeable yet (e.g.
 * the "hit (HIGH) $5,000" leg on the gold-touch market) — so it cannot be priced. Callers SKIP such a
 * leg (filter it out) instead of crashing on `ids[0]` (the old inline `JSON.parse(...) : m.clobTokenIds`
 * left `ids` undefined for a missing field → `ids[0]` → an unhandled TypeError → HTTP 500).
 */
export function parseClobTokenIds(m) {
  const raw = m?.clobTokenIds;
  if (raw == null) return null;
  try {
    const ids = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(ids) && ids.length > 0 ? ids : null;
  } catch {
    return null; // malformed JSON → treat as no token (skip the leg), never throw here
  }
}

/** Per-leg supplementary liquidity fields from a gamma market leg: windowed volume (24h / 7d) AND
 *  (Increment C) order-book depth `m.liquidity` (resting-order $ value; `liquidityClob` is the same
 *  number). All SUPPLEMENTARY — recorded outside raw_inputs, never hashed. */
function legWindowed(m) {
  return {
    volume_24hr: numOrNull(m.volume24hr),
    volume_1wk: numOrNull(m.volume1wk),
    book_depth: numOrNull(m.liquidity ?? m.liquidityClob), // Increment C: order-book depth ($)
  };
}

/**
 * Aggregate windowed + all-time volume across a market's legs into the supplementary liquidity
 * object. The event-level windowed volume EQUALS the sum of per-leg windowed volume (verified
 * against live gamma to the cent), so summing legs is the authoritative aggregate and is uniform
 * across every market type. `keyOf(leg)` (optional) maps a leg to its derived threshold for the
 * per-rung 24h map the ladder table reads. Returns null when NO windowed data is present on any
 * leg (e.g. SpaceX's frozen replay, whose captured legs predate this feature) — so the caller
 * OMITS derived.liquidity and the frozen parity block stays byte-identical.
 */
export function aggregateLiquidity(legs, keyOf = null) {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  const has24 = legs.some((l) => l.volume_24hr != null);
  const has7 = legs.some((l) => l.volume_1wk != null);
  // Increment C: book depth is per-leg `m.liquidity`, NOT a sum (resting orders don't aggregate across
  // mutually-exclusive legs — a 128-leg event would over-count). Red-team F1: take the DOMINANT-outcome
  // leg's depth — the leg the headline rests on, proxied by the MOST-TRADED leg (highest all-time
  // volume; prob isn't available at aggregate time) — falling back to the max across legs only when the
  // leader leg has no book data. MAX-across-legs over-credited a market whose deepest book sat on an
  // obscure low-volume longshot, not the headline. Omit-when-absent: SpaceX's frozen replay / any
  // resolved market carry no liquidity field → book_depth null → the whole object omitted below.
  const withDepth = legs.filter((l) => l.book_depth != null);
  const hasDepth = withDepth.length > 0;
  if (!has24 && !has7 && !hasDepth) return null;
  const sum = (f) => legs.reduce((s, l) => s + (l[f] ?? 0), 0);
  const liq = {
    volume_24hr: has24 ? sum('volume_24hr') : null,
    volume_1wk: has7 ? sum('volume_1wk') : null,
    volume_all: legs.some((l) => l.volume != null) ? sum('volume') : null,
  };
  if (hasDepth) {
    const tradedness = (l) => l.volume ?? l.volume_24hr ?? 0; // most-traded ⇒ dominant-outcome proxy
    const leader = legs.reduce((best, l) => (tradedness(l) > tradedness(best) ? l : best), legs[0]);
    liq.book_depth = leader.book_depth != null
      ? leader.book_depth                                  // the headline leg's book
      : Math.max(...withDepth.map((l) => l.book_depth));   // fallback: deepest available book
  }
  if (keyOf && has24) {
    const by = {};
    for (const l of legs) {
      const k = keyOf(l);
      if (k != null && l.volume_24hr != null) by[k] = (by[k] ?? 0) + l.volume_24hr;
    }
    liq.by_threshold = by;
  }
  return liq;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

const gammaUrl = (slug) => `https://gamma-api.polymarket.com/events?slug=${slug}`;

// ── shared midpoint resolution (Phase 1) — used by BOTH the ladder and binary
// fetchers so the fallback chain lives in one place. Pure of I/O except
// fetchLastTradePrice. resolveFromBook covers everything up to the last-trade tier;
// callers fetch last-trade only for the rungs/sides it marks `needsLastTrade`.
function resolveFromBook(mid, book) {
  const best_bid = book.BUY != null ? String(book.BUY) : null;
  const best_ask = book.SELL != null ? String(book.SELL) : null;
  if (mid != null) return { best_bid, best_ask, midpoint: String(mid), midpoint_source: 'clob_midpoint' };
  if (best_bid != null && best_ask != null) {
    return { best_bid, best_ask, midpoint: String((Number(best_bid) + Number(best_ask)) / 2), midpoint_source: 'bid_ask_mean' };
  }
  if (best_bid != null) return { best_bid, best_ask, midpoint: best_bid, midpoint_source: 'best_bid' };
  if (best_ask != null) return { best_bid, best_ask, midpoint: best_ask, midpoint_source: 'best_ask' };
  return { best_bid, best_ask, needsLastTrade: true }; // no midpoint, no book
}
async function fetchLastTradePrice(token) {
  try {
    const lt = await fetchJson(lastTradeUrl(token));
    return lt && lt.price != null ? String(lt.price) : null;
  } catch {
    return null;
  }
}

/**
 * Gamma event → ascending rung metadata. `config` (a MarketConfig) supplies the
 * event slug + threshold parser + label; omitted ⇒ legacy SpaceX behavior.
 * Captures resolution signals (closed / umaResolutionStatus / outcomes /
 * outcomePrices) in the side channel for the lifecycle classifier — NEVER in
 * raw_inputs, so the frozen hash recipe is untouched.
 */
export async function fetchMarketMeta(config = null) {
  const url = config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma;
  const re = config ? thresholdRegExp(config) : THRESHOLD_RE;
  const labelOf = config ? (t) => labelGt(config, t) : (t) => `>$${t}T`;
  const events = await fetchJson(url);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Gamma API returned no events');
  }
  const markets = events[0].markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error('Gamma event contained no markets');
  }
  return markets
    .map((m) => {
      const match = m.question.match(re);
      if (!match) throw new Error(`Cannot parse threshold: ${m.question}`);
      const threshold = parseFloat(match[1]);
      const ids = parseClobTokenIds(m);
      if (!ids) return null; // untraded/placeholder rung (no order book) — skip, don't crash on ids[0]
      return {
        threshold,
        label: labelOf(threshold),
        token_id: ids[0], // YES
        volume: m.volume != null ? Number(m.volume) : null,
        ...legWindowed(m), // windowed volume — supplementary, never hashed
        // Status + resolution signals — NOT part of raw_inputs / the hash.
        closed: m.closed === true,
        active: m.active !== false,
        accepting_orders: m.acceptingOrders !== false,
        uma_resolution_status: m.umaResolutionStatus ?? null,
        outcomes: m.outcomes ?? null,
        outcome_prices: m.outcomePrices ?? null,
      };
    })
    .filter(Boolean) // drop skipped (no-token) legs; SpaceX legs all have tokens → identity → byte-identical
    .sort((a, b) => a.threshold - b.threshold);
}

/**
 * Fetch a live snapshot with full provenance. Returns:
 *   { fetched_at, endpoints[], raw_inputs[], raw_sha256, markets[] }
 * where markets = [{ label, threshold, prob, volume }] (prob = midpoint) and
 * raw_inputs keeps the API's literal string values for midpoint/bid/ask.
 */
export async function fetchLiveSnapshot(config = null) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchMarketMeta(config);
  const tokenIds = meta.map((m) => m.token_id);

  // Batch midpoints (POST [{token_id}] → { id: "0.x" }).
  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenIds.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);

  // Batch best bid/ask (POST [{token_id,side}] → { id: {BUY, SELL} }).
  const priceBody = tokenIds.flatMap((t) => [
    { token_id: t, side: 'BUY' },
    { token_id: t, side: 'SELL' },
  ]);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(priceBody),
  });

  // Resolve a midpoint per rung with a documented fallback chain — an illiquid /
  // near-settled rung often has NO live midpoint AND an empty book (no bid/ask),
  // leaving only a last trade. Priority: clob_midpoint → bid_ask_mean → single side
  // → last_trade → skip (no usable price). raw_inputs records the RESOLVED midpoint
  // plus its `midpoint_source` (and `last_trade_price` when used) for honest
  // provenance; those extra fields are deliberately NOT in canonicalizeRawInputs, so
  // the hash recipe — and the frozen SpaceX hash — are untouched (the resolved
  // midpoint VALUE is what's hashed). Skipped rungs are excluded from raw_inputs AND
  // the ladder, and surfaced via midpoint_fallback → confidence. See gotchas.md.
  const resolved = meta.map((m) => ({ m, ...resolveFromBook(midRaw[m.token_id], priceRaw[m.token_id] || {}) }));

  // Fetch last-trade ONLY for the no-book rungs (small N) — never on the normal path.
  const needers = resolved.filter((r) => r.needsLastTrade);
  const lastTrades = await Promise.all(
    needers.map(async (r) => [r.m.token_id, await fetchLastTradePrice(r.m.token_id)])
  );
  const lastTradeBy = new Map(lastTrades);

  const skippedThresholds = [];
  const lastTradeThresholds = [];
  const raw_inputs = [];
  for (const r of resolved) {
    if (r.needsLastTrade) {
      const price = lastTradeBy.get(r.m.token_id);
      if (price == null) { skippedThresholds.push(r.m.threshold); continue; } // truly no price → skip rung
      lastTradeThresholds.push(r.m.threshold);
      raw_inputs.push({
        token_id: r.m.token_id, threshold: r.m.threshold, midpoint: price,
        best_bid: null, best_ask: null, volume: r.m.volume,
        midpoint_source: 'last_trade', last_trade_price: price,
      });
    } else {
      raw_inputs.push({
        token_id: r.m.token_id, threshold: r.m.threshold, midpoint: r.midpoint,
        best_bid: r.best_bid, best_ask: r.best_ask, volume: r.m.volume,
        midpoint_source: r.midpoint_source,
      });
    }
  }

  if (raw_inputs.length === 0) {
    throw new Error(`No usable price for any rung of ${config ? config.event_slug : EVENT_SLUG}`);
  }

  const labelByToken = new Map(meta.map((m) => [m.token_id, m.label]));
  const markets = raw_inputs.map((r) => ({
    label: labelByToken.get(r.token_id),
    threshold: r.threshold,
    prob: parseFloat(r.midpoint),
    volume: r.volume,
  }));

  // Fallback signal for confidence (empty/zero on the normal path → no effect, so
  // SpaceX's frozen confidence is unchanged).
  const midpoint_fallback = {
    lastTradeCount: lastTradeThresholds.length,
    lastTradeThresholds,
    skippedCount: skippedThresholds.length,
    skippedThresholds,
  };

  // Side channel for anomaly detection + lifecycle classification (closed /
  // inactive / not accepting orders / UMA resolution / settled outcome).
  // Deliberately excluded from raw_inputs so the provenance hash recipe is stable.
  const status = meta.map((m) => ({
    threshold: m.threshold,
    closed: m.closed,
    active: m.active,
    accepting_orders: m.accepting_orders,
    umaResolutionStatus: m.uma_resolution_status,
    outcomes: m.outcomes,
    outcomePrices: m.outcome_prices,
  }));

  return {
    fetched_at: fetchedAt,
    endpoints: [config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma, ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    markets,
    status,
    midpoint_fallback,
    // Windowed volume (Increment 1) — null on a frozen/price-only replay (legs lack the fields)
    // → derived.liquidity omitted → SpaceX parity byte-identical. by_threshold keyed by rung.
    liquidity: aggregateLiquidity(meta, (l) => l.threshold),
  };
}

// ── BINARY (single Yes/No) market support (Phase 2) ──────────────────────────
// A binary EVENT has exactly ONE market with outcomes ["Yes","No"]; a ladder event
// has many threshold legs. Detection MUST happen before any threshold parsing,
// because fetchMarketMeta throws "Cannot parse threshold" on a non-`$` leg question
// — so classifyMarketKind never parses; it classifies from the event shape only.

/** Pure classifier from an event's markets[]:
 *   'binary'      — one Yes/No leg;
 *   'ladder'      — multi-leg AND the first leg's question carries a numeric $threshold;
 *   'categorical' — multi-leg with non-numeric outcomes (Fed cuts, next Chancellor, …)
 *                   the threshold pipeline can't process. Returning this (instead of
 *                   letting fetchMarketMeta throw "Cannot parse threshold") keeps the raw
 *                   parser error off the UI — computeMarketRecord turns it into a friendly
 *                   "not supported" message. Binary detection (length === 1) is unaffected. */
export function kindFromMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Gamma event contained no markets');
  if (markets.length === 1) return 'binary';
  return THRESHOLD_RE.test(markets[0]?.question ?? '') ? 'ladder' : 'categorical';
}

// A "(LOW)"/"(HIGH)" qualifier marks a directional TOUCH leg (P(price touches a level
// before expiry), not a settlement value). A "between X and Y" leg marks a bucket PMF
// (disjoint intervals). Neither is a survival curve, so both must route away from the
// ladder math (see MARKET-TYPES-PLAN.md).
const TOUCH_RE = /\((?:LOW|HIGH)\)/;
const BUCKET_RE = /\bbetween\b/i;

/** Finer shape of a MULTI-LEG event, classified from question text only (no CLOB):
 *   'directional_touch' — any leg is a "(LOW)/(HIGH) hit $X" touch market (WTI, Silver);
 *   'bucket_pmf'        — any leg is a "between $X and $Y" interval bucket (Bitcoin,
 *                         Anthropic IPO) — a PMF, possibly with one categorical leg;
 *   'survival'          — nested "above $X" legs that ARE a P(>X) curve (SpaceX);
 *   'categorical'       — multi-leg with no numeric $ threshold at all.
 * Detection order matters: touch and bucket are checked before survival because their
 * legs also contain a `$`. */
export function ladderShapeFromMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Gamma event contained no markets');
  const questions = markets.map((m) => m?.question ?? '');
  if (questions.some((qn) => TOUCH_RE.test(qn))) return 'directional_touch';
  if (questions.some((qn) => BUCKET_RE.test(qn))) return 'bucket_pmf';
  if (questions.some((qn) => THRESHOLD_RE.test(qn))) return 'survival';
  return 'categorical';
}

/** 'binary' | 'ladder' | 'categorical'. One gamma GET, no threshold parsing. */
export async function classifyMarketKind(slug) {
  const events = await fetchJson(gammaUrl(slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  return kindFromMarkets(events[0].markets);
}

/** The FINE market shape used for compute routing (computeMarketRecord):
 *   'binary' | 'survival' | 'bucket_pmf' | 'directional_touch' | 'categorical'.
 *  kindFromMarkets/classifyMarketKind keep the coarse binary|ladder|categorical contract
 *  (binary gate + existing tests); this refines the 'ladder' bucket into the three real
 *  multi-leg structures so each routes to its own pipeline. */
export function marketShapeFromMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Gamma event contained no markets');
  if (markets.length === 1) return 'binary';
  return ladderShapeFromMarkets(markets);
}

/** Fine shape from a slug. One gamma GET, no threshold parsing. */
export async function classifyMarketShape(slug) {
  const events = await fetchJson(gammaUrl(slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  return marketShapeFromMarkets(events[0].markets);
}

/** The single Yes/No market's metadata — NO threshold parsing (the binary question
 *  has none). Returns the YES/NO token ids + resolution signals + display fields. */
export async function fetchBinaryMeta(config = null) {
  const url = config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma;
  const events = await fetchJson(url);
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  const ev = events[0];
  const m = (ev.markets || [])[0];
  if (!m) throw new Error('Gamma binary event contained no market');
  const ids = parseClobTokenIds(m);
  if (!ids) {
    // A binary has ONE leg — a missing order book can't be skipped, so surface a clean 404-class
    // error (integer code → statusFor maps it to 404) instead of crashing on ids[0] (a 500).
    const e = new Error(`Binary market "${config?.event_slug ?? m.question}" has no tradeable order book`);
    e.code = 404;
    throw e;
  }
  return {
    title: ev.title ?? m.question ?? config?.event_slug,
    question: m.question,
    end_date: ev.endDate ?? null,
    yes_token: ids[0], // YES
    no_token: ids[1], // NO
    volume: m.volume != null ? Number(m.volume) : null,
    ...legWindowed(m), // windowed volume — supplementary, never hashed
    closed: m.closed === true,
    active: m.active !== false,
    accepting_orders: m.acceptingOrders !== false,
    uma_resolution_status: m.umaResolutionStatus ?? null,
    outcomes: m.outcomes ?? null,
    outcome_prices: m.outcomePrices ?? null,
  };
}

/** Gamma-only lifecycle signal for a binary market (no CLOB; threshold 1 = the single
 *  Yes/No leg). Mirrors fetchEventStatus's shape so classifyLifecycle is reusable. */
export async function fetchBinaryStatus(config = null) {
  const meta = await fetchBinaryMeta(config);
  return [{
    threshold: 1,
    closed: meta.closed,
    active: meta.active,
    accepting_orders: meta.accepting_orders,
    umaResolutionStatus: meta.uma_resolution_status,
    outcomes: meta.outcomes,
    outcomePrices: meta.outcome_prices,
  }];
}

/**
 * Live binary snapshot. probability = the RESOLVED YES midpoint (Phase-1 fallback
 * chain applies per token, incl. last_trade). raw_inputs carries BOTH sides using a
 * SYNTHETIC threshold as the canonical sort key (1=YES, 0=NO) so canonicalizeRawInputs
 * — and the hash recipe — are reused UNCHANGED (same recipe, binary content).
 */
export async function fetchBinarySnapshot(config = null) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchBinaryMeta(config);
  const tokens = [meta.yes_token, meta.no_token];

  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.flatMap((t) => [{ token_id: t, side: 'BUY' }, { token_id: t, side: 'SELL' }])),
  });

  // threshold 1 = YES, 0 = NO — synthetic, only a stable canonical sort key.
  const sides = [
    { token: meta.yes_token, threshold: 1 },
    { token: meta.no_token, threshold: 0 },
  ].map((s) => ({ ...s, ...resolveFromBook(midRaw[s.token], priceRaw[s.token] || {}) }));

  const lastTradeThresholds = [];
  const skippedThresholds = [];
  const raw_inputs = [];
  for (const s of sides) {
    let { midpoint, midpoint_source, best_bid, best_ask } = s;
    let last_trade_price;
    if (s.needsLastTrade) {
      midpoint = await fetchLastTradePrice(s.token);
      if (midpoint == null) { skippedThresholds.push(s.threshold); continue; }
      midpoint_source = 'last_trade';
      last_trade_price = midpoint;
      lastTradeThresholds.push(s.threshold);
    }
    raw_inputs.push({
      token_id: s.token, threshold: s.threshold, midpoint,
      best_bid: best_bid ?? null, best_ask: best_ask ?? null, volume: meta.volume,
      midpoint_source, ...(last_trade_price != null ? { last_trade_price } : {}),
    });
  }

  const yes = raw_inputs.find((r) => r.threshold === 1);
  if (!yes) throw new Error(`No usable YES price for binary market ${config ? config.event_slug : meta.question}`);
  const no = raw_inputs.find((r) => r.threshold === 0);

  return {
    fetched_at: fetchedAt,
    endpoints: [config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma, ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    probability: parseFloat(yes.midpoint),
    probability_no: no ? parseFloat(no.midpoint) : null,
    total_volume: meta.volume ?? 0,
    liquidity: aggregateLiquidity([{ volume: meta.volume, volume_24hr: meta.volume_24hr, volume_1wk: meta.volume_1wk, book_depth: meta.book_depth }]),
    title: meta.title,
    end_date: meta.end_date,
    yes_best_bid: yes.best_bid,
    yes_best_ask: yes.best_ask,
    status: [{
      threshold: 1, closed: meta.closed, active: meta.active, accepting_orders: meta.accepting_orders,
      umaResolutionStatus: meta.uma_resolution_status, outcomes: meta.outcomes, outcomePrices: meta.outcome_prices,
    }],
    midpoint_fallback: {
      lastTradeCount: lastTradeThresholds.length, lastTradeThresholds,
      skippedCount: skippedThresholds.length, skippedThresholds,
    },
  };
}

// ── BUCKET-PMF (interval) market support ─────────────────────────────────────
// A bucket event prices DISJOINT value intervals ("between $X and $Y", "less than $X",
// "$Y or greater") whose YES prices form a PMF — NOT a survival ladder. We parse each leg
// to an interval (core/bucket.parseBucketLeg, dropping any non-$ categorical leg such as
// "Will X not IPO …"), de-vig the PMF to sum to 1, then DERIVE the survival curve P(>X) so
// the existing ladder math/record/detail all apply. Thresholds are stored as mantissas in
// the ladder's own derived unit (core/money.deriveUnit), exactly like SpaceX stores "1.8"
// for $1.8T — so labels/median/mean read in the market's denomination, fixing Bugs 1/2/4.

/** Gamma event → { title, end_date, unit, legs[] } where each leg is a parseable bucket
 *  (lo/hi absolute $, YES token, volume, resolution signals). Non-$ legs are excluded. */
export async function fetchBucketMeta(config) {
  const events = await fetchJson(gammaUrl(config.event_slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  const ev = events[0];
  const all = Array.isArray(ev.markets) ? ev.markets : [];
  const legs = all.map((m) => {
    const interval = parseBucketLeg(m.question);
    if (!interval) return null; // categorical leg (no $ amount) — excluded from the PMF
    const ids = parseClobTokenIds(m);
    if (!ids) return null; // untraded/placeholder rung (no order book) — skip, don't crash on ids[0]
    return {
      lo: interval.lo, hi: interval.hi, unit: interval.unit, token_id: ids[0],
      volume: m.volume != null ? Number(m.volume) : null,
      ...legWindowed(m), // windowed volume — supplementary, never hashed
      closed: m.closed === true, active: m.active !== false, accepting_orders: m.acceptingOrders !== false,
      uma_resolution_status: m.umaResolutionStatus ?? null, outcomes: m.outcomes ?? null, outcome_prices: m.outcomePrices ?? null,
    };
  }).filter(Boolean).sort((a, b) => a.lo - b.lo);
  if (legs.length < 2) throw new Error(`Bucket event ${config.event_slug} has <2 parseable buckets`);
  // Percentage-denominated buckets (UK GDP growth) bypass the dollar T/B/M/K scale — the mantissa IS
  // the percent (divisor 1, prefix ''); T/B/M/K don't apply to percentages.
  const isPercent = legs.some((l) => l.unit === '%');
  const absVals = legs.flatMap((l) => [l.lo, l.hi]).filter((v) => Number.isFinite(v) && v > 0);
  const unitInfo = isPercent ? { unit: '%', divisor: 1 } : deriveUnit(absVals);
  return { title: ev.title ?? config.event_slug, end_date: ev.endDate ?? null, unitInfo, excludedCount: all.length - legs.length, legs };
}

/** Gamma-only lifecycle signal for a bucket market (no CLOB; threshold = bucket index). */
export async function fetchBucketStatus(config) {
  const meta = await fetchBucketMeta(config);
  return meta.legs.map((l, i) => ({
    threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
    umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
  }));
}

/**
 * Live bucket-PMF snapshot. Resolves each bucket's YES midpoint (Phase-1 fallback chain),
 * de-vigs the PMF, derives the survival ladder + PMF mean. raw_inputs carry the OBSERVED
 * per-bucket midpoint (threshold = bucket lower bound in mantissa units) — same hash recipe
 * (canonicalizeRawInputs unchanged); only the content differs. Returns a fetchLiveSnapshot-
 * shaped object (markets = derived survival rungs) plus { unit, pmf_mean, total_volume, … }.
 */
export async function fetchBucketPmfSnapshot(config) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchBucketMeta(config);
  const { divisor, unit } = meta.unitInfo;
  const prefix = unit === '%' ? '' : '$'; // percent labels read "2%"; dollar labels read "$1.8T"
  const tokens = meta.legs.map((l) => l.token_id);

  // An open-bottom bucket (percent "below 0%") has lo = -Infinity, which can't be a finite hash key.
  // Give it a synthetic FLOOR one median-bucket-width below the lowest finite lower bound (mirroring
  // dollars' natural 0 floor), so its raw_input threshold is finite, unique, sorts first, and
  // canonicalizes cleanly. Only ever fires for an open-bottom bucket → dollar markets are unaffected.
  const finiteLos = meta.legs.map((l) => l.lo).filter(Number.isFinite);
  const minFiniteLo = finiteLos.length ? Math.min(...finiteLos) : 0;
  const finiteWidths = meta.legs.filter((l) => Number.isFinite(l.lo) && Number.isFinite(l.hi)).map((l) => l.hi - l.lo).sort((a, b) => a - b);
  const medianWidth = finiteWidths.length ? finiteWidths[Math.floor(finiteWidths.length / 2)] : 1;
  const syntheticFloor = minFiniteLo - medianWidth;
  const loKey = (lo) => (Number.isFinite(lo) ? lo : syntheticFloor) / divisor;

  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.flatMap((t) => [{ token_id: t, side: 'BUY' }, { token_id: t, side: 'SELL' }])),
  });

  // Resolve each bucket's YES price with the shared fallback chain (last-trade for a dead book).
  const resolved = meta.legs.map((l) => ({ l, ...resolveFromBook(midRaw[l.token_id], priceRaw[l.token_id] || {}) }));
  const needers = resolved.filter((r) => r.needsLastTrade);
  const lastTradeBy = new Map(await Promise.all(needers.map(async (r) => [r.l.token_id, await fetchLastTradePrice(r.l.token_id)])));

  const lastTradeThresholds = [];
  const skippedThresholds = [];
  const priced = []; // { l, prob (number), midpoint (string), best_bid, best_ask }
  for (const r of resolved) {
    let midpoint = r.midpoint, source = r.midpoint_source, best_bid = r.best_bid ?? null, best_ask = r.best_ask ?? null;
    if (r.needsLastTrade) {
      midpoint = lastTradeBy.get(r.l.token_id);
      if (midpoint == null) { skippedThresholds.push(loKey(r.l.lo)); continue; }
      source = 'last_trade'; lastTradeThresholds.push(loKey(r.l.lo));
    }
    priced.push({ l: r.l, prob: parseFloat(midpoint), midpoint, source, best_bid, best_ask });
  }
  if (priced.length < 2) throw new Error(`No usable prices for bucket event ${config.event_slug}`);

  // De-vig: normalize the observed PMF mass to sum to 1 (overround removed). The OBSERVED
  // midpoint stays in raw_inputs (provenance); the normalized prob feeds the derived curve.
  const probSum = priced.reduce((s, p) => s + (Number.isFinite(p.prob) ? p.prob : 0), 0);
  const norm = probSum > 0 ? probSum : 1;

  const raw_inputs = priced.map((p) => ({
    token_id: p.l.token_id, threshold: loKey(p.l.lo), midpoint: p.midpoint,
    best_bid: p.best_bid, best_ask: p.best_ask, volume: p.l.volume,
    ...(p.source === 'last_trade' ? { midpoint_source: 'last_trade', last_trade_price: p.midpoint } : { midpoint_source: p.source }),
  }));

  // PMF in mantissa units → derived survival ladder + PMF mean.
  const pmfLegs = priced.map((p) => ({ lo: loKey(p.l.lo), hi: Number.isFinite(p.l.hi) ? p.l.hi / divisor : Infinity, prob: p.prob / norm }));
  const { markets: survival, mean: pmfMean } = buildPmfLadder(pmfLegs);

  // Per-boundary volume = the bucket starting at that boundary (for the liquidity signal).
  const volByLo = new Map(priced.map((p) => [loKey(p.l.lo), p.l.volume ?? 0]));
  const markets = survival.map((m) => ({
    label: `>${prefix}${m.threshold}${unit}`, threshold: m.threshold, prob: m.prob, volume: volByLo.get(m.threshold) ?? 0,
  }));

  const status = meta.legs.map((l, i) => ({
    threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
    umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
  }));

  return {
    fetched_at: fetchedAt,
    endpoints: [gammaUrl(config.event_slug), ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs, raw_sha256: hashRawInputs(raw_inputs), markets, status,
    midpoint_fallback: { lastTradeCount: lastTradeThresholds.length, lastTradeThresholds, skippedCount: skippedThresholds.length, skippedThresholds },
    unit, pmf_mean: pmfMean, total_volume: priced.reduce((s, p) => s + (p.l.volume ?? 0), 0),
    liquidity: aggregateLiquidity(meta.legs, (l) => loKey(l.lo)), // by_threshold keyed by derived rung
    title: meta.title, end_date: meta.end_date, excluded_count: meta.excludedCount,
  };
}

// ── DIRECTIONAL-TOUCH market support ─────────────────────────────────────────
// WTI/Silver "(LOW)/(HIGH) hit $X" markets price P(price touches a level before expiry),
// NOT a settlement value. There is no survival curve / implied median. We parse HIGH legs
// (P touch ≥ X) and LOW legs (P touch ≤ X) as SEPARATE series and derive the implied range
// from their 50% crossovers (core/touch.js). raw_inputs use a SIGNED synthetic threshold
// (+level for HIGH, −level for LOW, mantissa units) so canonicalizeRawInputs stays UNCHANGED
// and deterministic (mirrors binary's 1=YES/0=NO trick). See MARKET-TYPES-PLAN.md.

/** Gamma event → { title, end_date, unitInfo, legs[] } of parseable touch legs. */
export async function fetchTouchMeta(config) {
  const events = await fetchJson(gammaUrl(config.event_slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  const ev = events[0];
  const all = Array.isArray(ev.markets) ? ev.markets : [];
  const legs = all.map((m) => {
    const t = parseTouchLeg(m.question);
    if (!t) return null;
    const ids = parseClobTokenIds(m);
    if (!ids) return null; // untraded/placeholder rung (e.g. gold "hit (HIGH) $5,000") — skip, don't crash
    return {
      side: t.side, level: t.level, token_id: ids[0],
      volume: m.volume != null ? Number(m.volume) : null,
      ...legWindowed(m), // windowed volume — supplementary, never hashed
      closed: m.closed === true, active: m.active !== false, accepting_orders: m.acceptingOrders !== false,
      uma_resolution_status: m.umaResolutionStatus ?? null, outcomes: m.outcomes ?? null, outcome_prices: m.outcomePrices ?? null,
    };
  }).filter(Boolean);
  if (legs.length < 2) throw new Error(`Touch event ${config.event_slug} has <2 parseable legs`);
  return { title: ev.title ?? config.event_slug, end_date: ev.endDate ?? null, unitInfo: deriveUnit(legs.map((l) => l.level)), legs };
}

/** Gamma-only lifecycle signal for a touch market (no CLOB; threshold = leg index). */
export async function fetchTouchStatus(config) {
  const meta = await fetchTouchMeta(config);
  return meta.legs.map((l, i) => ({
    threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
    umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
  }));
}

/**
 * Live directional-touch snapshot. Resolves each leg's YES (touch) midpoint, splits into
 * HIGH/LOW series (levels in the ladder's derived mantissa unit), and derives the implied
 * range from the 50% crossovers. raw_inputs use signed synthetic thresholds for a stable hash.
 */
export async function fetchTouchSnapshot(config) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchTouchMeta(config);
  const { divisor, unit } = meta.unitInfo;
  const tokens = meta.legs.map((l) => l.token_id);

  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.flatMap((t) => [{ token_id: t, side: 'BUY' }, { token_id: t, side: 'SELL' }])),
  });

  const resolved = meta.legs.map((l) => ({ l, ...resolveFromBook(midRaw[l.token_id], priceRaw[l.token_id] || {}) }));
  const needers = resolved.filter((r) => r.needsLastTrade);
  const lastTradeBy = new Map(await Promise.all(needers.map(async (r) => [r.l.token_id, await fetchLastTradePrice(r.l.token_id)])));

  const lastTradeThresholds = [];
  const skippedThresholds = [];
  const raw_inputs = [];
  const high = [];
  const low = [];
  for (const r of resolved) {
    let midpoint = r.midpoint, source = r.midpoint_source, best_bid = r.best_bid ?? null, best_ask = r.best_ask ?? null;
    const lvl = r.l.level / divisor; // mantissa level
    const signed = (r.l.side === 'HIGH' ? 1 : -1) * lvl; // unique signed key for the hash
    if (r.needsLastTrade) {
      midpoint = lastTradeBy.get(r.l.token_id);
      if (midpoint == null) { skippedThresholds.push(signed); continue; }
      source = 'last_trade'; lastTradeThresholds.push(signed);
    }
    raw_inputs.push({
      token_id: r.l.token_id, threshold: signed, midpoint, best_bid, best_ask, volume: r.l.volume,
      ...(source === 'last_trade' ? { midpoint_source: 'last_trade', last_trade_price: midpoint } : { midpoint_source: source }),
    });
    (r.l.side === 'HIGH' ? high : low).push({ level: lvl, prob: parseFloat(midpoint), volume: r.l.volume ?? 0 });
  }
  if (high.length + low.length < 2) throw new Error(`No usable prices for touch event ${config.event_slug}`);
  high.sort((a, b) => a.level - b.level);
  low.sort((a, b) => a.level - b.level);

  return {
    fetched_at: fetchedAt,
    endpoints: [gammaUrl(config.event_slug), ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs, raw_sha256: hashRawInputs(raw_inputs),
    high_series: high, low_series: low, implied_range: impliedRange(high, low),
    unit, total_volume: meta.legs.reduce((s, l) => s + (l.volume ?? 0), 0),
    liquidity: aggregateLiquidity(meta.legs),
    status: meta.legs.map((l, i) => ({
      threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
      umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
    })),
    midpoint_fallback: { lastTradeCount: lastTradeThresholds.length, lastTradeThresholds, skippedCount: skippedThresholds.length, skippedThresholds },
    title: meta.title, end_date: meta.end_date,
    yes_best_bid: null, yes_best_ask: null,
  };
}

// ── CATEGORICAL (named-outcome) market support ───────────────────────────────
// A categorical event ("How many Fed rate cuts in 2026?", "Next Chancellor") is N
// mutually-exclusive Yes/No legs whose YES midpoints form a PMF over NAMED outcomes —
// no numeric ordering, no CDF (forcing a threshold parse here is exactly what the 422 gate
// avoided). We resolve each leg's YES midpoint (Phase-1 fallback chain), keep the OBSERVED
// midpoints in raw_inputs (threshold = leg index, a stable canonical sort key — same hash
// recipe), and hand the leg distribution to core/categorical for de-vig + entropy + dominant.

/** Gamma event → { title, end_date, legs[] } where each leg = a named outcome (label from
 *  groupItemTitle, else the question) with its YES token + resolution signals. */
export async function fetchCategoricalMeta(config) {
  const events = await fetchJson(gammaUrl(config.event_slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  const ev = events[0];
  const all = Array.isArray(ev.markets) ? ev.markets : [];
  if (all.length < 2) throw new Error(`Categorical event ${config.event_slug} has <2 outcomes`);
  const legs = all.map((m) => {
    const ids = parseClobTokenIds(m);
    if (!ids) return null; // untraded/placeholder outcome (no order book) — skip, don't crash on ids[0]
    return {
      label: (m.groupItemTitle != null && String(m.groupItemTitle).trim()) || m.question,
      token_id: ids[0], // YES
      volume: m.volume != null ? Number(m.volume) : null,
      ...legWindowed(m), // windowed volume — supplementary, never hashed
      closed: m.closed === true, active: m.active !== false, accepting_orders: m.acceptingOrders !== false,
      uma_resolution_status: m.umaResolutionStatus ?? null, outcomes: m.outcomes ?? null, outcome_prices: m.outcomePrices ?? null,
    };
  }).filter(Boolean);
  return { title: ev.title ?? config.event_slug, end_date: ev.endDate ?? null, legs };
}

/** Gamma-only lifecycle signal for a categorical market (no CLOB; threshold = leg index). */
export async function fetchCategoricalStatus(config) {
  const meta = await fetchCategoricalMeta(config);
  return meta.legs.map((l, i) => ({
    threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
    umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
  }));
}

/**
 * Live categorical snapshot. Resolves each outcome's YES midpoint (Phase-1 fallback chain,
 * incl. last_trade), keeping the OBSERVED midpoint in raw_inputs (threshold = leg index) so
 * canonicalizeRawInputs — and the hash recipe — are reused UNCHANGED. De-vig/entropy happen
 * downstream in core/categorical (the RAW midpoints are never normalized into raw_inputs).
 */
export async function fetchCategoricalSnapshot(config) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchCategoricalMeta(config);
  const tokens = meta.legs.map((l) => l.token_id);

  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.flatMap((t) => [{ token_id: t, side: 'BUY' }, { token_id: t, side: 'SELL' }])),
  });

  const resolved = meta.legs.map((l) => ({ l, ...resolveFromBook(midRaw[l.token_id], priceRaw[l.token_id] || {}) }));
  const needers = resolved.filter((r) => r.needsLastTrade);
  const lastTradeBy = new Map(await Promise.all(needers.map(async (r) => [r.l.token_id, await fetchLastTradePrice(r.l.token_id)])));

  const lastTradeThresholds = [];
  const skippedThresholds = [];
  const raw_inputs = [];
  const outcomes = [];
  resolved.forEach((r, i) => {
    let midpoint = r.midpoint, source = r.midpoint_source, best_bid = r.best_bid ?? null, best_ask = r.best_ask ?? null;
    let last_trade_price;
    if (r.needsLastTrade) {
      midpoint = lastTradeBy.get(r.l.token_id);
      if (midpoint == null) { skippedThresholds.push(i); return; }
      source = 'last_trade'; last_trade_price = midpoint; lastTradeThresholds.push(i);
    }
    raw_inputs.push({
      token_id: r.l.token_id, threshold: i, midpoint, best_bid, best_ask, volume: r.l.volume,
      midpoint_source: source, ...(last_trade_price != null ? { last_trade_price } : {}),
    });
    outcomes.push({ label: r.l.label, prob: parseFloat(midpoint), volume: r.l.volume, midpoint_source: source, best_bid, best_ask });
  });
  if (outcomes.length < 2) throw new Error(`No usable prices for categorical event ${config.event_slug}`);

  return {
    fetched_at: fetchedAt,
    endpoints: [gammaUrl(config.event_slug), ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    outcomes,
    total_volume: meta.legs.reduce((s, l) => s + (l.volume ?? 0), 0),
    liquidity: aggregateLiquidity(meta.legs),
    title: meta.title,
    end_date: meta.end_date,
    status: meta.legs.map((l, i) => ({
      threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
      umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
    })),
    midpoint_fallback: {
      lastTradeCount: lastTradeThresholds.length, lastTradeThresholds,
      skippedCount: skippedThresholds.length, skippedThresholds,
    },
  };
}

/**
 * Gamma-only per-rung lifecycle signals (no CLOB). Safe to call on a RESOLVED
 * market, which returns no midpoints — so classification must happen from THIS,
 * before any price fetch (ARCHITECTURE §5). Returns the camelCase shape the
 * lifecycle classifier consumes.
 */
export async function fetchEventStatus(config = null) {
  const meta = await fetchMarketMeta(config);
  return meta.map((m) => ({
    threshold: m.threshold,
    closed: m.closed,
    active: m.active,
    accepting_orders: m.accepting_orders,
    umaResolutionStatus: m.uma_resolution_status,
    outcomes: m.outcomes,
    outcomePrices: m.outcome_prices,
  }));
}

/** Count markets that are closed, inactive, or not accepting orders. */
export function countClosed(status) {
  if (!status) return 0;
  return status.filter((s) => s.closed || !s.active || !s.accepting_orders).length;
}
