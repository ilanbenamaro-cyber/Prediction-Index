// scripts/verify-phase2a.mjs — live verification of the DEPLOYED Phase 2a stack.
//
// Run AFTER deploy + seed, with the Vercel URL (and, for the resolution-trap
// check, the service-role creds) in env:
//   BASE_URL=https://your.vercel.app \
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   node scripts/verify-phase2a.mjs
//
// Proves, against the real function + cache:
//   1. an OPEN ladder returns a core/-validated, re-hash-verified record;
//   2. a 2nd call within TTL is served from cache (cached:true);
//   3. SpaceX returns the seeded frozen RESOLVED record;
//   4. (creds-gated) a market that resolved AFTER caching is NOT served stale-live.
// Exits non-zero on any failure.

import { hashRawInputs } from '../core/fetch.js';

const BASE = process.env.BASE_URL;
if (!BASE) { console.error('Set BASE_URL=https://your-deployment.vercel.app'); process.exit(2); }
const OPEN_MARKET = process.env.OPEN_MARKET || 'kraken-ipo-closing-market-cap-above';
const SPACEX = 'spacex-ipo-closing-market-cap-above';
// Optional Vercel deployment-protection bypass for automation: if the secret is
// present, send the header so a PROTECTED preview is reachable WITHOUT disabling
// the wall for humans. No-op (no header) when absent — behavior is unchanged.
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const FETCH_OPTS = BYPASS ? { headers: { 'x-vercel-protection-bypass': BYPASS } } : {};

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };
const get = async (id) => {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/market?id=${encodeURIComponent(id)}`, FETCH_OPTS);
  const body = await res.json();
  return { status: res.status, body, ms: Date.now() - t0 };
};
const bucketsSumToOne = (m) => Math.abs((1 - m[0].adjusted_prob) + m.reduce((s, x) => s + x.bucket_prob, 0) - 1) < 1e-6;
const monotone = (m) => m.every((x, i) => i === 0 || x.adjusted_prob <= m[i - 1].adjusted_prob + 1e-9);

console.log(`\nPhase 2a live verification → ${BASE}\n`);

// ── C1: OPEN market returns a verified, re-hash-checked record ──
console.log(`C1: OPEN market (${OPEN_MARKET}) returns a verified record`);
{
  const { status, body } = await get(OPEN_MARKET);
  ok(status === 200, `HTTP 200 (got ${status})`);
  if (status === 200) {
    const rec = body.record;
    const d = rec.snapshot.derived;
    ok(rec.snapshot.source.raw_sha256 === hashRawInputs(rec.snapshot.raw_inputs), 'raw_sha256 re-hash matches (provenance intact)');
    ok(monotone(d.markets), 'adjusted CDF monotone non-increasing');
    ok(bucketsSumToOne(d.markets), 'bucket probabilities sum to 1.0');
    // Split confidence (schema 2.0.0): { reliability, liquidity }, each { tier, score, reasons }.
    const tiers = ['high', 'medium', 'low'];
    ok(tiers.includes(d.confidence?.reliability?.tier) && tiers.includes(d.confidence?.liquidity?.tier),
      `confidence computed (reliability ${d.confidence?.reliability?.tier} · liquidity ${d.confidence?.liquidity?.tier})`);
    ok(body.lifecycle_state === 'OPEN', `lifecycle OPEN (got ${body.lifecycle_state})`);
    ok(d.scenarios === undefined, 'no Tier-2 scenarios on a generic market');
  }
}

// ── C2: second call within TTL is served from cache ──
console.log('\nC2: second call within TTL is served from cache');
{
  await get(OPEN_MARKET); // ensure cached
  const { body } = await get(OPEN_MARKET);
  ok(body.cached === true, `cached:true on repeat (got ${body.cached})`);
}

// ── C3: SpaceX returns the seeded frozen RESOLVED record ──
console.log('\nC3: SpaceX served frozen RESOLVED (no live pull)');
{
  const { status, body } = await get(SPACEX);
  ok(status === 200, `HTTP 200 (got ${status})`);
  ok(body.lifecycle_state === 'RESOLVED', `lifecycle RESOLVED (got ${body.lifecycle_state})`);
  ok(body.cached === true, 'served from cache (seeded)');
  ok(Array.isArray(body.record?.snapshot?.lifecycle?.resolved_outcome), 'carries a resolved_outcome');
}

// ── C4 (creds-gated): a market that resolved AFTER caching is NOT served stale-live ──
console.log('\nC4: cache×resolution — a since-resolved market is never served stale-live');
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  // Poison the cache: claim SpaceX is OPEN with a recent cached_at + a stale probe time.
  const recent = new Date(Date.now() - 60_000).toISOString();
  const longAgo = new Date(Date.now() - 3600_000).toISOString();
  const real = (await db.from('market_latest').select('record').eq('market_id', SPACEX).maybeSingle()).data?.record;
  if (!real) { ok(false, 'SpaceX must be seeded first (run scripts/seed-spacex.mjs)'); }
  else {
    await db.from('market_snapshots').insert({
      market_id: SPACEX, fetched_at: recent, cached_at: recent, raw_sha256: real.snapshot.source.raw_sha256,
      schema_version: real.schema_version, methodology_version: real.methodology_version,
      lifecycle_state: 'OPEN', is_final: false, record: real,
    });
    await db.from('markets').update({ resolution_status: 'open', last_checked_at: longAgo }).eq('id', SPACEX);
    const { body } = await get(SPACEX); // probe must detect RESOLVED → refuse OPEN
    ok(body.lifecycle_state === 'RESOLVED', `probe caught resolution; served RESOLVED not OPEN (got ${body.lifecycle_state})`);
    // cleanup: drop the synthetic OPEN row
    await db.from('market_snapshots').delete().eq('market_id', SPACEX).eq('fetched_at', recent);
    await db.from('markets').update({ resolution_status: 'resolved' }).eq('id', SPACEX);
  }
} else {
  console.log('  – skipped (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run the resolution-trap check)');
}

console.log(`\n${failures === 0 ? '✓ all live checks passed' : `✗ ${failures} live check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
