// components/zones/BinaryDetailView.tsx — Zone 2 detail for a BINARY (Yes/No) market.
//
// Rendered by MarketDetailView when derived.kind === 'binary'. A binary market has ONE
// number — the YES probability — so there's no distribution SVG, no ladder, no analytics.
// The TRUST layer (confidence, freshness, provenance + hash-verify) is identical to the
// ladder detail (reusing HashVerify + DetailFreshness), and the RESOLVED banner shows the
// settled Yes/No outcome. Server component; canonicalizes raw_inputs server-side for verify.
import { canonicalizeRawInputs } from '@/core/fetch.js';
import { fmtEastern, displayTitle, pointChange, binaryNarrative, fmtDeltaPp, deltaSign, daysToExpiryLabel, noProbLabel, platformLabel } from '@/lib/format-detail.mjs';
import { ConfidenceBadges, ConfidenceBasisGroup } from './ConfidenceBasis';
import { VolumeCard } from './VolumeCard';
import { HashVerify } from './HashVerify';
import { DetailFreshness } from './DetailFreshness';
import { RefreshButton } from './RefreshButton';
import { TrendHistorySection, type HistoryUI } from './TrendHistory';
import type { MarketRecord, ServeBody, ResolvedLeg } from './market-record';

const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };
const LIFECYCLE_LABEL: Record<string, string> = { OPEN: 'OPEN', CLOSED_PENDING: 'CLOSED · PENDING', RESOLVED: 'RESOLVED' };

const pctStr = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

/** Settled Yes/No from the single resolved leg (threshold 1 = YES). */
function binaryOutcome(outcome: ResolvedLeg[] | undefined): string | null {
  if (!Array.isArray(outcome) || outcome.length === 0) return null;
  const yes = outcome.find((o) => o.threshold === 1) ?? outcome[0];
  return yes ? `resolved ${yes.outcome.toUpperCase()}` : null;
}

export function BinaryDetailView({ record, envelope, hist, addControl }: { record: MarketRecord; envelope: ServeBody; hist?: HistoryUI; addControl?: React.ReactNode }) {
  const s = record?.snapshot ?? {};
  const d = s?.derived ?? {};
  const asset = record?.asset ?? {};
  const lifecycleState: string = s?.lifecycle?.state ?? envelope?.lifecycle_state ?? 'OPEN';
  const isFinal = lifecycleState === 'RESOLVED';
  const conf = d.confidence ?? {};
  const fresh = d.freshness ?? {};
  const rawSha: string = s?.source?.raw_sha256 ?? '';
  const canonical = Array.isArray(s?.raw_inputs) ? canonicalizeRawInputs(s.raw_inputs) : '';
  const outcome = binaryOutcome(s?.lifecycle?.resolved_outcome);

  // Enh 4: YES bid-ask spread from the stored raw inputs (threshold 1 = YES), and a
  // strong-consensus read off the probability — both presentation-only (no recompute).
  const yesRaw = (Array.isArray(s?.raw_inputs) ? s.raw_inputs : [])
    .find((r): r is { threshold: number; best_bid?: string | null; best_ask?: string | null } =>
      typeof r === 'object' && r != null && (r as { threshold?: number }).threshold === 1);
  const spread = yesRaw?.best_bid != null && yesRaw?.best_ask != null
    ? Number(yesRaw.best_ask) - Number(yesRaw.best_bid) : null;
  const p = d.probability ?? null;
  // FIX 2: independent rounding of YES/NO can fabricate a false 101%/99% sum on quotes that were
  // actually consistent — complement off the rounded YES when the two agree; show the true
  // rounded NO (a genuine overround) when they don't. Falls back to pctStr's own dash on absence.
  const noLabel = noProbLabel(d.probability ?? null, d.probability_no ?? null) ?? pctStr(d.probability_no);
  const consensus = p == null ? null
    : p >= 0.8 ? { label: 'STRONG · YES', cls: 'conf-high' }
    : p <= 0.2 ? { label: 'STRONG · NO', cls: 'conf-high' }
    : p >= 0.6 || p <= 0.4 ? { label: 'LEANING', cls: 'conf-med' }
    : { label: 'CONTESTED', cls: 'conf-low' };

  // v1 ITEM 1/5: the YES-probability move over the last 30d/7d (from the lean history series the
  // view already holds). Gated by days_have so a short window isn't mislabelled "past month".
  const pts = hist?.points ?? [];
  const daysHave = hist?.velocity?.days_have ?? 0;
  const change30 = daysHave >= 28 ? pointChange(pts, 30) : null;
  const change7 = daysHave >= 7 ? pointChange(pts, 7) : null;

  return (
    <article className="detail-view" data-zone="detail-view" data-kind="binary" data-market-id={envelope?.market_id} data-lifecycle={lifecycleState}>
      <header className="detail-head">
        <div>
          <h1 className="detail-title" data-field="title">{displayTitle(asset.name, envelope?.market_id)}</h1>
          <div className="detail-sub muted">
            {platformLabel(asset.platform)}{asset.resolves ? ` · resolves ${asset.resolves}` : ''}
            {/* FIX 1: a RESOLVED market omits the days-to-expiry segment — "days to expiry" reads
                as live-market present tense on a market that has already settled. */}
            {!isFinal && daysToExpiryLabel(asset.resolves) && <span data-field="days-to-expiry"> · {daysToExpiryLabel(asset.resolves)}</span>}
            {asset.market_url && <> · <a href={asset.market_url} target="_blank" rel="noopener">view market ↗</a></>}
            <> · binary (Yes/No)</>
          </div>
        </div>
        <div className="detail-head-actions">
          {addControl}
          {envelope?.market_id && <RefreshButton slug={envelope.market_id} />}
          <span className={`detail-lifecycle ${LIFECYCLE_CLASS[lifecycleState] ?? ''}`} data-field="lifecycle">
            ● {LIFECYCLE_LABEL[lifecycleState] ?? lifecycleState}
          </span>
        </div>
      </header>

      {isFinal && (
        <div className="detail-resolved" data-field="resolved-banner">
          <span className="detail-resolved-tag">RESOLVED</span>
          <span className="detail-resolved-band">{outcome ?? 'settled'}</span>
          <span className="detail-resolved-note faint">final record · served from cache, not re-pulled live</span>
        </div>
      )}

      {/* HEADLINE — the single probability, large */}
      <div className="detail-headline">
        <div className="detail-metric">
          <span className="label">Implied probability · YES</span>
          <span className="detail-hero num" data-field="probability">{pctStr(d.probability)}</span>
          <span className="detail-band faint">NO {noLabel}</span>
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
        <div className="detail-metric">
          <span className="label">Spread</span>
          <span className="detail-sec num" data-field="spread">{spread != null ? `${(spread * 100).toFixed(1)}pp` : '—'}</span>
          <span className="detail-band faint">{spread == null ? 'no live book' : spread < 0.04 ? 'tight' : spread <= 0.08 ? 'moderate' : 'wide'}</span>
        </div>
        <div className="detail-metric">
          <span className="label">Resolves</span>
          <span className="detail-sec num" data-field="resolves">{asset.resolves ?? '—'}</span>
          <span className="detail-band faint">settlement date</span>
        </div>
      </div>

      {/* Enh 4: probability meter — the YES/NO split at a glance + a consensus read */}
      <div className="bin-meter" data-field="prob-meter">
        <div className="bin-meter-track" role="img" aria-label={`YES ${pctStr(d.probability)}`}>
          <div className="bin-meter-fill" style={{ width: `${Math.round((d.probability ?? 0) * 100)}%` }} />
        </div>
        <div className="bin-meter-legend">
          <span className="faint">YES {pctStr(d.probability)}</span>
          {consensus && <span className={`bin-consensus ${consensus.cls}`} data-field="consensus">{consensus.label}</span>}
          <span className="faint">NO {noLabel}</span>
        </div>
      </div>

      {/* TRUST BAND — identical to the ladder detail (v1 ITEM 11 confidence checklist) */}
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
          {rawSha && canonical
            ? <HashVerify canonical={canonical} publishedHash={rawSha} />
            : <span className="faint">unavailable</span>}
        </div>
      </div>

      {/* KEY METRICS (v1 ITEMS 5 + 8) — the YES probability with its 30d move + 7d momentum +
          volume, each with a plain-English sub-label, and a synthesis line tying them together. */}
      <section className="detail-section" data-field="key-metrics">
        <h2 className="detail-h2">Key metrics</h2>
        <div className="detail-analytics">
          <div className="acard" data-field="pcard-yes">
            <div className="label">P(YES)</div>
            <div className="acard-v">{pctStr(p)}</div>
            <div className={`acard-s ${deltaSign(change30)}`}>{change30 == null ? <span className="faint">no 30d history</span> : <>{fmtDeltaPp(change30)} pp · 30d</>}</div>
          </div>
          <div className="acard" data-field="pcard-momentum">
            <div className="label">Momentum (7d)</div>
            <div className="acard-v">{change7 == null ? 'collecting' : change7 > 0.01 ? 'rising' : change7 < -0.01 ? 'falling' : 'steady'}</div>
            <div className={`acard-s ${deltaSign(change7)}`}>{change7 == null ? <span className="faint">requires ≥7 days</span> : <>{fmtDeltaPp(change7)} pp · 7d</>}</div>
          </div>
          <VolumeCard liquidity={d.liquidity} allTimeVolume={d.total_volume} />
        </div>
      </section>

      {/* NARRATIVE (v1 ITEM 1) — probability + 30d/7d move + consensus + confidence, built
          display-side; Δ sentences omit gracefully when history is absent (never a dash). FIX 1:
          a RESOLVED market gets the resolved-aware variant (reuses the banner's outcome string)
          instead of live-market present-tense prose. */}
      <p className="detail-narrative" data-field="narrative">{`${binaryNarrative({ prob: p ?? undefined, change30, change7, reliabilityTier: conf.reliability?.tier ?? null, liquidityTier: conf.liquidity?.tier ?? null, resolvedLabel: isFinal ? (outcome ?? 'settled') : null }) || d.narrative || ''}${hist?.synthesis ? ` ${hist.synthesis}` : ''}`}</p>

      {/* TREND & HISTORY — YES-probability series (Phase 1); collecting until 7 days accrue */}
      {hist && <TrendHistorySection hist={hist} unit="" label="YES probability" />}
    </article>
  );
}
