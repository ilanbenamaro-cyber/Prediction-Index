// components/zones/MarketDetailView.tsx — Zone 2 (market detail), 2c.3.
//
// PORT-AND-GENERALIZE of docs/index.html into the terminal detail pane, fed by the
// authoritative probed serve for the ONE selected market. DetailData runs serveMarket
// DIRECTLY (same shared DEPS as /api/market — no drift, behavior-identical, no HTTP
// hop) — the correctness layer, opposite of the rail's cached read. Render order puts
// the TRUST band high (a fund's "can I trust this number" is co-equal with the number).
// History-dependent sections (trends/Δ-columns/movers) are cut: /api/market carries no
// history; analytics.velocity conveys movement. Tier-2 scenarios cut (locked 2c scope).
// Defensive: optional-chaining + per-section fallbacks so a thin record degrades, never throws.
import { serveMarket } from '@/lib/serve-market.mjs';
import { DEPS } from '@/lib/market-deps.mjs';
import { createClient } from '@/lib/supabase/server';
import { listVisible } from '@/lib/watchlist.mjs';
import { AddToWatchlist, type Membership } from './AddToWatchlist';
import { canonicalizeRawInputs } from '@/core/fetch.js';
import { readHistory, headlineValue, deriveVelocity, deriveDispersion, deriveDeltas, deriveBiggestMoves, deriveChartSeries, headlineChange, latestSnapshotWindow, deriveReliabilityTrend, readBackfillStatus } from '@/lib/market-history.mjs';
import { unitFromLadder, fmtMoney, fmtRange, fmtEastern, impliedMedianLabel, displayTitle, fmtDeltaPp, deltaSign, meanRobustnessLabel, modeBucket, detailNarrative, daysToExpiryLabel, synthesizeSignals } from '@/lib/format-detail.mjs';
import { DistributionSVG } from './DistributionSVG';
import { SettlementConsensus } from './SettlementConsensus';
import { TrendHistorySection, type HistoryUI, type VelocityResult, type DispersionResult } from './TrendHistory';
import { HashVerify } from './HashVerify';
import { DetailFreshness } from './DetailFreshness';
import { RefreshButton } from './RefreshButton';
import { ConfidenceBadges, ConfidenceBasisGroup } from './ConfidenceBasis';
import { VolumeCard } from './VolumeCard';
import { LadderThresholdTable } from './LadderThresholdTable';
import { BinaryDetailView } from './BinaryDetailView';
import { TouchDetailView } from './TouchDetailView';
import { CategoricalDetailView } from './CategoricalDetailView';
import type { MarketRecord, ServeBody, Analytics, ResolvedLeg, LadderRow, ThresholdDelta, BiggestMoves, Mover } from './market-record';

// Shape for the Phase 1 history rows (lib/market-history.mjs is untyped JS; this types the
// boundary readHistory returns). The derived velocity/dispersion/UI types live in TrendHistory.
interface HistoryRow {
  snapshot_date: string; kind: string;
  implied_median: number | null; probability: number | null;
  touch_range_lo: number | null; touch_range_hi: number | null;
  record: MarketRecord;
}

const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };
const LIFECYCLE_LABEL: Record<string, string> = { OPEN: 'OPEN', CLOSED_PENDING: 'CLOSED · PENDING', RESOLVED: 'RESOLVED' };

const pct = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);

/** The realized band from a RESOLVED outcome ladder: highest Yes → first No. */
function resolvedBand(outcome: ResolvedLeg[] | undefined, unit: string): string | null {
  if (!Array.isArray(outcome) || outcome.length === 0) return null;
  const yes = outcome.filter((o) => o.outcome === 'Yes').map((o) => o.threshold);
  const no = outcome.filter((o) => o.outcome === 'No').map((o) => o.threshold);
  const lastYes = yes.length ? Math.max(...yes) : null;
  const firstNo = no.length ? Math.min(...no) : null;
  const p = unit === '%' ? '' : '$'; // percent buckets carry no '$' prefix
  if (lastYes != null && firstNo != null) return `settled in ${p}${lastYes}–${firstNo}${unit}  (>${p}${lastYes}${unit} Yes · >${p}${firstNo}${unit} No)`;
  if (lastYes != null) return `settled above ${p}${lastYes}${unit}`;
  if (firstNo != null) return `settled below ${p}${firstNo}${unit}`;
  return null;
}

/* ── async data boundary: the authoritative serve for one market ── */
export async function DetailData({ id }: { id: string }) {
  const { status, body } = (await serveMarket({ id, deps: DEPS })) as { status: number; body: ServeBody };
  if (status !== 200 || !body?.record) {
    return <DetailError id={id} status={status} message={body?.error} />;
  }
  // History layer (Phase 1): read the stored daily series and derive trend analytics +
  // a LEAN chart series (the heavy record JSONB never ships to the client). Additive —
  // a read failure degrades to empty, never breaking the authoritative serve.
  const dk = body.record?.snapshot?.derived?.kind;
  const chartKind = dk === 'binary' ? 'binary'
    : dk === 'categorical' ? 'categorical'
    : dk === 'directional_touch' ? 'directional_touch' : 'ladder';
  // Read up to a year of history so the chart's 90D/ALL toggle can show the FULL backfilled
  // series (a backfill can write 180+ days; the old 90-day window hid most of it, and for a
  // RESOLVED market whose data ends weeks ago the 90-day-from-today window caught only the tail).
  // The velocity/dispersion/Δ/mover derivations look only at fixed horizons, so the wider read
  // doesn't change them. Lean {date,value} points are shipped to the client — not the records.
  let rows: HistoryRow[] = [];
  try { rows = (await readHistory(id, 365)) as HistoryRow[]; } catch { rows = []; }
  // Backfill provenance: a freshly-added market whose CLOB reconstruction hasn't finished
  // (status null/'pending') shows "Backfilling history…" instead of the bare "Collecting" state.
  // A read failure degrades to null → the neutral collecting state, never breaks the serve.
  let backfillStatus: string | null = null;
  try { backfillStatus = (await readBackfillStatus(id)) as string | null; } catch { backfillStatus = null; }
  const hist: HistoryUI = {
    velocity: deriveVelocity(rows) as VelocityResult,
    dispersion: deriveDispersion(rows) as DispersionResult,
    points: rows.map((r) => ({ date: r.snapshot_date, value: headlineValue(r) as number })).filter((p) => p.value != null),
    kind: chartKind,
    // v1 ITEM 7: the multi-line dual-axis chart series — per-threshold P(>X) + median/mean — for
    // survival/bucket ladders only (null for binary/touch/categorical → single-line fallback).
    // Built server-side from the record JSONB; only lean {date,value}[] per line ships to the client.
    series: deriveChartSeries(rows),
    // Increment 2: capture window of the latest datapoint (US-hours vs off-peak) for the data note.
    snapshotWindow: latestSnapshotWindow(rows) as 'us-hours' | 'off-peak' | null,
    backfillStatus,
  };
  // Increment 5: the closing cross-signal synthesis sentence (velocity vs dispersion vs confidence
  // trend), appended to whichever detail view's narrative. Null when signals agree / history < 7d.
  hist.synthesis = synthesizeSignals({
    velocity: hist.velocity,
    dispersion: hist.dispersion,
    confidenceTrend: deriveReliabilityTrend(rows),
    currentConfidence: body.record?.snapshot?.derived?.confidence?.reliability?.tier ?? null,
    kind: chartKind,
  }) as string | null;
  // Phase 3: per-threshold Δ columns + biggest movers, derived from the same daily series.
  // Survival/PMF only (the ladder view owns the threshold table); the binary/touch/categorical
  // views ignore these props. Thresholds come from the current served record so the Δ rows
  // align 1:1 with the table; a horizon with no matching day stays null (rendered as "—").
  const thresholds = (body.record?.snapshot?.derived?.markets ?? []).map((m) => m.threshold);
  const deltas = deriveDeltas(rows, thresholds) as ThresholdDelta[];
  const movers = deriveBiggestMoves(rows, 30) as BiggestMoves;
  // v1 ITEM 1: history-derived narrative pieces. The 30d sentence needs a near-full month of data
  // so a short window isn't mislabelled "past month"; the band direction needs dispersion (≥30d).
  const daysHave = (hist.velocity as VelocityResult & { days_have?: number }).days_have ?? 0;
  const narrativeBits: NarrativeBits = {
    change7: daysHave >= 7 ? (headlineChange(rows, 7) as number | null) : null,
    change30: daysHave >= 28 ? (headlineChange(rows, 30) as number | null) : null,
    bandDirection: hist.dispersion.status === 'ok'
      ? (hist.dispersion.direction === 'converging' ? 'narrowing' : hist.dispersion.direction === 'diverging' ? 'widening' : 'steady')
      : null,
  };
  // Item 2: the header "Add to Watchlist" control. Fetch the user's orgs + this market's current
  // membership (personal / which orgs) via the cookie-bound user client (RLS-scoped), and build the
  // control here so it threads as one ready-made client element into every detail view's header. A
  // read failure degrades to no control rather than breaking the authoritative serve.
  let addControl: React.ReactNode = null;
  try {
    const supabase = await createClient();
    const [orgsRes, visible] = await Promise.all([
      supabase.from('organizations').select('id, name'),
      listVisible(supabase),
    ]);
    const orgs = (orgsRes.data ?? []).map((o) => ({ id: o.id as string, name: (o.name as string) ?? 'Org' }));
    const rows = (visible ?? []) as Array<{ market_id: string; scope: string; org_id: string | null }>;
    const mine = rows.filter((v) => v.market_id === id);
    const membership: Membership = {
      personal: mine.some((v) => v.scope === 'personal'),
      orgIds: [...new Set(mine.filter((v) => v.scope === 'org' && v.org_id).map((v) => v.org_id as string))],
    };
    // KEY the control on the current server-side membership. AddToWatchlist holds optimistic local
    // state (the ✓/Add flip), and useState(initial.*) does NOT re-read `initial` on a re-render — so
    // when membership changes EXTERNALLY (e.g. a remove from the rail revalidates the layout and
    // re-runs this fetch with personal=false), a stable component would keep its stale ✓. Changing
    // the key on a membership change forces a remount → useState re-initializes from fresh `initial`
    // → the Add button reappears. (React's "reset state when a prop changes" via key.)
    const membershipKey = `${id}|${membership.personal ? 'p' : '-'}|${[...membership.orgIds].sort().join(',')}`;
    addControl = <AddToWatchlist key={membershipKey} slug={id} orgs={orgs} initial={membership} />;
  } catch (e) {
    console.error('[detail] add-to-watchlist membership read failed:', e);
  }
  return <MarketDetailView record={body.record} envelope={body} hist={hist} deltas={deltas} movers={movers} narrativeBits={narrativeBits} addControl={addControl} />;
}

interface NarrativeBits { change7: number | null; change30: number | null; bandDirection: 'narrowing' | 'widening' | 'steady' | null; }

function MarketDetailView({ record, envelope, hist, deltas, movers, narrativeBits, addControl }:
  { record: MarketRecord; envelope: ServeBody; hist: HistoryUI; deltas: ThresholdDelta[]; movers: BiggestMoves; narrativeBits: NarrativeBits; addControl?: React.ReactNode }) {
  // Binary (Yes/No) markets get a distinct, simpler layout — no CDF/ladder/analytics.
  if (record?.snapshot?.derived?.kind === 'binary') {
    return <BinaryDetailView record={record} envelope={envelope} hist={hist} addControl={addControl} />;
  }
  // Directional-touch (WTI/Silver "hit $X") markets: implied range + touch table, no CDF.
  if (record?.snapshot?.derived?.kind === 'directional_touch') {
    return <TouchDetailView record={record} envelope={envelope} hist={hist} addControl={addControl} />;
  }
  // Categorical (named outcomes, e.g. Fed rate cuts): outcome distribution, no CDF.
  if (record?.snapshot?.derived?.kind === 'categorical') {
    return <CategoricalDetailView record={record} envelope={envelope} hist={hist} addControl={addControl} />;
  }
  const s = record?.snapshot ?? {};
  const d = s?.derived ?? {};
  const asset = record?.asset ?? {};
  const lifecycleState: string = s?.lifecycle?.state ?? envelope?.lifecycle_state ?? 'OPEN';
  const isFinal = lifecycleState === 'RESOLVED';
  const unit = unitFromLadder(d.markets);
  const conf = d.confidence ?? {};
  const fresh = d.freshness ?? {};
  const analytics = d?.market?.analytics ?? null;
  const rawSha: string = s?.source?.raw_sha256 ?? '';
  const canonical = Array.isArray(s?.raw_inputs) ? canonicalizeRawInputs(s.raw_inputs) : '';
  const band = resolvedBand(s?.lifecycle?.resolved_outcome, unit);
  const near = d.near_settlement === true && lifecycleState === 'OPEN'; // amber NEAR SETTLEMENT (Bug 3)
  // v1 ITEM 9: the at-the-money rung (P nearest 50%) is the threshold that matters most — the one
  // the market is actually deciding — vs the noise rungs pinned at 0%/100%. Highlight it amber.
  const atmThreshold = nearestThreshold(d.markets, 0.5)?.threshold ?? null;
  // Increment 1: per-rung 24h volume for the table column (present only on records computed with
  // windowed volume — older records omit it, and the column is hidden rather than showing dashes).
  const vol24ByThreshold = d.liquidity?.by_threshold ?? null;

  return (
    <article className="detail-view" data-zone="detail-view" data-market-id={envelope?.market_id} data-lifecycle={lifecycleState}>
      {/* HEADER */}
      <header className="detail-head">
        <div>
          <h1 className="detail-title" data-field="title">{displayTitle(asset.name, envelope?.market_id)}</h1>
          <div className="detail-sub muted">
            {asset.platform ?? 'polymarket'}{asset.resolves ? ` · resolves ${asset.resolves}` : ''}
            {daysToExpiryLabel(asset.resolves) && <span data-field="days-to-expiry"> · {daysToExpiryLabel(asset.resolves)}</span>}
            {asset.market_url && <> · <a href={asset.market_url} target="_blank" rel="noopener">view market ↗</a></>}
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

      {/* RESOLVED banner — prominent, frozen outcome, no live pull */}
      {isFinal && (
        <div className="detail-resolved" data-field="resolved-banner">
          <span className="detail-resolved-tag">RESOLVED</span>
          <span className="detail-resolved-band">{band ?? 'settled'}</span>
          <span className="detail-resolved-note faint">final record · served from cache, not re-pulled live</span>
        </div>
      )}

      {/* HEADLINE */}
      <div className="detail-headline">
        <div className="detail-metric">
          <span className="label">Implied median</span>
          <span className="detail-hero num" data-field="median">{impliedMedianLabel(d.markets, d.implied_median ?? null, unit)}</span>
          <span className="detail-band faint">{fmtRange(d.median, unit) ? `range ${fmtRange(d.median, unit)} · bid/ask` : 'point estimate'}</span>
        </div>
        <div className="detail-metric">
          <span className="label">Implied mean <span className="faint">(approx)</span></span>
          <span className="detail-sec num" data-field="mean">{fmtMoney(d.implied_mean, unit)}</span>
          {/* v1 ITEM 3: mean robustness at a glance from |mean − median| */}
          <span className="detail-band faint" data-field="mean-band">{meanRobustnessLabel(d.implied_mean ?? null, d.implied_median ?? null, unit) || (fmtRange(d.mean, unit) ? `range ${fmtRange(d.mean, unit)} · tail` : '')}</span>
        </div>
        <div className="detail-metric">
          <span className="label">50% band</span>
          <span className="detail-sec num" data-field="iqr">{d.iqr ? `${fmtMoney(d.iqr.p25, unit)} – ${fmtMoney(d.iqr.p75, unit)}` : '—'}</span>
          <span className="detail-band faint">p25–p75 valuation</span>
        </div>
        <div className="detail-metric">
          <span className="label">Confidence</span>
          <ConfidenceBadges confidence={conf} />
        </div>
      </div>

      {/* TRUST BAND — prominent, before the distribution */}
      <div className="detail-trust" data-field="trust">
        {/* v1 ITEM 11: the confidence basis as a tier-marked checklist — one row per dimension. */}
        <ConfidenceBasisGroup confidence={conf} />
        <div className="trust-prov">
          <span className="label">As of</span>
          <span className="num" data-field="as-of">{fmtEastern(s.fetched_at)}</span>
          <DetailFreshness asOf={fresh.as_of ?? null} staleAfter={fresh.stale_after ?? null} fetchedAt={s.fetched_at ?? null} isFinal={isFinal} />
          <span className="trust-sep">·</span>
          <span className="label">methodology</span><span className="num">v{record.methodology_version ?? '—'}</span>
          <span className="trust-sep">·</span>
          <span className="label">sha256</span>
          {rawSha && canonical
            ? <HashVerify canonical={canonical} publishedHash={rawSha} />
            : <span className="faint">unavailable</span>}
        </div>
      </div>

      {/* KEY METRICS — for an OPEN market the v1 P(>at-the-money)/P(>tail) cards (ITEMS 5+6); for a
          RESOLVED market those make no sense (every P(>X) is now 0/1 with a meaningless "30d Δ"), so
          Bug C swaps them for RESOLUTION STATE cards: outcome, final median, resolution date. */}
      {Array.isArray(d.markets) && d.markets.length > 0 && (
        isFinal
          ? <ResolvedMetricsSection
              outcome={s?.lifecycle?.resolved_outcome}
              medianLabel={impliedMedianLabel(d.markets, d.implied_median ?? null, unit)}
              resolvedAt={s?.lifecycle?.as_of ?? s?.fetched_at ?? null}
              unit={unit} />
          : <KeyMetricsSection markets={d.markets} totalVolume={d.total_volume ?? null} deltas={deltas} unit={unit} liquidity={d.liquidity ?? null} />
      )}

      {/* DISTRIBUTION — the analytical centerpiece. Near settlement the CDF is a step from
          1→0 with no remaining signal, so swap it for the settlement-consensus view (Bug 6).
          Enh 3 hierarchy: header → headline → trust → DISTRIBUTION → narrative → analytics. */}
      <section className="detail-section">
        <h2 className="detail-h2">{near ? 'Settlement consensus' : 'Distribution'}</h2>
        {near
          ? <SettlementConsensus markets={d.markets} impliedMedian={d.implied_median ?? null} unit={unit} />
          : <DistributionSVG markets={d.markets} impliedMedian={d.implied_median ?? null} unit={unit} />}
      </section>

      {/* NARRATIVE (v1 ITEM 1) — current median + 30d/7d change + mode bucket + band direction +
          confidence, built display-side from the derived block + history (the stored pipeline
          narrative is unchanged). Δ/band sentences omit gracefully when history is absent. */}
      <p className="detail-narrative" data-field="narrative">{`${detailNarrative({
        medianLabel: impliedMedianLabel(d.markets, d.implied_median ?? null, unit),
        change30: narrativeBits.change30,
        change7: narrativeBits.change7,
        mode: modeBucket(d.markets, unit),
        bandDirection: narrativeBits.bandDirection,
        reliabilityTier: conf.reliability?.tier ?? null,
        liquidityTier: conf.liquidity?.tier ?? null,
        unit,
      })}${hist?.synthesis ? ` ${hist.synthesis}` : ''}`}</p>

      {/* TREND & HISTORY — the daily series (Phase 1). Velocity/dispersion show an explicit
          "Collecting" state until enough days accrue; never dashes. */}
      <TrendHistorySection hist={hist} unit={unit} label="Implied median" />

      {/* TIER-1 ANALYTICS — always rendered (real data, "—" per missing field, or an
          explicit insufficient-data state); never silently absent. */}
      <AnalyticsCards analytics={analytics} unit={unit} />

      {/* BIGGEST MOVERS (Phase 3) — the thresholds whose P(>X) shifted most over 30 days,
          from the daily history series. Collecting until ≥2 snapshots exist; never blank. */}
      {Array.isArray(d.markets) && d.markets.length > 0 && (
        <BiggestMoversSection movers={movers} unit={unit} />
      )}

      {/* ALL THRESHOLDS — current snapshot + per-threshold Δ over 24h / 7d / 30d (Phase 3).
          The Δ columns read the daily history series; a horizon with no matching day shows
          "—" (never a fabricated 0). They populate automatically as the cron accrues days. */}
      {Array.isArray(d.markets) && d.markets.length > 0 && (
        <section className="detail-section">
          <h2 className="detail-h2">All thresholds <span className="faint">· current snapshot + history Δ</span></h2>
          {/* Increment 6: settled zones (P≥95% / ≤5%) collapse behind per-side toggles; active rows
              + the at-the-money row stay visible. Tiny/near-settlement tables aren't collapsed. */}
          <LadderThresholdTable markets={d.markets} deltas={deltas} atmThreshold={atmThreshold} vol24ByThreshold={vol24ByThreshold} near={near} />
        </section>
      )}

      {/* METHODOLOGY disclosure */}
      <details className="detail-method">
        <summary>How these numbers are computed (methodology v{record.methodology_version ?? '—'})</summary>
        <ul>
          <li><b>Arbitrage adjustment</b>: each &ldquo;above $X&rdquo; book is separate, so raw midpoints can violate monotonicity. We apply volume-weighted isotonic regression (PAVA) to a non-increasing CDF; every metric uses the adjusted curve, raw_prob preserved (△ marks an adjusted row).</li>
          <li><b>Implied median</b> = adjusted CDF crosses 50%. <b>Bucket %</b> = P(&gt;this) − P(&gt;next); buckets ≥ 0 and sum to 100%.</li>
          <li><b>Confidence</b> = worst of {'{'}threshold count, monotonicity, spread, thin liquidity, anomalies{'}'}; reasons shown above.</li>
          <li><b>Provenance</b>: every snapshot stores raw inputs + a sha256 you can re-verify (button above).</li>
        </ul>
      </details>
    </article>
  );
}

/** Look up the Δ row for one threshold (exact match; null when the history has no series). */
function deltaFor(deltas: ThresholdDelta[], threshold: number): ThresholdDelta | undefined {
  return deltas?.find((x) => x.threshold === threshold);
}

/** The ladder rung whose P(>X) is nearest a target probability — e.g. the at-the-money rung
 *  (target 0.5) or the tail rung (target 0.1). Null on an empty ladder. (v1 ITEMS 5, 9.) */
function nearestThreshold(markets: LadderRow[] | undefined, target: number): LadderRow | null {
  if (!Array.isArray(markets) || markets.length === 0) return null;
  return markets.reduce((best, m) => (Math.abs(m.prob - target) < Math.abs(best.prob - target) ? m : best), markets[0]);
}

/** v1 ITEMS 5 + 6: the key-metrics cards — P(>at-the-money) + P(>tail) (current % + 30d change,
 *  green/red) + total volume. The at-the-money rung (P≈0.5) and the tail rung (P≈0.1) bracket the
 *  distribution; the change comes from the same 30d Δ the table uses. */
function KeyMetricsSection({ markets, totalVolume, deltas, unit, liquidity }:
  { markets: LadderRow[]; totalVolume: number | null | undefined; deltas: ThresholdDelta[]; unit: string; liquidity?: { volume_24hr?: number | null; volume_1wk?: number | null; volume_all?: number | null } | null }) {
  const atm = nearestThreshold(markets, 0.5);
  const tail = nearestThreshold(markets, 0.1);
  const uPfx = unit === '%' ? '' : '$'; // percentage-denominated buckets carry no '$' prefix
  const probCard = (m: LadderRow | null, tag: string) => {
    if (!m) return null;
    const d30 = deltaFor(deltas, m.threshold)?.d30 ?? null;
    return (
      <div className="acard" key={tag} data-field={`pcard-${tag}`}>
        <div className="label">P(&gt;{uPfx}{m.threshold}{unit}) <span className="faint">· {tag}</span></div>
        <div className="acard-v">{pct(m.prob)}</div>
        <div className={`acard-s ${deltaSign(d30)}`}>{d30 == null ? <span className="faint">no 30d history</span> : <>{fmtDeltaPp(d30)} pp · 30d</>}</div>
      </div>
    );
  };
  return (
    <section className="detail-section" data-field="key-metrics">
      <h2 className="detail-h2">Key metrics</h2>
      <div className="detail-analytics">
        {probCard(atm, 'at-the-money')}
        {probCard(tail, 'tail')}
        <VolumeCard liquidity={liquidity} allTimeVolume={totalVolume} />
      </div>
    </section>
  );
}

/** Bug C: a concise settled-range label for a RESOLVED ladder (the resolution card value).
 *  Mirrors resolvedBand but tighter — "Settled: $2.0–2.2T range" / "Settled above $X". */
function settledRangeLabel(outcome: ResolvedLeg[] | undefined, unit: string): string {
  if (!Array.isArray(outcome) || outcome.length === 0) return 'settled';
  const yes = outcome.filter((o) => o.outcome === 'Yes').map((o) => o.threshold);
  const no = outcome.filter((o) => o.outcome === 'No').map((o) => o.threshold);
  const lastYes = yes.length ? Math.max(...yes) : null;
  const firstNo = no.length ? Math.min(...no) : null;
  const p = unit === '%' ? '' : '$'; // percent buckets carry no '$' prefix
  if (lastYes != null && firstNo != null) return `Settled: ${p}${lastYes}–${firstNo}${unit} range`;
  if (lastYes != null) return `Settled above ${p}${lastYes}${unit}`;
  if (firstNo != null) return `Settled below ${p}${firstNo}${unit}`;
  return 'settled';
}

/** Bug C: RESOLUTION STATE cards for a RESOLVED ladder — outcome, final implied median, and the
 *  resolution date — replacing the at-the-money/tail P(>X) cards (which read 0%/100% with a
 *  meaningless "30d Δ" once a market has settled). */
function ResolvedMetricsSection({ outcome, medianLabel, resolvedAt, unit }:
  { outcome: ResolvedLeg[] | undefined; medianLabel: string; resolvedAt: string | null; unit: string }) {
  return (
    <section className="detail-section" data-field="resolved-metrics">
      <h2 className="detail-h2">Resolution</h2>
      <div className="detail-analytics">
        <div className="acard" data-field="rcard-outcome">
          <div className="label">Resolution outcome</div>
          <div className="acard-v">{settledRangeLabel(outcome, unit)}</div>
          <div className="acard-s faint">final settled range</div>
        </div>
        <div className="acard" data-field="rcard-median">
          <div className="label">Final median</div>
          <div className="acard-v">{medianLabel}</div>
          <div className="acard-s faint">last implied median before resolution</div>
        </div>
        <div className="acard" data-field="rcard-date">
          <div className="label">Resolution date</div>
          <div className="acard-v">{resolvedAt ? fmtEastern(resolvedAt) : '—'}</div>
          <div className="acard-s faint">captured at settlement</div>
        </div>
      </div>
    </section>
  );
}

/** Biggest movers (30d): top thresholds by |ΔP(>X)| from the daily series. Below 2 snapshots
 *  the movers list is empty → an explicit collecting state (never a blank section). */
function BiggestMoversSection({ movers, unit }: { movers: BiggestMoves; unit: string }) {
  const list: Mover[] = Array.isArray(movers?.movers) ? movers.movers : [];
  const uPfx = unit === '%' ? '' : '$'; // percentage-denominated buckets carry no '$' prefix
  return (
    <section className="detail-section" data-field="biggest-movers">
      <h2 className="detail-h2">Biggest movers <span className="faint">· {movers?.period ?? '30d'} · P(&gt;X)</span></h2>
      {list.length === 0 ? (
        <div className="empty" data-field="movers-collecting">Collecting — biggest movers populate once 2+ daily snapshots exist.</div>
      ) : (
        <div className="detail-analytics" data-field="movers">
          {list.map((mv, i) => {
            const cls = deltaSign(mv.change);
            const arrow = mv.direction === 'up' ? '▲' : mv.direction === 'down' ? '▼' : '◆';
            return (
              <div key={`${mv.threshold}-${i}`} className="acard mover-card">
                <div className="label">&gt;{uPfx}{mv.threshold}{unit}</div>
                {/* v1 ITEM 10: start → end → delta — where it was, where it is, how much it moved. */}
                <div className={`acard-v ${cls}`} data-field="mover-change">{arrow} {pct(mv.start)} → {pct(mv.end)}</div>
                <div className="acard-s faint">{fmtDeltaPp(mv.change)} pp · {movers?.period ?? '30d'}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AnalyticsCards({ analytics, unit }: { analytics: Analytics | null; unit: string }) {
  if (!analytics) {
    return (
      <section className="detail-section">
        <h2 className="detail-h2">Market analytics <span className="tier1-tag">Tier 1 · market-derived</span></h2>
        <div className="empty" data-field="analytics-insufficient">Requires history — collecting. These populate as daily snapshots accrue.</div>
      </section>
    );
  }
  const sh = analytics.shape ?? {};
  const di = analytics.dispersion ?? {};
  const ve = analytics.velocity ?? {};
  // v1 ITEM 8: each card carries a plain-English interpretation, and a synthesis line below ties
  // the four together. Words shared between cards + synthesis so they read as one read.
  const shapeWord = sh.skew_bowley == null ? null : sh.skew_bowley > 0.1 ? 'right-skewed' : sh.skew_bowley < -0.1 ? 'left-skewed' : '~symmetric';
  const skew = shapeWord == null ? '—' : `${shapeWord === 'right-skewed' ? 'right (upside)' : shapeWord === 'left-skewed' ? 'left (downside)' : '~symmetric'} (${sh.skew_bowley!.toFixed(2)})`;
  const consensusWord = sh.entropy == null ? null : sh.entropy < 0.5 ? 'tight consensus' : sh.entropy < 0.78 ? 'moderate consensus' : 'wide field';
  const consensus = consensusWord == null ? '—' : `${sh.entropy! < 0.5 ? 'tight' : sh.entropy! < 0.78 ? 'moderate' : 'wide'} (${sh.entropy!.toFixed(2)})`;
  const massLabel = sh.dominant_bucket?.label ?? null;
  const uPfx = unit === '%' ? '' : '$'; // percentage-denominated buckets carry no '$' prefix
  const disp = di.trend ? `${di.trend} · width ${di.iqr_width != null ? `${uPfx}${di.iqr_width.toFixed(2)}${unit}` : '—'}` : 'collecting';
  const bandWord = di.trend === 'converging' ? 'narrowing' : di.trend === 'diverging' ? 'widening' : di.trend ? 'steady' : null;
  const drift = ve.drift_30d_annualized != null ? `${ve.drift_30d_annualized > 0 ? '+' : ''}${ve.drift_30d_annualized.toFixed(2)} ${uPfx}${unit}/yr (30d)` : null;
  const cards = [
    { l: 'Distribution shape', v: skew, s: `Bowley skew → ${shapeWord ?? 'unknown'}${sh.fat_tail != null ? ` (${sh.fat_tail.toFixed(2)}×)` : ''}` },
    { l: 'Consensus (entropy)', v: consensus, s: `${sh.entropy != null && sh.entropy < 0.5 ? 'lo = market agrees' : 'hi = market uncertain'}${massLabel ? ` · mass ${massLabel}` : ''}` },
    { l: 'Dispersion (25–75 band)', v: disp, s: di.trend === 'converging' ? 'narrowing → growing certainty' : di.trend === 'diverging' ? 'widening → growing uncertainty' : 'requires ≥30 days' },
    { l: 'Velocity', v: ve.acceleration ?? 'collecting', s: drift ? `median drift ${drift}` : 'requires ≥7 days' },
  ];
  // synthesis (mirrors v1's summary line): "[consensus]; [shape]; mass centred on $A–$B; band […]."
  const synth = [consensusWord, shapeWord, massLabel ? `mass centred on ${massLabel}` : null, bandWord ? `band ${bandWord}` : null]
    .filter(Boolean).join('; ');
  return (
    <section className="detail-section">
      <h2 className="detail-h2">Market analytics <span className="tier1-tag">Tier 1 · market-derived</span></h2>
      <div className="detail-analytics" data-field="analytics">
        {cards.map((c) => (
          <div key={c.l} className="acard">
            <div className="label">{c.l}</div>
            <div className="acard-v">{c.v}</div>
            <div className="acard-s faint">{c.s}</div>
          </div>
        ))}
      </div>
      {synth && <p className="detail-analytics-desc faint" data-field="analytics-synthesis">{synth}.</p>}
    </section>
  );
}

/* ── states ── */
export function DetailEmpty() {
  return (
    <div className="empty" data-zone="detail-empty">
      Select a market from the watchlist,<br />or search to add one.
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="detail-view" data-zone="detail-skeleton" data-field="detail-loading">
      {/* Enh 7: name what's happening — a new market runs the full verified pipeline live,
          which takes a moment, so the wait reads as work, not a hang. */}
      <div className="detail-loading-msg" role="status" aria-live="polite">
        <span className="detail-loading-title">Computing market data…</span>
        <span className="detail-loading-sub faint">Fetching live Polymarket prices and running the verified pipeline — this takes a moment for a new market.</span>
        <div className="detail-loading-bar" aria-hidden="true"><div className="detail-loading-bar-fill" /></div>
      </div>
      <div className="wl-skel-bar" style={{ width: '70%', height: 40, marginBottom: 12 }} aria-hidden="true" />
      <div className="wl-skel-bar" style={{ width: '90%', height: 12, marginBottom: 24 }} aria-hidden="true" />
      <div className="wl-skel-bar" style={{ width: '100%', height: 160 }} aria-hidden="true" />
    </div>
  );
}

function DetailError({ id, status, message }: { id: string; status: number; message?: string }) {
  return (
    <div className="empty wl-error" data-zone="detail-error" data-status={status}>
      Couldn’t load <code>{id}</code> (status {status}).<br />
      <span className="faint">{message ?? 'Try another market, or retry shortly.'}</span>
    </div>
  );
}
