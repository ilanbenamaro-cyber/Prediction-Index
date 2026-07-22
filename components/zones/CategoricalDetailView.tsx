// components/zones/CategoricalDetailView.tsx — Zone 2 detail for a CATEGORICAL market.
//
// Rendered by MarketDetailView when derived.kind === 'categorical' (e.g. "How many Fed rate
// cuts in 2026?"). A categorical market is a probability distribution over NAMED outcomes —
// no median/CDF/ladder. So this view shows what the data is: the dominant outcome (headline),
// a horizontal outcome-bar chart (de-vigged probabilities, sorted desc, dominant in amber), a
// consensus meter (Shannon entropy), and a volume table. The TRUST layer (confidence,
// freshness, provenance + hash-verify) is identical to every other detail. Server component;
// canonicalizes raw_inputs server-side for the in-browser verify.
import { canonicalizeRawInputs } from '@/core/fetch.js';
import { isPlaceholderLeg } from '@/core/categorical.js';
import { fmtEastern, displayTitle, pointChange, categoricalNarrative, fmtDeltaPp, deltaSign, daysToExpiryLabel, platformLabel } from '@/lib/format-detail.mjs';
import { ConfidenceBadges, ConfidenceBasisGroup, signalBarStyle } from './ConfidenceBasis';
import { VolumeCard } from './VolumeCard';
import { CategoricalOutcomeBars } from './CategoricalOutcomeBars';
import { ShapeNotice } from './ShapeNotice';
import { HashVerify } from './HashVerify';
import { DetailFreshness } from './DetailFreshness';
import { RefreshButton } from './RefreshButton';
import { TrendHistorySection, type HistoryUI } from './TrendHistory';
import type { MarketRecord, ServeBody, ResolvedLeg, CategoricalOutcome } from './market-record';

const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };
const LIFECYCLE_LABEL: Record<string, string> = { OPEN: 'OPEN', CLOSED_PENDING: 'CLOSED · PENDING', RESOLVED: 'RESOLVED' };

const pctStr = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const pct1 = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);
const NO_CONSENSUS_FLOOR = 0.10; // Bug A item 4: below this the leader is too weak to name

/** Consensus descriptor from normalized Shannon entropy (0 = certain, 1 = wide open). */
function consensusLabel(entropy: number | undefined): { label: string; cls: string } {
  if (entropy == null) return { label: '—', cls: '' };
  if (entropy < 0.5) return { label: 'HIGH CONSENSUS', cls: 'conf-high' };
  if (entropy < 0.78) return { label: 'CONTESTED', cls: 'conf-med' };
  return { label: 'WIDE OPEN', cls: 'conf-low' };
}

/** The settled outcome from a RESOLVED categorical event: the leg whose price went to 1. */
function resolvedWinner(outcome: ResolvedLeg[] | undefined): string | null {
  if (!Array.isArray(outcome) || outcome.length === 0) return null;
  const won = outcome.find((o) => o.outcome && o.outcome !== 'No');
  return won ? `resolved: ${won.outcome}` : null;
}

export function CategoricalDetailView({ record, envelope, hist, addControl }: { record: MarketRecord; envelope: ServeBody; hist?: HistoryUI; addControl?: React.ReactNode }) {
  const s = record?.snapshot ?? {};
  const d = s?.derived ?? {};
  const asset = record?.asset ?? {};
  const lifecycleState: string = s?.lifecycle?.state ?? envelope?.lifecycle_state ?? 'OPEN';
  const isFinal = lifecycleState === 'RESOLVED';
  const conf = d.confidence ?? {};
  const fresh = d.freshness ?? {};
  // 5.6 EXCLUSIVITY GUARD: a guarded record carries RAW probabilities only — every PMF
  // derivation (dominant, entropy, consensus, de-vig) is suppressed at the core, and this
  // view must not resurrect any of them. `guarded` switches the headline, metrics, bars,
  // table, narrative, and methodology copy to the raw/honest variants.
  const excl = d.exclusivity as { verdict: string; basis?: { filtered_sum?: number }; headline?: { label: string; raw_probability: number | null } } | undefined;
  const guarded = excl != null;
  const nested = excl?.verdict === 'nested_deadline';
  const allOutcomes = (d.outcomes ?? []) as CategoricalOutcome[];
  // Bug A: defensively drop placeholder/untraded legs in the display too (belt-and-suspenders for a
  // record cached BEFORE the core de-vig fix). For a freshly computed record this is a no-op — the
  // SAME isPlaceholderLeg predicate already filtered them before normalization in core/categorical.
  const outcomes = allOutcomes.filter((o) => !isPlaceholderLeg({ label: o.label, prob: (o.raw_probability ?? o.probability) ?? undefined, volume: o.volume }));
  const dominant = outcomes[0] ?? null;
  const dominantProb = dominant?.probability ?? d.dominant_prob ?? 0;
  // Bug A item 4: with no leader above the consensus floor (10%) the field is genuinely wide open —
  // don't crown a 7% "leader". Name the leader in the headline only when it clears the floor.
  const wideOpen = dominantProb < NO_CONSENSUS_FLOOR;
  const consensus = consensusLabel(d.entropy);
  const rawSha: string = s?.source?.raw_sha256 ?? '';
  const canonical = Array.isArray(s?.raw_inputs) ? canonicalizeRawInputs(s.raw_inputs) : '';
  const winner = resolvedWinner(s?.lifecycle?.resolved_outcome);

  // v1 ITEM 1/5: the dominant-outcome probability + its move over 30d/7d (from the lean history
  // series the view holds). Gated by days_have so a short window isn't mislabelled "past month".
  const pts = hist?.points ?? [];
  const daysHave = hist?.velocity?.days_have ?? 0;
  const change30 = daysHave >= 28 ? pointChange(pts, 30) : null;
  const change7 = daysHave >= 7 ? pointChange(pts, 7) : null;
  const noConsensus = wideOpen || d.implied_winner === 'no consensus';
  const totalVolume = d.total_volume ?? outcomes.reduce((sum, o) => sum + (o.volume ?? 0), 0);

  return (
    <article className="detail-view" data-zone="detail-view" data-kind="categorical" data-market-id={envelope?.market_id} data-lifecycle={lifecycleState}>
      <header className="detail-head">
        <div>
          <h1 className="detail-title" data-field="title">{displayTitle(asset.name, envelope?.market_id)}</h1>
          <div className="detail-sub muted">
            {platformLabel(asset.platform)}{asset.resolves ? ` · resolves ${asset.resolves}` : ''}
            {/* FIX 1: a RESOLVED market omits the days-to-expiry segment — it no longer applies. */}
            {!isFinal && daysToExpiryLabel(asset.resolves) && <span data-field="days-to-expiry"> · {daysToExpiryLabel(asset.resolves)}</span>}
            {asset.market_url && <> · <a href={asset.market_url} target="_blank" rel="noopener">view market ↗</a></>}
            <> · <span className="cat-tag">CATEGORICAL</span></>
          </div>
        </div>
        <div className="detail-head-actions">
          {addControl}
          {envelope?.market_id && lifecycleState !== 'RESOLVED' && <RefreshButton slug={envelope.market_id} />}
          <span className={`detail-lifecycle ${LIFECYCLE_CLASS[lifecycleState] ?? ''}`} data-field="lifecycle">
            ● {LIFECYCLE_LABEL[lifecycleState] ?? lifecycleState}
          </span>
        </div>
      </header>

      {isFinal && (
        <div className="detail-resolved" data-field="resolved-banner">
          <span className="detail-resolved-tag">RESOLVED</span>
          <span className="detail-resolved-band">{winner ?? 'settled'}</span>
          <span className="detail-resolved-note faint">final record · served from cache, not re-pulled live</span>
        </div>
      )}

      {/* HEADLINE — the dominant outcome (exclusive) or the honest raw headline (guarded) */}
      <div className="detail-headline" style={signalBarStyle(conf, isFinal)} data-exclusivity={excl?.verdict ?? 'exclusive'}>
        <div className="detail-metric detail-metric-wide">
          {guarded ? (
            <>
              <span className="label">{nested ? 'Longest-horizon probability' : 'Outcomes'}</span>
              <span className="detail-hero num" data-field="dominant">
                {nested && excl?.headline
                  ? <>{excl.headline.label} <span className="faint">{pctStr(excl.headline.raw_probability)} raw</span></>
                  : 'No single-winner distribution'}
              </span>
              <span className="detail-band faint">{nested ? 'cumulative deadline board — each row is P(by that date)' : 'independent outcomes at raw market prices'}</span>
            </>
          ) : (
            <>
              <span className="label">Most likely outcome</span>
              <span className="detail-hero num" data-field="dominant">
                {wideOpen
                  ? 'No consensus — field is wide open'
                  : <>{dominant?.label ?? '—'} <span className="faint">{pctStr(dominantProb)}</span></>}
              </span>
              <span className="detail-band faint">{wideOpen ? 'no outcome above 10% — wide-open field' : (d.implied_winner === 'no consensus' ? 'no single outcome above 50% — no consensus' : 'market consensus leader')}</span>
            </>
          )}
        </div>
        <div className="detail-metric">
          <span className="label">Consensus</span>
          {guarded ? (
            <>
              <span className="detail-conf" data-field="consensus">N/A</span>
              <span className="detail-band faint">not mutually exclusive</span>
            </>
          ) : (
            <>
              <span className={`detail-conf ${consensus.cls}`} data-field="consensus">{consensus.label}</span>
              <span className="detail-band faint">{d.entropy != null ? `entropy ${d.entropy.toFixed(2)}` : ''}</span>
            </>
          )}
        </div>
        <div className="detail-metric">
          <span className="label">Confidence</span>
          <ConfidenceBadges confidence={conf} />
        </div>
      </div>

      {/* TRUST BAND — identical to every other detail (v1 ITEM 11 confidence checklist) */}
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

      {/* SHAPE NOTICE (5.6 guard) — right below trust: the structural honesty statement */}
      {guarded && (
        <ShapeNotice label={nested ? 'CUMULATIVE DEADLINES' : excl?.verdict === 'ambiguous' ? 'STRUCTURE AMBIGUOUS' : 'INDEPENDENT OUTCOMES'} field="exclusivity-notice">
          {nested
            ? 'These outcomes are nested deadlines (each implies every later one). Probabilities are shown RAW, do not sum to 100%, and no single-winner distribution exists — normalizing them would fabricate numbers.'
            : `These outcomes are not mutually exclusive (raw sum ≈ ${(excl?.basis?.filtered_sum ?? 0).toFixed(2)}, not 1). Probabilities are shown RAW; consensus, entropy, and single-winner readings do not apply.`}
        </ShapeNotice>
      )}

      {/* KEY METRICS (v1 ITEMS 5 + 8) — the leading-outcome probability with its 30d move +
          consensus (entropy) + volume, each with a plain-English sub-label. */}
      <section className="detail-section" data-field="key-metrics">
        <h2 className="detail-h2">Key metrics</h2>
        <div className="detail-analytics">
          {guarded ? (
            <div className="acard" data-field="pcard-leader">
              <div className="label">{nested ? 'Longest-horizon (raw)' : 'Highest raw price'}</div>
              <div className="acard-v">{pctStr(nested ? excl?.headline?.raw_probability : (outcomes[0]?.raw_probability ?? null))}</div>
              <div className={`acard-s ${deltaSign(change30)}`}>{change30 == null ? <span className="faint">no 30d history</span> : <>{fmtDeltaPp(change30)} pp · 30d</>}</div>
            </div>
          ) : (
            <>
              <div className="acard" data-field="pcard-leader">
                <div className="label">Leading outcome</div>
                <div className="acard-v">{pctStr(dominantProb)}</div>
                <div className={`acard-s ${deltaSign(change30)}`}>{change30 == null ? <span className="faint">no 30d history</span> : <>{fmtDeltaPp(change30)} pp · 30d</>}</div>
              </div>
              <div className="acard" data-field="pcard-consensus">
                <div className="label">Consensus (entropy)</div>
                <div className={`acard-v ${consensus.cls}`}>{consensus.label}</div>
                <div className="acard-s faint">{d.entropy != null ? `entropy ${d.entropy.toFixed(2)} · ${d.entropy < 0.5 ? 'lo = agrees' : 'hi = uncertain'}` : '—'}</div>
              </div>
            </>
          )}
          <VolumeCard liquidity={d.liquidity} allTimeVolume={totalVolume} />
        </div>
      </section>

      {/* NARRATIVE (v1 ITEM 1) — display-side for exclusive boards; a GUARDED board uses the
          core's honest narrative verbatim (the display builder speaks PMF language). */}
      <p className="detail-narrative" data-field="narrative">{guarded
        ? `${d.narrative ?? ''}${hist?.synthesis ? ` ${hist.synthesis}` : ''}`
        : `${categoricalNarrative({ dominantOutcome: dominant?.label ?? null, dominantProb, change30, change7, entropy: d.entropy ?? null, reliabilityTier: conf.reliability?.tier ?? null, liquidityTier: conf.liquidity?.tier ?? null, noConsensus, resolvedLabel: isFinal ? (winner ?? `resolved ${dominant?.label ?? 'settled'}`) : null }) || d.narrative || ''}${hist?.synthesis ? ` ${hist.synthesis}` : ''}`}</p>

      {/* OUTCOME DISTRIBUTION — the analytical centerpiece (top 10, "N more" expands) */}
      <section className="detail-section">
        <h2 className="detail-h2">{guarded
          ? <>Outcomes <span className="faint">· raw market prices — not mutually exclusive, do not sum to 100%</span></>
          : <>Outcome distribution <span className="faint">· de-vigged, sums to 100%</span></>}</h2>
        <CategoricalOutcomeBars outcomes={guarded ? outcomes.map((o) => ({ ...o, probability: o.raw_probability ?? 0 })) : outcomes} />
      </section>

      {/* VOLUME TABLE — where the conviction sits */}
      {outcomes.length > 0 && (
        <section className="detail-section">
          <h2 className="detail-h2">Outcomes <span className="faint">· current snapshot</span></h2>
          <div className="detail-table-wrap">
            <table className="detail-table num" data-field="categorical-table">
              {guarded ? (
                <>
                  <thead><tr><th className="tl">Outcome</th><th>Raw price</th><th>All-time volume</th></tr></thead>
                  <tbody>
                    {outcomes.map((o, i) => (
                      <tr key={i}>
                        <td className="tl">{o.label}</td>
                        <td>{pct1(o.raw_probability)}</td>
                        <td>{fmtVol(o.volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead><tr><th className="tl">Outcome</th><th>Probability</th><th>Raw (pre-devig)</th><th>All-time volume</th></tr></thead>
                  <tbody>
                    {outcomes.map((o, i) => (
                      <tr key={i} className={i === 0 ? 'cat-row-top' : ''}>
                        <td className="tl">{o.label}</td>
                        <td>{pct1(o.probability)}</td>
                        <td className="faint">{pct1(o.raw_probability)}</td>
                        <td>{fmtVol(o.volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </div>
        </section>
      )}

      {/* TREND & HISTORY — top-4 outcome probability lines when the series is available (multi-
          series pass); falls back to the dominant-outcome single line otherwise. */}
      {hist && <TrendHistorySection hist={hist} unit="" label={hist.series ? 'Outcome probabilities' : 'Dominant-outcome probability'} />}

      <details className="detail-method">
        <summary>How these numbers are computed (methodology v{record.methodology_version ?? '—'})</summary>
        {guarded ? (
          <ul>
            <li><b>Exclusivity guard</b>: this board&apos;s outcomes are {nested ? 'nested deadlines (each implies every later one — a cumulative curve in time)' : 'not mutually exclusive'}, so the standard de-vig (which presumes exactly one winner) would fabricate probabilities. Every number shown is the <b>raw</b> observed market price.</li>
            <li><b>Suppressed</b>: consensus/entropy, dominant-outcome, and single-winner readings do not exist for this structure and are deliberately not computed.</li>
            <li><b>Confidence</b> = worst of {'{'}spread, volume, last-trade fallback{'}'} — unchanged. <b>Provenance</b>: re-verifiable sha256 (button above) — the hash is over the raw observations, exactly as shown.</li>
          </ul>
        ) : (
          <ul>
            <li><b>Categorical market</b>: each named outcome is a Yes/No leg; its YES midpoint is P(outcome). The legs are mutually exclusive, so the midpoints form a PMF.</li>
            <li><b>De-vig</b>: leg midpoints carry the market-maker overround, so we normalize them to sum to 100% for display. The <b>raw</b> observed midpoints (shown in the table) are what enter raw_inputs + the hash — the hash is over truth, not the normalized presentation.</li>
            <li><b>Consensus</b> = normalized Shannon entropy (0 = one outcome certain, 1 = all outcomes equal). <b>Confidence</b> = worst of {'{'}spread, volume, last-trade fallback{'}'}. <b>Provenance</b>: re-verifiable sha256 (button above).</li>
          </ul>
        )}
      </details>
    </article>
  );
}
