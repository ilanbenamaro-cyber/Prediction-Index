// components/zones/TrendHistory.tsx — the shared "Trend & history" section (Phase 1).
//
// Rendered by all three detail views (ladder, binary, touch) so the trend frame is
// identical everywhere. Velocity (≥7d) and dispersion (≥30d) cards show an explicit
// "Collecting — N/min days" state below the minimum — never dashes (DoD: analytics never
// blank) — and the historical chart sits below them. Extracted into its own module to
// keep MarketDetailView ⇄ Binary/Touch view imports acyclic. Server component (the chart
// itself is the only client island).

import { HistoryChart, type HistoryPoint, type ChartSeries } from './HistoryChart';

// `jump` (Increment 4): a recent single-day jump in the headline series. When present, the card
// reports 'converged' (stabilized after the move) or 'volatile' instead of a misleading linreg trend.
export interface JumpInfo { hasRecentJump?: boolean; jumpDate?: string; jumpMagnitude?: number; daysSinceJump?: number; postJumpStdDev?: number; stable?: boolean; }
export interface VelocityResult { status: string; kind?: string; trend?: string; period?: string; change?: number; days_have?: number; days_needed?: number; jump?: JumpInfo; }
export interface DispersionResult { status: string; direction?: string; change_pct?: number; current_width?: number; days_have?: number; days_needed?: number; }
// `series` (v1 ITEM 7) is the multi-line dual-axis chart data for survival/bucket ladders; null
// for binary/touch/categorical (the chart falls back to the single `points` headline line).
// `snapshotWindow` (Increment 2) is the capture time of the latest datapoint: 'us-hours' (18:00 UTC
// US peak) or 'off-peak' (02:00 UTC), surfaced as a data-quality note. null = backfill/legacy.
// `synthesis` (Increment 5): the closing cross-signal sentence appended to the narrative (or null).
// `backfillStatus` (backfill-observability pass): the market's history-backfill state
// ('pending'|'done'|'failed'|null). null/'pending' on a still-thin market → the chart shows
// "Backfilling history…" instead of the bare "Collecting" state; it clears once rows accrue.
// `watched`: is the market on ANY of the viewer's lists? A never-watchlisted market (opened via
// search-navigate) also reads status null, but NO backfill will ever run for it (only addMarket
// triggers one; the cron retries watched ids only) — so a null status only means "backfilling"
// when the market is actually watched. 'pending' always means an in-flight reconstruction.
export interface HistoryUI { velocity: VelocityResult; dispersion: DispersionResult; points: HistoryPoint[]; kind: string; series?: ChartSeries | null; snapshotWindow?: 'us-hours' | 'off-peak' | null; synthesis?: string | null; backfillStatus?: string | null; watched?: boolean; }

/** Velocity card: rate/direction of the headline value over the last 7 days, or an explicit
 *  "Collecting" state below the minimum. */
function VelocityCard({ v, unit }: { v: VelocityResult; unit: string }) {
  const isProb = v.kind === 'binary' || v.kind === 'categorical';
  const pfx = unit === '%' ? '' : '$'; // percent-DENOMINATED value ladders carry no '$'
  const fmtMag = (m: number) => isProb
    ? `${m >= 0 ? '+' : '−'}${Math.abs(m * 100).toFixed(1)}pp`
    : `${m >= 0 ? '+' : '−'}${pfx}${Math.abs(m).toFixed(2)}${unit}`;
  let value = '—';
  let sub = '';
  if (v.status === 'collecting') {
    value = 'Collecting';
    sub = `${v.days_have ?? 0}/${v.days_needed ?? 7} days · populates at 7`;
  } else if (v.status === 'ok' && v.jump?.hasRecentJump && v.jump.jumpMagnitude != null) {
    // Increment 4: a recent jump — report convergence/volatility, not a misleading "rising fast".
    const j = v.jump;
    const mag = v.jump.jumpMagnitude; // narrowed to number on this access path by the guard above
    const sigma = isProb ? `${((j.postJumpStdDev ?? 0) * 100).toFixed(1)}pp` : `${pfx}${(j.postJumpStdDev ?? 0).toFixed(2)}${unit}`;
    value = j.stable ? 'converged' : 'volatile';
    sub = j.stable
      ? `jumped ${fmtMag(mag)} on ${j.jumpDate} · stable since (σ=${sigma})`
      : `moved ${fmtMag(mag)} on ${j.jumpDate} · direction unclear`;
  } else if (v.status === 'ok') {
    value = v.trend ?? '—';
    const ch = v.change ?? 0;
    sub = isProb
      ? `${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(1)}pp over ${v.period ?? '7d'}`
      : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)} ${pfx}${unit} over ${v.period ?? '7d'}`;
  }
  return (
    <div className="acard" data-field="velocity-card">
      <div className="label">Velocity (7d)</div>
      <div className="acard-v" data-field="velocity-value">{value}</div>
      <div className="acard-s faint">{sub}</div>
    </div>
  );
}

/** Dispersion card: how the 50% band has moved over ~30 days. Collecting below the minimum;
 *  not_applicable for binary/touch (no settlement distribution). */
function DispersionCard({ d, unit }: { d: DispersionResult; unit: string }) {
  let value = '—';
  let sub = '';
  if (d.status === 'not_applicable') { value = 'n/a'; sub = 'no settlement distribution'; }
  else if (d.status === 'collecting') { value = 'Collecting'; sub = `${d.days_have ?? 0}/${d.days_needed ?? 30} days · populates at 30`; }
  else if (d.status === 'ok') {
    value = d.direction ?? '—';
    const p = (d.change_pct ?? 0) * 100;
    const pfx = unit === '%' ? '' : '$'; // percent-DENOMINATED ladders carry no '$'
    sub = `IQR ${p >= 0 ? '+' : ''}${p.toFixed(0)}% · width ${d.current_width != null ? `${pfx}${d.current_width.toFixed(2)}${unit}` : '—'} (30d)`;
  }
  return (
    <div className="acard" data-field="dispersion-card">
      <div className="label">Dispersion (30d)</div>
      <div className="acard-v">{value}</div>
      <div className="acard-s faint">{sub}</div>
    </div>
  );
}

/** Velocity + dispersion cards above the historical trends chart. */
export function TrendHistorySection({ hist, unit, label }: { hist: HistoryUI; unit: string; label: string }) {
  // A freshly-added market whose CLOB reconstruction hasn't completed (status null/'pending')
  // is actively backfilling, not merely waiting for daily snapshots — surface that distinction.
  // A NULL status only implies a coming backfill when the market is WATCHED (add-time trigger or
  // the cron retry); a search-navigated, never-added market would show a false "populates
  // automatically" promise — it degrades to the plain Collecting state instead.
  const backfilling = hist.backfillStatus === 'pending' || (hist.backfillStatus == null && hist.watched === true);
  return (
    <section className="detail-section" data-field="trend-history">
      <h2 className="detail-h2">Trend &amp; history <span className="tier1-tag">Tier 1 · market-derived</span></h2>
      <div className="detail-analytics">
        <VelocityCard v={hist.velocity} unit={unit} />
        <DispersionCard d={hist.dispersion} unit={unit} />
      </div>
      <HistoryChart points={hist.points} kind={hist.kind} unit={unit} label={label} series={hist.series ?? null} backfilling={backfilling} />
      {/* Increment 2: which daily capture the latest datapoint came from. The 18:00 UTC (US-peak)
          run is the higher-liquidity point; preferred over the 02:00 off-peak run when both exist. */}
      {hist.snapshotWindow && (
        <p className="hist-note" data-field="snapshot-window">
          {hist.snapshotWindow === 'us-hours'
            ? 'Latest point captured at 18:00 UTC (US-hours) — preferred where available.'
            : 'Latest point captured at 02:00 UTC (off-peak); US-hours capture not yet available.'}
        </p>
      )}
    </section>
  );
}
