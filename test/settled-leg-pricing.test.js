// test/settled-leg-pricing.test.js — the settled-leg pricing rule (operator-approved
// 2026-07-16), locked with the two live fixtures that exposed it (world-cup-winner,
// prod). THE rule: a leg prices from the most-settled truth available, and a dead
// book's midpoint is never truth. See gotchas "CLOB midpoint returns a SYNTHETIC 0.5".
// If a change makes a settled leg price from any live quote again, the change is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { priceLeg } from '../core/fetch.js';
import { settledYesStr, settledYesNum } from '../core/settlement.js';

// ── verbatim live fixtures (2026-07-16, world-cup-winner) ──
// Norway: eliminated, uma=resolved, settled ["0","1"]; CLOB /book was 0 bids × 0 asks,
// yet /midpoints answered 0.5 and /prices returned the empty-side SENTINELS BUY=0/SELL=1.
const NORWAY = {
  resolution: { uma_resolution_status: 'resolved', outcomes: '["Yes", "No"]', outcome_prices: '["0", "1"]', closed: true, accepting_orders: false },
  mid: '0.5',
  book: { BUY: '0', SELL: '1' },
};
// Italy: same settled truth, book deleted outright (no midpoint, no prices entry).
const ITALY = {
  resolution: { uma_resolution_status: 'resolved', outcomes: '["Yes", "No"]', outcome_prices: '["0", "1"]', closed: true, accepting_orders: false },
  mid: undefined,
  book: {},
};

test('Norway: a settled leg prices to its settled truth, NOT its lying 0.5 midpoint', () => {
  const r = priceLeg(NORWAY.resolution, NORWAY.mid, NORWAY.book);
  assert.equal(r.midpoint, '0');
  assert.equal(r.midpoint_source, 'resolved_settlement');
  assert.equal(r.best_bid, null); // the sentinels are absences, never recorded as quotes
  assert.equal(r.best_ask, null);
  assert.ok(!r.needsLastTrade);
});

test('Italy: a settled leg with a deleted book prices to its settled truth, NOT a stale last_trade', () => {
  const r = priceLeg(ITALY.resolution, ITALY.mid, ITALY.book);
  assert.equal(r.midpoint, '0');
  assert.equal(r.midpoint_source, 'resolved_settlement');
  assert.ok(!r.needsLastTrade); // pre-fix this leg fell to last_trade (2.7% where truth is 0)
});

test('ONE-SIDED asks-only book (operator pin): the midpoint is NOT trusted, the real side survives', () => {
  // the settled-NO shape: no bids (sentinel BUY=0), a real ask at 0.001 — on an OPEN leg.
  // A one-sided book must not be read as live: mid present must NOT return clob_midpoint.
  const r = priceLeg(null, '0.0005', { BUY: '0', SELL: '0.001' });
  assert.notEqual(r.midpoint_source, 'clob_midpoint');
  assert.equal(r.midpoint_source, 'best_ask'); // honest degrade: the one REAL observed quote
  assert.equal(r.midpoint, '0.001');
  assert.equal(r.best_bid, null); // sentinel side stripped
  assert.equal(r.best_ask, '0.001');
});

test('ONE-SIDED bids-only book: same rule, mirrored (SELL=1 sentinel stripped, best_bid tier)', () => {
  const r = priceLeg(null, '0.7', { BUY: '0.4', SELL: '1' });
  assert.notEqual(r.midpoint_source, 'clob_midpoint');
  assert.equal(r.midpoint_source, 'best_bid');
  assert.equal(r.midpoint, '0.4');
  assert.equal(r.best_ask, null);
});

test('EMPTY book (both sentinels): never a midpoint — falls to last_trade', () => {
  const r = priceLeg(null, '0.5', { BUY: '0', SELL: '1' });
  assert.ok(r.needsLastTrade);
  assert.equal(r.best_bid, null);
  assert.equal(r.best_ask, null);
});

test('PENDING (closed, not yet uma-resolved): last_trade, NEVER the midpoint over a dead book', () => {
  const r = priceLeg({ uma_resolution_status: null, outcomes: null, outcome_prices: null, closed: true, accepting_orders: false },
    '0.31', { BUY: '0.30', SELL: '0.32' });
  assert.ok(r.needsLastTrade); // even a seemingly two-sided remnant book: trading stopped
  assert.equal(r.best_bid, '0.30'); // the real quotes are still recorded as observed
  assert.equal(r.best_ask, '0.32');
});

test('uma=resolved but UNPARSEABLE settled price: null-not-zero → degrades to PENDING, never a fabricated 0', () => {
  const r = priceLeg({ uma_resolution_status: 'resolved', outcomes: null, outcome_prices: null, closed: true, accepting_orders: false },
    '0.5', { BUY: '0', SELL: '1' });
  assert.notEqual(r.midpoint, '0'); // the Number(null)===0 trap must not resurface here
  assert.ok(r.needsLastTrade);
});

test('OPEN two-sided book: the existing chain is unchanged (regression)', () => {
  const spain = priceLeg({ uma_resolution_status: null, outcomes: '["Yes", "No"]', outcome_prices: '["0.5835", "0.4165"]', closed: false, accepting_orders: true },
    '0.5835', { BUY: '0.583', SELL: '0.584' });
  assert.equal(spain.midpoint, '0.5835');
  assert.equal(spain.midpoint_source, 'clob_midpoint');
  // and CRITICALLY: the open leg's outcomePrices (a LIVE-price mirror) was not read as settled
  assert.notEqual(spain.midpoint_source, 'resolved_settlement');
});

test('settledYesStr/Num: label-aligned YES index, positional fallback, null-not-zero', () => {
  assert.equal(settledYesStr('["Yes", "No"]', '["0", "1"]'), '0');
  assert.equal(settledYesStr('["No", "Yes"]', '["1", "0"]'), '0'); // label wins over position
  assert.equal(settledYesStr(null, null), null);
  assert.equal(settledYesNum(null, null), null); // never Number(null) === 0
  assert.equal(settledYesNum('["Yes", "No"]', '["1", "0"]'), 1);
});
