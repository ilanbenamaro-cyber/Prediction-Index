// scripts/verify-2c3-detail.mjs — Phase 2c.3 GATE (data layer): the detail view's
// data source is correct, so the rendered fields can't drift from the record.
//
// The detail Server Component renders VERBATIM from what serveMarket() returns, so this
// asserts that authoritative serve at the data layer (headless), against the real frozen
// SpaceX record on dev. The UI half (render of these fields, the SVG distribution, the
// states, and the in-browser hash-verify ✓) is a Playwright flow run against the dev
// server — same split as 2c.1/2c.2 (the authed detail can't be fetched headlessly).
//
// Proves: (1) RESOLVED served FINAL from cache — cached:true, NO live re-pull (the
// inverse-falsification: the detail consumed the authoritative cache-final serve);
// (2) the record carries every field the detail renders (asset, ladder, confidence,
// resolved_outcome, raw_sha256); (3) the in-browser verify WILL pass (hash recipe).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/verify-2c3-detail.mjs
// Exit: 0 pass · 1 a check failed · 2 not run (missing creds).

import { createHash } from 'node:crypto';
import { serveMarket } from '../lib/serve-market.mjs';
import { DEPS } from '../lib/market-deps.mjs';
import { canonicalizeRawInputs } from '../core/fetch.js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (dev project).');
  process.exit(2);
}
const SPACEX = process.env.SPACEX_ID || 'spacex-ipo-closing-market-cap-above';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };

async function run() {
  console.log(`\nPhase 2c.3 detail data-layer gate → ${process.env.SUPABASE_URL}\n`);
  const { status, body } = await serveMarket({ id: SPACEX, deps: DEPS });
  ok(status === 200, `serveMarket(SpaceX) → 200 (got ${status})`);
  if (status !== 200) return;
  const rec = body.record, s = rec.snapshot, d = s.derived;

  console.log('INVERSE-FALSIFICATION — RESOLVED served frozen/final from cache, not re-pulled:');
  ok(body.cached === true, `served from cache (cached:true)`);
  ok(body.lifecycle_state === 'RESOLVED' && s.lifecycle?.state === 'RESOLVED', `lifecycle RESOLVED`);
  ok(Array.isArray(s.lifecycle?.resolved_outcome) && s.lifecycle.resolved_outcome.length > 0,
    `frozen resolved_outcome present (${s.lifecycle?.resolved_outcome?.length} legs)`);

  console.log('\nFIELD COVERAGE — the detail renders these verbatim (no drift possible):');
  ok(!!rec.asset?.name, `asset.name present ("${rec.asset?.name}")`);
  ok(typeof d.implied_median === 'number', `implied_median present (${d.implied_median})`);
  ok(typeof d.implied_mean === 'number', `implied_mean present`);
  // post-0010 confidence split: {reliability, liquidity} each with {tier, reasons}
  // (the pre-split d.confidence.tier check had been failing since 0010/0011 landed)
  ok(!!d.confidence?.reliability?.tier && Array.isArray(d.confidence?.reliability?.reasons)
     && !!d.confidence?.liquidity?.tier && Array.isArray(d.confidence?.liquidity?.reasons),
     `confidence reliability+liquidity tiers + reasons present (${d.confidence?.reliability?.tier}/${d.confidence?.liquidity?.tier})`);
  ok(Array.isArray(d.markets) && d.markets.length >= 2, `ladder markets[] present (${d.markets?.length} rungs)`);
  ok(!!d.market?.analytics?.velocity, `analytics present (movement via velocity)`);

  console.log('\nTRUST — the in-browser hash-verify WILL pass:');
  const sha = s.source?.raw_sha256;
  const canonical = canonicalizeRawInputs(s.raw_inputs);
  const recompute = createHash('sha256').update(canonical).digest('hex');
  ok(!!sha, `raw_sha256 present`);
  ok(recompute === sha, `sha256(canonical(raw_inputs)) === published raw_sha256 → verify ✓`);
}

let code = 1;
try {
  await run();
  code = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? '✓ DETAIL DATA-LAYER GATE PASSED — authoritative cache-final serve, full record, verify-ready' : `✗ ${failures} check(s) FAILED`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored: ${err.message}\n`);
}
process.exit(code);
