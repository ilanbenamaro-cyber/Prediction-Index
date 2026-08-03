// test/backfill.test.js — the backfill orchestrator (I3), with all I/O injected.
//
// backfillMarket() is the read→reconstruct→assemble→write loop; like serve-market.mjs it takes
// its I/O as deps so every branch is deterministic without network/DB: a mocked meta + per-token
// histories flow through the REAL reconstruction (core/price-history) + REAL assembler
// (lib/backfill-record) into a mock writer. Asserts: idempotent precedence (a writer that
// reports "exists" never counts), one bad day never aborts the batch, and status transitions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleBackfillRecords, backfillMarket } from '../lib/backfill.mjs';
import { defaultConfigForLadder } from '../core/market-config.js';

const ladderMeta = () => ({
  kind: 'survival',
  config: defaultConfigForLadder([1, 1.5, 2], { id: 'lad', event_slug: 'lad', name: 'Ladder', unit_prefix: '$', unit_suffix: 'T' }),
  legs: [
    { token_id: 'A', threshold: 1, label: '>$1T' },
    { token_id: 'B', threshold: 1.5, label: '>$1.5T' },
    { token_id: 'C', threshold: 2, label: '>$2T' },
  ],
  tokenIds: ['A', 'B', 'C'],
});
const D = (date, p) => ({ t: Math.floor(Date.parse(`${date}T00:00:05Z`) / 1000), p });

test('assembleBackfillRecords: one record per computable date, incomplete days skipped', () => {
  const meta = ladderMeta();
  const rows = [
    { date: '2026-01-01', prices: { A: 0.9, B: 0.6, C: 0.3 }, filled: {}, complete: true },
    { date: '2026-01-02', prices: { A: 0.91 }, filled: {}, complete: false }, // only 1 leg → still builds (1 rung)
  ];
  const out = assembleBackfillRecords(meta, rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].date, '2026-01-01');
  assert.equal(out[0].record.snapshot.derived.markets.length, 3);
  assert.equal(out[1].record.snapshot.derived.markets.length, 1);
});

test('backfillMarket: reconstructs from histories and writes one row per day; status → done', async () => {
  const writes = [];
  const statuses = [];
  const deps = {
    fetchMeta: async () => ladderMeta(),
    fetchHistory: async (tok) => ({
      A: [D('2026-01-01', 0.90), D('2026-01-02', 0.92)],
      B: [D('2026-01-01', 0.60), D('2026-01-02', 0.62)],
      C: [D('2026-01-01', 0.30), D('2026-01-02', 0.32)],
    })[tok],
    writeRow: async (slug, date, record) => { writes.push({ date, sha: record.snapshot.source.raw_sha256 }); return true; },
    setStatus: async (slug, status, through) => { statuses.push({ status, through }); },
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn() {}, error() {} } });
  assert.equal(res.written, 2);
  assert.equal(res.failed, 0);
  assert.deepEqual(writes.map((w) => w.date), ['2026-01-01', '2026-01-02']);
  assert.equal(statuses[0].status, 'pending');
  assert.equal(statuses.at(-1).status, 'done');
  assert.equal(statuses.at(-1).through, '2026-01-01'); // earliest written
});

test('backfillMarket: a writer reporting "exists" (cron precedence) is not counted, no error', async () => {
  const deps = {
    fetchMeta: async () => ladderMeta(),
    fetchHistory: async (tok) => ({
      A: [D('2026-01-01', 0.90)], B: [D('2026-01-01', 0.60)], C: [D('2026-01-01', 0.30)],
    })[tok],
    writeRow: async () => false, // row already present (cron) → ignoreDuplicates reported it
    setStatus: async () => {},
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn() {}, error() {} } });
  assert.equal(res.written, 0);
  assert.equal(res.failed, 0);
});

test('backfillMarket: one failing write does not abort the batch', async () => {
  let n = 0;
  const warns = [];
  const deps = {
    fetchMeta: async () => ladderMeta(),
    fetchHistory: async (tok) => ({
      A: [D('2026-01-01', 0.90), D('2026-01-02', 0.92)],
      B: [D('2026-01-01', 0.60), D('2026-01-02', 0.62)],
      C: [D('2026-01-01', 0.30), D('2026-01-02', 0.32)],
    })[tok],
    writeRow: async () => { n++; if (n === 1) throw new Error('transient db error'); return true; },
    setStatus: async () => {},
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn: (m) => warns.push(m), error() {} } });
  assert.equal(res.written, 1);   // the second day still wrote
  assert.equal(res.failed, 1);
  assert.equal(warns.length, 1);
});

test('backfillMarket: every leg throws (total outage) → status failed (retryable), not done', async () => {
  const statuses = [];
  const deps = {
    fetchMeta: async () => ladderMeta(),
    fetchHistory: async () => { throw new Error('CLOB 502'); },
    writeRow: async () => true,
    setStatus: async (slug, status, through) => { statuses.push({ status, through }); },
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn() {}, error() {} } });
  assert.equal(res.written, 0);
  assert.equal(res.failed, 0);
  assert.equal(res.days, 0);
  assert.equal(statuses.at(-1).status, 'failed');
});

test('backfillMarket: every leg answers empty (genuinely never traded) → status no_history, terminal', async () => {
  const statuses = [];
  const deps = {
    fetchMeta: async () => ladderMeta(),
    fetchHistory: async () => [], // all 3 legs answer 200 with empty history
    writeRow: async () => true,
    setStatus: async (slug, status, through) => { statuses.push({ status, through }); },
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn() {}, error() {} } });
  assert.equal(res.written, 0);
  assert.equal(res.failed, 0);
  assert.equal(res.days, 0);
  assert.equal(statuses.at(-1).status, 'no_history');
});

test('backfillMarket: mixed — one leg throws, the rest answer empty → status failed (any error is retryable)', async () => {
  const statuses = [];
  let calls = 0;
  const deps = {
    fetchMeta: async () => ladderMeta(),
    fetchHistory: async () => {
      calls++;
      if (calls === 1) throw new Error('CLOB 500');
      return [];
    },
    writeRow: async () => true,
    setStatus: async (slug, status, through) => { statuses.push({ status, through }); },
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn() {}, error() {} } });
  assert.equal(res.written, 0);
  assert.equal(res.days, 0);
  assert.equal(statuses.at(-1).status, 'failed');
});

test('backfillMarket: already-complete (real rows, but every write is a dup) → status done, byte-identical branch', async () => {
  const statuses = [];
  const deps = {
    fetchMeta: async () => ladderMeta(),
    fetchHistory: async (tok) => ({
      A: [D('2026-01-01', 0.90)], B: [D('2026-01-01', 0.60)], C: [D('2026-01-01', 0.30)],
    })[tok],
    writeRow: async () => false, // real assembled row, but the write reports "already present"
    setStatus: async (slug, status, through) => { statuses.push({ status, through }); },
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn() {}, error() {} } });
  assert.equal(res.written, 0);
  assert.equal(res.failed, 0);
  assert.ok(res.days > 0); // assembled non-empty
  assert.equal(statuses.at(-1).status, 'done');
});

test('backfillMarket: a fatal fetch error marks the market failed, never throws', async () => {
  const statuses = [];
  const deps = {
    fetchMeta: async () => { throw new Error('gamma 500'); },
    fetchHistory: async () => [],
    writeRow: async () => true,
    setStatus: async (slug, status) => { statuses.push(status); },
  };
  const res = await backfillMarket({ slug: 'lad', deps, log: { warn() {}, error() {} } });
  assert.equal(res.written, 0);
  assert.ok(res.error);
  assert.equal(statuses.at(-1), 'failed');
});

// ── bucketBackfillMeta (percent-bucket support — the synthetic floor + rung rule + unit prefix
//    that mirror the LIVE path; the old inline shaping hashed a raw -Infinity threshold) ────────
import { bucketBackfillMeta } from '../lib/backfill.mjs';

test('bucketBackfillMeta: percent bucket — open-bottom leg gets the live path\'s synthetic finite floor', () => {
  const m = {
    title: 'UK GDP growth', end_date: '2026-12-31T00:00:00Z',
    unitInfo: { divisor: 1, unit: '%' },
    legs: [
      { token_id: 'p0', lo: -Infinity, hi: 0 }, // "below 0%"
      { token_id: 'p1', lo: 0, hi: 1 },
      { token_id: 'p2', lo: 1, hi: 2 },
      { token_id: 'p3', lo: 2, hi: Infinity },  // "2% or higher"
    ],
  };
  const meta = bucketBackfillMeta(m, 'uk-gdp');
  // synthetic floor = minFiniteLo (0) − medianWidth (1) = -1 — FINITE, hashable, mirrors core/fetch.js
  assert.equal(meta.legs[0].lo, -1);
  assert.ok(meta.legs.every((l) => Number.isFinite(l.lo)));
  // percent config: no '$' prefix (the old inline version hardcoded '$')
  assert.equal(meta.config.threshold.unit_prefix, '');
  assert.equal(meta.config.threshold.unit_suffix, '%');
  // rung rule keeps 0 (a "below 0%" leg sits underneath) — the old `v > 0` filter dropped it
  assert.ok(meta.config.tracked_thresholds.length > 0);
});

test('bucketBackfillMeta: dollar bucket — boundaries + prefix byte-identical to the old shaping', () => {
  const m = {
    title: 'BTC weekly', end_date: null,
    unitInfo: { divisor: 1e3, unit: 'K' },
    legs: [
      { token_id: 'b0', lo: 0, hi: 60_000 },      // "less than $60K" → dollar floor 0
      { token_id: 'b1', lo: 60_000, hi: 62_000 },
      { token_id: 'b2', lo: 62_000, hi: 64_000 },
      { token_id: 'b3', lo: 64_000, hi: Infinity },
    ],
  };
  const meta = bucketBackfillMeta(m, 'btc');
  assert.deepEqual(meta.legs.map((l) => l.lo), [0, 60, 62, 64]);
  assert.equal(meta.config.threshold.unit_prefix, '$');
  // the rung rule drops the dollar 0 floor exactly like the old `v > 0` filter (nothing below it)
  const ladderSize = meta.config.confidence.ladder_size;
  assert.equal(ladderSize, 3); // rungs [60, 62, 64]
});
