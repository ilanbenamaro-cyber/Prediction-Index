// test/market-scan.test.js — PURE-logic gate for the rail's scan assembler
// (lib/market-scan.assembleScanRows). The live firewall + DB reads are proven by
// scripts/verify-2c2-rail.mjs (needs a real Supabase); this covers the
// deterministic transform: dedup/scope-merge, median formatting (via core/format.fmtT,
// the SAME formatter the detail view uses), delta extraction from the record JSONB,
// ordering (personal-first), and graceful handling of a watchlisted-but-unscanned row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleScanRows } from '../lib/market-scan.mjs';

// A minimal core-record stub carrying just the path the assembler reads.
const recWithDelta = (display, dir) => ({
  snapshot: { derived: { market: { analytics: { velocity: { change_24h: { display, dir } } } } } },
});

test('formats median via fmtT and extracts the pre-formatted delta verbatim', () => {
  const visible = [{ scope: 'personal', org_id: null, market_id: 'm1', created_at: '2026-06-20T00:00:00Z' }];
  const markets = [{ id: 'm1', title: 'SpaceX IPO cap' }];
  const latest = [{
    market_id: 'm1', implied_median: 2.1, confidence_tier: 'high', lifecycle_state: 'OPEN',
    is_final: false, stale_after: '2026-06-21T00:00:00Z', fetched_at: '2026-06-20T00:00:00Z',
    record: recWithDelta('+$0.05T', 'up'),
  }];
  const [row] = assembleScanRows(visible, markets, latest);
  assert.equal(row.title, 'SpaceX IPO cap');
  assert.equal(row.median_display, '$2.10T'); // byte-identical to detail view's fmtT
  assert.equal(row.delta_display, '+$0.05T');
  assert.equal(row.delta_dir, 'up');
  assert.equal(row.confidence_tier, 'high');
  assert.equal(row.has_scan, true);
  assert.deepEqual(row.scopes, ['personal']);
});

test('dedups by market_id and MERGES both scopes into one row', () => {
  const visible = [
    { scope: 'personal', org_id: null, market_id: 'm1', created_at: '2026-06-20T00:00:00Z' },
    { scope: 'org', org_id: 'orgA', market_id: 'm1', created_at: '2026-06-19T00:00:00Z' },
  ];
  const markets = [{ id: 'm1', title: 'Dual-scoped' }];
  const latest = [{ market_id: 'm1', implied_median: 1.0, confidence_tier: 'medium', lifecycle_state: 'OPEN', is_final: false, stale_after: null, fetched_at: '2026-06-20T00:00:00Z', record: recWithDelta(null, 'flat') }];
  const rows = assembleScanRows(visible, markets, latest);
  assert.equal(rows.length, 1, 'one merged row, not two');
  assert.equal(rows[0].personal, true);
  assert.deepEqual(rows[0].scopes.sort(), ['org', 'personal']);
  assert.equal(rows[0].org_id, 'orgA', 'captures the org_id for org-scoped remove');
  assert.deepEqual(rows[0].org_ids, ['orgA'], 'org_ids carries the org for the per-org filter');
});

test('org_ids accumulates EVERY org a market is shared in (multi-org)', () => {
  const visible = [
    { scope: 'org', org_id: 'orgA', market_id: 'm1', created_at: '2026-06-20T00:00:00Z' },
    { scope: 'org', org_id: 'orgB', market_id: 'm1', created_at: '2026-06-19T00:00:00Z' },
  ];
  const markets = [{ id: 'm1', title: 'In two orgs' }];
  const latest = [{ market_id: 'm1', implied_median: 1.0, confidence_tier: 'medium', lifecycle_state: 'OPEN', is_final: false, stale_after: null, fetched_at: '2026-06-20T00:00:00Z', record: recWithDelta(null, 'flat') }];
  const [row] = assembleScanRows(visible, markets, latest);
  assert.equal(row.personal, false);
  assert.deepEqual(row.org_ids.sort(), ['orgA', 'orgB'], 'both orgs present so the toggle shows it under each');
  assert.equal(row.org_id, 'orgA', 'org_id keeps the first for back-compat remove');
});

test('orders personal-first, then most-recently-added', () => {
  const visible = [
    { scope: 'org', org_id: 'o', market_id: 'mOrg', created_at: '2026-06-22T00:00:00Z' },
    { scope: 'personal', org_id: null, market_id: 'mOld', created_at: '2026-06-10T00:00:00Z' },
    { scope: 'personal', org_id: null, market_id: 'mNew', created_at: '2026-06-21T00:00:00Z' },
  ];
  const markets = [{ id: 'mOrg', title: 'o' }, { id: 'mOld', title: 'old' }, { id: 'mNew', title: 'new' }];
  const latest = [];
  const rows = assembleScanRows(visible, markets, latest);
  assert.deepEqual(rows.map((r) => r.market_id), ['mNew', 'mOld', 'mOrg'],
    'personal (newest→oldest) before org, even though org was added most recently overall');
});

test('a watchlisted market with NO scan row degrades gracefully (no throw, placeholders)', () => {
  const visible = [{ scope: 'personal', org_id: null, market_id: 'mGhost', created_at: '2026-06-20T00:00:00Z' }];
  const markets = [{ id: 'mGhost', title: 'Pending compute' }];
  const [row] = assembleScanRows(visible, markets, /* latest */ []);
  assert.equal(row.has_scan, false);
  assert.equal(row.median_display, '—');
  assert.equal(row.delta_display, null);
  assert.equal(row.confidence_tier, null);
  assert.equal(row.lifecycle_state, null);
});

test('falls back to a HUMANIZED slug as title when the markets row is absent (Bug 7), and emits no raw record', () => {
  const visible = [{ scope: 'personal', org_id: null, market_id: 'how-many-fed-rate-cuts', created_at: '2026-06-20T00:00:00Z' }];
  const latest = [{ market_id: 'how-many-fed-rate-cuts', implied_median: 3.3, confidence_tier: 'low', lifecycle_state: 'RESOLVED', is_final: true, stale_after: null, fetched_at: '2026-06-20T00:00:00Z', record: recWithDelta('-$0.10T', 'down') }];
  const [row] = assembleScanRows(visible, /* markets */ [], latest);
  assert.equal(row.title, 'How Many Fed Rate Cuts'); // cleaned slug, not the raw id
  assert.equal(row.is_final, true);
  assert.equal(row.stale_after, null, 'final rows carry no stale_after');
  assert.ok(!('record' in row), 'the heavy record JSONB is never shipped on a light row');
});

test('binary market renders its headline as a probability %, ladder as $median', () => {
  const visible = [
    { scope: 'personal', org_id: null, market_id: 'bin', created_at: '2026-06-22T00:00:00Z' },
    { scope: 'personal', org_id: null, market_id: 'lad', created_at: '2026-06-21T00:00:00Z' },
  ];
  const markets = [{ id: 'bin', title: 'Recession?', kind: 'binary' }, { id: 'lad', title: 'SpaceX cap', kind: 'threshold_ladder' }];
  const latest = [
    { market_id: 'bin', implied_median: 0.16, confidence_tier: 'low', lifecycle_state: 'OPEN', is_final: false, stale_after: null, fetched_at: '2026-06-22T00:00:00Z', record: {} },
    { market_id: 'lad', implied_median: 2.1, confidence_tier: 'high', lifecycle_state: 'OPEN', is_final: false, stale_after: null, fetched_at: '2026-06-21T00:00:00Z', record: {} },
  ];
  const rows = assembleScanRows(visible, markets, latest);
  const bin = rows.find((r) => r.market_id === 'bin');
  const lad = rows.find((r) => r.market_id === 'lad');
  assert.equal(bin.kind, 'binary');
  assert.equal(bin.median_display, '16%', 'binary headline is a probability %');
  assert.equal(lad.median_display, '$2.10T', 'ladder headline is the $median');
});

test('F7: a categorical market headlines the leading outcome probability (not a bare —)', () => {
  const visible = [{ scope: 'personal', org_id: null, market_id: 'cat', created_at: '2026-06-22T00:00:00Z' }];
  const markets = [{ id: 'cat', title: 'How many Fed cuts?', kind: 'categorical' }];
  // categorical does NOT populate implied_median; the leading outcome lives in the record.
  const latest = [{ market_id: 'cat', implied_median: null, confidence_tier: 'medium', lifecycle_state: 'OPEN', is_final: false, stale_after: null, fetched_at: '2026-06-22T00:00:00Z',
    record: { snapshot: { derived: { dominant_outcome: '0 cuts', dominant_prob: 0.62 } } } }];
  const [row] = assembleScanRows(visible, markets, latest);
  assert.equal(row.median_display, '62%', 'leading-outcome probability, not "—"');
});

test('F3: a ladder whose CDF never crosses 50% shows the honest bound label, not a bare —', () => {
  const visible = [{ scope: 'personal', org_id: null, market_id: 'lad', created_at: '2026-06-22T00:00:00Z' }];
  const markets = [{ id: 'lad', title: 'Cap above', kind: 'threshold_ladder' }];
  // implied_median null + every rung pinned ABOVE 50% → median is above the top strike → "> $X".
  const rungs = [{ threshold: 1, prob: 0.99, adjusted_prob: 0.99 }, { threshold: 2, prob: 0.95, adjusted_prob: 0.95 }];
  const latest = [{ market_id: 'lad', implied_median: null, confidence_tier: 'high', lifecycle_state: 'OPEN', is_final: false, stale_after: null, fetched_at: '2026-06-22T00:00:00Z',
    record: { snapshot: { derived: { markets: rungs } } } }];
  const [row] = assembleScanRows(visible, markets, latest);
  assert.equal(row.median_display, '> $2', 'honest "> $top" label (Bug 5), not a bare "—"');
});

test('empty watchlist yields no rows', () => {
  assert.deepEqual(assembleScanRows([], [], []), []);
});
