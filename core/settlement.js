// core/settlement.js — the ONE reader for gamma settled-outcome truth.
//
// Why this exists (INC settled-leg-pricing, 2026-07-16): the live pricing chain
// (core/fetch.js priceLeg) must price a settled leg from its own settled truth —
// and lib/compute.mjs's resolved-no-prior builders already read that truth. The
// reader lives HERE because core cannot import lib; lib/compute re-imports these
// so there is exactly one definition of "what did this leg settle to" (the
// one-source-of-truth rule; the repo has been bitten by second readers drifting).

/** Parse a gamma array field that may arrive as a JSON string OR an already-parsed array
 *  (mirrors core/lifecycle.js's parser, which isn't exported). */
export function parseGammaArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; }
  }
  return null;
}

/** null-guard FIRST: Number(null) is 0 (not NaN), so a missing price must short-circuit to null
 *  rather than fabricate a 0%/false probability (the trap from the binary fix — see gotchas.md). */
export function num(s) {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The settled YES-outcome price for one gamma leg's outcomes/outcomePrices, as a string (for
 *  raw_inputs) — aligned by label ('Yes') when present, else positional [0]. null when unparseable.
 *  Shared across every shape: each leg's "did this outcome settle true" is the same lookup.
 *  ⚠ Settlement truth ONLY under umaResolutionStatus='resolved' — on an OPEN leg gamma's
 *  outcomePrices mirrors LIVE prices (see gotchas "CLOB midpoint returns a SYNTHETIC 0.5").
 *  Callers gate on that status; this function only does the lookup. */
export function settledYesStr(outcomesRaw, pricesRaw) {
  const outcomes = parseGammaArr(outcomesRaw) ?? [];
  const prices = parseGammaArr(pricesRaw) ?? [];
  const idx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  const raw = idx >= 0 ? prices[idx] : prices[0];
  return raw != null ? String(raw) : null;
}

/** The settled YES-outcome price as a NUMBER (0 or 1), or null when unparseable — never a
 *  fabricated 0 for missing data (see `num`). */
export function settledYesNum(outcomesRaw, pricesRaw) {
  return num(settledYesStr(outcomesRaw, pricesRaw));
}
