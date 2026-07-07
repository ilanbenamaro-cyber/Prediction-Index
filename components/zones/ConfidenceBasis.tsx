// components/zones/ConfidenceBasis.tsx — the confidence basis as a tier-marked CHECKLIST of
// conditions, not a failure log. For HIGH the stored reasons ARE the passing conditions (✓); MEDIUM
// marks caveats (·); LOW marks the conditions that failed (✗). The reason TEXT stays pipeline-
// generated — the display only reframes presentation by tier. Renders nothing when there are no
// reasons.
//
// Confidence is now TWO independent dimensions — RELIABILITY (is the number trustworthy) and
// LIQUIDITY (can you transact). ConfidenceBasisGroup renders one labelled basis row per dimension;
// ConfidenceBadges renders the headline two-badge cell. A missing dimension (legacy pre-0010 data)
// renders "—", never a fabricated tier.
//
// FIX 3: the mark is now PER-CHIP, not per-dimension. The pipeline's reason vocabulary uses
// "moderate …" as its MEDIUM wording and "market resolved — …" as purely informational — under a
// worst-of LOW dimension those specific reasons are NOT failures, so marking them ✗ alongside a
// real failing reason (e.g. "✗ moderate order book ($29,662 depth)") reads as a false failure. A
// reason matching /^(moderate |market resolved)/ always gets the caveat mark '·', regardless of the
// dimension's tier; every other reason keeps the dimension mark. The chip COLOUR class stays tied
// to the dimension tier as before — only the leading mark glyph changes per-chip.

import type { Confidence, ConfidenceDimension, Tier } from './market-record';

const CONF_CLASS: Record<string, string> = { high: 'conf-high', medium: 'conf-med', low: 'conf-low' };

// Reasons that are caveats/informational, never a "failure", no matter which tier's chip they
// render under — a worst-of LOW dimension must not paint these ✗.
const CAVEAT_REASON = /^(moderate |market resolved)/;

export function ConfidenceBasis({ reasons, tier, label = 'Confidence basis', field }:
  { reasons?: string[] | null; tier?: string | null; label?: string; field?: string }) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const dimMark = tier === 'high' ? '✓' : tier === 'low' ? '✗' : '·';
  return (
    <div className="trust-reasons" data-field={field ?? 'confidence-basis'}>
      <span className="label">{label}</span>
      {reasons.map((r, i) => {
        const mark = CAVEAT_REASON.test(r) ? '·' : dimMark;
        return (
          <span key={i} className={`trust-chip conf-chip-${tier ?? 'medium'}`}>{mark} {r}</span>
        );
      })}
    </div>
  );
}

/** Both basis rows (reliability + liquidity), each labelled with its own tier marks. Renders nothing
 *  when neither dimension carries reasons. */
export function ConfidenceBasisGroup({ confidence }: { confidence?: Confidence | null }) {
  const rel = confidence?.reliability, liq = confidence?.liquidity;
  if (!rel?.reasons?.length && !liq?.reasons?.length) return null;
  return (
    <>
      <ConfidenceBasis reasons={rel?.reasons} tier={rel?.tier} label="Reliability basis" field="reliability-basis" />
      <ConfidenceBasis reasons={liq?.reasons} tier={liq?.tier} label="Liquidity basis" field="liquidity-basis" />
    </>
  );
}

function Badge({ dim, label, field }: { dim?: ConfidenceDimension | null; label: string; field: string }) {
  const tier = dim?.tier as Tier | undefined;
  return (
    <span className="detail-conf-badge" data-field={field}>
      <span className="detail-conf-badge-label">{label}</span>
      <span className={`detail-conf ${tier ? CONF_CLASS[tier] : ''}`} data-field={`${field}-tier`}
        title={dim?.score != null ? `score ${dim.score}` : ''}>
        {tier ? tier.toUpperCase() : '—'}
      </span>
    </span>
  );
}

/** The headline confidence cell: two stacked badges, RELIABILITY + LIQUIDITY. */
export function ConfidenceBadges({ confidence }: { confidence?: Confidence | null }) {
  return (
    <span className="detail-conf-split" data-field="confidence">
      <Badge dim={confidence?.reliability} label="Reliability" field="reliability" />
      <Badge dim={confidence?.liquidity} label="Liquidity" field="liquidity" />
    </span>
  );
}
