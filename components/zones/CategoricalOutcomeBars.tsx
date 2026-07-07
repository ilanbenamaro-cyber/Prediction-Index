'use client';
// components/zones/CategoricalOutcomeBars.tsx — the categorical outcome-bar chart (Bug A item 2).
//
// Hand-rolled SVG (no charting dep, same approach as the rest of the detail), one labeled bar per
// outcome, width ∝ probability, the dominant bar in amber. Shows at most MAX_BARS outcomes by
// probability; when a field has more real candidates than that, a "N more outcomes" toggle expands
// the rest (the one piece of client state, hence 'use client'). Bar scaling is fixed to the leader
// so bars don't jump when expanded. SVG <text> uses a single string child (the hydration trap).
import { useState } from 'react';
import type { CategoricalOutcome } from './market-record';

const MAX_BARS = 10;
const pct1 = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

export function CategoricalOutcomeBars({ outcomes }: { outcomes: CategoricalOutcome[] }) {
  const [expanded, setExpanded] = useState(false);
  // Hovered row + cursor position (fraction of the box) for the tooltip. Categorical bars are
  // HORIZONTAL rows, so the interaction is per-row hover, not a vertical crosshair — but it reuses
  // the shared .chart-tip styling so the tooltip reads identically to the axis charts.
  const [hover, setHover] = useState<{ i: number; xFrac: number; yFrac: number } | null>(null);
  if (outcomes.length === 0) return <div className="empty" data-field="outcomes-empty">No outcome data.</div>;

  const shown = expanded ? outcomes : outcomes.slice(0, MAX_BARS);
  const hidden = outcomes.length - shown.length;
  const max = Math.max(0.01, ...outcomes.map((o) => o.probability)); // fixed scale (leader)
  // LEDGER chart recalibration: the 480-wide viewBox renders ~2.4x, so viewBox rows must be
  // tighter than they look here — 17 (≈40px rendered) reads terminal-dense; 26 read toy-scaled.
  const rowH = 17;
  const VB_W = 480;
  const VB_H = shown.length * rowH + 8;
  const labelW = 150;
  const barMax = VB_W - labelW - 52;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.height === 0) return;
    const yFrac = (e.clientY - rect.top) / rect.height;
    const i = Math.max(0, Math.min(shown.length - 1, Math.floor((yFrac * VB_H) / rowH)));
    setHover({ i, xFrac: (e.clientX - rect.left) / rect.width, yFrac });
  };
  const hovered = hover ? shown[hover.i] : null;
  const flip = hover ? hover.xFrac > 0.6 : false;

  return (
    <div className="chart-hover" data-field="outcome-bars-wrap">
      <svg className="cat-bars" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Outcome probability distribution — hover a bar for its exact probability and volume" data-field="outcome-bars"
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
        {shown.map((o, i) => {
          const y = i * rowH + 4;
          const w = (o.probability / max) * barMax;
          const isHover = hover?.i === i;
          return (
            <g key={i}>
              {isHover && <rect className="cat-bar-hoverbg" x={0} y={y} width={VB_W} height={rowH} />}
              <text className="cat-bar-label" x={labelW - 6} y={y + rowH / 2 + 2.5} textAnchor="end">{o.label}</text>
              <rect className={`cat-bar${i === 0 ? ' cat-bar-top' : ''}`} x={labelW} y={y + 4} width={Math.max(1, w)} height={rowH - 8} />
              <text className="cat-bar-pct" x={labelW + Math.max(1, w) + 6} y={y + rowH / 2 + 2.5} textAnchor="start">{pct1(o.probability)}</text>
            </g>
          );
        })}
      </svg>
      {hovered && hover && (
        <div className="chart-tip" role="status" aria-live="polite"
          style={{ left: `${hover.xFrac * 100}%`, top: `${hover.yFrac * 100}%`, transform: flip ? 'translate(calc(-100% - 8px), 8px)' : 'translate(8px, 8px)' }}>
          <div className="chart-tip-title">{hovered.label}</div>
          <div className="chart-tip-row"><span className="chart-tip-label">probability</span><span className="chart-tip-value">{pct1(hovered.probability)}</span></div>
          <div className="chart-tip-row"><span className="chart-tip-label">volume</span><span className="chart-tip-value">{fmtVol(hovered.volume)}</span></div>
        </div>
      )}
      {outcomes.length > MAX_BARS && (
        <button
          type="button"
          className="cat-more"
          data-field="outcomes-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▴ show top 10' : `▾ ${hidden} more outcome${hidden === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}
