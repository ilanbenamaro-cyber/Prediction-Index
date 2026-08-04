// test/cron-batch.test.js — the snapshot cron's batch orchestration (lib/cron-batch.mjs), every
// branch, with injected fakes (no DB, no network, no real clock). Mirrors the fake-deps idiom
// from test/serve-market.test.js: a builder returning { deps, calls } so assertions read the
// call counts directly, plus order-recording arrays for the sequencing proofs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSnapshotBatch, POOL_SIZE, BUDGET_EXHAUSTED } from '../lib/cron-batch.mjs';

const STARTED_AT = '2026-08-04T02:00:00.000Z';
const NOW0 = Date.parse(STARTED_AT);
const TODAY = '2026-08-04';
const HOUR = 2;

function okBody() {
  return { record: { snapshot: { fetched_at: STARTED_AT } }, lifecycle_state: 'OPEN' };
}

/** A fake deps builder with call counters + an order log, matching serve-market's idiom. */
function fakeDeps({ ledgerId = 1, snapshotted = new Set(), needingBackfill = [], serveImpl } = {}) {
  const calls = { insertLedgerStart: 0, marketsSnapshottedOn: 0, serve: 0, writeHistory: 0, marketsNeedingBackfill: 0, fireBackfill: 0, updateLedgerFinal: 0 };
  const order = [];
  const finalPatches = [];
  const backfillCalls = [];
  const deps = {
    insertLedgerStart: async (row) => { calls.insertLedgerStart++; order.push('start'); return ledgerId; },
    marketsSnapshottedOn: async () => { calls.marketsSnapshottedOn++; return snapshotted; },
    serve: serveImpl ?? (async (id) => { calls.serve++; order.push(`serve:${id}`); return { status: 200, body: okBody() }; }),
    writeHistory: async () => { calls.writeHistory++; },
    marketsNeedingBackfill: async () => { calls.marketsNeedingBackfill++; return needingBackfill; },
    fireBackfill: async (id) => { calls.fireBackfill++; backfillCalls.push(id); },
    updateLedgerFinal: async (id, patch) => { calls.updateLedgerFinal++; order.push('final'); finalPatches.push(patch); },
  };
  return { deps, calls, order, finalPatches, backfillCalls };
}

// ── 1. Start-row lands BEFORE any serve ─────────────────────────────────────────────────────
test('ledger start row lands before any serve', async () => {
  const { deps, order } = fakeDeps();
  await runSnapshotBatch({ ids: ['a', 'b'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT, deps, now: () => NOW0, budgetMs: 55_000 });
  assert.equal(order[0], 'start');
  assert.ok(order.indexOf('start') < order.indexOf('serve:a'), 'start must precede the first serve');
});

// ── 2. Soft-abort ────────────────────────────────────────────────────────────────────────────
test('soft budget exhausted → remaining ids skipped with marker, no backfill, status truncated, in-flight preserved', async () => {
  let clock = NOW0;
  const { deps, backfillCalls } = fakeDeps({
    needingBackfill: ['x'],
    serveImpl: async (id) => {
      clock += 60_000; // advance the clock past budget once a market is actually served
      return { status: 200, body: okBody() };
    },
  });
  const summary = await runSnapshotBatch({
    ids: ['a', 'b', 'c'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
    deps, now: () => clock, budgetMs: 30_000, // exceeded after the first serve's clock bump
  });
  assert.equal(summary.status, 'truncated');
  const skipped = summary.failures.filter((f) => f.error === BUDGET_EXHAUSTED);
  assert.ok(skipped.length >= 1, 'at least one id must be skipped with the budget marker');
  assert.equal(backfillCalls.length, 0, 'backfill fan-out must never fire on a truncated run');
  assert.ok(summary.success >= 1, 'work already dispatched before exhaustion must still be counted');
  assert.equal(summary.success + skipped.length, 3, 'every id accounted for: served or budget-skipped');
});

// ── 3. Completed path ────────────────────────────────────────────────────────────────────────
test('all served within budget → status completed, counts correct, completed_at set', async () => {
  const { deps, finalPatches } = fakeDeps();
  const summary = await runSnapshotBatch({
    ids: ['a', 'b', 'c'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
    deps, now: () => NOW0, budgetMs: 55_000,
  });
  assert.equal(summary.status, 'completed');
  assert.equal(summary.success, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.failures.length, 0);
  assert.equal(finalPatches.length, 1);
  assert.equal(finalPatches[0].status, 'completed');
  assert.ok(finalPatches[0].completed_at, 'completed_at must be set on the final ledger patch');
});

// ── 4. Ledger final-update throws ────────────────────────────────────────────────────────────
test('ledger final update throws → run still returns its summary, console.error fired, no exception escapes', async () => {
  const { deps } = fakeDeps();
  deps.updateLedgerFinal = async () => { throw new Error('supabase down'); };
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args); };
  let summary;
  try {
    summary = await runSnapshotBatch({
      ids: ['a'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
      deps, now: () => NOW0, budgetMs: 55_000,
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(summary.status, 'completed');
  assert.equal(summary.success, 1);
  assert.equal(errors.length, 1, 'console.error must fire exactly once for the failed ledger update');
  assert.match(errors[0][0], /cron_runs final update FAILED/);
});

// ── 5. Pool concurrency ──────────────────────────────────────────────────────────────────────
test('pool caps in-flight serves at POOL_SIZE with 7 ids', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const serveImpl = async (id) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5)); // real async gap → genuine concurrency
    inFlight--;
    return { status: 200, body: okBody() };
  };
  const { deps } = fakeDeps({ serveImpl });
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const summary = await runSnapshotBatch({
    ids, snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
    deps, now: () => NOW0, budgetMs: 55_000,
  });
  assert.equal(summary.success, 7);
  assert.ok(maxInFlight <= POOL_SIZE, `max in-flight ${maxInFlight} must not exceed POOL_SIZE (${POOL_SIZE})`);
  assert.equal(POOL_SIZE, 3, 'pin the documented pool size — a change here is an intentional constant bump');
});

// ── 6. Failures don't abort the batch ───────────────────────────────────────────────────────
test('one serve rejects → counted failed, others still served', async () => {
  const serveImpl = async (id) => {
    if (id === 'b') throw new Error('upstream 502');
    return { status: 200, body: okBody() };
  };
  const { deps } = fakeDeps({ serveImpl });
  const summary = await runSnapshotBatch({
    ids: ['a', 'b', 'c'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
    deps, now: () => NOW0, budgetMs: 55_000,
  });
  assert.equal(summary.status, 'completed');
  assert.equal(summary.success, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].id, 'b');
  assert.match(summary.failures[0].error, /upstream 502/);
});

// ── dedup guard (today's behavior, preserved) ────────────────────────────────────────────────
test('dedup guard skips already-snapshotted ids, never calls serve for them', async () => {
  const { deps, calls } = fakeDeps({ snapshotted: new Set(['a']) });
  const summary = await runSnapshotBatch({
    ids: ['a', 'b'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
    deps, now: () => NOW0, budgetMs: 55_000,
  });
  assert.equal(summary.skipped_already, 1);
  assert.equal(calls.serve, 1, 'only the non-snapshotted id is served');
  assert.equal(summary.success, 1);
});

// ── RESOLVED markets are skipped, not written ───────────────────────────────────────────────
test('a RESOLVED serve is counted skipped_resolved and never written to history', async () => {
  const serveImpl = async () => ({ status: 200, body: { record: {}, lifecycle_state: 'RESOLVED' } });
  const { deps, calls } = fakeDeps({ serveImpl });
  const summary = await runSnapshotBatch({
    ids: ['a'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
    deps, now: () => NOW0, budgetMs: 55_000,
  });
  assert.equal(summary.skipped_resolved, 1);
  assert.equal(summary.success, 0);
  assert.equal(calls.writeHistory, 0);
});

// ── backfill fan-out fires only when budget remains, capped at 10 ──────────────────────────
test('backfill fan-out fires when budget remains, and only for markets needing it', async () => {
  const { deps, backfillCalls } = fakeDeps({ needingBackfill: ['x', 'y'] });
  const summary = await runSnapshotBatch({
    ids: ['a'], snapshotHour: HOUR, today: TODAY, startedAt: STARTED_AT,
    deps, now: () => NOW0, budgetMs: 55_000,
  });
  assert.equal(summary.status, 'completed');
  assert.deepEqual(backfillCalls, ['x', 'y']);
  assert.deepEqual(summary.backfill_retried, ['x', 'y']);
});
