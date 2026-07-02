// components/zones/SettlementConsensus.tsx — Bug 6: the near-settlement view.
//
// When a ladder is NEAR SETTLEMENT (expiring ≤7d, rungs pinned to ~0/~1), the full CDF/density
// distribution carries no remaining signal — it's a step from 1 to 0. So the ladder detail
// REPLACES the distribution with this: the converged settlement zone (the bucket holding the
// mass, from format-detail.settlementZone) shown prominently as a band on the strike track,
// with the implied median. Server component (static SVG); reuses the touch-* track styling.
import { settlementZone, settlementZoneLabel } from '@/lib/format-detail.mjs';
import type { LadderRow } from './market-record';

export function SettlementConsensus({ markets, impliedMedian, unit }:
  { markets: LadderRow[] | undefined; impliedMedian: number | null; unit: string }) {
  if (!markets || markets.length < 2) {
    return <div className="empty" data-field="settlement-empty">No settlement data for this market.</div>;
  }
  const zone = settlementZone(markets);
  const label = settlementZoneLabel(zone, unit);
  const prob = zone?.prob ?? null;

  const levels = markets.map((m) => m.threshold);
  const min = Math.min(...levels), max = Math.max(...levels);
  const span = max - min || 1;
  const W = 1000;
  const x = (v: number) => ((v - min) / span) * W;
  const bandL = zone?.kind === 'below' ? 0 : x(zone?.lo ?? min);
  const bandR = zone?.kind === 'above' ? W : x(zone?.hi ?? max);
  const medX = impliedMedian != null ? Math.max(0, Math.min(W, x(impliedMedian))) : null;

  return (
    <div className="settle-view" data-field="settlement-consensus">
      <div className="settle-headline">
        <span className="settle-zone num" data-field="settlement-zone">{label}</span>
        <span className="settle-prob faint">{prob != null ? `${Math.round(prob * 100)}% of the implied probability mass` : ''}</span>
      </div>
      <svg className="settle-bar" viewBox="0 0 1000 80" preserveAspectRatio="none" role="img" aria-label="settlement consensus zone" data-field="settlement-bar">
        <line x1={0} y1={40} x2={W} y2={40} className="touch-track" />
        <rect x={Math.max(0, bandL)} y={26} width={Math.max(2, bandR - bandL)} height={28} className="settle-band" />
        {medX != null && <line x1={medX} y1={18} x2={medX} y2={62} className="touch-mark" />}
        <text x={Math.max(0, bandL)} y={16} className="touch-axislabel" textAnchor="start">{label}</text>
        {/* percent buckets carry no '$' prefix on the axis ends */}
        <text x={0} y={74} className="touch-axisend" textAnchor="start">{`${unit === '%' ? '' : '$'}${min}${unit}`}</text>
        <text x={W} y={74} className="touch-axisend" textAnchor="end">{`${unit === '%' ? '' : '$'}${max}${unit}`}</text>
      </svg>
      <p className="faint settle-note">
        This market has essentially converged — most rungs are pinned to 0/1 and the outcome is settling in the band above.
        The full distribution is omitted near settlement because it carries no remaining signal.
      </p>
    </div>
  );
}
