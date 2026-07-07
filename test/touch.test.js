// Directional-touch core (WTI/Silver "(LOW)/(HIGH) hit $X"). These markets price
// P(price touches a level before expiry) — NOT a settlement distribution, so there is no
// implied median. The honest signal is the IMPLIED RANGE: the band between the HIGH series'
// 50% crossover (upper: 50% chance of breaking above) and the LOW series' 50% crossover
// (lower: 50% chance of breaking below). parseTouchLeg locked against real gamma questions;
// impliedRange against controlled series with hand-computed crossovers. See MARKET-TYPES-PLAN.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTouchLeg, impliedRange } from '../core/touch.js';

test('parseTouchLeg: HIGH/LOW side + level (WTI)', () => {
  assert.deepEqual(parseTouchLeg('Will WTI Crude Oil (WTI) hit (HIGH) $90 in June?'), { side: 'HIGH', level: 90 });
  assert.deepEqual(parseTouchLeg('Will WTI Crude Oil (WTI) hit (LOW) $85 in June?'), { side: 'LOW', level: 85 });
});

test('parseTouchLeg: Silver levels', () => {
  assert.deepEqual(parseTouchLeg('Will Silver (XAGUSD) hit (HIGH) $71 Week of June 22 2026?'), { side: 'HIGH', level: 71 });
  assert.deepEqual(parseTouchLeg('Will Silver (XAGUSD) hit (LOW) $58 Week of June 22 2026?'), { side: 'LOW', level: 58 });
});

test('parseTouchLeg: a non-touch leg → null', () => {
  assert.equal(parseTouchLeg('SpaceX IPO closing market cap above $1.4T?'), null);
});

test('impliedRange: 50% crossovers of the HIGH (down) and LOW (up) series', () => {
  // HIGH = P(touch ≥ level), decreasing; crosses 0.5 between 85(0.6) and 90(0.4) → 87.5
  const high = [{ level: 80, prob: 0.7 }, { level: 85, prob: 0.6 }, { level: 90, prob: 0.4 }, { level: 95, prob: 0.2 }];
  // LOW = P(touch ≤ level), increasing; crosses 0.5 between 60(0.4) and 65(0.6) → 62.5
  const low = [{ level: 55, prob: 0.2 }, { level: 60, prob: 0.4 }, { level: 65, prob: 0.6 }, { level: 70, prob: 0.8 }];
  assert.deepEqual(impliedRange(high, low), { low: 62.5, high: 87.5, confidence: 0.5 });
});

test('impliedRange: null bound when a series never crosses 50% (no false precision)', () => {
  const high = [{ level: 80, prob: 0.3 }, { level: 90, prob: 0.1 }]; // already < 0.5 → no upper crossover
  const low = [{ level: 55, prob: 0.6 }, { level: 60, prob: 0.8 }]; // already > 0.5 → no lower crossover
  assert.deepEqual(impliedRange(high, low), { low: null, high: null, confidence: 0.5 });
});

// ── dedupTouchLegs: one gamma event can carry DUPLICATE strikes with contradictory settlements ──
// A touch leg settles Yes EARLY the moment it touches, and the board re-lists a fresh strike at
// the same level measuring from re-listing (observed live: si-hit-jun-2026 "hit (HIGH) $110" both
// Yes-in-January and No-at-window-end). Keep the CURRENT board: tradeable beats closed; among
// closed, the latest closedTime wins.

const leg = (side, level, over = {}) => ({
  side, level, token_id: `${side}-${level}-${over.closed_time ?? 'open'}`,
  closed: true, accepting_orders: false, closed_time: null,
  outcomes: '["Yes", "No"]', outcome_prices: '["0", "1"]', ...over,
});

test('dedupTouchLegs: contradictory duplicate strike → the latest-closedTime leg wins', async () => {
  const { dedupTouchLegs } = await import('../core/fetch.js');
  const early = leg('HIGH', 110, { closed_time: '2026-01-27T00:00:00Z', outcome_prices: '["1", "0"]' });
  const relisted = leg('HIGH', 110, { closed_time: '2026-07-01T00:00:00Z', outcome_prices: '["0", "1"]' });
  assert.deepEqual(dedupTouchLegs([early, relisted]), [relisted]);
  assert.deepEqual(dedupTouchLegs([relisted, early]), [relisted]); // order-independent
});

test('dedupTouchLegs: a still-tradeable leg beats any closed duplicate', async () => {
  const { dedupTouchLegs } = await import('../core/fetch.js');
  const closed = leg('LOW', 60, { closed_time: '2026-06-30T00:00:00Z' });
  const open = leg('LOW', 60, { closed: false, accepting_orders: true });
  assert.deepEqual(dedupTouchLegs([closed, open]), [open]);
});

test('dedupTouchLegs: no duplicates → identity (stable order, distinct sides kept apart)', async () => {
  const { dedupTouchLegs } = await import('../core/fetch.js');
  const legs = [leg('HIGH', 90), leg('LOW', 90), leg('HIGH', 100)]; // same level, different side = distinct
  assert.deepEqual(dedupTouchLegs(legs), legs);
});

test('dedupTouchLegs: missing closedTime never beats a dated duplicate', async () => {
  const { dedupTouchLegs } = await import('../core/fetch.js');
  const undated = leg('HIGH', 80);
  const dated = leg('HIGH', 80, { closed_time: '2026-01-07T00:00:00Z' });
  assert.deepEqual(dedupTouchLegs([undated, dated]), [dated]);
  assert.deepEqual(dedupTouchLegs([dated, undated]), [dated]);
});
