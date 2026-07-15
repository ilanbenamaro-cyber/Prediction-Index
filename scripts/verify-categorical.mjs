// scripts/verify-categorical.mjs — live verification of the categorical pipeline (Phase 1b).
//
// Runs the REAL compute path (computeMarketRecord → fetchCategoricalSnapshot → gamma + CLOB)
// against a live categorical market — no Supabase needed (compute is DB-free). Proves the
// market computes a valid outcome distribution, identifies the dominant outcome, and that the
// provenance hash re-verifies. Run:  node scripts/verify-categorical.mjs
//   (override the market with CAT_SLUG=<event-slug>)

import { computeMarketRecord } from '../lib/compute.mjs';
import { hashRawInputs } from '../core/fetch.js';

const SLUG = process.env.CAT_SLUG || 'how-many-fed-rate-cuts-in-2026';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };

console.log(`\nCategorical live verification → ${SLUG}\n`);
try {
  const { record, lifecycle } = await computeMarketRecord({ id: SLUG });
  const d = record.snapshot.derived;
  ok(d.kind === 'categorical', `kind === 'categorical' (got ${d.kind})`);
  ok(Array.isArray(d.outcomes) && d.outcomes.length >= 2, `≥2 outcomes (${d.outcomes?.length})`);
  const sum = (d.outcomes ?? []).reduce((a, o) => a + o.probability, 0);
  ok(Math.abs(sum - 1) < 1e-6, `outcome probabilities sum to 1.0 (got ${sum.toFixed(6)})`);
  ok(d.dominant_outcome != null && d.dominant_prob > 0, `dominant: "${d.dominant_outcome}" @ ${(d.dominant_prob * 100).toFixed(1)}%`);
  ok(d.entropy >= 0 && d.entropy <= 1, `entropy in [0,1] (${d.entropy?.toFixed(3)}) → ${d.consensus_strength}`);
  // Split confidence (schema 2.0.0): { reliability, liquidity }, each { tier, score, reasons }.
  const tiers = ['high', 'medium', 'low'];
  ok(tiers.includes(d.confidence?.reliability?.tier) && tiers.includes(d.confidence?.liquidity?.tier),
    `confidence computed (reliability ${d.confidence?.reliability?.tier} · liquidity ${d.confidence?.liquidity?.tier})`);
  ok(record.snapshot.source.raw_sha256 === hashRawInputs(record.snapshot.raw_inputs), 'raw_sha256 re-hash matches (provenance intact)');
  ok(record.snapshot.raw_inputs.every((r) => r.midpoint != null), 'every stored leg has an observed (un-normalized) midpoint');
  console.log(`\n  lifecycle: ${lifecycle.state} · top outcome distribution:`);
  for (const o of (d.outcomes ?? []).slice(0, 5)) console.log(`    ${(o.probability * 100).toFixed(1).padStart(5)}%  ${o.label}  (raw ${(o.raw_probability * 100).toFixed(1)}%)`);
} catch (e) {
  ok(false, `compute threw: ${e.message}`);
}

// ── 5.6 EXCLUSIVITY GUARD: a live NON-exclusive board must compute GUARDED —
//    raw prices only, every PMF derivation suppressed (the de-vig on a nested
//    board fabricated numbers: raw 20.5% displayed as 49%, found 2026-07-13).
//    Override with GUARDED_SLUG=<event-slug>. ──
const GUARDED = process.env.GUARDED_SLUG || 'fed-rate-cut-by-629';
console.log(`\nGuarded (non-exclusive) verification → ${GUARDED}\n`);
try {
  const { record } = await computeMarketRecord({ id: GUARDED });
  const d = record.snapshot.derived;
  ok(d.kind === 'categorical', `kind === 'categorical' (got ${d.kind})`);
  ok(d.exclusivity != null && d.exclusivity.verdict !== 'exclusive',
    `guard fired (verdict: ${d.exclusivity?.verdict ?? 'MISSING — board normalized!'})`);
  for (const k of ['entropy', 'dominant_prob', 'dominant_outcome', 'consensus_strength', 'implied_winner']) {
    ok(!(k in d), `${k} suppressed`);
  }
  ok((d.outcomes ?? []).every((o) => !('probability' in o) && o.raw_probability != null),
    'outcomes carry RAW probabilities only (no normalized values)');
  ok(!/assigns .*probability to/.test(d.narrative ?? ''), 'narrative contains no fabricated-PMF sentence');
  ok(record.snapshot.source.raw_sha256 === hashRawInputs(record.snapshot.raw_inputs), 'guarded record provenance re-hashes');
  console.log(`  narrative: ${d.narrative?.slice(0, 120)}…`);
} catch (e) {
  ok(false, `guarded compute threw: ${e.message}`);
}

console.log(failures === 0 ? '\n✅ categorical verification PASSED\n' : `\n❌ ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
