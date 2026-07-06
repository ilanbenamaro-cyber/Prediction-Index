'use client';
// components/zones/HistoryChart.tsx — the historical trends chart (Phase 1 + v1 ITEM 7).
//
// Hand-rolled inline SVG (no charting dependency, same approach as DistributionSVG),
// fed a LEAN server-built series so the heavy record JSONB never ships to the client.
//
// TWO modes, chosen by whether a `series` prop is supplied:
//   • SINGLE-LINE (binary/touch/categorical, and ladder before history accrues): the one
//     headline line per kind — binary YES prob; touch range midpoint; categorical dominant
//     prob; ladder implied median — on one axis.
//   • DUAL-AXIS MULTI-LINE (v1 ITEM 7, survival/bucket only): per-threshold P(>X) lines on a
//     left 0–100% probability axis + implied median (+ faint dashed mean) on a right value axis,
//     exactly the v1 trend chart. Low-confidence days are dashed/faded. Built server-side
//     (lib/market-history.deriveChartSeries); only lean {date,value}[] per line crosses the wire.
//
// Both share the 7D/30D/90D/ALL time-range toggle (the one piece of client state, hence
// 'use client'). Below 2 points in the window → an explicit "Collecting history" state, never
// an empty axis. SVG <text> uses a single string child (the adjacent dynamic+static hydration
// trap, see gotchas.md).

import { useState } from 'react';
import { ChartCrosshair, type SnapAnchor, type TooltipRow } from './ChartCrosshair';
import { pickTicks, probDomain, fmtDateShort } from '@/lib/chart-hover.mjs';
import { niceTicks } from '@/lib/touch-rangebar.mjs';

export interface HistoryPoint { date: string; value: number }
export interface ChartLine { key: string; label?: string; threshold?: number; points: HistoryPoint[]; faint?: boolean; dashed?: boolean }
/** One day of the P25–P75 IQR band (ladder value axis) — a shaded dispersion region. */
export interface BandPoint { date: string; lo: number; hi: number }
export interface ChartSeries { dual: boolean; probLines: ChartLine[]; valueLines: ChartLine[]; lowDays: string[]; band?: BandPoint[] | null }

const VB_W = 480;
const VB_H = 190;
const PAD = { t: 12, r: 14, b: 40, l: 44 }; // generous bottom for rotated date ticks
const PAD_DUAL = { t: 12, r: 44, b: 40, l: 44 }; // dual axis needs room on the right for the value ticks
const X_TICKS = 6; // ~evenly-spaced date labels (every Nth point) so many-day charts don't overlap
const RANGES: { key: string; days: number | null }[] = [
  { key: '7D', days: 7 }, { key: '30D', days: 30 }, { key: '90D', days: 90 }, { key: 'ALL', days: null },
];
const DAY_MS = 86_400_000;
const PROB_CLASSES = ['hist-line-p0', 'hist-line-p1', 'hist-line-p2']; // up to 3 threshold lines
// Multi-prob series colours: touch sides are FIXED (HIGH = warm amber, LOW = cool blue — the
// direction must read at a glance); other keys take the palette by index. CSS variables only.
const KEY_COLORS: Record<string, string> = { high: 'var(--accent-amber)', low: 'var(--accent-blue)' };
const SERIES_PALETTE = ['var(--accent-amber)', 'var(--accent-blue)', 'var(--tier1)', 'var(--accent-violet)'];
const lineColor = (l: ChartLine, i: number) => KEY_COLORS[l.key] ?? SERIES_PALETTE[i % SERIES_PALETTE.length];

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Probability-axis kinds use a 0–100% scale; value kinds use a padded data range. */
const isPctKind = (kind: string) => kind === 'binary' || kind === 'categorical';

/** Axis-label formatter by kind: probability kinds → %, otherwise value + unit.
 *  A percent-DENOMINATED value ladder (UK GDP, unit '%') carries no '$' prefix. */
function fmtVal(v: number, kind: string, unit: string): string {
  if (isPctKind(kind)) return `${Math.round(v * 100)}%`;
  return `${unit === '%' ? '' : '$'}${v.toFixed(2)}${unit}`;
}
/** The ladder unit's money prefix ('' for percent-denominated, '$' otherwise). */
const unitPfx = (unit: string) => (unit === '%' ? '' : '$');

export function HistoryChart({ points, kind, unit = '', label = 'Value', series = null, backfilling = false }:
  { points: HistoryPoint[]; kind: string; unit?: string; label?: string; series?: ChartSeries | null; backfilling?: boolean }) {
  const [range, setRange] = useState<string>('30D');
  const sel = RANGES.find((r) => r.key === range) ?? RANGES[3];
  const days = sel.days; // hoist for narrowing inside the filter closures

  // MULTI-LINE paths (a derived series). DUAL (ladder): per-threshold P(>X) on the left axis +
  // median/mean on the right. PROB-ONLY (touch P(touch), categorical outcomes): N probability
  // lines on one % axis. The collecting test uses the primary line — median where one exists,
  // else the first probability line.
  if (series && (series.dual || series.probLines.length > 0)) {
    const filt = (pts: HistoryPoint[]) => {
      if (days == null) return pts;
      const last = pts.length ? ms(pts[pts.length - 1].date) : 0;
      return pts.filter((p) => ms(p.date) >= last - days * DAY_MS);
    };
    const probLines = series.probLines.map((l) => ({ ...l, points: filt(l.points) }));
    const valueLines = series.valueLines.map((l) => ({ ...l, points: filt(l.points) }));
    // The IQR band filters by the same window (its dates are the median line's dates).
    const bandAll = series.band ?? null;
    const band = bandAll && days != null
      ? bandAll.filter((b) => ms(b.date) >= (bandAll.length ? ms(bandAll[bandAll.length - 1].date) : 0) - days * DAY_MS)
      : bandAll;
    const primary = valueLines.find((l) => l.key === 'median') ?? valueLines[0] ?? probLines[0];
    const enough = primary && primary.points.length >= 2;
    // Legend sits TOP-RIGHT of the chart area (above the plot, right-aligned via CSS) so series
    // identification comes before reading; the explanatory note stays below the plot.
    return (
      <div className="hist-chart" data-field="history-chart">
        <ChartHead label={label} range={range} setRange={setRange} />
        {enough && (series.dual
          ? <DualLegend probLines={probLines} valueLines={valueLines} unit={unit} hasBand={!!(band && band.length >= 2)} />
          : <MultiProbLegend lines={probLines} />)}
        {!enough
          ? <Collecting range={range} backfilling={backfilling} />
          : series.dual
            ? <DualPlot probLines={probLines} valueLines={valueLines} lowDays={series.lowDays} unit={unit} band={band && band.length >= 2 ? band : null} />
            : <MultiProbPlot lines={probLines} lowDays={series.lowDays} />}
        {enough && series.dual &&
          <p className="hist-note">Probabilities read off the left axis; valuation off the right. Dashed/faded segments are low-confidence days.</p>}
      </div>
    );
  }

  // SINGLE-LINE path (default).
  const sorted = [...(points ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const lastMs = sorted.length ? ms(sorted[sorted.length - 1].date) : 0;
  const visible = days == null ? sorted
    : sorted.filter((p) => ms(p.date) >= lastMs - days * DAY_MS);

  return (
    <div className="hist-chart" data-field="history-chart">
      <ChartHead label={label} range={range} setRange={setRange} />
      {visible.length < 2
        ? <Collecting range={range} backfilling={backfilling} />
        : <Plot points={visible} kind={kind} unit={unit} label={label} />}
    </div>
  );
}

function ChartHead({ label, range, setRange }: { label: string; range: string; setRange: (k: string) => void }) {
  return (
    <div className="hist-head">
      <div className="label">{`${label} over time`}</div>
      <div className="hist-range" role="group" aria-label="time range">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`hist-range-btn${r.key === range ? ' is-active' : ''}`}
            aria-pressed={r.key === range}
            onClick={() => setRange(r.key)}
          >{r.key}</button>
        ))}
      </div>
    </div>
  );
}

function Collecting({ range, backfilling = false }: { range: string; backfilling?: boolean }) {
  // A freshly-added market is actively reconstructing its history from Polymarket's price feed —
  // say so (and that it self-populates) rather than showing the neutral "waiting for snapshots" copy.
  if (backfilling) {
    return (
      <div className="empty" data-field="history-backfilling" aria-live="polite">
        {'Backfilling history… — reconstructing the daily series from Prediction Index price history. This section populates automatically once it completes.'}
      </div>
    );
  }
  return (
    <div className="empty" data-field="history-collecting">
      {`Collecting history — the trend chart appears once ${range === 'ALL' ? '2+' : `2+ in the last ${range.toLowerCase()}`} daily snapshots exist.`}
    </div>
  );
}

function Plot({ points, kind, unit, label }: { points: HistoryPoint[]; kind: string; unit: string; label: string }) {
  const xs = points.map((p) => ms(p.date));
  const xLo = xs[0], xHi = xs[xs.length - 1];
  const ys = points.map((p) => p.value);
  // Both axis families FIT THE FILTERED WINDOW (Bug 1): probability kinds via probDomain (padded
  // + min-span guarded + clamped to [0,1] — never a fixed 0–100% that flattens the series); value
  // kinds via the padded data range. `points` is already the tab-filtered set, so every 7D/30D/
  // 90D/ALL switch re-domains the Y axis.
  let yLo: number, yHi: number;
  if (isPctKind(kind)) { ({ lo: yLo, hi: yHi } = probDomain(ys)); }
  else {
    const min = Math.min(...ys), max = Math.max(...ys);
    const pad = (max - min) * 0.1 || Math.abs(max) * 0.05 || 1;
    yLo = min - pad; yHi = max + pad;
  }
  const xScale = (msVal: number) => xHi === xLo ? PAD.l : PAD.l + ((msVal - xLo) / (xHi - xLo)) * (VB_W - PAD.l - PAD.r);
  const yScale = (v: number) => yHi === yLo ? VB_H - PAD.b : VB_H - PAD.b - ((v - yLo) / (yHi - yLo)) * (VB_H - PAD.t - PAD.b);
  const line = points.map((p, i) => `${xScale(xs[i]).toFixed(1)},${yScale(p.value).toFixed(1)}`).join(' ');

  const yTicks = niceTicks(yLo, yHi, 5); // round tick values within the domain, consistent labels
  const xTickY = VB_H - PAD.b + 10;

  // Hover (snap): the headline value on that date.
  const anchors: SnapAnchor[] = points.map((p, i) => ({
    x: xScale(xs[i]),
    payload: { title: fmtDateShort(p.date, { year: true }), rows: [{ label, swatch: 'var(--accent-blue)', value: fmtVal(p.value, kind, unit) }] },
    dots: [{ y: yScale(p.value), color: 'var(--accent-blue)' }],
  }));

  return (
    <ChartCrosshair vbW={VB_W} vbH={VB_H} plotLeft={PAD.l} plotRight={VB_W - PAD.r} plotTop={PAD.t} plotBottom={VB_H - PAD.b}
      mode="snap" anchors={anchors} ariaLabel="History trend chart — hover for the value on each date">
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="History trend chart" data-field="history-svg">
      {yTicks.map((v, i) => (
        <g key={i}>
          <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={yScale(v)} y2={yScale(v)} />
          <text className="dist-axis" x={PAD.l - 5} y={yScale(v) + 3} textAnchor="end">{fmtVal(v, kind, unit)}</text>
        </g>
      ))}
      <polyline className="dist-cdf-line" points={line} fill="none" />
      {points.map((p, i) => (
        <circle key={i} className="dist-cdf-dot" cx={xScale(xs[i])} cy={yScale(p.value)} r={2.2}>
          <title>{`${fmtDateShort(p.date, { year: true })} · ${fmtVal(p.value, kind, unit)}`}</title>
        </circle>
      ))}
      <g data-field="hist-x-labels">
        {pickTicks(points, X_TICKS).map(({ item, i }) => {
          const x = xScale(xs[i]);
          return <text key={i} className="dist-tick" transform={`rotate(-45 ${x.toFixed(1)} ${xTickY})`} x={x.toFixed(1)} y={xTickY} textAnchor="end">{fmtDateShort(item.date)}</text>;
        })}
      </g>
    </svg>
    </ChartCrosshair>
  );
}

/** v1 ITEM 7: the dual-axis multi-line plot. Probability lines read off the LEFT axis (0–100%),
 *  value lines (median/mean) off the RIGHT axis. Each line is drawn segment-by-segment so a
 *  low-confidence day can dash/fade just its adjacent segments (the v1 segment styling). */
function DualPlot({ probLines, valueLines, lowDays, unit, band = null }:
  { probLines: ChartLine[]; valueLines: ChartLine[]; lowDays: string[]; unit: string; band?: BandPoint[] | null }) {
  const P = PAD_DUAL;
  const low = new Set(lowDays);
  // X domain across every visible point on every line.
  const allDates = [...probLines, ...valueLines].flatMap((l) => l.points.map((p) => ms(p.date)));
  const xLo = Math.min(...allDates), xHi = Math.max(...allDates);
  const xScale = (msVal: number) => xHi === xLo ? P.l : P.l + ((msVal - xLo) / (xHi - xLo)) * (VB_W - P.l - P.r);

  // LEFT axis: probability, FITTED to the filtered window (Bug 1 — was fixed 0–100%, which never
  // re-domained on a tab switch). RIGHT axis: value range across the value lines AND the IQR band
  // (the band must never bleed past the plot), padded.
  const pDom = probDomain(probLines.flatMap((l) => l.points.map((p) => p.value)));
  const yP = (v: number) => (VB_H - P.b) - ((v - pDom.lo) / (pDom.hi - pDom.lo)) * (VB_H - P.t - P.b);
  const vVals = [
    ...valueLines.flatMap((l) => l.points.map((p) => p.value)),
    ...(band ?? []).flatMap((b) => [b.lo, b.hi]),
  ];
  const vMin = vVals.length ? Math.min(...vVals) : 0;
  const vMax = vVals.length ? Math.max(...vVals) : 1;
  const vPad = (vMax - vMin) * 0.1 || Math.abs(vMax) * 0.05 || 1;
  const vLo = vMin - vPad, vHi = vMax + vPad;
  const yV = (v: number) => vHi === vLo ? VB_H - P.b : (VB_H - P.b) - ((v - vLo) / (vHi - vLo)) * (VB_H - P.t - P.b);

  const segments = (line: ChartLine, yScale: (v: number) => number, cls: string) =>
    line.points.slice(1).map((p, i) => {
      const prev = line.points[i];
      const isLow = low.has(prev.date) || low.has(p.date);
      return (
        <line
          key={`${line.key}-${i}`}
          className={`hist-line ${cls}${isLow ? ' is-low' : ''}`}
          x1={xScale(ms(prev.date))} y1={yScale(prev.value)}
          x2={xScale(ms(p.date))} y2={yScale(p.value)}
        />
      );
    });

  const probTicks = niceTicks(pDom.lo, pDom.hi, 5);
  const valTicks = niceTicks(vLo, vHi, 5);
  const xTickY = VB_H - P.b + 10;

  // Hover (snap): ONE tooltip showing every plotted series' value on that date (all P(>X) lines +
  // median + mean), colours matching the legend. Anchored on the union of dates across all lines.
  const swatchColor = (cls: string): string =>
    ({ 'hist-line-p0': 'var(--accent-amber)', 'hist-line-p1': 'var(--accent-blue)', 'hist-line-p2': 'var(--text-muted)',
       'hist-line-median': 'var(--tier1)', 'hist-line-mean': 'var(--tier1)' } as Record<string, string>)[cls] ?? 'var(--text-muted)';
  const bandByDate = new Map((band ?? []).map((b) => [b.date, b]));
  const allDateStrs = [...new Set([...probLines, ...valueLines].flatMap((l) => l.points.map((p) => p.date)))].sort();
  const anchors: SnapAnchor[] = allDateStrs.map((date) => {
    const rows: TooltipRow[] = [];
    const dots: { y: number; color: string }[] = [];
    probLines.forEach((l, i) => {
      const pt = l.points.find((p) => p.date === date);
      if (!pt) return;
      const color = swatchColor(PROB_CLASSES[i] ?? 'hist-line-p2');
      rows.push({ label: `P(>${unitPfx(unit)}${l.threshold}${unit})`, swatch: color, value: `${(pt.value * 100).toFixed(1)}%` });
      dots.push({ y: yP(pt.value), color });
    });
    valueLines.forEach((l) => {
      const pt = l.points.find((p) => p.date === date);
      if (!pt) return;
      const color = swatchColor(l.key === 'median' ? 'hist-line-median' : 'hist-line-mean');
      rows.push({ label: l.label ?? l.key, swatch: color, value: `${unitPfx(unit)}${pt.value.toFixed(2)}${unit}` });
      dots.push({ y: yV(pt.value), color });
    });
    const b = bandByDate.get(date);
    if (b) rows.push({ label: 'IQR (P25–P75)', swatch: 'var(--tier1)', value: `${unitPfx(unit)}${b.lo.toFixed(2)}–${unitPfx(unit)}${b.hi.toFixed(2)}${unit}` });
    return { x: xScale(ms(date)), payload: { title: fmtDateShort(date, { year: true }), rows }, dots };
  });

  // The IQR band as one closed polygon: the P75 edge left→right, then the P25 edge back.
  const bandPath = band && band.length >= 2
    ? [
        ...band.map((b, i) => `${i === 0 ? 'M' : 'L'}${xScale(ms(b.date)).toFixed(1)},${yV(b.hi).toFixed(1)}`),
        ...[...band].reverse().map((b) => `L${xScale(ms(b.date)).toFixed(1)},${yV(b.lo).toFixed(1)}`),
        'Z',
      ].join(' ')
    : null;

  return (
    <ChartCrosshair vbW={VB_W} vbH={VB_H} plotLeft={P.l} plotRight={VB_W - P.r} plotTop={P.t} plotBottom={VB_H - P.b}
      mode="snap" anchors={anchors} ariaLabel="Multi-line history chart — hover for every series on each date">
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Multi-line dual-axis history chart" data-field="history-svg" data-dual="true">
      {/* left probability axis grid + ticks */}
      {probTicks.map((v, i) => (
        <g key={`p${i}`}>
          <line className="dist-grid" x1={P.l} x2={VB_W - P.r} y1={yP(v)} y2={yP(v)} />
          <text className="dist-axis" x={P.l - 5} y={yP(v) + 3} textAnchor="end">{`${Math.round(v * 100)}%`}</text>
        </g>
      ))}
      {/* right value axis ticks (no grid lines — they belong to the left axis) */}
      {valueLines.length > 0 && valTicks.map((v, i) => (
        <text key={`v${i}`} className="hist-axis-r" x={VB_W - P.r + 5} y={yV(v) + 3} textAnchor="start">{`${unitPfx(unit)}${v.toFixed(2)}${unit}`}</text>
      ))}
      {/* P25–P75 IQR band (value axis) BEHIND every line — dispersion of the settlement distribution */}
      {bandPath && <path className="hist-band" d={bandPath} data-field="hist-iqr-band" />}
      {/* probability lines (left axis) */}
      {probLines.map((l, i) => segments(l, yP, PROB_CLASSES[i] ?? 'hist-line-p2'))}
      {/* value lines (right axis): median solid bright, mean faint dashed */}
      {valueLines.map((l) => segments(l, yV, l.key === 'median' ? 'hist-line-median' : 'hist-line-mean'))}
      <g data-field="hist-x-labels">
        {pickTicks(allDateStrs, X_TICKS).map(({ item, i }) => {
          const x = xScale(ms(item));
          return <text key={i} className="dist-tick" transform={`rotate(-45 ${x.toFixed(1)} ${xTickY})`} x={x.toFixed(1)} y={xTickY} textAnchor="end">{fmtDateShort(item)}</text>;
        })}
      </g>
    </svg>
    </ChartCrosshair>
  );
}

/** Legend chips for the dual chart — names each line so the colour hierarchy is legible. */
function DualLegend({ probLines, valueLines, unit, hasBand = false }: { probLines: ChartLine[]; valueLines: ChartLine[]; unit: string; hasBand?: boolean }) {
  const swatch = (cls: string) => {
    const map: Record<string, string> = {
      'hist-line-p0': 'var(--accent-amber)', 'hist-line-p1': 'var(--accent-blue)', 'hist-line-p2': 'var(--text-muted)',
      'hist-line-median': 'var(--tier1)', 'hist-line-mean': 'var(--tier1)',
    };
    return { borderTopColor: map[cls] ?? 'var(--text-muted)', opacity: cls === 'hist-line-mean' ? 0.4 : 1 };
  };
  return (
    <>
      <div className="hist-legend" data-field="history-legend">
        {probLines.map((l, i) => (
          <span key={l.key} className="hist-leg">
            <span className="hist-swatch" style={swatch(PROB_CLASSES[i] ?? 'hist-line-p2')} />
            {`P(>${unit === '%' ? '' : '$'}${l.threshold}${unit})`}
          </span>
        ))}
        {valueLines.map((l) => (
          <span key={l.key} className="hist-leg">
            <span className="hist-swatch" style={swatch(l.key === 'median' ? 'hist-line-median' : 'hist-line-mean')} />
            {l.label ?? l.key}
          </span>
        ))}
        {hasBand && (
          <span className="hist-leg">
            <span className="hist-swatch hist-swatch-band" />
            {'P25–P75 band'}
          </span>
        )}
      </div>
    </>
  );
}

/** PROB-ONLY multi-line plot (touch P(touch) sides, categorical outcome lines): N probability
 *  lines on a single % axis. Same segment-by-segment low-confidence dashing as DualPlot; colours
 *  by line key (touch high/low fixed warm/cool) else the palette. */
function MultiProbPlot({ lines, lowDays }: { lines: ChartLine[]; lowDays: string[] }) {
  const P = PAD;
  const low = new Set(lowDays);
  const allDates = lines.flatMap((l) => l.points.map((p) => ms(p.date)));
  const xLo = Math.min(...allDates), xHi = Math.max(...allDates);
  const xScale = (msVal: number) => xHi === xLo ? P.l : P.l + ((msVal - xLo) / (xHi - xLo)) * (VB_W - P.l - P.r);
  // Probability axis FITTED to the filtered window (Bug 1) — padded, min-span guarded, [0,1]-clamped.
  const dom = probDomain(lines.flatMap((l) => l.points.map((p) => p.value)));
  const yP = (v: number) => (VB_H - P.b) - ((v - dom.lo) / (dom.hi - dom.lo)) * (VB_H - P.t - P.b);

  const probTicks = niceTicks(dom.lo, dom.hi, 5);
  const xTickY = VB_H - P.b + 10;

  // Hover (snap): every line's value at the hovered date in one tooltip, colours matching the legend.
  const allDateStrs = [...new Set(lines.flatMap((l) => l.points.map((p) => p.date)))].sort();
  const anchors: SnapAnchor[] = allDateStrs.map((date) => {
    const rows: TooltipRow[] = [];
    const dots: { y: number; color: string }[] = [];
    lines.forEach((l, i) => {
      const pt = l.points.find((p) => p.date === date);
      if (!pt) return;
      const color = lineColor(l, i);
      rows.push({ label: l.label ?? l.key, swatch: color, value: `${(pt.value * 100).toFixed(1)}%` });
      dots.push({ y: yP(pt.value), color });
    });
    return { x: xScale(ms(date)), payload: { title: fmtDateShort(date, { year: true }), rows }, dots };
  });

  return (
    <ChartCrosshair vbW={VB_W} vbH={VB_H} plotLeft={P.l} plotRight={VB_W - P.r} plotTop={P.t} plotBottom={VB_H - P.b}
      mode="snap" anchors={anchors} ariaLabel="Multi-line probability history chart — hover for every series on each date">
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Multi-line probability history chart" data-field="history-svg" data-multiprob="true">
      {probTicks.map((v, i) => (
        <g key={i}>
          <line className="dist-grid" x1={P.l} x2={VB_W - P.r} y1={yP(v)} y2={yP(v)} />
          <text className="dist-axis" x={P.l - 5} y={yP(v) + 3} textAnchor="end">{`${Math.round(v * 100)}%`}</text>
        </g>
      ))}
      {lines.map((l, li) =>
        l.points.slice(1).map((p, i) => {
          const prev = l.points[i];
          const isLow = low.has(prev.date) || low.has(p.date);
          return (
            <line
              key={`${l.key}-${i}`}
              className={`hist-line${isLow ? ' is-low' : ''}`}
              style={{ stroke: lineColor(l, li) }}
              x1={xScale(ms(prev.date))} y1={yP(prev.value)}
              x2={xScale(ms(p.date))} y2={yP(p.value)}
            />
          );
        }))}
      <g data-field="hist-x-labels">
        {pickTicks(allDateStrs, X_TICKS).map(({ item, i }) => {
          const x = xScale(ms(item));
          return <text key={i} className="dist-tick" transform={`rotate(-45 ${x.toFixed(1)} ${xTickY})`} x={x.toFixed(1)} y={xTickY} textAnchor="end">{fmtDateShort(item)}</text>;
        })}
      </g>
    </svg>
    </ChartCrosshair>
  );
}

/** Legend chips for the prob-only multi-line chart: swatch + label + the CURRENT value. */
function MultiProbLegend({ lines }: { lines: ChartLine[] }) {
  return (
    <div className="hist-legend" data-field="history-legend">
      {lines.map((l, i) => {
        const last = l.points.length ? l.points[l.points.length - 1] : null;
        return (
          <span key={l.key} className="hist-leg">
            <span className="hist-swatch" style={{ borderTopColor: lineColor(l, i) }} />
            {`${l.label ?? l.key}${last ? ` · ${(last.value * 100).toFixed(0)}%` : ''}`}
          </span>
        );
      })}
    </div>
  );
}
