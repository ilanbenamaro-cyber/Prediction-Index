// test/format-detail.test.js — the 2c.3 unit-aware formatter: the headline must read
// in the market's OWN denomination (T/B/M), derived from the ladder labels, not a
// hardcoded $T. Covers the generalization tightening for non-trillion markets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitFromLadder, fmtMoney, fmtRange, fmtEastern, settlementZone, settlementZoneLabel,
  pointChange, binaryNarrative, touchNarrative, categoricalNarrative, confidenceSentence, noProbLabel } from '../lib/format-detail.mjs';

test('derives T from a trillions ladder (SpaceX-style)', () => {
  assert.equal(unitFromLadder([{ label: '>$1T' }, { label: '>$1.8T' }]), 'T');
  assert.equal(unitFromLadder([{ label: '$2–2.2T' }]), 'T'); // bucket-style label
});

test('derives B from a billions ladder (Kraken-style) and M from millions', () => {
  assert.equal(unitFromLadder([{ label: '>$28B' }]), 'B');
  assert.equal(unitFromLadder([{ label: '>$500M' }]), 'M');
});

test('derives K from a thousands ladder (Bitcoin) and plain $ from a bare ladder (WTI)', () => {
  assert.equal(unitFromLadder([{ label: '>$56K' }, { label: '>$74K' }]), 'K');
  assert.equal(unitFromLadder([{ label: '>$90' }, { label: '>$120' }]), ''); // bare dollars
});

test('falls back to dimensionless (NOT $T) on a missing/odd label', () => {
  // Defaulting to "T" was Bug 1 — an ambiguous label must render dimensionless, never $T.
  assert.equal(unitFromLadder([]), '');
  assert.equal(unitFromLadder(undefined), '');
  assert.equal(unitFromLadder([{ label: '' }]), '');
});

test('percentage-denominated buckets (UK GDP): unit %, no $ prefix, no T/B/M/K', () => {
  assert.equal(unitFromLadder([{ label: '>0%' }, { label: '>5%' }]), '%');
  assert.equal(unitFromLadder([{ label: '>-1%' }]), '%'); // negative percent label
  assert.equal(fmtMoney(1.04, '%'), '1.04%');   // no '$'
  assert.equal(fmtMoney(-0.5, '%'), '-0.50%');  // negative growth
  assert.equal(fmtRange({ low: 0.8, high: 1.2 }, '%'), '0.80%–1.20%');
  // out-of-range median labels drop the '$' too
  assert.equal(impliedMedianLabel([{ threshold: 0, prob: 0.4 }], null, '%'), '< 0%');
  assert.equal(impliedMedianLabel([{ threshold: 5, prob: 0.6 }], null, '%'), '> 5%');
});

test('fmtMoney renders in the derived unit', () => {
  assert.equal(fmtMoney(2.1, 'T'), '$2.10T');
  assert.equal(fmtMoney(28, 'B'), '$28.00B');
  assert.equal(fmtMoney(500, 'M'), '$500.00M');
  assert.equal(fmtMoney(61.13, 'K'), '$61.13K');
  assert.equal(fmtMoney(90, ''), '$90.00'); // plain dollars — no unit suffix
  assert.equal(fmtMoney(null, 'T'), 'n/a');
  assert.equal(fmtMoney(Infinity, 'B'), 'n/a');
});

test('fmtRange formats a {low,high} band or returns null', () => {
  assert.equal(fmtRange({ low: 2.05, high: 2.15 }, 'T'), '$2.05–$2.15T');
  assert.equal(fmtRange({ low: 26, high: 30 }, 'B'), '$26.00–$30.00B');
  assert.equal(fmtRange(null, 'T'), null);
  assert.equal(fmtRange({ low: 1 }, 'T'), null); // missing high
});

// ── FIX 6b: a degenerate lo===hi range collapses to a single value ──────────────
test('fmtRange: lo === hi renders the single value, not "$X–$X"', () => {
  assert.equal(fmtRange({ low: 100, high: 100 }, ''), '$100.00');
  assert.equal(fmtRange({ low: 2.1, high: 2.1 }, 'T'), '$2.10T');
  assert.equal(fmtRange({ low: 1, high: 1 }, '%'), '1.00%');
});

test('end-to-end: a billions market formats its headline in $B', () => {
  const markets = [{ label: '>$16B' }, { label: '>$20B' }, { label: '>$28B' }];
  const unit = unitFromLadder(markets);
  assert.equal(fmtMoney(22.4, unit), '$22.40B');
});

test('fmtEastern converts UTC → America/New_York with a DST-aware zone label', () => {
  // 19:42 UTC in summer = 3:42 PM EDT (UTC-4)
  const summer = fmtEastern('2026-06-24T19:42:00Z');
  assert.match(summer, /3:42\s?PM/);
  assert.match(summer, /EDT/);
  assert.doesNotMatch(summer, /UTC/);
  // 18:42 UTC in winter = 1:42 PM EST (UTC-5) — proves we never hardcode -4
  const winter = fmtEastern('2026-01-15T18:42:00Z');
  assert.match(winter, /1:42\s?PM/);
  assert.match(winter, /EST/);
  // bad input degrades, never throws
  assert.equal(fmtEastern(null), '—');
  assert.equal(fmtEastern('not-a-date'), '—');
});

// ── Bug 6: settlement zone (the converged bucket for a near-settled ladder) ──────
test('settlementZone: picks the interior bucket holding the most mass', () => {
  // converged: ~all mass between $2.0 and $2.2 (P(>2.0)=0.99, P(>2.2)=0.01)
  const m = [
    { threshold: 1.8, adjusted_prob: 0.999, bucket_prob: 0.009 },
    { threshold: 2.0, adjusted_prob: 0.99, bucket_prob: 0.98 },
    { threshold: 2.2, adjusted_prob: 0.01, bucket_prob: 0.01 },
  ];
  const z = settlementZone(m);
  assert.equal(z.kind, 'between');
  assert.equal(z.lo, 2.0);
  assert.equal(z.hi, 2.2);
  assert.equal(settlementZoneLabel(z, 'T'), '$2–2.2T');
});

test('settlementZone: converged ABOVE the top strike → the ">top" tail wins', () => {
  const m = [
    { threshold: 1.8, adjusted_prob: 0.999, bucket_prob: 0.001 },
    { threshold: 2.0, adjusted_prob: 0.999, bucket_prob: 0.001 },
    { threshold: 2.2, adjusted_prob: 0.998, bucket_prob: 0.998 }, // top tail holds the mass
  ];
  const z = settlementZone(m);
  assert.equal(z.kind, 'above');
  assert.equal(z.lo, 2.2);
  assert.equal(settlementZoneLabel(z, 'T'), '> $2.2T');
});

test('settlementZone: converged BELOW the lowest strike → the "<lowest" bucket wins', () => {
  const m = [
    { threshold: 1.8, adjusted_prob: 0.02, bucket_prob: 0.01 }, // P(<1.8) = 0.98
    { threshold: 2.0, adjusted_prob: 0.01, bucket_prob: 0.01 },
  ];
  const z = settlementZone(m);
  assert.equal(z.kind, 'below');
  assert.equal(z.hi, 1.8);
  assert.equal(settlementZoneLabel(z, 'T'), '< $1.8T');
});

test('settlementZone: empty ladder → null (degrades, never throws)', () => {
  assert.equal(settlementZone([]), null);
  assert.equal(settlementZoneLabel(null, 'T'), 'n/a');
});

// ── Bug 5: implied-median label (honest <lowest / >highest, not bare n/a) ────────
import { impliedMedianLabel, titleFromSlug, displayTitle } from '../lib/format-detail.mjs';

test('impliedMedianLabel: shows the value when the CDF crosses 50%', () => {
  const m = [{ threshold: 1.8, adjusted_prob: 0.7 }, { threshold: 2.4, adjusted_prob: 0.3 }];
  assert.equal(impliedMedianLabel(m, 2.05, 'T'), '$2.05T');
});

test('impliedMedianLabel: median above the top strike → "> $highest"', () => {
  // even at the highest strike P(>X) ≥ 0.5 → value is above it
  const m = [{ threshold: 1.8, adjusted_prob: 0.95 }, { threshold: 2.4, adjusted_prob: 0.6 }];
  assert.equal(impliedMedianLabel(m, null, 'T'), '> $2.4T');
});

test('impliedMedianLabel: median below the lowest strike → "< $lowest"', () => {
  // even at the lowest strike P(>X) < 0.5 → value is below it
  const m = [{ threshold: 1.8, adjusted_prob: 0.3 }, { threshold: 2.4, adjusted_prob: 0.05 }];
  assert.equal(impliedMedianLabel(m, null, 'T'), '< $1.8T');
});

test('impliedMedianLabel: no markets → n/a (degrades, never throws)', () => {
  assert.equal(impliedMedianLabel([], null, 'T'), 'n/a');
});

// ── Bug 7: title fallback (cleaned slug when no gamma title) ─────────────────────
test('titleFromSlug: humanizes a hyphenated event slug', () => {
  assert.equal(titleFromSlug('how-many-fed-rate-cuts-in-2026'), 'How Many Fed Rate Cuts In 2026');
  assert.equal(titleFromSlug(''), '');
});

test('displayTitle: prefers the stored name, falls back to a cleaned slug', () => {
  assert.equal(displayTitle('SpaceX IPO market cap', 'spacex-ipo'), 'SpaceX IPO market cap');
  assert.equal(displayTitle(null, 'how-many-fed-rate-cuts-in-2026'), 'How Many Fed Rate Cuts In 2026');
  // a name that is just the raw slug is treated as missing → cleaned
  assert.equal(displayTitle('wti-crude-oil', 'wti-crude-oil'), 'Wti Crude Oil');
});

// ── FIX 4: gamma's trailing numeric uniquifier is stripped before title-casing ──
test('titleFromSlug: strips a trailing 13+-digit gamma uniquifier', () => {
  assert.equal(titleFromSlug('strc-hits-100-by-20260618001620693'), 'Strc Hits 100 By');
  assert.equal(titleFromSlug('world-cup-golden-ball-winner-20260603194031758'), 'World Cup Golden Ball Winner');
});

test('titleFromSlug: a trailing 4-digit year is untouched (not a uniquifier)', () => {
  assert.equal(titleFromSlug('how-many-fed-rate-cuts-in-2026'), 'How Many Fed Rate Cuts In 2026');
});

// ── date-range repair in titles (the Bitcoin "June 22 28 2026" bug) ──────────────
import { humanizeDateRange } from '../lib/format-detail.mjs';
test('humanizeDateRange: inserts an em-dash + comma into a stripped date range', () => {
  assert.equal(humanizeDateRange('June 22 28 2026'), 'June 22–28, 2026');
  assert.equal(humanizeDateRange('Bitcoin price on June 22 28 2026'), 'Bitcoin price on June 22–28, 2026');
  assert.equal(humanizeDateRange('December 31 2026'), 'December 31, 2026'); // single date → comma
  assert.equal(humanizeDateRange('June 22–28, 2026'), 'June 22–28, 2026'); // already punctuated: untouched
  assert.equal(humanizeDateRange('Group 22 28 2026'), 'Group 22 28 2026'); // no month name → no change
});

test('titleFromSlug + displayTitle repair date ranges end-to-end', () => {
  assert.equal(titleFromSlug('bitcoin-june-22-28-2026'), 'Bitcoin June 22–28, 2026');
  assert.equal(displayTitle('Will Bitcoin dip June 22 28 2026?', 'x'), 'Will Bitcoin dip June 22–28, 2026?');
});

// ── FIX 4: platform label normalization (stored 'polymarket' predates the rebrand) ──
import { platformLabel } from '../lib/format-detail.mjs';
test('platformLabel: null/undefined/polymarket render as "prediction index"; other values pass through', () => {
  assert.equal(platformLabel(null), 'prediction index');
  assert.equal(platformLabel(undefined), 'prediction index');
  assert.equal(platformLabel('polymarket'), 'prediction index');
  assert.equal(platformLabel('kalshi'), 'kalshi');
});

// ── Enh 5: human-readable volume ────────────────────────────────────────────────
import { fmtVolHuman } from '../lib/format-detail.mjs';
test('fmtVolHuman: compact dollar volumes across magnitudes', () => {
  assert.equal(fmtVolHuman(3_568_640), '$3.6M');
  assert.equal(fmtVolHuman(820_000), '$820K');
  assert.equal(fmtVolHuman(1_240_000_000), '$1.2B');
  assert.equal(fmtVolHuman(42), '$42');
  assert.equal(fmtVolHuman(null), '');
  assert.equal(fmtVolHuman(undefined), '');
});

// ── Phase 3: per-threshold delta formatting (Δ columns + biggest movers) ─────────
import { fmtDeltaPp, deltaSign } from '../lib/format-detail.mjs';
test('fmtDeltaPp: a P(>X) change renders as signed percentage points', () => {
  assert.equal(fmtDeltaPp(0.07), '+7.0');     // +7 percentage points
  assert.equal(fmtDeltaPp(-0.203), '-20.3');  // the minus comes from the number
  assert.equal(fmtDeltaPp(0.004), '+0.4');
  assert.equal(fmtDeltaPp(0), '0.0');         // exact zero is neutral, no sign
});
test('fmtDeltaPp: a missing horizon is an em dash, never a fabricated 0', () => {
  assert.equal(fmtDeltaPp(null), '—');
  assert.equal(fmtDeltaPp(undefined), '—');
  assert.equal(fmtDeltaPp(NaN), '—');
});
test('deltaSign: classes direction with a sub-0.1pp deadband', () => {
  assert.equal(deltaSign(0.05), 'is-up');
  assert.equal(deltaSign(-0.02), 'is-down');
  assert.equal(deltaSign(0.0003), '');   // <0.05pp → neutral, no colour
  assert.equal(deltaSign(null), '');
  assert.equal(deltaSign(undefined), '');
});

// ── v1 ITEM 3: mean robustness ──────────────────────────────────────────────────
import { meanRobustnessLabel, modeBucket, detailNarrative } from '../lib/format-detail.mjs';
test('meanRobustnessLabel: ≈0 / tail-insensitive / tail-sensitive by |mean−median| relative to median', () => {
  assert.equal(meanRobustnessLabel(2.10, 2.10, 'T'), 'tail-insensitive (≈0)');
  assert.equal(meanRobustnessLabel(2.12, 2.10, 'T'), 'tail-insensitive (+$0.02T)'); // 0.95% → insensitive but shown
  assert.equal(meanRobustnessLabel(2.40, 2.10, 'T'), 'tail-sensitive (+$0.30T) — outlier rungs present'); // 14%
  assert.equal(meanRobustnessLabel(null, 2.1, 'T'), '');
});

// ── v1 ITEM 1: mode bucket + narrative ──────────────────────────────────────────
test('modeBucket: the density bucket with the most mass, with a clean label', () => {
  const markets = [
    { threshold: 1, adjusted_prob: 1.0, bucket_prob: 0.05 },
    { threshold: 2, adjusted_prob: 0.95, bucket_prob: 0.90 }, // the mode
    { threshold: 2.2, adjusted_prob: 0.05, bucket_prob: 0.05 },
  ];
  const m = modeBucket(markets, 'T');
  assert.equal(m.label, '$2–2.2T');
  assert.ok(Math.abs(m.prob - 0.90) < 1e-9);
});

test('detailNarrative: full paragraph with history; omits Δ/band sentences without it (no "—")', () => {
  const full = detailNarrative({ medianLabel: '$2.10T', change30: -0.07, change7: -0.03,
    mode: { prob: 1.0, label: '$2–2.2T' }, bandDirection: 'narrowing', reliabilityTier: 'high', liquidityTier: 'high', unit: 'T' });
  assert.match(full, /median of \$2\.10T, down \$0\.07T over the past month and down \$0\.03T this week\./);
  assert.match(full, /largest single concentration of probability \(100%\) sits in the \$2–2\.2T range\./);
  assert.match(full, /25–75% band is narrowing — the market is converging on a view\./);
  assert.match(full, /trustworthy and the market is liquid enough to trade at it\./);

  const noHist = detailNarrative({ medianLabel: '$2.10T', change30: null, change7: null,
    mode: { prob: 0.9, label: '$2–2.2T' }, bandDirection: null, reliabilityTier: 'medium', liquidityTier: 'medium', unit: 'T' });
  assert.match(noHist, /^The market implies a median of \$2\.10T\./); // no Δ clause
  assert.doesNotMatch(noHist, /band is/);  // no band sentence
  assert.doesNotMatch(noHist, /—/);        // never a dash in prose
  assert.match(noHist, /Moderate confidence in both/);
});

// ── FIX 2: binary NO label complements YES when quotes are consistent ───────────
test('noProbLabel: independent rounding does not fabricate a false 101%/99% sum', () => {
  // YES 0.605 / NO 0.395 sum to exactly 1.000, but round(60.5)=61 and round(39.5)=40 → 101 raw.
  // Consistent quotes → NO complements the rounded YES (61% → 39%), never a fabricated 101%.
  assert.equal(noProbLabel(0.605, 0.395), '39%');
  // YES 0.601 / NO 0.399 → round(60.1)=60, round(39.9)=40 → already sums to 100; complement agrees.
  assert.equal(noProbLabel(0.601, 0.399), '40%');
});

test('noProbLabel: a genuine overround stays visible (quotes disagree beyond tolerance)', () => {
  // YES 0.55 + NO 0.50 = 1.05 — a real overround, more than 0.5pp off 1 — show the true NO.
  assert.equal(noProbLabel(0.55, 0.50), '50%');
});

test('noProbLabel: null when either quote is missing', () => {
  assert.equal(noProbLabel(null, 0.4), null);
  assert.equal(noProbLabel(0.6, null), null);
  assert.equal(noProbLabel(undefined, undefined), null);
});

// ── FIX 1: resolved-aware narratives (RESOLVED markets speak in the past tense) ──
test('detailNarrative: resolvedLabel returns the resolved variant, no live clauses', () => {
  const s = detailNarrative({ medianLabel: '$2.10T', resolvedLabel: 'settled in $2–2.2T', change30: -0.07, unit: 'T' });
  assert.match(s, /^This market has resolved — settled in \$2–2\.2T\./);
  assert.match(s, /implied valuation moved down \$0\.07T over its final month\./);
  assert.doesNotMatch(s, /trade at/);
  assert.doesNotMatch(s, /trustworthy/);
  // no change30 → no final-month sentence, still no live clauses
  const noMove = detailNarrative({ medianLabel: '$2.10T', resolvedLabel: 'settled', reliabilityTier: 'high', liquidityTier: 'low', unit: 'T' });
  assert.equal(noMove, 'This market has resolved — settled.');
});

test('binaryNarrative: resolvedLabel returns the resolved variant, no live clauses', () => {
  const s = binaryNarrative({ prob: 0.5, resolvedLabel: 'resolved YES', change30: -0.149 });
  assert.match(s, /^This market has resolved — resolved YES\./);
  assert.match(s, /moved down 14\.9pp over its final month\./);
  assert.doesNotMatch(s, /trade at/);
  assert.doesNotMatch(s, /trustworthy/);
  const noMove = binaryNarrative({ prob: 1, resolvedLabel: 'resolved NO', reliabilityTier: 'high', liquidityTier: 'low' });
  assert.equal(noMove, 'This market has resolved — resolved NO.');
});

test('touchNarrative: resolvedLabel returns the resolved variant, no tradability/range clauses', () => {
  const s = touchNarrative({ lowLabel: '$66.73', highLabel: '$90.00', resolvedLabel: 'touched HIGH $90.00', reliabilityTier: 'high', liquidityTier: 'low' });
  assert.equal(s, 'This market has resolved — touched HIGH $90.00. This was a barrier-option market: each leg priced the probability of touching a level before expiry, not a settlement value.');
  assert.doesNotMatch(s, /trade at/);
  assert.doesNotMatch(s, /implied barrier range runs/);
});

test('categoricalNarrative: resolvedLabel returns the resolved variant, no live clauses', () => {
  const s = categoricalNarrative({ dominantOutcome: '0 (0 bps)', dominantProb: 0.80, resolvedLabel: 'resolved 0 (0 bps)', change30: 0.03, reliabilityTier: 'high', liquidityTier: 'low' });
  assert.match(s, /^This market has resolved — resolved 0 \(0 bps\)\./);
  assert.match(s, /moved up 3\.0pp over its final month\./);
  assert.doesNotMatch(s, /trade at/);
  assert.doesNotMatch(s, /trustworthy/);
  const noMove = categoricalNarrative({ dominantOutcome: 'Yes', dominantProb: 1, resolvedLabel: 'resolved Yes' });
  assert.equal(noMove, 'This market has resolved — resolved Yes.');
});

// ── confidenceSentence (the 3×3 reliability×liquidity synthesis) ──────────────
test('confidenceSentence: all 9 cells produce a distinct sentence; divergent cells are bespoke', () => {
  const tiers = ['high', 'medium', 'low'];
  const seen = new Set();
  for (const r of tiers) for (const l of tiers) {
    const s = confidenceSentence(r, l);
    assert.ok(typeof s === 'string' && s.length > 0, `${r}/${l} has a sentence`);
    seen.add(s);
  }
  assert.equal(seen.size, 9, 'all 9 combinations are distinct');
  // The CT-Governor case: trustworthy number, untradeable.
  assert.match(confidenceSentence('high', 'low'), /trustworthy, but thin liquidity/);
  // The inverse: deeply traded but the number is unreliable.
  assert.match(confidenceSentence('low', 'high'), /deeply traded, but the displayed price itself is unreliable/);
});

test('confidenceSentence: legacy single-half data states only the known half; null when neither', () => {
  assert.match(confidenceSentence('high', null), /^Reliability is high\.$/);
  assert.match(confidenceSentence(null, 'low'), /^Liquidity is low\.$/);
  assert.equal(confidenceSentence(null, null), null);
});

// ── pointChange (v1 ITEM 1: lean-series Δ for the non-ladder views) ───────────
test('pointChange: today minus the row nearest N days ago', () => {
  const pts = [
    { date: '2026-05-01', value: 0.30 },
    { date: '2026-05-25', value: 0.40 }, // ~7 days before 2026-06-01
    { date: '2026-06-01', value: 0.50 },
  ];
  assert.ok(Math.abs(pointChange(pts, 7) - 0.10) < 1e-9);  // 0.50 - 0.40
  assert.ok(Math.abs(pointChange(pts, 30) - 0.20) < 1e-9); // 0.50 - 0.30 (nearest to 30d ago)
});

test('pointChange: null below two points', () => {
  assert.equal(pointChange([{ date: '2026-06-01', value: 0.5 }], 7), null);
  assert.equal(pointChange([], 30), null);
  assert.equal(pointChange(undefined, 30), null);
});

// ── binaryNarrative ──────────────────────────────────────────────────────────
test('binaryNarrative: probability + 30d/7d move + consensus + confidence', () => {
  const s = binaryNarrative({ prob: 0.82, change30: 0.05, change7: -0.02, reliabilityTier: 'high', liquidityTier: 'high' });
  assert.match(s, /82% chance of YES/);
  assert.match(s, /up 5\.0pp over the past month/);
  assert.match(s, /down 2\.0pp this week/);
  assert.match(s, /strong YES consensus/);
  assert.match(s, /trustworthy and the market is liquid enough/);
});

test('binaryNarrative: omits Δ sentences gracefully with no history (never a dash)', () => {
  const s = binaryNarrative({ prob: 0.5, change30: null, change7: null, reliabilityTier: 'low', liquidityTier: 'low' });
  assert.match(s, /50% chance of YES\./);
  assert.doesNotMatch(s, /—|month|week/);
  assert.match(s, /contested book/);
  assert.match(s, /Low confidence in both/);
});

// ── touchNarrative ───────────────────────────────────────────────────────────
test('touchNarrative: range + midpoint move in unit space + barrier framing (Increment 7)', () => {
  const s = touchNarrative({ lowLabel: '$66.73', highLabel: '$90.00', midChange30: 1.5, unit: '', reliabilityTier: 'high', liquidityTier: 'low' });
  assert.match(s, /\$66\.73 to \$90\.00/);
  assert.match(s, /midpoint up \$1\.50 over the past month/);
  assert.match(s, /not a settlement forecast/); // Increment 7: barrier framing (was "not a settlement value")
  // CT-Governor synthesis: trustworthy price, thin liquidity.
  assert.match(s, /trustworthy, but thin liquidity may make it hard to actually trade at\./);
});

test('touchNarrative: empty when a bound label is missing', () => {
  assert.equal(touchNarrative({ lowLabel: '', highLabel: '$90', unit: '' }), '');
});

// ── categoricalNarrative ─────────────────────────────────────────────────────
test('categoricalNarrative: leader + move + entropy consensus read', () => {
  const s = categoricalNarrative({ dominantOutcome: '0 (0 bps)', dominantProb: 0.80, change30: 0.03, entropy: 0.29, reliabilityTier: 'high', liquidityTier: 'low' });
  assert.match(s, /most likely outcome is 0 \(0 bps\) at 80%/);
  assert.match(s, /up 3\.0pp over the past month/);
  assert.match(s, /high consensus/);
  // CT-Governor: strong consensus (trustworthy) but thin liquidity.
  assert.match(s, /trustworthy, but thin liquidity/);
});

test('categoricalNarrative: no-consensus framing when nothing clears 50%', () => {
  const s = categoricalNarrative({ dominantOutcome: 'Yes', dominantProb: 0.42, entropy: 0.9, noConsensus: true });
  assert.match(s, /No single outcome clears 50%/);
  assert.match(s, /wide open/);
});

// ── Increment 6: ladder zone classification (threshold table signal-to-noise) ────
import { classifyLadderZones } from '../lib/format-detail.mjs';
test('classifyLadderZones: splits rungs into settled-high / active / settled-low by P(>X)', () => {
  const m = [
    { threshold: 1.0, prob: 0.99 }, // settled-high
    { threshold: 1.5, prob: 0.95 }, // settled-high (boundary ≥0.95)
    { threshold: 2.0, prob: 0.60 }, // active
    { threshold: 2.5, prob: 0.20 }, // active
    { threshold: 3.0, prob: 0.05 }, // settled-low (boundary ≤0.05)
    { threshold: 3.5, prob: 0.01 }, // settled-low
  ];
  const z = classifyLadderZones(m);
  assert.deepEqual(z.settledHigh.map((r) => r.threshold), [1.0, 1.5]);
  assert.deepEqual(z.active.map((r) => r.threshold), [2.0, 2.5]);
  assert.deepEqual(z.settledLow.map((r) => r.threshold), [3.0, 3.5]);
});

test('classifyLadderZones: all-active and empty edge cases', () => {
  const allActive = classifyLadderZones([{ threshold: 2, prob: 0.5 }, { threshold: 2.2, prob: 0.4 }]);
  assert.equal(allActive.active.length, 2);
  assert.equal(allActive.settledHigh.length, 0);
  assert.equal(allActive.settledLow.length, 0);
  const empty = classifyLadderZones([]);
  assert.deepEqual([empty.settledHigh.length, empty.active.length, empty.settledLow.length], [0, 0, 0]);
});

// ── Increment 7: touch barrier framing ──────────────────────────────────────────
import { barrierPathUncertainty } from '../lib/format-detail.mjs';
test('barrierPathUncertainty: wide / moderate / narrow by fraction of the strike axis', () => {
  assert.equal(barrierPathUncertainty(0.40).label, 'wide');
  assert.match(barrierPathUncertainty(0.40).detail, /significant price movement/);
  assert.equal(barrierPathUncertainty(0.20).label, 'moderate');
  assert.equal(barrierPathUncertainty(0.10).label, 'moderate'); // boundary ≥0.10
  assert.equal(barrierPathUncertainty(0.05).label, 'narrow');
  assert.match(barrierPathUncertainty(0.05).detail, /contained movement/);
  assert.equal(barrierPathUncertainty(null), null); // one-sided range → unknown
});

test('touchNarrative: explicit barrier-option framing with the expiry date (not "trading range")', () => {
  const s = touchNarrative({ lowLabel: '$66.73', highLabel: '$90.00', unit: '', resolves: '2026-12-31' });
  assert.match(s, /implied barrier range runs \$66\.73 to \$90\.00/);
  assert.match(s, /barrier-option market: each leg prices P\(price touches a level before 2026-12-31\)/);
  assert.match(s, /not a settlement forecast/);
  assert.doesNotMatch(s, /trading range/);
});

// ── percent-denominated display (UK GDP): no '$' prefix anywhere a % ladder reaches a label ──
test('modeBucket: percent unit labels carry no "$" prefix', () => {
  const markets = [
    { threshold: 0, adjusted_prob: 0.9, prob: 0.9, bucket_prob: 0.3 },
    { threshold: 1, adjusted_prob: 0.6, prob: 0.6, bucket_prob: 0.5 },
    { threshold: 2, adjusted_prob: 0.1, prob: 0.1, bucket_prob: 0.1 },
  ];
  const mode = modeBucket(markets, '%');
  assert.equal(mode.label, '1–2%'); // was "$1–2%"
  const dollar = modeBucket(markets, 'T');
  assert.equal(dollar.label, '$1–2T'); // dollar path unchanged
});

test('settlementZoneLabel: percent unit carries no "$" prefix', () => {
  assert.equal(settlementZoneLabel({ lo: 0, hi: 1, kind: 'between' }, '%'), '0–1%');
  assert.equal(settlementZoneLabel({ lo: -Infinity, hi: 0, kind: 'below' }, '%'), '< 0%');
  assert.equal(settlementZoneLabel({ lo: 2, hi: Infinity, kind: 'above' }, '%'), '> 2%');
  assert.equal(settlementZoneLabel({ lo: 2, hi: 2.2, kind: 'between' }, 'T'), '$2–2.2T'); // unchanged
});

test('detailNarrative: percent-unit deltas read "down 0.20%", never "down $0.20%"', () => {
  const n = detailNarrative({ medianLabel: '1.04%', change30: -0.2, change7: 0.1, unit: '%' });
  assert.ok(n.includes('down 0.20% over the past month'), n);
  assert.ok(n.includes('up 0.10% this week'), n);
  assert.ok(!n.includes('$'), `no $ in a percent narrative: ${n}`);
  const d = detailNarrative({ medianLabel: '$2.10T', change30: -0.2, unit: 'T' });
  assert.ok(d.includes('down $0.20T over the past month'), d); // dollar path unchanged
});

// ── DISPLAY FIX: resolved-categorical banner derives winners from derived.outcomes, not the
// {threshold, outcome} lifecycle side channel (which carries no label and made every resolved
// categorical banner print the literal string "resolved: Yes"). ────────────────────────────
import { resolvedCategoricalWinners } from '../lib/format-detail.mjs';

test('resolvedCategoricalWinners: LOCK — the predicate is probability === 1 (settled truth), never near-1', () => {
  // LOCK: the winner predicate is probability === 1 (settled truth), never near-1. Loosening
  // this to a band (>0.95) would crown a confident-but-OPEN leg as resolved winner. If you are
  // relaxing this predicate, you are about to fabricate a settlement.
  const outcomes = [
    { label: 'Confident-but-open', probability: 0.99 },
    { label: 'Long shot A', probability: 0.008 },
    { label: 'Long shot B', probability: 0.002 },
  ];
  assert.deepEqual(resolvedCategoricalWinners(outcomes), []); // the 0.99 leg is NOT crowned
});

test('resolvedCategoricalWinners: LOCK — zero winners on a degraded-freeze record and an all-No board', () => {
  // A degraded-freeze-shaped record: lifecycle says RESOLVED, but outcomes still carry pre-final
  // open-market quotes (no leg ever reached 1) — never guess a winner from stale quotes.
  const degradedFreeze = [
    { label: 'Alpha', probability: 0.62 },
    { label: 'Beta', probability: 0.31 },
    { label: 'Gamma', probability: 0.07 },
  ];
  assert.deepEqual(resolvedCategoricalWinners(degradedFreeze), []);

  // A genuine all-No board (every leg settled to 0) — no winner exists, so none is fabricated.
  const allNo = [
    { label: 'Alpha', probability: 0 },
    { label: 'Beta', probability: 0 },
    { label: 'Gamma', probability: 0 },
  ];
  assert.deepEqual(resolvedCategoricalWinners(allNo), []);
});

test('resolvedCategoricalWinners: single winner settled to exactly 1', () => {
  // Live-verified shape: Spain=1 among lower legs.
  const outcomes = [
    { label: 'Spain', probability: 1 },
    { label: 'France', probability: 0 },
    { label: 'Germany', probability: 0 },
  ];
  assert.deepEqual(resolvedCategoricalWinners(outcomes), ['Spain']);
});

test('resolvedCategoricalWinners: multi-winner (N-slots family) — every leg settled to 1 is crowned', () => {
  const outcomes = [
    { label: 'A', probability: 1 },
    { label: 'B', probability: 1 },
    { label: 'C', probability: 0 },
  ];
  assert.deepEqual(resolvedCategoricalWinners(outcomes), ['A', 'B']);
});

test('resolvedCategoricalWinners: raw_probability-only shape (guarded record) is crowned via the fallback', () => {
  // A guarded record carries RAW probabilities only — probability is absent, raw_probability
  // is the settled channel.
  const outcomes = [
    { label: 'Other', raw_probability: 1 },
    { label: 'Everyone else', raw_probability: 0 },
  ];
  assert.deepEqual(resolvedCategoricalWinners(outcomes), ['Other']);
});

test('resolvedCategoricalWinners: empty/nullish input degrades to [], never throws', () => {
  assert.deepEqual(resolvedCategoricalWinners([]), []);
  assert.deepEqual(resolvedCategoricalWinners(null), []);
  assert.deepEqual(resolvedCategoricalWinners(undefined), []);
});

test('resolvedCategoricalWinners: a winner missing a label is never crowned (label required)', () => {
  const outcomes = [{ probability: 1 }, { label: 'Real winner', probability: 1 }];
  assert.deepEqual(resolvedCategoricalWinners(outcomes), ['Real winner']);
});
