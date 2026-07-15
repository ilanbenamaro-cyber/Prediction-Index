// scripts/reconstruct-guarded-history.mjs — HISTORY REMEDIATION for the 5.6 exclusivity
// guard (operator-approved splice disposition, 2026-07-13).
//
// Pre-guard history rows on non-exclusive boards carry a FABRICATED derived layer (the
// unconditional de-vig). Their RAW observations are true — so rather than purge, this
// script RECONSTRUCTS each row's `record.snapshot.derived` in place under the guard:
//   • verdict assessed ONCE per market from CURRENT gamma leg wording/endDates (labels
//     are the stable join key — old records didn't store leg questions);
//   • each row rebuilt from ITS OWN raw outcomes via buildCategoricalRecord;
//   • raw_inputs + raw_sha256 byte-untouched (derived is never hashed — provenance intact);
//   • promoted columns (dominant_*, confidence tiers) refreshed to match;
//   • rows already carrying derived.exclusivity are skipped (idempotent);
//   • a row whose record lacks reconstructable outcomes is PURGED (counted, reported).
//
//   node scripts/reconstruct-guarded-history.mjs [--apply] [--prod]
// Default is DRY-RUN (prints what would change). --prod targets .env.prod via the
// shared resolveTarget (dev = shell env). Exit: 0 done · 1 error · 2 not run.

import { createClient } from '@supabase/supabase-js';
import { resolveTarget } from './operator-env.mjs';
import { assessExclusivity, buildCategoricalRecord } from '../core/categorical.js';

const APPLY = process.argv.includes('--apply');
const argv = process.argv.slice(2).filter((a) => a !== '--apply');
const target = resolveTarget(argv);
console.log(`${target.banner} · ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
const svc = createClient(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

/** label → { question, leg_end_date } from current gamma (labels are stable across a board's life). */
async function legMap(slug) {
  const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const ev = res.ok ? (await res.json())[0] : null;
  const map = new Map();
  for (const m of ev?.markets ?? []) {
    const label = (m.groupItemTitle != null && String(m.groupItemTitle).trim()) || m.question;
    map.set(label, { question: m.question ?? null, leg_end_date: m.endDate ?? null });
  }
  return map;
}

const { data: markets, error } = await svc.from('markets').select('id').eq('kind', 'categorical');
if (error) { console.error(error.message); process.exit(1); }

let reconstructed = 0, skippedGuardless = 0, alreadyGuarded = 0, purged = 0;
for (const m of markets) {
  const legs = await legMap(m.id);
  if (legs.size === 0) { console.log(`  ${m.id}: no gamma event — SKIP (cannot assess)`); continue; }
  const { data: rows, error: hErr } = await svc.from('market_history')
    .select('market_id, snapshot_date, snapshot_hour, record').eq('market_id', m.id);
  if (hErr) { console.error(`  ${m.id}: history read failed: ${hErr.message}`); continue; }
  if (!rows?.length) continue;

  // one market-level verdict from current wording + a representative row's raw probs
  const probe = rows[rows.length - 1].record?.snapshot?.derived?.outcomes ?? [];
  const probeLegs = probe.map((o) => ({
    label: o.label, prob: o.raw_probability ?? o.probability ?? null, volume: o.volume ?? 0,
    ...(legs.get(o.label) ?? {}),
  }));
  const verdict = assessExclusivity(probeLegs).verdict;
  if (verdict === 'exclusive') { skippedGuardless += rows.length; continue; }
  console.log(`  ${m.id}: verdict ${verdict} → ${rows.length} row(s)`);

  for (const row of rows) {
    const rec = row.record;
    const d = rec?.snapshot?.derived;
    if (d?.exclusivity) { alreadyGuarded++; continue; }
    const outs = d?.outcomes ?? [];
    if (!outs.length || !rec?.snapshot?.fetched_at) {
      purged++;
      console.log(`    ${row.snapshot_date}/${row.snapshot_hour}: unreconstructable → PURGE`);
      if (APPLY) await svc.from('market_history').delete()
        .match({ market_id: row.market_id, snapshot_date: row.snapshot_date, snapshot_hour: row.snapshot_hour });
      continue;
    }
    const live = {
      fetched_at: rec.snapshot.fetched_at,
      endpoints: rec.snapshot.source?.endpoints ?? [],
      raw_inputs: rec.snapshot.raw_inputs ?? [],
      raw_sha256: rec.snapshot.source?.raw_sha256 ?? null,
      outcomes: outs.map((o) => ({
        label: o.label, prob: o.raw_probability ?? o.probability ?? 0,
        volume: o.volume ?? null, midpoint_source: o.midpoint_source ?? null,
        ...(legs.get(o.label) ?? {}),
      })),
      total_volume: d.total_volume ?? 0,
      ...(d.liquidity ? { liquidity: d.liquidity } : {}),
    };
    const config = {
      id: rec.asset?.id ?? row.market_id, name: rec.asset?.name ?? row.market_id,
      platform: rec.asset?.platform ?? 'Polymarket', market_url: rec.asset?.market_url ?? '',
      resolves: rec.asset?.resolves ?? null,
    };
    const rebuilt = buildCategoricalRecord(live, '1.8.0', config, rec.snapshot.lifecycle ?? null);
    // provenance invariant: the raw layer must be byte-identical
    if (JSON.stringify(rebuilt.snapshot.raw_inputs) !== JSON.stringify(rec.snapshot.raw_inputs)
        || rebuilt.snapshot.source.raw_sha256 !== rec.snapshot.source?.raw_sha256) {
      console.error(`    ${row.snapshot_date}: RAW LAYER CHANGED — refusing`); process.exit(1);
    }
    const nd = rebuilt.snapshot.derived;
    reconstructed++;
    if (APPLY) {
      const { error: uErr } = await svc.from('market_history').update({
        record: rebuilt,
        dominant_outcome: nd.exclusivity?.headline?.label ?? null,
        dominant_prob: nd.exclusivity?.headline?.raw_probability ?? null,
        reliability_tier: nd.confidence?.reliability?.tier ?? null,
        reliability_score: nd.confidence?.reliability?.score ?? null,
        liquidity_tier: nd.confidence?.liquidity?.tier ?? null,
        liquidity_score: nd.confidence?.liquidity?.score ?? null,
      }).match({ market_id: row.market_id, snapshot_date: row.snapshot_date, snapshot_hour: row.snapshot_hour });
      if (uErr) { console.error(`    ${row.snapshot_date}: update failed: ${uErr.message}`); process.exit(1); }
    }
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: reconstructed=${reconstructed} · purged=${purged} · already-guarded=${alreadyGuarded} · exclusive-boards-skipped=${skippedGuardless} rows`);
