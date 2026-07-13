// Locks the multi-leg market-shape classifier against REAL gamma question strings
// (fetched live 2026-06-24). These four shapes were all previously mislabeled 'ladder'
// and fed into the survival-curve model — the P0 cluster (Bugs 1/2/4). See
// MARKET-TYPES-PLAN.md and core/fetch.js ladderShapeFromMarkets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladderShapeFromMarkets } from '../core/fetch.js';

const q = (arr) => arr.map((question) => ({ question }));

test('survival ladder: all "above $X" nested legs (SpaceX)', () => {
  const m = q([
    'SpaceX IPO closing market cap above $1T?',
    'SpaceX IPO closing market cap above $1.4T?',
    'SpaceX IPO closing market cap above $2T?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'survival');
});

test('bucket PMF: "between / less than / greater than" intervals (Bitcoin)', () => {
  const m = q([
    'Will the price of Bitcoin be between $62,000 and $64,000 on June 24?',
    'Will the price of Bitcoin be less than $56,000 on June 24?',
    'Will the price of Bitcoin be greater than $74,000 on June 24?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'bucket_pmf');
});

test('bucket PMF tolerates one categorical leg (Anthropic IPO "not IPO")', () => {
  const m = q([
    "Will Anthropic's market cap be less than $1.25T at market close on IPO day?",
    "Will Anthropic's market cap be between $1.5T and $1.75T at market close on IPO day?",
    "Will Anthropic's market cap be $3.0T or greater at market close on IPO day?",
    'Will Anthropic not IPO by December 31, 2027?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'bucket_pmf');
});

test('directional touch: "(LOW)/(HIGH) $X hit" legs, incl. colliding levels (WTI)', () => {
  const m = q([
    'Will WTI Crude Oil (WTI) hit (LOW) $90 in June?',
    'Will WTI Crude Oil (WTI) hit (HIGH) $90 in June?',
    'Will WTI Crude Oil (WTI) hit (HIGH) $120 in June?',
    'Will WTI Crude Oil (WTI) hit (LOW) $40 in June?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'directional_touch');
});

test('directional touch: Silver HIGH/LOW legs', () => {
  const m = q([
    'Will Silver (XAGUSD) hit (HIGH) $71 Week of June 22 2026?',
    'Will Silver (XAGUSD) hit (LOW) $58 Week of June 22 2026?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'directional_touch');
});

test('categorical: multi-leg, no numeric $ threshold', () => {
  const m = q([
    'Will the Fed cut rates in June?',
    'Will the Fed hold rates in June?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'categorical');
});

// ── Marker-less touch verbs: "reach $N" / "dip to $N" (gamma survey 2026-07-13) ──
// The crypto "what price will X hit" family words touch legs WITHOUT the (HIGH)/(LOW)
// marker. Rule (operator-approved): exactly the reach/dip-to verb families, each
// governing a money amount ($-adjacency), with a ≥2-leg quorum. The negative controls
// below are PERMANENT GUARDS — every one is a real live/stored market that a broadened
// regex once could have (or would have) mis-flipped. If your classifier change breaks
// one of these, the change is wrong, not the test.
import { parseTouchLeg } from '../core/touch.js';

test('touch verbs: two-sided reach/dip board (Bitcoin June 29-July 5, verbatim legs)', () => {
  const m = q([
    'Will Bitcoin reach $74,000 June 29-July 5?',
    'Will Bitcoin reach $62,000 June 29-July 5?',
    'Will Bitcoin dip to $58,000 June 29-July 5?',
    'Will Bitcoin dip to $46,000 June 29-July 5?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'directional_touch');
});

test('touch verbs: one-sided reach-only board (Ethereum July, verbatim legs)', () => {
  const m = q([
    'Will Ethereum reach $2,500 in July?',
    'Will Ethereum reach $2,400 in July?',
    'Will Ethereum reach $2,300 in July?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'directional_touch');
});

test('NEGATIVE: SpaceX "above $X" settlement wording stays survival (the frozen hash)', () => {
  const m = q([
    'SpaceX IPO closing market cap above $4T?',
    'SpaceX IPO closing market cap above $2T?',
    'SpaceX IPO closing market cap above $1T?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'survival');
});

test('NEGATIVE: one stray "hit $" leg does not flip a categorical event to TOUCH (GTA VI, verbatim)', () => {
  const m = q([
    'Will bitcoin hit $1m before GTA VI?',
    'Another pandemic before GTA VI?',
    'Russia-Ukraine ceasefire before GTA VI?',
  ]);
  // NOT touch (bare "hit" excluded) — the property this rule owns. It lands on
  // 'survival' via the PRE-EXISTING some($-leg) survival rule: a separate, older
  // looseness (one stray $ leg makes a categorical event survival), documented for
  // triage 2026-07-13 — this exact-assert will flag whoever changes either behavior.
  assert.equal(ladderShapeFromMarkets(m), 'survival');
});

test('NEGATIVE: quorum — a single reach-$ leg among categorical legs does not flip the event to TOUCH', () => {
  const m = q([
    'Will bitcoin reach $1m before GTA VI?', // hypothetical single verb-leg: below quorum
    'Another pandemic before GTA VI?',
    'New Rihanna album before GTA VI?',
  ]);
  // below quorum → not touch; falls to the same pre-existing some($) survival rule as above
  assert.equal(ladderShapeFromMarkets(m), 'survival');
});

test('NEGATIVE: "reach" without money is not a touch verb (World Cup semifinals, stored on dev)', () => {
  const m = q([
    'Will Argentina reach the semifinals?',
    'Will Spain reach the semifinals?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'categorical');
});

test('NEGATIVE: "launches reach space" is not a touch verb (Starship, on the dev watchlist)', () => {
  const m = q([
    'Will 5 or more SpaceX Starship launches reach space in 2026?',
    'Will 10 or more SpaceX Starship launches reach space in 2026?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'categorical');
});

test('NEGATIVE: bare "hit $X by <date>" multi-deadline stays out of touch (STRC, verbatim)', () => {
  const m = q([
    'Will STRC hit $100 by June 30?',
    'Will STRC hit $100 by September 30?',
    'Will STRC hit $100 by December 31?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'survival'); // still mis-shaped — parked deadline-ladder gap, NOT fixed by verbs
});

test('NEGATIVE: "between" buckets stay bucket_pmf beside reach-free legs', () => {
  const m = q([
    'Will the price of Bitcoin be between $62,000 and $64,000 on June 24?',
    'Will the price of Bitcoin be less than $56,000 on June 24?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'bucket_pmf');
});

test('parseTouchLeg: verb sides — reach→HIGH, dip to→LOW; marker keeps precedence; unsideable→null', () => {
  assert.deepEqual(parseTouchLeg('Will Bitcoin reach $74,000 June 29-July 5?'), { side: 'HIGH', level: 74000 });
  assert.deepEqual(parseTouchLeg('Will Bitcoin dip to $46,000 June 29-July 5?'), { side: 'LOW', level: 46000 });
  assert.deepEqual(parseTouchLeg('Will WTI hit (LOW) $75 Week of June 22 2026?'), { side: 'LOW', level: 75 });
  // marker precedence over a verb, if both ever co-occur
  assert.deepEqual(parseTouchLeg('Will X reach (LOW) $10?'), { side: 'LOW', level: 10 });
  // $-bearing but unsideable (bare hit / settlement wording) → null (fetchTouchMeta logs it loudly)
  assert.equal(parseTouchLeg('Will STRC hit $100 by June 30?'), null);
  assert.equal(parseTouchLeg('SpaceX IPO closing market cap above $4T?'), null);
  // money-less → null (quiet skip is legitimate)
  assert.equal(parseTouchLeg('Will Argentina reach the semifinals?'), null);
});
