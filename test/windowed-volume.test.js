// test/windowed-volume.test.js — Increment 1: windowed (recent) volume.
//
// All-time cumulative volume is a poor liquidity proxy (a dormant market reads identical to an
// active one). Gamma exposes volume24hr / volume1wk per leg; we aggregate them into a supplementary
// derived.liquidity object (NEVER into raw_inputs / the hash) and drive confidence off the recent
// window, falling back to all-time only when windowed data is absent. These cover the two pure
// functions + the scorer wiring; the omit-when-absent parity safety is covered by the SpaceX gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLiquidity } from '../core/fetch.js';
import { windowedVolumeSignal as winSig, bookDepthSignal as depthSig, scoreConfidence } from '../core/confidence.js';

// ── windowedVolumeSignal (the calibrated tiers) ──────────────────────────────
test('windowedVolumeSignal: HIGH at 24h ≥ $50K or 7d ≥ $200K', () => {
  assert.equal(winSig({ volume_24hr: 50_000, volume_1wk: 0 }).tier, 'high');       // Fed/SpaceX/Silver
  assert.equal(winSig({ volume_24hr: 6_000, volume_1wk: 551_000 }).tier, 'high');  // Silver via 7d
  assert.equal(winSig({ volume_24hr: 50_000, volume_1wk: 0 }).reason, null);       // HIGH carries no caveat
});

test('windowedVolumeSignal: MEDIUM at 24h ≥ $5K or 7d ≥ $25K', () => {
  const m = winSig({ volume_24hr: 6_000, volume_1wk: 20_000 });
  assert.equal(m.tier, 'medium');
  assert.match(m.reason, /moderate 24h volume \(\$6,000\)/);
});

test('windowedVolumeSignal: MEDIUM via 7d-only names "7d" in the reason, not a $0-24h "24h"', () => {
  // 24h is present but BELOW the medium floor (didn't qualify); 7d alone crosses it. The reason
  // must name the window that actually earned the tier — not just whichever field is present.
  const via7 = winSig({ volume_24hr: 0, volume_1wk: 30_000 });
  assert.equal(via7.tier, 'medium');
  assert.match(via7.reason, /moderate 7d volume \(\$30,000\)/);
  assert.doesNotMatch(via7.reason, /24h/);
});

test('windowedVolumeSignal: MEDIUM via BOTH windows still prefers 24h (unchanged default)', () => {
  const both = winSig({ volume_24hr: 5_500, volume_1wk: 30_000 });
  assert.equal(both.tier, 'medium');
  assert.match(both.reason, /moderate 24h volume \(\$5,500\)/);
});

test('windowedVolumeSignal: LOW catches the dormant-but-historically-traded market', () => {
  // US recession: $478/24h, $16K/7d — thin recently despite a $1.6M all-time total.
  const l = winSig({ volume_24hr: 478, volume_1wk: 16_071 });
  assert.equal(l.tier, 'low');
  assert.match(l.reason, /thin 24h volume \(\$478\)/);
  // Connecticut primary: $0/$0 — also LOW.
  assert.equal(winSig({ volume_24hr: 0, volume_1wk: 0 }).tier, 'low');
});

// H2: the MEDIUM-tier naming fix (250e4af, "name whichever window ACTUALLY earned it") was never
// carried to LOW — LOW named the window by mere presence (`v24 != null ? '24h' : '7d'`), so a
// present-but-exactly-zero 24h figure beside a real (if sub-threshold) 7d number reported the
// misleading "$0" instead of the more representative week-long figure.
test('windowedVolumeSignal: LOW qualified via 7d window (24h present but zero) names "7d", not "24h"', () => {
  // 24h is present but genuinely zero (no trades today); 7d has real, if sub-threshold, activity.
  const via7 = winSig({ volume_24hr: 0, volume_1wk: 20_000 });
  assert.equal(via7.tier, 'low');
  assert.match(via7.reason, /thin 7d volume \(\$20,000\)/);
  assert.doesNotMatch(via7.reason, /24h/);
});

test('windowedVolumeSignal: LOW with a real nonzero 24h figure still prefers 24h (unchanged)', () => {
  // Regression-lock: the US-recession case above (v24=478, both present) must still name 24h — the
  // fix only changes the EXACTLY-ZERO-24h case, not "24h present and genuinely informative".
  const via24 = winSig({ volume_24hr: 478, volume_1wk: 16_071 });
  assert.match(via24.reason, /thin 24h volume \(\$478\)/);
});

test('windowedVolumeSignal: just-over-the-line Anthropic is HIGH (24h $51,666 ≥ $50K)', () => {
  assert.equal(winSig({ volume_24hr: 51_666, volume_1wk: 220_614 }).tier, 'high');
});

test('F1: a STALE 7d spike on a now-dormant market does NOT read HIGH (24h floor $2K)', () => {
  // v7 ≥ $200K but 24h is dead → the floor blocks HIGH; it reads MEDIUM (still ≥ $25K/7d).
  assert.equal(winSig({ volume_24hr: 0, volume_1wk: 250_000 }).tier, 'medium');
  assert.equal(winSig({ volume_24hr: 1_999, volume_1wk: 250_000 }).tier, 'medium'); // just below the floor
  // a live market clearing the $2K floor keeps its 7d-driven HIGH (boundary).
  assert.equal(winSig({ volume_24hr: 2_000, volume_1wk: 250_000 }).tier, 'high'); // exactly at the floor
  assert.equal(winSig({ volume_24hr: 6_000, volume_1wk: 551_000 }).tier, 'high'); // Silver: $6K ≥ floor
  // the 24h≥$50K path is unaffected by the floor.
  assert.equal(winSig({ volume_24hr: 60_000, volume_1wk: 0 }).tier, 'high');
});

test('windowedVolumeSignal: null when no windowed data (drives the all-time fallback + parity safety)', () => {
  assert.equal(winSig(null), null);
  assert.equal(winSig({ volume_24hr: null, volume_1wk: null }), null);
  assert.equal(winSig({}), null);
});

// ── aggregateLiquidity (sum-of-legs == event aggregate, verified vs gamma) ────
test('aggregateLiquidity: sums per-leg windowed + all-time; builds the by_threshold map', () => {
  const legs = [
    { threshold: 1.8, volume: 1000, volume_24hr: 300, volume_1wk: 700 },
    { threshold: 2.0, volume: 2000, volume_24hr: 200, volume_1wk: 800 },
  ];
  const liq = aggregateLiquidity(legs, (l) => l.threshold);
  assert.equal(liq.volume_24hr, 500);
  assert.equal(liq.volume_1wk, 1500);
  assert.equal(liq.volume_all, 3000);
  assert.deepEqual(liq.by_threshold, { 1.8: 300, 2.0: 200 });
});

test('aggregateLiquidity: null when NO leg carries windowed data (omit-when-absent → parity)', () => {
  assert.equal(aggregateLiquidity([{ threshold: 1, volume: 5000 }]), null); // all-time only (frozen replay)
  assert.equal(aggregateLiquidity([]), null);
  assert.equal(aggregateLiquidity(null), null);
});

// ── scoreConfidence wiring (present caps/raises tier; absent is byte-identical) ──
function ladder(n) { return Array.from({ length: n }, (_, i) => ({ threshold: i, prob: 0.5, adjusted_prob: 0.5 })); }

test('scoreConfidence (split): thin recent volume drags LIQUIDITY to LOW but leaves RELIABILITY HIGH', () => {
  // The CT-Governor fix at the unit level: an otherwise-clean ladder (full, monotonic, tight spread)
  // with near-zero recent volume is HIGH reliability (the number is trustworthy) + LOW liquidity (you
  // can't trade it) — no longer collapsed to a single misleading LOW.
  const base = { markets: ladder(16), rawInputs: ladder(16).map(() => ({ best_bid: '0.49', best_ask: '0.51' })) };
  const high = scoreConfidence({ ...base, windowedVolume: { volume_24hr: 80_000, volume_1wk: 300_000 } });
  const low = scoreConfidence({ ...base, windowedVolume: { volume_24hr: 100, volume_1wk: 1_000 } });
  assert.equal(high.liquidity.tier, 'high');
  assert.equal(low.liquidity.tier, 'low');
  // The split: thin recent volume is a LIQUIDITY signal — it no longer drags reliability.
  assert.equal(high.reliability.tier, 'high');
  assert.equal(low.reliability.tier, 'high');
  assert.ok(low.liquidity.reasons.some((r) => /thin 24h volume/.test(r)));
  assert.ok(low.liquidity.score < high.liquidity.score);
});

test('scoreConfidence: absent windowed volume leaves tier/score/reasons unchanged (parity safety)', () => {
  const base = { markets: ladder(16), rawInputs: ladder(16).map(() => ({ best_bid: '0.49', best_ask: '0.51' })) };
  const withNull = scoreConfidence({ ...base, windowedVolume: null });
  const without = scoreConfidence({ ...base });
  assert.deepEqual(withNull, without); // null windowed == omitted entirely
});

// ── Increment C: book depth (max per-leg gamma `liquidity`) ───────────────────
test('bookDepthSignal: HIGH ≥ $100K, MED ≥ $10K, LOW below; null when absent', () => {
  assert.equal(depthSig({ book_depth: 100_000 }).tier, 'high');
  assert.equal(depthSig({ book_depth: 100_000 }).reason, null);   // HIGH carries no caveat
  assert.equal(depthSig({ book_depth: 250_000 }).tier, 'high');
  const m = depthSig({ book_depth: 53_000 });
  assert.equal(m.tier, 'medium');
  assert.match(m.reason, /moderate order book \(\$53,000 depth\)/);
  const l = depthSig({ book_depth: 5_000 });
  assert.equal(l.tier, 'low');
  assert.match(l.reason, /thin order book \(\$5,000 depth\)/);
  assert.equal(depthSig(null), null);
  assert.equal(depthSig({ book_depth: null }), null); // omit-when-absent → parity safety
  assert.equal(depthSig({ volume_24hr: 999 }), null); // no depth field → null
});

test('aggregateLiquidity: book_depth is the DOMINANT-outcome (most-traded) leg depth, not a sum nor blind max; omit-when-absent', () => {
  const legs = [
    { volume: 100, book_depth: 20_000 },
    { volume: 900, book_depth: 60_000 },   // leader (most traded) → its book IS the headline depth
    { volume: 5,   book_depth: 999_000 },  // a deep book on an obscure longshot — must NOT win
  ];
  assert.equal(aggregateLiquidity(legs).book_depth, 60_000); // leader's book — not 999_000, not the sum
  // FALLBACK: the leader leg has no book → deepest available across legs
  assert.equal(aggregateLiquidity([{ volume: 900 }, { volume: 5, book_depth: 12_345 }]).book_depth, 12_345);
  // depth alone (no windowed) still yields an object (a live market with only a depth field)
  assert.equal(aggregateLiquidity([{ volume: 900, book_depth: 12_345 }]).book_depth, 12_345);
  // NO depth on any leg → key omitted entirely
  assert.equal('book_depth' in aggregateLiquidity([{ volume_24hr: 100 }]), false);
  // NOTHING present (windowed nor depth) → null (SpaceX frozen replay → omits derived.liquidity)
  assert.equal(aggregateLiquidity([{ volume: 5000 }]), null);
});

test('aggregateLiquidity: red-team F1 lock — a thin LEADER leg + a deep LONGSHOT leg reads the leader depth', () => {
  // The exact red-team repro: the headline outcome (most-traded, $900K vol) has a THIN $5K book; an
  // obscure longshot ($100 vol) rests a DEEP $200K book. book_depth must be the leader's $5K (so the
  // market reads liquidity LOW — you can't transact the headline at size), NOT the longshot's $200K.
  const legs = [
    { volume: 900_000, volume_24hr: 50_000, book_depth: 5_000 },   // leader — thin book
    { volume: 100,     volume_24hr: 0,      book_depth: 200_000 }, // longshot — deep book, irrelevant
  ];
  assert.equal(aggregateLiquidity(legs).book_depth, 5_000); // the headline leg's depth, not 200_000
  assert.equal(depthSig(aggregateLiquidity(legs)).tier, 'low'); // → LIQUIDITY LOW, not a false HIGH
});

test('scoreConfidence (worst-of): a thin book drags LIQUIDITY down despite HIGH recent volume', () => {
  const base = { markets: ladder(16), rawInputs: ladder(16).map(() => ({ best_bid: '0.49', best_ask: '0.51' })) };
  // $3M/24h volume (HIGH) but only a $5K book → can't actually transact at size → liquidity LOW.
  const thinBook = scoreConfidence({ ...base, windowedVolume: { volume_24hr: 3_000_000, volume_1wk: 9_000_000, book_depth: 5_000 } });
  const deepBook = scoreConfidence({ ...base, windowedVolume: { volume_24hr: 3_000_000, volume_1wk: 9_000_000, book_depth: 500_000 } });
  assert.equal(deepBook.liquidity.tier, 'high');
  assert.equal(thinBook.liquidity.tier, 'low'); // depth worst-of bites
  assert.ok(thinBook.liquidity.reasons.some((r) => /thin order book/.test(r)));
  assert.ok(thinBook.liquidity.score < deepBook.liquidity.score);
  // RELIABILITY is untouched by book depth.
  assert.equal(thinBook.reliability.tier, deepBook.reliability.tier);
});
