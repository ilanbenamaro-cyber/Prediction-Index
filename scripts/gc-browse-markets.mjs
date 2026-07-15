// scripts/gc-browse-markets.mjs — GC for BROWSE markets (INC 6, operator-approved design
// 2026-07-13). "Browse" = served-but-not-watchlisted (see decisions "Browse markets load
// history via a DERIVED model"): every viewed market accretes a markets row + snapshots +
// a full backfilled history, and that set grows without bound. Browse data is CACHE,
// watchlist data is RECORD — so GC deletes whole browse markets and lets the existing
// browse/backfill path regenerate on the next view (proven for OPEN markets by the
// browse→Add reuse design, and for RESOLVED markets by the 2026-07-13 pricesmart
// delete/re-browse experiment: record + all 6 history rows regenerated from live upstream).
//
// A market is GC-eligible iff ALL of:
//   • it appears on NO watchlist (personal ∪ org) — re-checked immediately before delete;
//   • last_checked_at is older than --days (default 30) — protects the browse→Add upgrade
//     path and anything recently viewed;
//   • its id is not in HARD_EXCLUDE (the frozen SpaceX record, belt over suspenders).
// The delete is the markets row; FK cascade clears market_snapshots + market_history.
//
// The cron is untouched by design: its scope stays allWatchedMarketIds() (watchlist tables
// only), so GC adds no reader or writer to that path. Deletes stay operator-gated — an
// unattended path does not get delete authority until this script has earned trust.
//
//   node scripts/gc-browse-markets.mjs [--apply] [--prod] [--days N] [--id <market_id>]
// Default is DRY-RUN. --id targets ONE market (staleness waived; watchlist + exclusion
// still enforced). Exit: 0 done · 1 a delete failed or a watchlist re-check refused · 2 not run.
//
// KNOWN RESIDUAL RACE (accepted v1, operator ruling 2026-07-13 — see gotchas): a watchlist
// insert committing in the window between the per-market re-check and the delete statement
// would be FK-cascade-deleted along with the market. Requires watchlisting a ≥30-day-untouched
// market in that instant. Airtight v2 = scan+delete in one transaction via a migration-defined
// SQL function; not built — cost/benefit.

import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { resolveTarget } from './operator-env.mjs';

// The frozen SpaceX record's markets.id is the EVENT SLUG (dev + prod verified 2026-07-13);
// the internal config id is kept alongside as belt-over-suspenders.
export const HARD_EXCLUDE = new Set(['spacex-ipo-closing-market-cap-above', 'spacex-ipo-market-cap']);
export const DEFAULT_DAYS = 30;

/**
 * Pure eligibility selection — exported so the verify gate asserts the exact rule the
 * script runs. `markets` rows need { id, last_checked_at }; staleness is measured
 * against `now`. `onlyId` waives staleness but never the watchlist/exclusion checks.
 */
export function selectEligible({ markets, watchedIds, now, days = DEFAULT_DAYS, onlyId = null }) {
  const cutoff = now - days * 86_400_000;
  const out = [];
  for (const m of markets) {
    if (onlyId && m.id !== onlyId) continue;
    if (HARD_EXCLUDE.has(m.id)) { if (onlyId) out.push({ ...m, refused: 'hard-excluded' }); continue; }
    if (watchedIds.has(m.id)) { if (onlyId) out.push({ ...m, refused: 'watchlisted' }); continue; }
    const checked = m.last_checked_at ? Date.parse(m.last_checked_at) : 0;
    if (!onlyId && checked >= cutoff) continue; // fresh → protected (browse→Add reuse window)
    out.push(m);
  }
  return out;
}

// supabase-js silently caps un-ranged selects at 1000 rows (red-team INC 7): an
// un-paginated watchlist read past that cap would make a watchlisted market look
// unwatched — a silent-deletion path. Every full-table read here paginates.
async function selectAll(svc, table, columns) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

async function watchedIdSet(svc) {
  const [pw, ow] = await Promise.all([
    selectAll(svc, 'personal_watchlist', 'market_id'),
    selectAll(svc, 'org_watchlist', 'market_id'),
  ]);
  return new Set([...pw, ...ow].map((r) => r.market_id));
}

/** Targeted per-id watchlist check for delete time — immune to pagination by construction. */
async function isWatched(svc, id) {
  const [pw, ow] = await Promise.all([
    svc.from('personal_watchlist').select('*', { count: 'exact', head: true }).eq('market_id', id),
    svc.from('org_watchlist').select('*', { count: 'exact', head: true }).eq('market_id', id),
  ]);
  if (pw.error) throw new Error(`re-check (personal) ${id}: ${pw.error.message}`);
  if (ow.error) throw new Error(`re-check (org) ${id}: ${ow.error.message}`);
  return (pw.count ?? 0) > 0 || (ow.count ?? 0) > 0;
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  let argv = process.argv.slice(2).filter((a) => a !== '--apply');
  const target = resolveTarget(argv);
  argv = target.rest;
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : DEFAULT_DAYS;
  if (!Number.isFinite(days) || days < 1) { console.error(`--days must be a number ≥ 1 (got "${argv[daysIdx + 1]}")`); process.exit(2); }
  const idIdx = argv.indexOf('--id');
  const onlyId = idIdx >= 0 ? argv[idIdx + 1] : null;
  if (idIdx >= 0 && !onlyId) { console.error('--id needs a market id'); process.exit(2); }

  console.log(`${target.banner} · ${APPLY ? 'APPLY' : 'DRY-RUN'} · retention ${days}d${onlyId ? ` · only ${onlyId}` : ''}`);
  const svc = createClient(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let markets;
  try { markets = await selectAll(svc, 'markets', 'id, kind, resolution_status, last_checked_at, config'); }
  catch (e) { console.error(e.message); process.exit(1); }
  const watchedIds = await watchedIdSet(svc);

  const eligible = selectEligible({ markets: markets ?? [], watchedIds, now: Date.now(), days, onlyId });
  if (onlyId && eligible.length === 0) {
    // a targeted call that matches nothing is an operator error, never a silent success
    console.error(`  ${onlyId}: NOT FOUND in markets — nothing to GC`);
    process.exit(1);
  }
  let deleted = 0, refused = 0, failed = 0;

  for (const m of eligible) {
    if (m.refused) { console.error(`  ${m.id}: REFUSED (${m.refused})`); refused++; continue; }
    const [h, s] = await Promise.all([
      svc.from('market_history').select('*', { count: 'exact', head: true }).eq('market_id', m.id),
      svc.from('market_snapshots').select('*', { count: 'exact', head: true }).eq('market_id', m.id),
    ]);
    // RESOLVED markets get their age surfaced: regeneration is proven only inside CLOB's
    // retention horizon (2026-07-13 probe: history exists for markets ending ≥ ~Nov 2023,
    // and is a SILENT HTTP-200-empty for older ones) — the operator must see the risk
    // before typing --apply. See gotchas "browse=cache proven at 4 days post-resolution".
    let life = m.resolution_status ?? 'open';
    if (m.resolution_status === 'resolved') {
      const resolvedAt = Date.parse(m.config?.resolves ?? '');
      life = Number.isFinite(resolvedAt)
        ? `RESOLVED ${Math.round((Date.now() - resolvedAt) / 86_400_000)}d ago`
        : 'RESOLVED, age UNKNOWN — regeneration not guaranteed';
    }
    console.log(`  ${m.id}: ${m.kind ?? '?'} · ${life} · last_checked ${m.last_checked_at ?? 'never'} · history=${h.count ?? '?'} snapshots=${s.count ?? '?'}`);
    if (!APPLY) { deleted++; continue; }

    // delete-time watchlist re-check (the GC invariant: never delete a watchlisted market) —
    // targeted per-id counts, immune to any full-table read truncation
    if (await isWatched(svc, m.id)) { console.error(`    REFUSED: watchlisted since scan — skipping`); refused++; continue; }
    const del = await svc.from('markets').delete().eq('id', m.id).select('id');
    if (del.error) { console.error(`    delete failed: ${del.error.message}`); failed++; continue; }
    const [h2, s2] = await Promise.all([
      svc.from('market_history').select('*', { count: 'exact', head: true }).eq('market_id', m.id),
      svc.from('market_snapshots').select('*', { count: 'exact', head: true }).eq('market_id', m.id),
    ]);
    if ((h2.count ?? -1) !== 0 || (s2.count ?? -1) !== 0) { console.error(`    CASCADE INCOMPLETE: history=${h2.count} snapshots=${s2.count}`); failed++; continue; }
    deleted++;
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${APPLY ? 'deleted' : 'would delete'}=${deleted} · refused=${refused} · failed=${failed} (scanned ${markets?.length ?? 0} markets, ${watchedIds.size} watched)`);
  process.exit(refused || failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
