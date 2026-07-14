// scripts/verify-gc-browse.mjs — INC 6 GATE: browse-market GC selects ONLY stale
// non-watchlisted markets and its delete path preserves everything it must never touch.
//
// Proves, against a real DEV Supabase, the four-fixture matrix from the approved design:
//   A watchlisted+stale  → NEVER selected; --id apply against it REFUSES (exit 1), history
//                          byte-identical after (THE invariant: never delete a watchlisted
//                          market's history);
//   B browse+fresh       → not selected (inside the retention window = browse→Add protection);
//   C browse+stale       → selected by the full scan AND deleted by --id apply, FK cascade
//                          verified (markets/history/snapshots all 0);
//   D frozen SpaceX id   → hard-excluded even when synthetically stale (pure-function assert
//                          + a DRY-RUN --id refusal; apply is never pointed at the real id).
// Selection asserts run through the SAME exported selectEligible the script executes, plus a
// real child-process dry-run over the live table — so the gate cannot drift from the tool.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/verify-gc-browse.mjs
// Exit: 0 pass · 1 a check failed · 2 not run (missing creds). Fixtures are self-cleaning.

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { selectEligible, HARD_EXCLUDE, DEFAULT_DAYS } from './gc-browse-markets.mjs';

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (dev project), then re-run.');
  process.exit(2);
}

const RUN = Date.now().toString(36);
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };
const HEX64 = 'a'.repeat(64);
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

// Minimal valid record for writeRecord + a history row payload.
const rec = (fetchedAt) => ({
  schema_version: '1.2.1', methodology_version: '1.4.0', assumptions_version: '1.0.0',
  snapshot: {
    fetched_at: fetchedAt, source: { raw_sha256: HEX64 },
    derived: { implied_median: 1.0, confidence: { tier: 'high' }, freshness: { stale_after: null } },
  },
});

const created = { orgs: [], markets: [] };
async function seedMarket(id, staleDays) {
  created.markets.push(id);
  const { writeRecord } = await import('../lib/cache.mjs');
  await writeRecord(id, rec(daysAgo(staleDays)), { state: 'OPEN', resolved_outcome: null }, { name: id });
  const h = await svc.from('market_history').insert([
    { market_id: id, snapshot_date: daysAgo(staleDays).slice(0, 10), snapshot_hour: 0, kind: 'survival', record: rec(daysAgo(staleDays)) },
    { market_id: id, snapshot_date: daysAgo(staleDays + 1).slice(0, 10), snapshot_hour: 0, kind: 'survival', record: rec(daysAgo(staleDays + 1)) },
  ]);
  if (h.error) throw new Error(`seed history ${id}: ${h.error.message}`);
  // writeRecord stamps last_checked_at=now; backdate to make the fixture stale
  if (staleDays > 0) {
    const u = await svc.from('markets').update({ last_checked_at: daysAgo(staleDays) }).eq('id', id);
    if (u.error) throw new Error(`backdate ${id}: ${u.error.message}`);
  }
}

const gc = (...args) => spawnSync('node', ['scripts/gc-browse-markets.mjs', ...args],
  { env: process.env, encoding: 'utf8' });

async function cleanup() {
  if (created.orgs.length) await svc.from('organizations').delete().in('id', created.orgs);
  if (created.markets.length) await svc.from('markets').delete().in('id', created.markets);
}

async function run() {
  console.log(`\nGC-browse gate → ${URL}  (run ${RUN})\n`);
  const A = `gcv-${RUN}-watch-stale`, B = `gcv-${RUN}-browse-fresh`, C = `gcv-${RUN}-browse-stale`;
  await seedMarket(A, 40);
  await seedMarket(B, 0);
  await seedMarket(C, 40);
  const org = await svc.from('organizations').insert({ name: `GCV_${RUN}` }).select('id').single();
  if (org.error) throw new Error(`seed org: ${org.error.message}`);
  created.orgs.push(org.data.id);
  const w = await svc.from('org_watchlist').insert({ org_id: org.data.id, market_id: A, added_by: null });
  if (w.error) throw new Error(`seed watchlist: ${w.error.message}`);

  console.log('— selection (pure function over live rows + synthetic SpaceX) —');
  const { data: markets, error } = await svc.from('markets').select('id, kind, resolution_status, last_checked_at');
  if (error) throw new Error(`read markets: ${error.message}`);
  const [pw, ow] = await Promise.all([
    svc.from('personal_watchlist').select('market_id'), svc.from('org_watchlist').select('market_id'),
  ]);
  const watched = new Set([...(pw.data ?? []), ...(ow.data ?? [])].map((r) => r.market_id));
  const withSpacex = [...markets, { id: 'spacex-ipo-closing-market-cap-above', last_checked_at: daysAgo(400) }];
  const picked = new Set(selectEligible({ markets: withSpacex, watchedIds: watched, now: Date.now(), days: DEFAULT_DAYS }).map((m) => m.id));
  ok(picked.has(C), 'C (browse+stale) is selected');
  ok(!picked.has(A), 'A (watchlisted+stale) is NOT selected');
  ok(!picked.has(B), 'B (browse+fresh) is NOT selected');
  ok(!picked.has('spacex-ipo-closing-market-cap-above'), 'frozen SpaceX id is NOT selected even when stale');
  ok(HARD_EXCLUDE.has('spacex-ipo-closing-market-cap-above') && HARD_EXCLUDE.has('spacex-ipo-market-cap'),
    'hard-exclusion list pins the frozen id (event slug + internal config id)');
  // an id-pinned guard must guard a row that EXISTS — the original HARD_EXCLUDE pinned the
  // config id, which is not a markets row, and only the watchlist check stood between GC
  // and the frozen record (see gotchas "markets.id is the EVENT SLUG")
  ok(markets.some((m) => m.id === 'spacex-ipo-closing-market-cap-above'),
    'HARD_EXCLUDE primary id exists as a real markets row (guard points at something)');

  console.log('— full-scan DRY-RUN (child process, no writes) —');
  const dry = gc();
  ok(dry.status === 0, `dry-run exits 0 (got ${dry.status})`);
  ok(dry.stdout.includes(C), 'dry-run lists C');
  ok(!dry.stdout.includes(A), 'dry-run does not list A');
  ok(!dry.stdout.includes(B), 'dry-run does not list B');

  console.log('— refusals —');
  const before = await svc.from('market_history').select('snapshot_date, snapshot_hour, kind, record').eq('market_id', A).order('snapshot_date');
  const refA = gc('--id', A, '--apply');
  ok(refA.status === 1, `--id A --apply exits 1 (got ${refA.status})`);
  ok((refA.stdout + refA.stderr).includes('watchlisted'), 'A refusal names the watchlist');
  const refD = gc('--id', 'spacex-ipo-closing-market-cap-above'); // DRY-RUN on purpose — never apply at the real id
  ok(refD.status === 1, `--id spacex (dry-run) exits 1 (got ${refD.status})`);
  ok((refD.stdout + refD.stderr).includes('hard-excluded'), 'SpaceX refusal names the exclusion');
  // a targeted call that matches nothing must be LOUD — the original script exited 0 silently
  // (red-team INC 7): on a delete tool, "nothing matched" is an operator error, never a success
  const refN = gc('--id', `gcv-${RUN}-does-not-exist`, '--apply');
  ok(refN.status === 1, `--id <nonexistent> --apply exits 1 (got ${refN.status})`);
  ok((refN.stdout + refN.stderr).includes('NOT FOUND'), 'no-match refusal says NOT FOUND');

  console.log('— delete path (C) + invariant (A intact) —');
  const del = gc('--id', C, '--apply');
  ok(del.status === 0, `--id C --apply exits 0 (got ${del.status})`);
  const [cm, ch, cs] = await Promise.all([
    svc.from('markets').select('*', { count: 'exact', head: true }).eq('id', C),
    svc.from('market_history').select('*', { count: 'exact', head: true }).eq('market_id', C),
    svc.from('market_snapshots').select('*', { count: 'exact', head: true }).eq('market_id', C),
  ]);
  ok(cm.count === 0 && ch.count === 0 && cs.count === 0, `C fully cascaded (markets=${cm.count} history=${ch.count} snapshots=${cs.count})`);
  const after = await svc.from('market_history').select('snapshot_date, snapshot_hour, kind, record').eq('market_id', A).order('snapshot_date');
  ok(JSON.stringify(after.data) === JSON.stringify(before.data) && (before.data?.length ?? 0) === 2,
    `A history byte-identical after GC (${before.data?.length} rows)`);

  if (failures) console.error(`\n✗ GC-BROWSE GATE FAILED — ${failures} check(s)`);
  else console.log('\n✓ GC-BROWSE GATE PASSED — selection exact, refusals loud, cascade clean, watched history untouched');
}

run().catch((e) => { console.error(`\n✗ gate error: ${e.message}`); failures++; })
  .finally(async () => { await cleanup(); process.exit(failures ? 1 : 0); });
