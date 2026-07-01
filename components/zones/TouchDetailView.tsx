// components/zones/TouchDetailView.tsx — Zone 2 detail for a DIRECTIONAL-TOUCH market.
//
// Rendered by MarketDetailView when derived.kind === 'directional_touch' (WTI/Silver
// "(LOW)/(HIGH) hit $X"). These markets price P(price TOUCHES a level before expiry), not a
// settlement value — there is NO survival curve and NO implied median (forcing one was the
// bug). So this view shows what the data actually is: the IMPLIED RANGE (from the HIGH/LOW
// 50% crossovers) as a horizontal range bar, plus a touch-probability table. The TRUST layer
// (confidence, freshness, provenance + hash-verify) is identical to every other detail.
import { canonicalizeRawInputs } from '@/core/fetch.js';
import { fmtEastern, displayTitle, pointChange, touchNarrative, daysToExpiryLabel, barrierPathUncertainty } from '@/lib/format-detail.mjs';
import { rangeBarLayout, niceTicks } from '@/lib/touch-rangebar.mjs';
import { ChartCrosshair, type InterpConfig, type InterpChannel } from './ChartCrosshair';
import { interpSeriesAtLevel } from '@/lib/chart-hover.mjs';
import { ConfidenceBadges, ConfidenceBasisGroup } from './ConfidenceBasis';
import { VolumeCard } from './VolumeCard';
import { TouchProbabilityTable } from './TouchProbabilityTable';
import { HashVerify } from './HashVerify';
import { DetailFreshness } from './DetailFreshness';
import { RefreshButton } from './RefreshButton';
import { TrendHistorySection, type HistoryUI } from './TrendHistory';
import type { MarketRecord, ServeBody, TouchPoint } from './market-record';

const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };
const LIFECYCLE_LABEL: Record<string, string> = { OPEN: 'OPEN', CLOSED_PENDING: 'CLOSED · PENDING', RESOLVED: 'RESOLVED' };

const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

// Item 4 redesign — a padded 480×150 viewBox (no clipping), a real tick axis reusing
// DistributionSVG's dist-tick/dist-grid tokens, and the implied band + markers in the middle.
const RB_VB_W = 480, RB_VB_H = 150;
const RB_PAD = { t: 28, r: 16, b: 40, l: 16 };
const RB_PLOT_L = RB_PAD.l, RB_PLOT_R = RB_VB_W - RB_PAD.r, RB_PLOT_W = RB_PLOT_R - RB_PLOT_L; // 16 … 464 (448 wide)
const RB_BAND_TOP = 52, RB_BAND_H = 22, RB_TRACK_Y = RB_BAND_TOP + RB_BAND_H / 2; // band 52..74, track 63
const RB_MARK_TOP = 44, RB_MARK_BOT = 82;
const RB_LABEL_ABOVE_Y = 40, RB_LABEL_BELOW_Y = 96; // hi/lo bound-label baselines (wide vs narrow)
const RB_AXIS_Y = 110, RB_TICK_H = 5, RB_TICK_LABEL_Y = 120; // tick axis + rotated labels

/** Horizontal range bar: the implied [low, high] band within the full strike span. A null
 *  bound (50% crossover outside the quoted ladder) extends the band to that edge. Hover along the
 *  axis interpolates P(touch ≥) / P(touch ≤) at that price level from the touch-probability table. */
function RangeBar({ low, high, lowLabel, highLabel, levels, unit, highPts, lowPts }: {
  low: number | null; high: number | null; lowLabel: string; highLabel: string; levels: number[];
  unit: string; highPts: { level: number; prob: number }[]; lowPts: { level: number; prob: number }[];
}) {
  const unionLevels = [...new Set(levels)].sort((a, b) => a - b);
  // Scope the axis to the IMPLIED RANGE plus a couple of context levels just beyond each bound, then
  // a 12% margin. "Will it ever hit $X" touch markets have heavy tails — deep strikes keep a few %
  // touch probability all the way out (Anthropic: P(touch≥$5T)=5.5%), so a probability threshold
  // never crops them and the real signal ($0.8–1.7T) gets squeezed into a sliver. Anchoring on the
  // range + context crops the far dead tail (still shown in the probability table below) so the band
  // is prominent. A wide-range market (range spans most of the ladder) keeps ~all levels: the
  // context levels beyond the bounds ARE the ladder ends.
  const CONTEXT = 2; // quoted levels to keep beyond each range bound, for context
  const rHi = high != null ? high : (unionLevels[unionLevels.length - 1] ?? 1);
  const rLo = low != null ? low : (unionLevels[0] ?? 0);
  const above = unionLevels.filter((l) => l > rHi).slice(0, CONTEXT);
  const below = unionLevels.filter((l) => l < rLo).slice(-CONTEXT);
  const focusVals = [rLo, rHi, ...above, ...below];
  let dMin = Math.min(...focusVals), dMax = Math.max(...focusVals);
  const margin = ((dMax - dMin) || Math.abs(dMax) || 1) * 0.12;
  dMin = Math.max(0, dMin - margin); dMax = dMax + margin;

  const layout = rangeBarLayout(low, high, levels,
    { x0: RB_PLOT_L, W: RB_PLOT_W, yAbove: RB_LABEL_ABOVE_Y, yBelow: RB_LABEL_BELOW_Y, domain: [dMin, dMax] });
  if (!layout) return null;
  const { min, max, bandL, bandR, narrow, lo, hi } = layout;
  const span = (max - min) || 1;
  const xOf = (lvl: number) => RB_PLOT_L + ((lvl - min) / span) * RB_PLOT_W;
  // Interpolate each touch side over the union of strike levels → a serializable interp config the
  // shared crosshair reads. P(touch ≥) comes from the HIGH legs, P(touch ≤) from the LOW legs.
  const rows: InterpChannel[] = [];
  if (highPts.length) rows.push({ label: 'P(touch ≥)', swatch: 'var(--accent-blue)', values: unionLevels.map((l) => interpSeriesAtLevel(highPts, l)), fmt: { scale: 100, digits: 0, suffix: '%' } });
  if (lowPts.length) rows.push({ label: 'P(touch ≤)', swatch: 'var(--accent-amber)', values: unionLevels.map((l) => interpSeriesAtLevel(lowPts, l)), fmt: { scale: 100, digits: 0, suffix: '%' } });
  const interp: InterpConfig = {
    anchorsVbX: unionLevels.map(xOf),
    titleValues: unionLevels,
    titleFmt: { prefix: '$', suffix: unit, digits: 2 },
    rows,
  };
  const ticks = niceTicks(min, max, 6);
  return (
    // crosshair spans the band+axis region (plotTop below the bound labels) so its tooltip never
    // collides with the hi/lo labels sitting in the padded top zone.
    <ChartCrosshair vbW={RB_VB_W} vbH={RB_VB_H} plotLeft={RB_PLOT_L} plotRight={RB_PLOT_R} plotTop={RB_BAND_TOP} plotBottom={RB_AXIS_Y}
      mode="interpolate" interp={interp} tooltipAtCursor ariaLabel="Implied barrier range — hover for P(touch) at each price level">
    <svg className="touch-rangebar" viewBox={`0 0 ${RB_VB_W} ${RB_VB_H}`} preserveAspectRatio="none" role="img" aria-label="implied trading range" data-field="range-bar" data-narrow={narrow ? 'true' : 'false'}>
      {/* nice-tick axis: faint vertical gridlines + a baseline + rotated $ labels (dist-* tokens) */}
      <g data-field="range-axis">
        {ticks.map((t, i) => {
          const x = xOf(t);
          return (
            <g key={i}>
              <line className="dist-grid" x1={x} x2={x} y1={RB_PAD.t} y2={RB_AXIS_Y} />
              <line className="dist-grid" x1={x} x2={x} y1={RB_AXIS_Y} y2={RB_AXIS_Y + RB_TICK_H} />
              <text className="dist-tick" transform={`rotate(-45 ${x.toFixed(1)} ${RB_TICK_LABEL_Y})`} x={x.toFixed(1)} y={RB_TICK_LABEL_Y} textAnchor="end">{`$${t}${unit}`}</text>
            </g>
          );
        })}
        <line className="touch-axis" x1={RB_PLOT_L} x2={RB_PLOT_R} y1={RB_AXIS_Y} y2={RB_AXIS_Y} />
      </g>
      {/* full strike track */}
      <line x1={RB_PLOT_L} y1={RB_TRACK_Y} x2={RB_PLOT_R} y2={RB_TRACK_Y} className="touch-track" />
      {/* implied band */}
      <rect x={Math.max(RB_PLOT_L, bandL)} y={RB_BAND_TOP} width={Math.max(2, bandR - bandL)} height={RB_BAND_H} className="touch-band" />
      {/* bound markers */}
      {low != null && <line x1={bandL} y1={RB_MARK_TOP} x2={bandL} y2={RB_MARK_BOT} className="touch-mark" />}
      {high != null && <line x1={bandR} y1={RB_MARK_TOP} x2={bandR} y2={RB_MARK_BOT} className="touch-mark" />}
      {/* bound labels — above-left/above-right when the band is wide; stacked hi-above/lo-below
          (centred on the band) when narrow, so they never overlap (Bug B). */}
      <text x={lo.x} y={lo.y} className="touch-axislabel" textAnchor={lo.anchor as 'start' | 'end' | 'middle'} data-field="range-lo-label">{lowLabel}</text>
      <text x={hi.x} y={hi.y} className="touch-axislabel" textAnchor={hi.anchor as 'start' | 'end' | 'middle'} data-field="range-hi-label">{highLabel}</text>
    </svg>
    </ChartCrosshair>
  );
}

export function TouchDetailView({ record, envelope, hist, addControl }: { record: MarketRecord; envelope: ServeBody; hist?: HistoryUI; addControl?: React.ReactNode }) {
  const s = record?.snapshot ?? {};
  const d = s?.derived ?? {};
  const asset = record?.asset ?? {};
  const lifecycleState: string = s?.lifecycle?.state ?? envelope?.lifecycle_state ?? 'OPEN';
  const isFinal = lifecycleState === 'RESOLVED';
  const conf = d.confidence ?? {};
  const fresh = d.freshness ?? {};
  const unit = d.unit ?? d.implied_range?.unit ?? '';
  const range = d.implied_range ?? {};
  const high = (d.high_series ?? []) as TouchPoint[];
  const low = (d.low_series ?? []) as TouchPoint[];
  const rawSha: string = s?.source?.raw_sha256 ?? '';
  const canonical = Array.isArray(s?.raw_inputs) ? canonicalizeRawInputs(s.raw_inputs) : '';
  const near = d.near_settlement === true && lifecycleState === 'OPEN'; // amber NEAR SETTLEMENT

  // Merge HIGH/LOW into one table keyed by level (descending — top of the range first).
  const byLevel = new Map<number, { level: number; high?: number; low?: number; vol?: number }>();
  for (const p of high) byLevel.set(p.level, { ...(byLevel.get(p.level) ?? { level: p.level }), high: p.prob, vol: p.volume });
  for (const p of low) byLevel.set(p.level, { ...(byLevel.get(p.level) ?? { level: p.level }), low: p.prob, vol: p.volume });
  const rows = [...byLevel.values()].sort((a, b) => b.level - a.level);
  const allLevels = [...high, ...low].map((p) => p.level);

  // v1 ITEM 1/5: the implied-range midpoint + its move over 30d/7d (from the lean history series).
  // A touch market has no median — the midpoint of the [low,high] band is the headline scalar.
  const lo = range.low ?? null, hi = range.high ?? null;
  const mid = lo != null && hi != null ? (lo + hi) / 2 : (hi ?? lo);
  const width = lo != null && hi != null ? hi - lo : null;
  // Increment 7: the barrier range's width as a fraction of the strike axis → PATH uncertainty.
  const axisSpan = allLevels.length ? Math.max(...allLevels) - Math.min(...allLevels) : null;
  const pathUncertainty = barrierPathUncertainty(width != null && axisSpan ? width / axisSpan : null);
  const pts = hist?.points ?? [];
  const daysHave = hist?.velocity?.days_have ?? 0;
  const midChange30 = daysHave >= 28 ? pointChange(pts, 30) : null;
  const midChange7 = daysHave >= 7 ? pointChange(pts, 7) : null;
  const fmtSigned = (c: number | null) => c == null ? null : `${c >= 0 ? '+' : '−'}$${Math.abs(c).toFixed(2)}${unit}`;
  const signCls = (c: number | null) => c == null ? '' : c > 0 ? 'is-up' : c < 0 ? 'is-down' : '';

  return (
    <article className="detail-view" data-zone="detail-view" data-kind="directional_touch" data-market-id={envelope?.market_id} data-lifecycle={lifecycleState}>
      <header className="detail-head">
        <div>
          <h1 className="detail-title" data-field="title">{displayTitle(asset.name, envelope?.market_id)}</h1>
          <div className="detail-sub muted">
            {asset.platform ?? 'polymarket'}{asset.resolves ? ` · resolves ${asset.resolves}` : ''}
            {daysToExpiryLabel(asset.resolves) && <span data-field="days-to-expiry"> · {daysToExpiryLabel(asset.resolves)}</span>}
            {asset.market_url && <> · <a href={asset.market_url} target="_blank" rel="noopener">view market ↗</a></>}
            <> · <span className="touch-tag">TOUCH MARKET</span></>
          </div>
        </div>
        <div className="detail-head-actions">
          {addControl}
          {envelope?.market_id && <RefreshButton slug={envelope.market_id} />}
          {near ? (
            <span className="detail-lifecycle state-pending" data-field="lifecycle" data-near-settlement="true">
              ◐ NEAR SETTLEMENT
            </span>
          ) : (
            <span className={`detail-lifecycle ${LIFECYCLE_CLASS[lifecycleState] ?? ''}`} data-field="lifecycle">
              ● {LIFECYCLE_LABEL[lifecycleState] ?? lifecycleState}
            </span>
          )}
        </div>
      </header>

      {/* what a touch market IS — so the quant knows exactly what they're reading */}
      <p className="touch-explainer faint" data-field="touch-explainer">
        This is a <b>barrier-option</b> market: each leg prices the probability of the price
        <b> touching</b> a level before expiry. There is no implied median; the signal is the implied
        barrier range. <b>These prices reflect the probability of touching a barrier, not where the
        market expects the price to settle.</b>
      </p>

      {/* HEADLINE — the implied range */}
      <div className="detail-headline">
        <div className="detail-metric detail-metric-wide">
          <span className="label">Implied barrier range <span className="faint">({Math.round((range.confidence ?? 0.5) * 100)}% confidence)</span></span>
          <span className="detail-hero num" data-field="implied-range">{range.low_label ?? '—'} <span className="faint">–</span> {range.high_label ?? '—'}</span>
          <span className="detail-band faint">lower / upper 50% touch crossovers</span>
        </div>
        <div className="detail-metric">
          <span className="label">Confidence</span>
          <ConfidenceBadges confidence={conf} />
        </div>
        <div className="detail-metric">
          <span className="label">Volume</span>
          <span className="detail-sec num" data-field="volume">{fmtVol(d.total_volume)}</span>
          <span className="detail-band faint">cumulative, all-time</span>
        </div>
      </div>

      {/* RANGE BAR — the band within the strike span (no CDF: there is no distribution) */}
      <section className="detail-section">
        <h2 className="detail-h2" data-field="barrier-range-heading">Implied barrier range</h2>
        <RangeBar low={range.low ?? null} high={range.high ?? null} lowLabel={range.low_label ?? '—'} highLabel={range.high_label ?? '—'} levels={allLevels} unit={unit}
          highPts={high.map((p) => ({ level: p.level, prob: p.prob })).sort((a, b) => a.level - b.level)}
          lowPts={low.map((p) => ({ level: p.level, prob: p.prob })).sort((a, b) => a.level - b.level)} />
      </section>

      {/* TRUST BAND — identical to the ladder/binary detail (v1 ITEM 11 confidence checklist) */}
      <div className="detail-trust" data-field="trust">
        <ConfidenceBasisGroup confidence={conf} />
        <div className="trust-prov">
          <span className="label">As of</span>
          <span className="num" data-field="as-of">{fmtEastern(s.fetched_at)}</span>
          <DetailFreshness asOf={fresh.as_of ?? null} staleAfter={fresh.stale_after ?? null} fetchedAt={s.fetched_at ?? null} isFinal={isFinal} />
          <span className="trust-sep">·</span>
          <span className="label">methodology</span><span className="num">v{record.methodology_version ?? '—'}</span>
          <span className="trust-sep">·</span>
          <span className="label">sha256</span>
          {rawSha && canonical ? <HashVerify canonical={canonical} publishedHash={rawSha} /> : <span className="faint">unavailable</span>}
        </div>
      </div>

      {/* KEY METRICS (v1 ITEMS 5 + 8) — the range midpoint with its 30d move + range width +
          volume, each with a plain-English sub-label. The midpoint is the touch headline scalar. */}
      <section className="detail-section" data-field="key-metrics">
        <h2 className="detail-h2">Key metrics</h2>
        <div className="detail-analytics">
          <div className="acard" data-field="pcard-midpoint">
            <div className="label">Range midpoint</div>
            <div className="acard-v">{mid != null ? `$${mid.toFixed(2)}${unit}` : '—'}</div>
            <div className={`acard-s ${signCls(midChange30)}`}>{midChange30 == null ? <span className="faint">no 30d history</span> : <>{fmtSigned(midChange30)} · 30d</>}</div>
          </div>
          <div className="acard" data-field="pcard-width">
            <div className="label">Range width <span className="faint">· path uncertainty</span></div>
            {/* A one-sided range (an open "> $X" / "< $X" bound) has no finite width — say so honestly
                instead of a bare dash (the product's never-dashes principle). */}
            <div className="acard-v">{width != null ? `$${width.toFixed(2)}${unit}` : 'n/a'}</div>
            <div className="acard-s faint" data-field="range-width-interp">{
              width != null
                ? (pathUncertainty ? `${pathUncertainty.label} — ${pathUncertainty.detail}` : 'upper − lower bound')
                : `open-ended ${lo == null ? 'lower' : 'upper'} bound — no finite width`
            }</div>
          </div>
          <VolumeCard liquidity={d.liquidity} allTimeVolume={d.total_volume} />
        </div>
      </section>

      {/* NARRATIVE (v1 ITEM 1) — the implied range + midpoint move + confidence, built display-side;
          Δ sentences omit gracefully when history is absent (never a dash). */}
      <p className="detail-narrative" data-field="narrative">{`${touchNarrative({ lowLabel: range.low_label ?? '', highLabel: range.high_label ?? '', midChange30, midChange7, unit, reliabilityTier: conf.reliability?.tier ?? null, liquidityTier: conf.liquidity?.tier ?? null, resolves: asset.resolves ?? null }) || d.narrative || ''}${hist?.synthesis ? ` ${hist.synthesis}` : ''}`}</p>

      {/* TOUCH PROBABILITY TABLE — P(touch ≥) for HIGH legs, P(touch ≤) for LOW legs. Near
          settlement (Bug B) it shows the active range only with a "show all" toggle; otherwise
          consecutive all-zero levels collapse into one "N levels at 0%" row. */}
      {rows.length > 0 && (
        <section className="detail-section">
          <h2 className="detail-h2">Touch probabilities <span className="faint">· current snapshot</span></h2>
          <TouchProbabilityTable rows={rows} near={near} unit={unit} resolves={asset.resolves ?? null} />
        </section>
      )}

      {/* TREND & HISTORY — implied-range midpoint over time (Phase 1) */}
      {hist && <TrendHistorySection hist={hist} unit={unit} label="Range midpoint" />}

      <details className="detail-method">
        <summary>How these numbers are computed (methodology v{record.methodology_version ?? '—'})</summary>
        <ul>
          <li><b>Touch market</b>: each leg prices P(price touches a level before expiry) — a HIGH leg is P(touch ≥ level), a LOW leg is P(touch ≤ level). These are not points on a settlement distribution, so there is no implied median or CDF.</li>
          <li><b>Implied range</b>: the lower bound is where the LOW series crosses 50% (50% chance of breaking below); the upper bound is where the HIGH series crosses 50% (50% chance of breaking above). A bound shown as &ldquo;&lt; $X&rdquo; / &ldquo;&gt; $X&rdquo; means the crossover falls outside the quoted strike ladder.</li>
          <li><b>Confidence</b> = worst of {'{'}bid-ask spread, volume, last-trade fallback{'}'}; reasons shown above. <b>Provenance</b>: raw inputs + a re-verifiable sha256 (button above).</li>
        </ul>
      </details>
    </article>
  );
}
