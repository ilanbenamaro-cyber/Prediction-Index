# Methodology

**Version 1.9.0** (see `core/methodology.json` — the version of record, with full changelog) · source: Polymarket (public market data only)

## Two tiers (the firewall)
- **Tier 1 — market signal** (`derived` + `derived.market.analytics`): pure transforms of observed
  Polymarket prices. No assumptions.
- **Tier 2 — scenario analysis** (`derived.scenarios`): anything needing an input the market did not
  provide (shares outstanding, a prior valuation). Every Tier-2 number carries a sourced, dated,
  ranged, low-confidence assumption from `core/assumptions.json`; with no usable input it renders
  `status:"input_required"` — never a fabricated number. The build **fails** if a scenario number
  lacks a sourced+dated assumption, or if an `assumptions` key appears outside `derived.scenarios`.

## Tier-1 analytics (added 1.2.0; quantile/probability-only — zero assumptions)
- **Shape** — Bowley quartile skewness `((p75-med)-(med-p25))/(p75-p25)`; a robust fat-tail ratio
  (10th–90th percentile valuation spread / IQR vs a normal's 1.90); normalized Shannon entropy + Gini
  over the density buckets (consensus vs dispersion); dominant bucket.
- **Dispersion over time** — the 25–75% band width tracked vs 7d/30d ago; `trend` = converging
  (narrowing → growing certainty) / diverging / stable.
- **Velocity** — 24h/7d/30d median change (the single source for every displayed median delta),
  annualized drift, and acceleration (sign of the second difference).
- **Calibration** — structural only: `status:"pending_resolution"`. The market resolves once (2027),
  so a Brier score is impossible now and is **not faked**; the standing forecast is recorded for later.

## Tier-2 scenarios (assumption-based)
- **Implied share price** = market cap / shares outstanding, as `{central, low, high}` from the shares
  range. **Round-over-round** = implied IPO-close median vs the last reported valuation. Inputs are
  press-estimated (SpaceX is private), low-confidence, wide-range, cited and dated in `assumptions.json`
  (v1.0.0). The dashboard lets a user explore their own input client-side without mutating the feed.



Human-readable companion to [`core/methodology.json`](core/methodology.json) (served at
[`/api/v1/methodology.json`](docs/api/v1/methodology.json)). Every snapshot embeds the
`methodology_version` it was computed under. **A formula change is a breaking change**: bump the
version and add a changelog entry.

Each "closing market cap above $X?" market is a **separate order book**, so raw YES midpoints are
*not* jointly arbitrage-constrained — `P(>1.2T)` can exceed `P(>1.4T)`, which would put **negative
mass** in a bucket. Every metric is therefore computed from an **arbitrage-adjusted** curve; raw is
preserved alongside.

## Arbitrage adjustment (isotonic regression) — *robust*
Volume-weighted **Pool Adjacent Violators (PAVA)** projects the raw midpoints onto a non-increasing
CDF. On a violation, adjacent markets pool to their **volume-weighted mean**, pulling the estimate
toward the more liquid (more trustworthy) quote. Each market stores `raw_prob` and `adjusted_prob`;
all metrics use `adjusted_prob`. Per snapshot we publish `adjustment.monotonicity_violations` and
`adjustment.max_adjustment`. Weight = volume (fallback 1 when volume is unknown, e.g. price-only
history). Guarantees: every `bucket_prob ≥ 0` and the full distribution sums to 1.0 (asserted at build).

## Implied median — *robust* (+ uncertainty band, live only)
Valuation where the adjusted CDF crosses **0.50** (interpolation). The **band** `{low, high}` is
spread-implied: the `best_bid` and `best_ask` curves are each isotonic-adjusted, each one's 0.50
crossing is taken, and the median is bounded by them. `null` when there is no two-sided book
(price-only history). Missing quotes are excluded, **never synthesized**.

## Implied mean (approx) — *assumption-sensitive* (+ sensitivity range)
Bucket-weighted EV over the adjusted distribution; tails use midpoint offsets (base case
`lowest − $0.15T`, `highest + $0.40T`). The **range** `{low, high}` spans a 3×3 grid
(below ∈ {0.10, 0.15, 0.20}, above ∈ {0.30, 0.40, 0.60}). A tight range proves robustness; a wide
range discloses fragility. The median is the more reliable central estimate.

## 50% confidence band (IQR) — *robust*
`p25`/`p75` valuations = adjusted CDF crossings at **0.75** and **0.25**.

## Bucket probability
`adjusted P(> this) − adjusted P(> next)`; top = `adjusted P(> top)`; a `< lowest` bucket
(`1 − adjusted P(> lowest)`) completes the distribution. All ≥ 0, sum to 1.0.

## Confidence — `{ tier, score, reasons[] }`
The **worst** of several signals (a single bad signal caps trust), each surfaced as a reason:

| Signal | high | medium | low |
|---|---|---|---|
| Active thresholds | ≥ 12 | 8–11 | < 8 |
| Monotonicity adjustments | 0 | ≤ 2 | > 2 |
| Mean bid−ask spread | < 0.04 | 0.04–0.08 | > 0.08 |
| Thin-liquidity breadth (share of books < $50K) | < 20% | 20–50% | > 50% |
| Anomalies | none | stale / 1–2 closed / volume drop | > 2 closed |

**Materiality threshold on monotonicity adjustments (`MATERIAL_ADJUSTMENT` = 0.5%):** an isotonic
adjustment whose maximum magnitude is **below 0.5%** is treated as *immaterial* — the tier stays
**high** with a "negligible monotonicity tweak(s)" reason, instead of dropping to medium. Rationale:
a violation pooled to a sub-0.5% tweak is float-level quote noise, not a data-quality defect;
penalizing it would make the tier oscillate on negligible price adjustments. Documented in
`core/methodology.json` `metrics.confidence.material_adjustment` (methodology 1.7.1).

**Anomalies**: `stale` (raw inputs identical to the prior snapshot), `closed` (markets closed / not
accepting orders), `liquidity_drop` (total volume > 40% below the trailing-7-day median). Liquidity
breadth is **not** assessed when volume is unknown (price-only history); those days are capped at
medium with reason `price-only history (no bid/ask spread)`.

## Narrative
A deterministic, template-based reading composed **only** from stored fields (median vs 7d/30d-ago,
divergence, dominant bucket, confidence caveat). **No language model in the data path** — reproducible
from `narrative_components`; it never asserts anything not in those fields.

## Provenance — `raw_sha256`
Unchanged from 1.0.0 (so archived snapshots stay verifiable): SHA-256 over the canonical JSON of
`raw_inputs` (fixed key order, ascending by threshold, literal API strings). The dashboard's
**verify hash** button reproduces it in-browser. Market status flags (closed/active) are deliberately
**excluded** from the hashed inputs.

## Source of record — the CLOB midpoint (canonical)
Two public Polymarket surfaces expose a YES price, and they are **different statistics**:
the **CLOB `/midpoints`** endpoint — `(best_bid + best_ask) / 2` of the live order book — and the
**Gamma** event's `outcomePrices`, a platform-surfaced display price that can reflect last trade or a
cached value and **may lag the book**. The feed's `raw_inputs.midpoint` (hence every `raw_prob` and
all derived metrics) is the **CLOB midpoint**. It is the **canonical source of record** because it is
(a) the live two-sided book — the price you could actually transact near — not a trailing display
value, (b) computed directly from `best_bid`/`best_ask`, which we already publish for the spread/
confidence signal, so the recipe is self-consistent, and (c) the same per-token statistic across all
thresholds. Gamma is used **only** for metadata (token ids, volume, threshold parsing); its
`outcomePrices` is treated as a **cross-check**, never as an input. When the two disagree, the CLOB
midpoint wins and the divergence is reported (see verification, below) — never silently reconciled.

## Verification — `scripts/verify-accuracy.js`
An independent, on-demand/CI reconciliation harness that **proves** the published feed matches source
rather than eyeballing it. It fetches the live market **twice** (~10 s apart) from both surfaces and:
(1) cross-checks Gamma `outcomePrices` against the CLOB midpoint per token (upstream sanity, ±1pt);
(2) quantifies order-book **drift** between the two captures, so timing is attributable separately
from error; (3) reconciles the **published** `latest.json` against the fresh CLOB midpoint per
threshold (±2pt, widened by the observed drift), showing the publish-age gap; and (4) confirms the
published curve is a **valid isotonic transform** of fresh source (monotone CDF, buckets ≥ 0, sum 1.0)
using the production `core/stats.js` transform. It separates **two horizons** so it never conflates
market movement with error: the strict ±2pt price-match is a hard PASS/FAIL **only inside a ~3h
price-match window** (young enough that a >tol delta is a real data error); between 3h and the
staleness horizon (17h, imported from `core/freshness.js`) the snapshot is "aged but live" and
per-threshold deltas are reported **descriptively as expected market drift, never a FAIL**; past the
horizon it is **STALE** (a pipeline-liveness signal, shared with the dashboard via
`core/freshness.js`). The ±2pt tolerance is **not** widened to cover aging —
that would blind it to real source errors; instead the harness bounds *when* the strict check applies.
The canonical green path is the CI pattern: **run the snapshot, then verify immediately while
seconds-old → tight match → exit 0**. The harness **reports only**; it never mutates the feed or
`fetch.js`. A discrepancy is a finding to investigate, not an auto-fix.

## Data freshness (Tier-1) — `derived.freshness`
A silently stale number is a trust failure, so the feed **discloses its own age**. Each record
carries a Tier-1 `freshness` block — a pure function of the snapshot's own `fetched_at` plus one
documented constant, no external input: `{ as_of, staleness_threshold_hours, stale_after,
expected_cadence, policy }`. The published record holds **policy only** — it does *not* bake a live
`age`/`stale` boolean, because age is a **read-time** quantity and a frozen flag would lie the moment
the file sits unchanged. Instead it publishes an absolute **`stale_after`** instant (`as_of +
threshold`), so every consumer judges staleness with one comparison — `now > stale_after` — and no
duplicated formula. The dashboard and printable note compute the live age in-browser and show an
explicit "as-of age" plus a **stale** badge past the threshold; `core/freshness.js` owns the policy
(single source of truth). **Threshold = 17h, derived from the schedule** — never a free-standing
literal. The snapshot cron (`update.yml`, `0 0,12,14,16,18,20,22 * * *`) runs **every 2h from 12:00
to 22:00 UTC plus 00:00, daily incl. weekends**; the largest scheduled gap is the **12h overnight
pause** (00:00→12:00 UTC). Threshold = 12h max gap + 2h one fully-missed run + 3h Actions queue
jitter. A normal overnight pause never flags; anything beyond 17h is a genuine pipeline failure.
`core/freshness.js` exports the `SCHEDULE` facts and computes the threshold from them, and a coupling
test re-derives the gaps from the workflow cron so schedule and threshold cannot silently desync.
(The weekday-only `1-5` crons are the *email* runs, not the snapshot.)

## Contract & scope
The canonical record conforms to [`/api/v1/schema.json`](docs/api/v1/schema.json) (JSON Schema
2020-12), validated at build. **v1 covers public Polymarket data only** — no grey-market /
secondary-market (Forge, Caplight, EquityZen) data.

## Changelog
- **1.3.0** (2026-06-12) — Cadence + freshness policy change, **no formula change**. Snapshot
  cadence raised from 1/day to **every 2h, 12:00–00:00 UTC** (7/day; overnight pause 00:00–12:00
  UTC); email crons unchanged. Staleness threshold **re-derived as a function of the schedule**
  (12h max scheduled gap + 2h missed run + 3h queue jitter = **17h**, was a 50h literal sized for
  the daily cadence), with a coupling test binding the workflow cron to the threshold derivation.
  Added a **post-publish accuracy verify step** in CI (publish-then-alert: `verify-accuracy.js`
  runs non-strict after every push; FAIL marks the run red, never blocks publication or emails).
- **1.2.1** (2026-06-08) — Clarification + additive freshness field, **no formula change**.
  Documented the **canonical source of record** (CLOB `/midpoints`; Gamma `outcomePrices` is a
  lagging cross-check, never an input) and added an independent data-accuracy verification harness
  (`scripts/verify-accuracy.js`) that reconciles the published feed against fresh dual-source data
  with documented tolerances and a separate freshness verdict. Added a **Tier-1 `derived.freshness`**
  policy block (as-of anchor + absolute `stale_after`; 50h threshold sized to the daily cron) surfaced
  as an as-of age + stale badge on the dashboard and note. **Schema 1.2.1** (additive:
  `derived.freshness`).
- **1.2.0** (2026-06-05) — Tier-1 analytics (Bowley skew, robust fat-tail ratio, entropy/Gini,
  dispersion-over-time, velocity/acceleration) + a calibration scaffold (pending resolution, not
  faked). Firewalled Tier-2 scenario tier (implied share price, round-over-round) with sourced/dated
  assumptions (assumptions.json v1.0.0) and build-time firewall validation. Unified delta rounding.
  Schema 1.2.0 (additive: derived.market, derived.scenarios, assumptions_version).
- **1.1.0** (2026-06-05) — Volume-weighted isotonic adjustment (removes negative-probability
  artifacts; raw preserved); spread-implied median band; mean tail-sensitivity range;
  anomaly/staleness/liquidity confidence signals; deterministic narrative; published JSON Schema.
- **1.0.0** (2026-06-05) — Initial: median, mean (tail assumptions), IQR band, bucket probabilities,
  three-signal confidence, raw_sha256 provenance.
