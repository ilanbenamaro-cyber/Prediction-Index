// test/exclusivity-guard.test.js — the 5.6 EXCLUSIVITY GUARD, locked against live boards
// (fixtures are verbatim or family-faithful wild data from the 2026-07-13 survey).
// The guard's core property is ASYMMETRY: every misclassification degrades to
// raw-and-honest, never to a fabricated normalized PMF. If a change here makes a
// non-exclusive board normalize again, the change is wrong, not the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessExclusivity, buildCategoricalRecord, parseByDeadline } from '../core/categorical.js';
import { deriveVelocity, detectJumps, deriveCategoricalSeries } from '../lib/market-history.mjs';

// ── fixtures ──
// fed-rate-cut-by-629, verbatim wording + live raw prices (2026-07-13): nested deadlines.
// The de-vig displayed December at 49% when the market priced it at 20.5% — THE bug.
const FED_CUT = [
  { label: 'January Meeting', prob: 0.005, volume: 588114, question: 'Fed rate cut by January 2026 meeting?', leg_end_date: '2026-01-28T00:00:00Z' },
  { label: 'March Meeting', prob: 0.001, volume: 1, question: 'Fed rate cut by March 2026 meeting?', leg_end_date: '2026-03-18T00:00:00Z' },
  { label: 'April Meeting', prob: 0.021, volume: 542979, question: 'Fed rate cut by April 2026 meeting?', leg_end_date: '2026-04-29T00:00:00Z' },
  { label: 'June Meeting', prob: 0.012, volume: 784968, question: 'Fed rate cut by June 2026 meeting?', leg_end_date: '2026-06-17T00:00:00Z' },
  { label: 'July Meeting', prob: 0.006, volume: 370933, question: 'Fed rate cut by July 2026 meeting?', leg_end_date: '2026-06-17T00:00:00Z' },
  { label: 'September Meeting', prob: 0.0395, volume: 166427, question: 'Fed rate cut by September 2026 meeting?', leg_end_date: '2026-06-17T00:00:00Z' },
  { label: 'October Meeting', prob: 0.132, volume: 67658, question: 'Fed rate cut by October 2026 meeting?', leg_end_date: '2026-06-17T00:00:00Z' },
  { label: 'December Meeting', prob: 0.205, volume: 222471, question: 'Fed rate cut by December 2026 meeting?', leg_end_date: '2026-06-17T00:00:00Z' },
];
// note: January(0.005) > March(0.001) is a live 0.4pp noise inversion — inside the 2.5pp eps.

const CONFIG = { id: 'fed-rate-cut-by-629', name: 'Fed rate cut by...?', platform: 'Polymarket', market_url: 'x', resolves: '2026-12-31' };
const live = (outcomes) => ({
  fetched_at: '2026-07-13T12:00:00Z', endpoints: [], raw_inputs: [], raw_sha256: 'x',
  outcomes, total_volume: outcomes.reduce((a, o) => a + (o.volume ?? 0), 0),
});

test('guard: nested-deadline board (fed-rate-cut, verbatim) → nested_deadline', () => {
  const { verdict, basis } = assessExclusivity(FED_CUT);
  assert.equal(verdict, 'nested_deadline');
  assert.ok(basis.dated_fraction >= 0.8);
});

test('guard: the sum-invisible poison case — nested board whose raw sum ≈ 1 (anthropic-ipo-by family)', () => {
  // family-faithful: monotone "by <date>" legs summing 1.04 — the sum test alone would
  // happily de-vig this and the fabrication would be invisible. Structure must catch it.
  const legs = [
    { label: 'by Mar', prob: 0.05, volume: 10, question: 'Anthropic IPO by March 31, 2026?' },
    { label: 'by Jun', prob: 0.12, volume: 10, question: 'Anthropic IPO by June 30, 2026?' },
    { label: 'by Sep', prob: 0.27, volume: 10, question: 'Anthropic IPO by September 30, 2026?' },
    { label: 'by Dec', prob: 0.60, volume: 10, question: 'Anthropic IPO by December 31, 2026?' },
  ];
  assert.equal(assessExclusivity(legs).verdict, 'nested_deadline');
  assert.equal(assessExclusivity(legs).basis.filtered_sum, 1.04);
});

test('guard NEGATIVE: same-deadline independent board (which-banks-fail) is NOT nested — one distinct date can never fake monotonicity', () => {
  const legs = [0.395, 0.85, 0.207, 0.01, 0.02].map((p, i) => ({
    label: `Bank ${i}`, prob: p, volume: 10, question: `Will Bank ${i} fail by end of 2026?`,
  }));
  const { verdict } = assessExclusivity(legs);
  assert.equal(verdict, 'non_exclusive'); // sum 1.482 outside band; nested path skipped (1 distinct date)
  // adversarial: ascending input order must not change the verdict
  const asc = [...legs].sort((a, b) => a.prob - b.prob);
  assert.equal(assessExclusivity(asc).verdict, 'non_exclusive');
});

test('guard NEGATIVE: exclusive date-window PMF (lebron "on July N") stays exclusive', () => {
  const legs = [0.02, 0.05, 0.4, 0.3, 0.15, 0.08].map((p, i) => ({
    label: `July ${i + 2}`, prob: p, volume: 10, question: `Will LeBron James sign his next NBA contract on July ${i + 2}?`,
  }));
  assert.equal(assessExclusivity(legs).verdict, 'exclusive'); // sum 1.0, "on" not "by"
});

test('guard: multi-winner board (world-cup semifinals, sum≈4) → non_exclusive', () => {
  const legs = Array.from({ length: 16 }, (_, i) => ({
    label: `Nation ${i}`, prob: 0.25, volume: 10, question: `Will Nation ${i} reach the Semifinals at the 2026 FIFA World Cup?`,
  }));
  assert.equal(assessExclusivity(legs).verdict, 'non_exclusive');
});

test('guard: settled-independent integer trap (pricesmart, sum=12 exactly) → non_exclusive, never N-slots', () => {
  const legs = Array.from({ length: 20 }, (_, i) => ({
    label: `Phrase ${i}`, prob: i < 12 ? 1 : 0, volume: 10, question: `Will PriceSmart say "phrase ${i}" 5+ times during earnings call?`,
  }));
  assert.equal(assessExclusivity(legs).verdict, 'non_exclusive');
});

test('guard: band edge — genuinely exclusive but high-vig board (sum 1.26) degrades to raw, not blank', () => {
  const legs = [0.5, 0.4, 0.36].map((p, i) => ({ label: `O${i}`, prob: p, volume: 10, question: `Which one: O${i}?` }));
  assert.equal(assessExclusivity(legs).verdict, 'non_exclusive'); // honest raw — mild, safe failure mode
});

test('guard: signals disagree (text monotone, endDates contradict) → ambiguous (conservative)', () => {
  const legs = [
    { label: 'A', prob: 0.1, volume: 10, question: 'X out by March 31?', leg_end_date: '2026-12-31T00:00:00Z' },
    { label: 'B', prob: 0.2, volume: 10, question: 'X out by June 30?', leg_end_date: '2026-06-30T00:00:00Z' },
    { label: 'C', prob: 0.5, volume: 10, question: 'X out by September 30?', leg_end_date: '2026-03-31T00:00:00Z' },
  ];
  assert.equal(assessExclusivity(legs).verdict, 'ambiguous');
});

test('parseByDeadline: month-day-year, end-of-year, yearless, and non-deadline forms', () => {
  assert.equal(parseByDeadline('Fed rate cut by January 2026 meeting?').key, 20260128);
  assert.equal(parseByDeadline('Netanyahu out by end of 2026?').key, 20261231);
  assert.equal(parseByDeadline('out by March 31?').yearless, true);
  assert.equal(parseByDeadline('Will LeBron sign on July 2?'), null);
  assert.equal(parseByDeadline('Will Nation reach the Semifinals?'), null);
});

test('guarded record: PMF derivations SUPPRESSED, raw outcomes date-ordered, honest headline + narrative', () => {
  const rec = buildCategoricalRecord(live(FED_CUT), '1.8.0', CONFIG);
  const d = rec.snapshot.derived;
  assert.equal(d.exclusivity.verdict, 'nested_deadline');
  for (const k of ['entropy', 'dominant_prob', 'dominant_outcome', 'consensus_strength', 'implied_winner']) {
    assert.ok(!(k in d), `${k} must be OMITTED on a guarded record`);
  }
  assert.equal(d.outcomes[0].label, 'January Meeting');            // date-ordered
  assert.equal(d.outcomes[d.outcomes.length - 1].label, 'December Meeting');
  assert.ok(!('probability' in d.outcomes[0]), 'no normalized probability on guarded outcomes');
  assert.equal(d.outcomes[d.outcomes.length - 1].raw_probability, 0.205);
  assert.equal(d.exclusivity.headline.label, 'December Meeting');  // longest horizon, RAW
  assert.equal(d.exclusivity.headline.raw_probability, 0.205);
  assert.match(d.narrative, /Cumulative deadlines/);
  assert.match(d.narrative, /21% \(raw\)/); // Math.round(20.5) = 21 — half-up, matching every other pct in the app
  assert.ok(!/assigns .*probability to/.test(d.narrative), 'the fabricating sentence must be gone');
  // Increment B consensus lift must not fire (entropy/dominantProb passed as null)
  assert.ok(!d.confidence.reliability.reasons.some((r) => /strong consensus/.test(r)));
});

test('exclusive record: unchanged shape (regression)', () => {
  const legs = [
    { label: 'A', prob: 0.7, volume: 10, question: 'Which wins: A?' },
    { label: 'B', prob: 0.3, volume: 10, question: 'Which wins: B?' },
  ];
  const d = buildCategoricalRecord(live(legs), '1.8.0', CONFIG).snapshot.derived;
  assert.ok(!('exclusivity' in d));
  assert.equal(d.dominant_outcome, 'A');
  assert.ok(d.entropy != null && d.consensus_strength != null && d.implied_winner != null);
  assert.ok(Math.abs(d.outcomes[0].probability - 0.7) < 1e-9);
});

// ── mode segmentation: a guard transition is NOT a market move ──
const histRow = (date, dominantProb, guarded) => ({
  kind: 'categorical', snapshot_date: date, snapshot_hour: 2, dominant_prob: dominantProb,
  record: { snapshot: { derived: guarded ? { exclusivity: { verdict: 'nested_deadline' } } : {} } },
});

test('mode segmentation: the fabricated→honest transition is never narrated as a jump', () => {
  const rows = [
    histRow('2026-07-01', 0.49, false), histRow('2026-07-02', 0.48, false),
    histRow('2026-07-03', 0.49, false), // fabricated de-vig era
    histRow('2026-07-04', 0.205, true), histRow('2026-07-05', 0.21, true),
    histRow('2026-07-06', 0.20, true), // honest raw era — a 28pp "drop" that never happened
  ];
  assert.equal(detectJumps(rows).hasRecentJump, false);
  const v = deriveVelocity(rows);
  assert.notEqual(v.status, 'ok'); // 3-point homogeneous segment < MIN_VELOCITY_DAYS → collecting
});

test('mode segmentation: band-edge flapping cannot manufacture volatility', () => {
  const rows = [
    histRow('2026-07-01', 0.49, false), histRow('2026-07-02', 0.205, true),
    histRow('2026-07-03', 0.49, false), histRow('2026-07-04', 0.205, true),
    histRow('2026-07-05', 0.49, false), histRow('2026-07-06', 0.205, true),
  ];
  assert.equal(detectJumps(rows).hasRecentJump, false); // latest segment = 1 row → nothing to narrate
});

test('deriveCategoricalSeries: guarded segment charts RAW values', () => {
  const mk = (date, raw) => ({
    kind: 'categorical', snapshot_date: date, snapshot_hour: 2, confidence_tier: 'high',
    record: { snapshot: { derived: { exclusivity: { verdict: 'nested_deadline' }, outcomes: [
      { label: 'December Meeting', raw_probability: raw },
      { label: 'October Meeting', raw_probability: raw - 0.07 },
    ] } } },
  });
  const s = deriveCategoricalSeries([mk('2026-07-04', 0.2), mk('2026-07-05', 0.21)]);
  assert.ok(s && s.probLines.length === 2);
  assert.equal(s.probLines[0].points[0].value, 0.2);
});
