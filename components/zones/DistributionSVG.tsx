// components/zones/DistributionSVG.tsx — the analytical centerpiece: the whole
// implied distribution, hand-rolled in SVG (no charting dependency). Two panels from
// the stored ladder (markets[]): the cumulative P(>X) curve with the implied-median
// marker, and the bucket-probability density. Server-rendered (static SVG, no client
// JS); colours come from existing tokens via the .dist-* classes in globals.css.
//
// Axes (so the chart reads without prior knowledge of the shape): the CDF carries a
// Y probability scale (0/25/50/75/100% + hairline grid) and a rotated X threshold
// label at every rung; the density carries a rotated X bucket label under every bar.
// The implied-median marker has an explicit text label.

import type { LadderRow as LadderPoint } from './market-record';
import { ChartCrosshair, type SnapAnchor, type InterpConfig, type NumFmt, type TooltipRow } from './ChartCrosshair';

const VB_W = 480;
const VB_H = 210;
const PAD = { t: 12, r: 14, b: 48, l: 34 }; // generous bottom for the rotated X labels
const Y_TICKS = [0, 25, 50, 75, 100];
const CDF_COLOR = 'var(--accent-blue)';
const BUCKET_COLOR = 'var(--accent-blue)';

function xScale(t: number, lo: number, hi: number): number {
  if (hi === lo) return PAD.l;
  return PAD.l + ((t - lo) / (hi - lo)) * (VB_W - PAD.l - PAD.r);
}
function yScalePct(pct: number): number {
  return VB_H - PAD.b - (pct / 100) * (VB_H - PAD.t - PAD.b);
}
/** A rung's display tick, stripped of the leading ">"/"≥" (e.g. ">$1.8T" → "$1.8T"). */
function tickLabel(label: string | undefined): string {
  return (label ?? '').replace(/^[>≥]\s*/, '');
}

/** Cumulative curve: P(market value > X) over the thresholds, with the median marker. */
function CdfPanel({ markets, impliedMedian, unit }: { markets: LadderPoint[]; impliedMedian: number | null; unit: string }) {
  const lo = markets[0].threshold;
  const hi = markets[markets.length - 1].threshold;
  const pts = markets.map((m) => `${xScale(m.threshold, lo, hi).toFixed(1)},${yScalePct(m.prob * 100).toFixed(1)}`).join(' ');
  const baseY = VB_H - PAD.b;
  const areaPts = `${PAD.l.toFixed(1)},${baseY.toFixed(1)} ${pts} ${(VB_W - PAD.r).toFixed(1)},${baseY.toFixed(1)}`; // Enh 1: filled area under the CDF
  const medX = impliedMedian != null ? xScale(impliedMedian, lo, hi) : null;
  const tickY = VB_H - PAD.b + 9;
  // Hover (interpolate): exact threshold + exact P(>X) at the cursor, linearly interpolated between
  // the two nearest rungs (not snapped to a dot) — the prompt's requirement for the CDF.
  const valFmt: NumFmt = { prefix: unit === '%' ? '' : '$', suffix: unit, digits: 2 };
  const interp: InterpConfig = {
    anchorsVbX: markets.map((m) => xScale(m.threshold, lo, hi)),
    titleValues: markets.map((m) => m.threshold),
    titleFmt: valFmt,
    rows: [{ label: 'P(>X)', swatch: CDF_COLOR, values: markets.map((m) => m.prob), fmt: { scale: 100, digits: 1, suffix: '%' } }],
  };
  return (
    <ChartCrosshair vbW={VB_W} vbH={VB_H} plotLeft={PAD.l} plotRight={VB_W - PAD.r} plotTop={PAD.t} plotBottom={VB_H - PAD.b}
      mode="interpolate" interp={interp} ariaLabel="Cumulative probability curve — hover for exact P(>X)">
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Cumulative probability curve" data-field="cdf">
      <defs>
        <linearGradient id="cdf-fill-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="dist-cdf-grad-top" />
          <stop offset="100%" className="dist-cdf-grad-bot" />
        </linearGradient>
      </defs>
      {/* Y probability scale + hairline grid */}
      {Y_TICKS.map((g) => (
        <g key={g}>
          <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct(g)} y2={yScalePct(g)} />
          {/* single string child: adjacent dynamic+static children mis-hydrate in SVG text */}
          <text className="dist-axis" x={PAD.l - 5} y={yScalePct(g) + 3} textAnchor="end">{`${g}%`}</text>
        </g>
      ))}
      <line className="dist-ref" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct(50)} y2={yScalePct(50)} />
      <polygon className="dist-cdf-area" points={areaPts} fill="url(#cdf-fill-grad)" /> {/* Enh 1: gradient fill */}
      <polyline className="dist-cdf-line" points={pts} fill="none" />
      {markets.map((m, i) => ( // index key: an arbitrary market's parsed thresholds aren't guaranteed unique
        <circle key={i} className="dist-cdf-dot" cx={xScale(m.threshold, lo, hi)} cy={yScalePct(m.prob * 100)} r={1.8}>
          <title>{`${tickLabel(m.label)} · P(>) ${(m.prob * 100).toFixed(1)}%${m.volume != null ? ` · vol $${Math.round(m.volume).toLocaleString('en-US')}` : ''}`}</title>
        </circle>
      ))}
      {/* X threshold tick label at every rung, rotated to avoid overlap */}
      <g data-field="cdf-x-labels">
        {markets.map((m, i) => {
          const x = xScale(m.threshold, lo, hi);
          return <text key={i} className="dist-tick" transform={`rotate(-45 ${x.toFixed(1)} ${tickY})`} x={x.toFixed(1)} y={tickY} textAnchor="end">{tickLabel(m.label)}</text>;
        })}
      </g>
      {medX != null && (
        <g data-field="cdf-median-marker">
          <line className="dist-median" x1={medX} x2={medX} y1={PAD.t} y2={VB_H - PAD.b} />
          <circle className="dist-median-dot" cx={medX} cy={yScalePct(50)} r={2.4} /> {/* Enh 1: marker on the 50% crossing */}
          <text className="dist-median-lbl" x={Math.min(medX + 4, VB_W - PAD.r - 60)} y={PAD.t + 9}>{`median ${unit === '%' ? '' : '$'}${impliedMedian?.toFixed(2)}${unit}`}</text>
        </g>
      )}
    </svg>
    </ChartCrosshair>
  );
}

/** Density: P(value in each bucket). First bar is the "<lowest" complement. */
function DensityPanel({ markets, impliedMedian, unit }: { markets: LadderPoint[]; impliedMedian: number | null; unit: string }) {
  const pfx = unit === '%' ? '' : '$'; // percentage-denominated buckets carry no '$' prefix
  const bars: Array<{ label: string; v: number; isMedian: boolean; vol: number | null }> = [];
  bars.push({ label: `<${pfx}${markets[0].threshold}${unit}`, v: Math.max(0, 1 - markets[0].adjusted_prob), isMedian: impliedMedian != null && impliedMedian < markets[0].threshold, vol: null });
  for (let i = 0; i < markets.length; i++) {
    const lo = markets[i].threshold;
    const hi = markets[i + 1]?.threshold ?? Infinity;
    bars.push({
      label: markets[i + 1] ? `${pfx}${lo}–${markets[i + 1].threshold}${unit}` : `>${pfx}${lo}${unit}`,
      v: markets[i].bucket_prob,
      isMedian: impliedMedian != null && impliedMedian >= lo && impliedMedian < hi,
      vol: markets[i].volume ?? null, // Enh 1: surface bucket volume in the hover tooltip
    });
  }
  const maxV = Math.max(0.01, ...bars.map((b) => b.v));
  const innerW = VB_W - PAD.l - PAD.r;
  const bw = innerW / bars.length;
  const tickY = VB_H - PAD.b + 9;
  // Hover (snap): the exact bucket RANGE + its probability mass (+ volume) at the nearest bar.
  const anchors: SnapAnchor[] = bars.map((b, i) => {
    const h = (b.v / maxV) * (VB_H - PAD.t - PAD.b);
    const cx = PAD.l + i * bw + bw * 0.12 + bw * 0.38;
    const rows: TooltipRow[] = [{ label: 'P(in bucket)', swatch: b.isMedian ? 'var(--accent-amber)' : BUCKET_COLOR, value: `${(b.v * 100).toFixed(1)}%` }];
    if (b.vol != null) rows.push({ label: 'volume', value: `$${Math.round(b.vol).toLocaleString('en-US')}` });
    return { x: cx, payload: { title: b.label, rows }, dots: [{ y: VB_H - PAD.b - h, color: b.isMedian ? 'var(--accent-amber)' : BUCKET_COLOR }] };
  });
  return (
    <ChartCrosshair vbW={VB_W} vbH={VB_H} plotLeft={PAD.l} plotRight={VB_W - PAD.r} plotTop={PAD.t} plotBottom={VB_H - PAD.b}
      mode="snap" anchors={anchors} ariaLabel="Bucket probability density — hover for exact bucket mass">
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Bucket probability density" data-field="density">
      {/* Y bucket-probability scale (0 / mid / peak) + grid */}
      {[0, maxV / 2, maxV].map((g, gi) => (
        <g key={gi}>
          <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct((g / maxV) * 100)} y2={yScalePct((g / maxV) * 100)} />
          <text className="dist-axis" x={PAD.l - 5} y={yScalePct((g / maxV) * 100) + 3} textAnchor="end">{`${Math.round(g * 100)}%`}</text>
        </g>
      ))}
      <g data-field="density-x-labels">
        {bars.map((b, i) => {
          const h = (b.v / maxV) * (VB_H - PAD.t - PAD.b);
          const x = PAD.l + i * bw + bw * 0.12;
          const cx = x + bw * 0.38;
          return (
            <g key={i}>
              <rect className={`dist-bar${b.isMedian ? ' dist-bar-median' : ''}`} x={x} y={VB_H - PAD.b - h} width={bw * 0.76} height={Math.max(0, h)}>
                <title>{`${b.label} · ${(b.v * 100).toFixed(1)}%${b.vol != null ? ` · vol $${Math.round(b.vol).toLocaleString('en-US')}` : ''}`}</title>
              </rect>
              <text className="dist-tick" transform={`rotate(-45 ${cx.toFixed(1)} ${tickY})`} x={cx.toFixed(1)} y={tickY} textAnchor="end">{b.label}</text>
            </g>
          );
        })}
      </g>
    </svg>
    </ChartCrosshair>
  );
}

export function DistributionSVG({ markets, impliedMedian, unit }: { markets: LadderPoint[] | undefined; impliedMedian: number | null; unit: string }) {
  if (!markets || markets.length < 2) {
    return <div className="empty" data-field="distribution-empty">No distribution data for this market.</div>;
  }
  return (
    <div className="dist-grid2">
      <div className="dist-panel">
        <div className="label">Cumulative — P(value &gt; X)</div>
        <CdfPanel markets={markets} impliedMedian={impliedMedian} unit={unit} />
      </div>
      <div className="dist-panel">
        <div className="label">Density — where the market expects it to land</div>
        <DensityPanel markets={markets} impliedMedian={impliedMedian} unit={unit} />
      </div>
    </div>
  );
}
