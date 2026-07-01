// core/freshness.js — Tier-1 data-freshness policy.
//
// Why this exists: a silently stale number is a trust failure for this product. The
// feed must DISCLOSE how old its data is and when to consider it stale, under one
// documented policy that the dashboard, the API, and any downstream consumer apply
// identically. Pure: a function of the snapshot's own as-of timestamp plus one
// documented constant — no external input, so it stays Tier-1 (no assumption).

// The snapshot schedule, as facts. The cron (.github/workflows/update.yml,
// `0 0,12,14,16,18,20,22 * * *`) runs every 2h from 12:00 to 22:00 UTC plus 00:00,
// daily including weekends; the overnight pause (00:00 → 12:00 UTC) is the largest
// *scheduled* gap. The staleness threshold is DERIVED from these facts — never a
// free-standing literal — so it cannot silently desync from the cadence again
// (audit P0-1: the previous 50h literal was sized for the retired daily cadence;
// at 2h cadence it meant ~25 missed runs of silence before the STALE flag fired).
// test/schedule-coupling.test.js re-derives these numbers from the workflow cron
// and fails loudly if the schedule and this struct drift apart.
export const SCHEDULE = Object.freeze({
  CADENCE_H: 2, // gap between snapshots while active (12:00–22:00 + 00:00 UTC)
  MAX_EXPECTED_GAP_H: 12, // the overnight pause, 00:00 → 12:00 UTC
  JITTER_MARGIN_H: 3, // Actions queue-delay allowance
});

// Threshold = largest scheduled gap + one fully-missed run + queue jitter = 17h.
// A normal overnight pause (~12h) never flags; missing the first post-pause run
// (~14h gap) still doesn't cry wolf; anything beyond that is a genuine pipeline
// failure and trips the flag.
//
// ALSO CORRECT for the HOSTED product's cadence: the Vercel snapshot cron
// (vercel.json → /api/snapshot at 02:00 + 18:00 UTC) has a max gap of 16h
// (02:00→18:00), so 17h (= 16h + ~1h jitter) means a watched market refreshed on
// EITHER cron never reads STALE before the next cron runs — while an on-demand view
// recomputes anything past the 15-min cache TTL anyway. CRITICALLY, this 17h TRUST
// threshold is DISTINCT from CACHE_TTL_HOURS (15min, the server recompute horizon in
// lib/decide-cache-action.mjs): the rail reads cached stale_after WITHOUT recomputing
// per view, so using the 15-min TTL as stale_after made every rail market flip STALE
// ~15min after a cron/view. compute.mjs therefore passes NO threshold (→ this 17h).
// (Two horizons — see gotchas "price-match window ≠ liveness window".)
export const STALENESS_THRESHOLD_HOURS =
  SCHEDULE.MAX_EXPECTED_GAP_H + SCHEDULE.CADENCE_H + SCHEDULE.JITTER_MARGIN_H;
export const EXPECTED_CADENCE =
  'every 2h, 12:00–00:00 UTC (overnight pause 00:00–12:00 UTC), incl. weekends';

const MS_PER_HOUR = 3_600_000;

/**
 * Freshness policy for a snapshot taken at `asOfISO`. Returns the as-of anchor, the
 * documented threshold, and an absolute `stale_after` instant (= as_of + threshold)
 * so any consumer judges staleness with a single timestamp comparison and no shared
 * formula to drift. The published record carries POLICY ONLY (no frozen age/flag —
 * age is inherently a read-time quantity; baking it at build time would be a lie
 * that goes wrong the moment the file sits unchanged). Pass `nowISO` (the live
 * clock, e.g. from the browser) to additionally evaluate `age_hours` + `stale`.
 */
export function buildFreshness(asOfISO, nowISO = null, thresholdHours = STALENESS_THRESHOLD_HOURS, lifecycle = null) {
  const asOfMs = Date.parse(asOfISO);
  if (Number.isNaN(asOfMs)) throw new Error(`buildFreshness: invalid as_of "${asOfISO}"`);
  const staleAfterMs = asOfMs + thresholdHours * MS_PER_HOUR;
  const out = {
    as_of: asOfISO,
    staleness_threshold_hours: thresholdHours,
    stale_after: new Date(staleAfterMs).toISOString(),
    expected_cadence: EXPECTED_CADENCE,
    policy: `Considered stale ${thresholdHours}h after as_of (= max scheduled gap ${SCHEDULE.MAX_EXPECTED_GAP_H}h overnight pause + ${SCHEDULE.CADENCE_H}h one missed run + ${SCHEDULE.JITTER_MARGIN_H}h queue jitter). Live age = now − as_of; stale = now > stale_after.`,
  };
  // A non-OPEN market (closed/resolved) is FINAL: it has stopped updating by
  // design, so consumers must NOT flag it stale. Additive — absent for OPEN
  // markets (and when no lifecycle is supplied), so OPEN records are unchanged.
  if (lifecycle && lifecycle.state != null && lifecycle.state !== 'OPEN') {
    out.final = true;
    out.lifecycle_state = lifecycle.state;
  }
  if (nowISO != null) {
    const nowMs = Date.parse(nowISO);
    if (Number.isNaN(nowMs)) throw new Error(`buildFreshness: invalid now "${nowISO}"`);
    out.age_hours = Number(((nowMs - asOfMs) / MS_PER_HOUR).toFixed(2));
    out.stale = nowMs > staleAfterMs;
  }
  return out;
}

/** Human "age" label from hours: "3h ago", "2d 4h ago", "just now". */
export function ageLabel(ageHours) {
  if (ageHours == null || !Number.isFinite(ageHours) || ageHours < 1) return 'just now';
  if (ageHours < 24) return `${Math.floor(ageHours)}h ago`;
  const days = Math.floor(ageHours / 24);
  const h = Math.floor(ageHours % 24);
  return h ? `${days}d ${h}h ago` : `${days}d ago`;
}
