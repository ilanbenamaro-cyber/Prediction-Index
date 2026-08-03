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
  // Concern: a boundary+between mix classifies bucket_pmf. Updated for the INC 4 bucket
  // quorum (fix/bucket-classifier-quorum): bucket_pmf now requires ≥2 legs carrying BOTH
  // the "between" wording AND a successful parse, so this fixture carries two between
  // legs — as every real censused bucket board does (all carry ≥5).
  const m = q([
    'Will the price of Bitcoin be between $62,000 and $64,000 on June 24?',
    'Will the price of Bitcoin be between $64,000 and $66,000 on June 24?',
    'Will the price of Bitcoin be less than $56,000 on June 24?',
    'Will the price of Bitcoin be greater than $74,000 on June 24?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'bucket_pmf');
});

test('bucket PMF tolerates one categorical leg (Anthropic IPO "not IPO")', () => {
  // Concern: one categorical stray ("not IPO") doesn't break a real bucket board.
  // Updated for the INC 4 bucket quorum (fix/bucket-classifier-quorum): a second
  // between-leg satisfies the ≥2 both-witness quorum (real Anthropic board has more).
  const m = q([
    "Will Anthropic's market cap be less than $1.25T at market close on IPO day?",
    "Will Anthropic's market cap be between $1.5T and $1.75T at market close on IPO day?",
    "Will Anthropic's market cap be between $1.75T and $2.0T at market close on IPO day?",
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
  // NOT touch (bare "hit" excluded). Since 5.5 (all-legs-$ survival tightening) a
  // MIXED board is 'unsupported' — served as an explicit honest refusal, never routed
  // to survival (throws on the unparseable leg) or categorical (would de-vig
  // non-exclusive outcomes into a fabricated PMF).
  assert.equal(ladderShapeFromMarkets(m), 'unsupported');
});

test('NEGATIVE: quorum — a single reach-$ leg among categorical legs does not flip the event to TOUCH', () => {
  const m = q([
    'Will bitcoin reach $1m before GTA VI?', // hypothetical single verb-leg: below quorum
    'Another pandemic before GTA VI?',
    'New Rihanna album before GTA VI?',
  ]);
  // below quorum → not touch; a mixed board is 'unsupported' since 5.5
  assert.equal(ladderShapeFromMarkets(m), 'unsupported');
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
  // Concern: between-buckets beside reach-free legs stay bucket (the touch-verb rule
  // must not steal them). Updated for the INC 4 bucket quorum
  // (fix/bucket-classifier-quorum): two between-legs to satisfy the ≥2 quorum.
  const m = q([
    'Will the price of Bitcoin be between $62,000 and $64,000 on June 24?',
    'Will the price of Bitcoin be between $64,000 and $66,000 on June 24?',
    'Will the price of Bitcoin be less than $56,000 on June 24?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'bucket_pmf');
});

// ── INC 4 bucket quorum controls (fix/bucket-classifier-quorum) ──
// bucket_pmf now requires ≥2 legs each carrying BOTH witnesses: the "between" wording
// (BUCKET_RE) AND a successful parseBucketLeg. The three controls below each lock a
// distinct invariant of that conjunction. If your classifier change breaks one of
// these, the change is wrong, not the test.

test('WIDENING-CONTROL: all-boundary survival ladder ("$X or above"/"less than $X") stays survival', () => {
  // LOAD-BEARING (INC 4, operator mandate): parseBucketLeg's single-bound fallback
  // parses EVERY '$X or above' leg ("hit $104" → {lo:104,hi:∞}), so a parse-only
  // quorum would route every survival ladder to bucket_pmf. This test permanently
  // prevents 'simplifying' the conjunction (BUCKET_RE ∧ parse) back to parse-only —
  // if you are deleting this test as redundant, you are about to reintroduce that
  // catastrophe. Every leg below parses under parseBucketLeg, and NONE says "between":
  // only the conjunction keeps this board out of bucket_pmf.
  const m = q([
    'Will MSTR close at $104 or above on August 7?',
    'Will MSTR close at $120 or above on August 7?',
    'Will MSTR close at less than $90 on August 7?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'survival');
});

test('NEGATIVE: one stray "between" leg among categorical legs does not flip the board to bucket_pmf', () => {
  // Stray-leg control: exactly ONE "between $X and $Y" leg among three non-between
  // legs is below the ≥2 quorum — the board routes per the 5.5 chain instead. Here
  // only the stray leg carries a $, so the MIXED board lands 'unsupported'
  // (deterministic: some-but-not-all legs match THRESHOLD_RE).
  const m = q([
    'Will the settlement be between $5,000 and $10,000?',
    'Another pandemic before GTA VI?',
    'New Rihanna album before GTA VI?',
    'Russia-Ukraine ceasefire before GTA VI?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'unsupported');
});

test('real-board control: ≥2 parseable "between" legs classify bucket_pmf ($ and % variants)', () => {
  // Two-plus both-witness legs (the real-board floor; census: live boards carry ≥5)
  // pass the quorum — dollar path (Bitcoin-style) …
  const dollar = q([
    'Will the price of Bitcoin be between $62,000 and $64,000 on June 24?',
    'Will the price of Bitcoin be between $64,000 and $66,000 on June 24?',
    'Will the price of Bitcoin be greater than $74,000 on June 24?',
  ]);
  assert.equal(ladderShapeFromMarkets(dollar), 'bucket_pmf');
  // … and the percent path (UK-GDP-style), locking PCT_BETWEEN_RE through the
  // conjunction (percent legs carry no $ token at all).
  const percent = q([
    'Will UK GDP growth in Q2 2026 be between 0% and 1%?',
    'Will UK GDP growth in Q2 2026 be between 1% and 2%?',
    'Will UK GDP growth in Q2 2026 be 2% or higher?',
  ]);
  assert.equal(ladderShapeFromMarkets(percent), 'bucket_pmf');
});

test('ACCEPTED EDGE: a 1-between minimal bucket board falls below quorum → survival (characterization)', () => {
  // ACCEPTED TRADE-OFF (INC 4): a 1-between minimal bucket board fails the ≥2 quorum
  // and falls to the honest 5.5 chain — unobserved in the wild (census: every real
  // bucket board carries ≥5 between legs); the [shape-tripwire] monotonicity warn is
  // the instrument if one ever appears. Revisiting means re-deriving the quorum, not
  // deleting this test. All three legs carry a $ threshold, so the 5.5 chain lands
  // 'survival' (NOT bucket_pmf) — deliberate documentation, not a bug.
  const m = q([
    'Will the price of Bitcoin be between $62,000 and $64,000 on June 24?',
    'Will the price of Bitcoin be less than $56,000 on June 24?',
    'Will the price of Bitcoin be greater than $74,000 on June 24?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'survival');
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
