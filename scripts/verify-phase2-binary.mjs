// scripts/verify-phase2-binary.mjs — Phase 2 GATE (data layer): binary market support.
//
// Computes through the REAL pipeline (gamma + CLOB; no Supabase needed — this only
// computes + validates, never writes the cache). Proves: detection (classifyMarketKind),
// a binary market computes into a valid kind:'binary' record with a YES probability +
// confidence reasons + a verify-ready hash, AND a ladder still computes unchanged
// (no-regression). The frozen-hash parity gate (node --test) is the SpaceX proof; the
// Playwright gate proves the binary detail renders + hash-verify ✓ in the browser.
//
//   node scripts/verify-phase2-binary.mjs
//   BINARY_SLUG=… LADDER_SLUG=… node scripts/verify-phase2-binary.mjs   (override the live markets)
// Exit: 0 pass · 1 a check failed.

import { computeMarketRecord } from '../lib/compute.mjs';
import { classifyMarketKind, hashRawInputs } from '../core/fetch.js';

const BINARY = process.env.BINARY_SLUG || 'us-recession-by-end-of-2026';
// LADDER fixture = the eternal SURVIVAL reference (RESOLVED → never changes; gamma-stable;
// compute-only read, no DB write). The previous default (will-wti-hit-week-of-june-22-2026)
// rotted two ways: dated weekly slugs expire, and WTI "hit (HIGH)/(LOW)" markets are
// directional_touch by construction — not a survival ladder at all (found 2026-07-13).
const LADDER = process.env.LADDER_SLUG || 'spacex-ipo-closing-market-cap-above';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };

async function run() {
  console.log(`\nPhase 2 binary-market gate  (binary=${BINARY}  ladder=${LADDER})\n`);

  // ── 1. DETECTION (before any threshold parsing) ──
  console.log('DETECTION — classifyMarketKind from event.markets.length:');
  const bk = await classifyMarketKind(BINARY);
  const lk = await classifyMarketKind(LADDER);
  ok(bk === 'binary', `${BINARY} → '${bk}' (expected binary)`);
  ok(lk === 'ladder', `${LADDER} → '${lk}' (expected ladder)`);

  // ── 2. BINARY computes into a valid record + verify-ready hash ──
  console.log('\nBINARY — computes into a kind:binary record:');
  const { record, lifecycle, config } = await computeMarketRecord({ id: BINARY });
  const d = record.snapshot.derived;
  ok(d.kind === 'binary', `derived.kind === 'binary'`);
  ok(typeof d.probability === 'number' && d.probability > 0 && d.probability < 1, `probability in (0,1): ${d.probability}`);
  ok(config.kind === 'binary', `config.kind === 'binary' (drives markets.kind in cache)`);
  // post-0010 confidence split: {reliability, liquidity} each {tier, reasons} — assert BOTH
  // dimensions (same staleness class as 2c3, fixed there in 07684a1)
  ok(!!d.confidence?.reliability?.tier && Array.isArray(d.confidence?.reliability?.reasons)
       && d.confidence.reliability.reasons.length > 0
     && !!d.confidence?.liquidity?.tier && Array.isArray(d.confidence?.liquidity?.reasons)
       && d.confidence.liquidity.reasons.length > 0,
    `confidence reliability=${d.confidence?.reliability?.tier} + liquidity=${d.confidence?.liquidity?.tier} with reasons`);
  ok(!Array.isArray(d.markets), `no ladder markets[] on a binary record`);
  const sha = record.snapshot.source.raw_sha256;
  ok(hashRawInputs(record.snapshot.raw_inputs) === sha, `hashRawInputs(raw_inputs) === raw_sha256 → in-browser verify will ✓`);
  ok(lifecycle.state === 'OPEN' || lifecycle.state === 'RESOLVED' || lifecycle.state === 'CLOSED_PENDING', `lifecycle ${lifecycle.state}`);
  // (computeMarketRecord runs validateRecord internally — reaching here means it validated.)

  // ── 3. LADDER still computes (no-regression of the ladder path) ──
  console.log('\nLADDER — no-regression: still computes as a ladder:');
  const lad = await computeMarketRecord({ id: LADDER });
  ok(lad.record.snapshot.derived.kind == null, `ladder record has no kind:binary`);
  ok(Array.isArray(lad.record.snapshot.derived.markets) && lad.record.snapshot.derived.markets.length >= 2,
    `ladder markets[] present (${lad.record.snapshot.derived.markets?.length} rungs)`);
}

let code = 1;
try {
  await run();
  code = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? '✓ BINARY GATE PASSED — detection + binary compute + verify-ready + ladder no-regression' : `✗ ${failures} check(s) FAILED`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored: ${err.message}\n`);
}
process.exit(code);
